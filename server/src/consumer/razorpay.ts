import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db.js';
import { one } from '../db.js';
import { AppError } from '../http/errors.js';
import { consumerAudit } from './context.js';
import type { BillingPeriod, PlanId } from './entitlements.js';

const API = 'https://api.razorpay.com/v1';

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

/** Razorpay webhook signature: hex HMAC-SHA256 of the exact raw body, keyed with the webhook secret. */
export function computeWebhookSignature(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

export function verifyWebhookSignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(computeWebhookSignature(secret, rawBody), 'hex');
  const given = Buffer.from(signature.toLowerCase(), 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface RazorpaySubscription {
  id: string;
  plan_id?: string;
  status: string;
  current_end?: number | null;
  notes?: Record<string, unknown> | unknown[] | null;
}

export const paymentsUnavailable = (message = 'Payments are not available yet') =>
  new AppError(503, 'payments_unavailable', message);

/** Thin Razorpay Subscriptions client (real network calls; never faked). */
export class RazorpayClient {
  constructor(
    private readonly creds: RazorpayCredentials,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const auth = Buffer.from(`${this.creds.keyId}:${this.creds.keySecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AppError(502, 'payment_provider_error', 'Could not reach the payment provider. Nothing was charged.');
    }
    const text = await res.text();
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text) as { error?: { description?: string } };
        if (j.error?.description) reason = j.error.description;
      } catch {
        /* keep status */
      }
      throw new AppError(502, 'payment_provider_error', `Payment provider rejected the request: ${reason}`);
    }
    return JSON.parse(text) as T;
  }

  createSubscription(input: {
    planId: string;
    billingPeriod: BillingPeriod;
    notes: Record<string, string>;
  }): Promise<RazorpaySubscription & { short_url?: string }> {
    // total_count is required by Razorpay: ~10 years of cycles; cancellation stops renewal earlier.
    return this.call('POST', '/subscriptions', {
      plan_id: input.planId,
      total_count: input.billingPeriod === 'yearly' ? 10 : 120,
      customer_notify: 1,
      notes: input.notes,
    });
  }

  fetchSubscription(id: string): Promise<RazorpaySubscription> {
    return this.call('GET', `/subscriptions/${encodeURIComponent(id)}`);
  }

  cancelAtCycleEnd(id: string): Promise<RazorpaySubscription> {
    return this.call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 1 });
  }
}

type EntStatus = 'active' | 'cancelled' | 'expired';

/** Razorpay subscription states that never become active again. */
const TERMINAL_SUB_STATUSES = new Set(['cancelled', 'completed', 'expired']);

/** Maps a Razorpay subscription status to an entitlement status; null means "leave unchanged". */
export function entitlementStatusFor(subStatus: string): EntStatus | null {
  switch (subStatus) {
    case 'active':
      return 'active';
    case 'cancelled':
      return 'cancelled';
    case 'halted':
    case 'completed':
    case 'expired':
    case 'paused':
      return 'expired';
    default:
      // created / authenticated / pending: no paid access change yet (pending = provider retrying a charge).
      return null;
  }
}

/**
 * Applies a provider subscription state to billing_subscriptions + entitlements (idempotent).
 * A non-active state for an older subscription never downgrades an account that is on a different one.
 */
export async function applySubscriptionState(
  q: Queryable,
  sub: RazorpaySubscription,
  now: Date,
  source: string,
): Promise<{ applied: boolean; accountId: string | null }> {
  const known = await one<{ account_id: string | null; plan: PlanId; billing_period: BillingPeriod; status: string }>(
    q,
    'SELECT account_id, plan, billing_period, status FROM billing_subscriptions WHERE id = $1 FOR UPDATE',
    [sub.id],
  );
  // Webhooks can arrive out of order: a late snapshot never revives a subscription that already ended.
  if (known && TERMINAL_SUB_STATUSES.has(known.status) && !TERMINAL_SUB_STATUSES.has(sub.status)) {
    return { applied: false, accountId: known.account_id };
  }
  const notes = sub.notes && !Array.isArray(sub.notes) ? sub.notes : {};
  let accountId = known?.account_id ?? null;
  let plan = known?.plan ?? null;
  let period = known?.billing_period ?? null;
  if (!known) {
    // Fall back to the notes we attached at checkout, then to the provider plan id mapping.
    const noteAccount = typeof notes.account_id === 'string' ? notes.account_id : null;
    if (noteAccount && (await one(q, 'SELECT 1 FROM consumer_accounts WHERE id = $1', [noteAccount]))) accountId = noteAccount;
    if (sub.plan_id) {
      const p = await one<{ id: PlanId; period: BillingPeriod }>(
        q,
        `SELECT id, CASE WHEN provider_plan_ids->>'yearly' = $1 THEN 'yearly' ELSE 'monthly' END AS period
           FROM plans WHERE provider_plan_ids->>'monthly' = $1 OR provider_plan_ids->>'yearly' = $1`,
        [sub.plan_id],
      );
      if (p) {
        plan = p.id;
        period = p.period;
      }
    }
    if (!accountId || !plan || !period) return { applied: false, accountId };
    await q.query(
      `INSERT INTO billing_subscriptions (id, account_id, plan, billing_period, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6) ON CONFLICT (id) DO NOTHING`,
      [sub.id, accountId, plan, period, sub.status, now],
    );
  } else {
    await q.query('UPDATE billing_subscriptions SET status = $2, updated_at = $3 WHERE id = $1', [sub.id, sub.status, now]);
  }
  const status = entitlementStatusFor(sub.status);
  if (!accountId || !plan || !period || status === null) return { applied: false, accountId };

  const before = await one<{ plan: string; status: string; provider_ref: string | null; current_period_end: Date | null }>(
    q,
    'SELECT plan, status, provider_ref, current_period_end FROM entitlements WHERE account_id = $1 FOR UPDATE',
    [accountId],
  );
  if (status !== 'active' && before?.provider_ref && before.provider_ref !== sub.id) {
    return { applied: false, accountId };
  }
  // A cancel-at-period-end request keeps the subscription 'active' at the provider until the period ends;
  // re-reading it (restore, or a late webhook) must not silently turn auto-renewal back on.
  const effective: EntStatus =
    status === 'active' && before?.status === 'cancelled' && before.provider_ref === sub.id ? 'cancelled' : status;
  const periodEnd = sub.current_end ? new Date(sub.current_end * 1000) : (before?.current_period_end ?? null);
  const after = { plan, billing_period: period, status: effective, current_period_end: periodEnd, channel: 'razorpay', provider_ref: sub.id };
  await q.query(
    `INSERT INTO entitlements (account_id, plan, billing_period, status, current_period_end, channel, provider_ref, updated_at)
     VALUES ($1,$2,$3,$4,$5,'razorpay',$6,$7)
     ON CONFLICT (account_id) DO UPDATE SET plan = EXCLUDED.plan, billing_period = EXCLUDED.billing_period,
       status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, channel = EXCLUDED.channel,
       provider_ref = EXCLUDED.provider_ref, updated_at = EXCLUDED.updated_at`,
    [accountId, plan, period, effective, periodEnd, sub.id, now],
  );
  await consumerAudit(q, accountId, `entitlement.${source}`, 'entitlement', accountId, before, after, now);
  return { applied: true, accountId };
}
