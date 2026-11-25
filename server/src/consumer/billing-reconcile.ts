import type { Queryable } from '../db.js';
import { many, one, withTransaction } from '../db.js';
import { metrics } from '../observability/metrics.js';
import type { JobContext } from '../queue/index.js';
import { consumerAudit } from './context.js';
import { applySubscriptionState, RazorpayClient } from './razorpay.js';
import { CashfreeClient, toNeutralSubscription } from './cashfree.js';

/**
 * Daily `billing.reconcile`: re-reads every non-terminal Razorpay subscription from the provider and applies its
 * state (activations missed by webhooks, halts, cancellations, completions). The server stays the source of
 * entitlement truth: nothing is ever unlocked from a client-side checkout callback.
 */
export async function reconcileBilling(job: JobContext): Promise<void> {
  const { pool, clock, config, log, fetchImpl } = job.deps;
  if (!config.razorpay && !config.cashfree) {
    log.info({ outcome: 'not_configured' }, 'billing reconcile skipped: no payment provider configured');
    metrics.inc('billing.reconcile', { outcome: 'not_configured' });
    return;
  }
  const rp = config.razorpay ? new RazorpayClient(config.razorpay, fetchImpl ?? globalThis.fetch) : null;
  const cf = config.cashfree ? new CashfreeClient(config.cashfree, fetchImpl ?? globalThis.fetch) : null;
  const subs = await many<{ id: string; provider: string }>(
    pool,
    `SELECT DISTINCT ON (id) id, provider FROM (
       SELECT id, provider FROM billing_subscriptions WHERE status NOT IN ('cancelled','completed','expired')
       UNION SELECT provider_ref AS id, channel AS provider FROM entitlements WHERE channel IN ('razorpay','cashfree') AND provider_ref IS NOT NULL AND status <> 'expired'
     ) s WHERE id IS NOT NULL ORDER BY id LIMIT 5000`,
  );
  let applied = 0;
  let errors = 0;
  for (const { id, provider } of subs) {
    try {
      let r: { applied: boolean };
      if (provider === 'cashfree') {
        if (!cf) continue;
        const sub = toNeutralSubscription(await cf.fetchSubscription(id));
        r = await withTransaction(pool, (c) => applySubscriptionState(c, sub, clock(), 'reconcile', 'cashfree'));
      } else {
        if (!rp) continue;
        const sub = await rp.fetchSubscription(id);
        r = await withTransaction(pool, (c) => applySubscriptionState(c, sub, clock(), 'reconcile'));
      }
      if (r.applied) applied++;
    } catch (err) {
      errors++;
      log.warn({ code: (err as { code?: string }).code ?? 'error', subscription: id }, 'billing reconcile: subscription fetch failed');
    }
  }
  metrics.inc('billing.reconcile', { outcome: errors ? 'partial' : 'ok' });
  log.info({ checked: subs.length, applied, errors }, 'billing reconcile finished');
  if (errors && errors === subs.length) {
    throw Object.assign(new Error(`billing reconcile: all ${errors} provider fetches failed`), { code: 'provider_unreachable' });
  }
}

/**
 * A full refund of a subscription payment ends paid access for that subscription (partial refunds are recorded only).
 * Returns whether an entitlement changed.
 */
export async function applyRefund(
  q: Queryable,
  refund: { paymentId: string; subscriptionId: string | null; accountId: string | null; amount: number | null; paymentAmount: number | null },
  now: Date,
): Promise<{ applied: boolean; full: boolean }> {
  const full = refund.amount !== null && refund.paymentAmount !== null && refund.amount >= refund.paymentAmount;
  if (!full) return { applied: false, full };
  let accountId = refund.accountId;
  if (!accountId && refund.subscriptionId) {
    accountId = (await one<{ account_id: string | null }>(q, 'SELECT account_id FROM billing_subscriptions WHERE id = $1', [refund.subscriptionId]))?.account_id ?? null;
  }
  if (!accountId) return { applied: false, full };
  const before = await one<{ status: string; provider_ref: string | null; plan: string }>(
    q,
    'SELECT status, provider_ref, plan FROM entitlements WHERE account_id = $1 FOR UPDATE',
    [accountId],
  );
  if (!before || before.plan === 'free') return { applied: false, full };
  if (refund.subscriptionId && before.provider_ref && before.provider_ref !== refund.subscriptionId) return { applied: false, full };
  await q.query(`UPDATE entitlements SET status = 'expired', current_period_end = $2, updated_at = $2 WHERE account_id = $1`, [accountId, now]);
  await consumerAudit(q, accountId, 'entitlement.refund', 'entitlement', accountId, before, { status: 'expired', reason: 'full_refund', paymentId: refund.paymentId }, now);
  return { applied: true, full };
}
