import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consumerAudit, currentAccount, entitlementOf, requireAccount } from '../consumer/context.js';
import { computeEntitlement, getPlan, listPlans, PAID_PLAN_IDS, publicPlan, type PlanRow } from '../consumer/entitlements.js';
import {
  applySubscriptionState,
  paymentsUnavailable,
  RazorpayClient,
  verifyWebhookSignature,
  type RazorpaySubscription,
} from '../consumer/razorpay.js';
import { applyRefund } from '../consumer/billing-reconcile.js';
import { one, withTransaction } from '../db.js';
import { metrics } from '../observability/metrics.js';
import { AppError, parse } from '../http/errors.js';
import { getSettings } from '../settings.js';
import { normaliseKeys, sha256 } from '../util.js';

function checkoutAvailability(p: PlanRow, configured: boolean) {
  return {
    monthly: configured && p.price_inr_monthly !== null && Boolean(p.provider_plan_ids?.monthly),
    yearly: configured && p.price_inr_yearly !== null && Boolean(p.provider_plan_ids?.yearly),
  };
}

interface RazorpayPayment {
  id?: string;
  amount?: number;
  amount_refunded?: number;
  subscription_id?: string;
  notes?: Record<string, unknown> | unknown[] | null;
}

export const CANCELLATION_PATH = 'Account > Plan > Cancel subscription in the Due app (takes effect at the end of the paid period).';

/**
 * Plans, checkout (Razorpay Subscriptions), restore, cancel and the provider webhook.
 * Without Razorpay credentials and plan ids every payment path returns 503 payments_unavailable.
 */
export async function billingRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock, config } = app.deps;
  const client = () => {
    if (!config.razorpay) throw paymentsUnavailable();
    return new RazorpayClient(config.razorpay);
  };

  app.get('/api/public/plans', async (_req, reply) => {
    const plans = (await listPlans(pool)).filter((p) => p.active);
    const settings = await getSettings(pool);
    const terms = settings.billing_terms;
    reply.header('Cache-Control', 'public, max-age=60');
    return {
      currency: 'INR',
      plans: plans.map((p) => ({ ...publicPlan(p), checkoutAvailable: checkoutAvailability(p, Boolean(config.razorpay)) })),
      terms: {
        renewal: terms.renewal,
        cancellation: terms.cancellation,
        refund: terms.refund,
        legalReviewStatus: terms.legal_review_status,
      },
      cancellationPath: CANCELLATION_PATH,
      tax: { note: settings['billing.tax_note'], pricesIncludeTax: settings['billing.prices_include_tax'] },
      purchaseChannel: config.razorpay ? 'razorpay' : null,
      paymentsAvailable: Boolean(config.razorpay) && plans.some((p) => Object.values(checkoutAvailability(p, true)).some(Boolean)),
    };
  });

  app.post('/api/account/checkout', { preHandler: requireAccount }, async (req, reply) => {
    const a = currentAccount(req);
    // billingPeriod has no default: yearly is only ever used when explicitly chosen.
    const body = parse(z.object({ plan: z.enum(PAID_PLAN_IDS), billingPeriod: z.enum(['monthly', 'yearly']) }).strict(), normaliseKeys(req.body));
    // Inactive plans (e.g. Household until sharing ships) are never sold, whatever the provider setup.
    const plan = await getPlan(pool, body.plan);
    const price = body.billingPeriod === 'monthly' ? plan?.price_inr_monthly : plan?.price_inr_yearly;
    if (!plan || !plan.active || price === null || price === undefined) {
      throw new AppError(400, 'plan_unavailable', 'This plan or billing period is not offered');
    }
    // Paid access (active, or cancelled but still inside the paid period) blocks a second subscription.
    const ent = await entitlementOf(req);
    if (ent.plan !== 'free') {
      throw new AppError(
        409,
        'already_subscribed',
        ent.status === 'cancelled'
          ? 'Your current plan stays active until the end of the paid period. You can choose a new plan after it ends.'
          : 'You already have an active plan. Cancel it before switching.',
      );
    }
    const rp = client();
    const providerPlanId = plan.provider_plan_ids?.[body.billingPeriod];
    if (!providerPlanId) throw paymentsUnavailable('Checkout for this plan is not configured yet');
    const sub = await rp.createSubscription({
      planId: providerPlanId,
      billingPeriod: body.billingPeriod,
      notes: { account_id: a.id, plan: body.plan, billing_period: body.billingPeriod },
    });
    const now = clock();
    await withTransaction(pool, async (c) => {
      await c.query(
        `INSERT INTO billing_subscriptions (id, account_id, plan, billing_period, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)
         ON CONFLICT (id) DO NOTHING`,
        [sub.id, a.id, body.plan, body.billingPeriod, sub.status, now],
      );
      await consumerAudit(c, a.id, 'checkout.created', 'billing_subscription', sub.id, null, { plan: body.plan, billingPeriod: body.billingPeriod, amountInr: price }, now);
    });
    const terms = (await getSettings(pool)).billing_terms;
    return reply.code(201).send({
      provider: 'razorpay',
      keyId: config.razorpay!.keyId,
      subscriptionId: sub.id,
      shortUrl: sub.short_url ?? null,
      plan: body.plan,
      billingPeriod: body.billingPeriod,
      amountInr: price,
      renewal: body.billingPeriod === 'yearly' ? 'Renews every year until you cancel.' : 'Renews every month until you cancel.',
      cancellationPath: CANCELLATION_PATH,
      terms,
    });
  });

  /** Restore purchase: re-reads the latest subscription from Razorpay when configured, otherwise from the database. */
  app.post('/api/account/restore', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const now = clock();
    let source: 'provider' | 'database' = 'database';
    if (config.razorpay) {
      const latest = await one<{ id: string }>(pool, 'SELECT id FROM billing_subscriptions WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 1', [a.id]);
      if (latest) {
        const sub = await client().fetchSubscription(latest.id);
        await withTransaction(pool, (c) => applySubscriptionState(c, sub, now, 'restore'));
        source = 'provider';
      }
    }
    return { source, entitlements: await computeEntitlement(pool, a.id, now) };
  });

  app.post('/api/account/subscription/cancel', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const rp = client();
    const ent = await one<{ provider_ref: string | null; channel: string | null; status: string }>(
      pool,
      'SELECT provider_ref, channel, status FROM entitlements WHERE account_id = $1',
      [a.id],
    );
    if (!ent || ent.channel !== 'razorpay' || !ent.provider_ref || ent.status !== 'active') {
      throw new AppError(400, 'no_active_subscription', 'There is no active subscription to cancel');
    }
    await rp.cancelAtCycleEnd(ent.provider_ref);
    const now = clock();
    await withTransaction(pool, async (c) => {
      await c.query(`UPDATE entitlements SET status = 'cancelled', updated_at = $2 WHERE account_id = $1`, [a.id, now]);
      await consumerAudit(c, a.id, 'subscription.cancel_requested', 'entitlement', a.id, { status: 'active' }, { status: 'cancelled', atPeriodEnd: true }, now);
    });
    return { ok: true, entitlements: await computeEntitlement(pool, a.id, now) };
  });

  app.post('/api/billing/razorpay/webhook', async (req, reply) => {
    if (!config.razorpay) throw paymentsUnavailable();
    const raw = req.rawBody ?? '';
    const sig = req.headers['x-razorpay-signature'];
    if (!verifyWebhookSignature(config.razorpay.webhookSecret, raw, typeof sig === 'string' ? sig : undefined)) {
      metrics.inc('billing.webhook', { outcome: 'invalid_signature' });
      throw new AppError(400, 'invalid_signature', 'Webhook signature verification failed');
    }
    const body = req.body as
      | {
          event?: string;
          payload?: {
            subscription?: { entity?: RazorpaySubscription };
            payment?: { entity?: RazorpayPayment };
            refund?: { entity?: { id?: string; payment_id?: string; amount?: number } };
          };
        }
      | undefined;
    const event = typeof body?.event === 'string' ? body.event : 'unknown';
    const entity = body?.payload?.subscription?.entity;
    const headerId = req.headers['x-razorpay-event-id'];
    const eventId = typeof headerId === 'string' && headerId ? headerId.slice(0, 200) : `sha256:${sha256(raw)}`;
    const now = clock();
    const result = await withTransaction(pool, async (c) => {
      const ins = await c.query('INSERT INTO billing_events (event_id, event, subscription_id, received_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [
        eventId,
        event,
        entity?.id ?? null,
        now,
      ]);
      if (!ins.rowCount) return { duplicate: true, applied: false };
      // Refunds: a full refund of a subscription payment ends paid access; partial refunds are recorded only.
      if (event === 'refund.processed' || event === 'payment.refunded') {
        const payment = body?.payload?.payment?.entity;
        const refund = body?.payload?.refund?.entity;
        const paymentId = payment?.id ?? refund?.payment_id ?? null;
        if (!paymentId) return { duplicate: false, applied: false };
        const notes = payment?.notes && !Array.isArray(payment.notes) ? payment.notes : {};
        const r = await applyRefund(
          c,
          {
            paymentId,
            subscriptionId: typeof payment?.subscription_id === 'string' ? payment.subscription_id : null,
            accountId: typeof notes.account_id === 'string' ? notes.account_id : null,
            amount: typeof payment?.amount_refunded === 'number' ? payment.amount_refunded : typeof refund?.amount === 'number' ? refund.amount : null,
            paymentAmount: typeof payment?.amount === 'number' ? payment.amount : null,
          },
          now,
        );
        await c.query('UPDATE billing_events SET payment_id = $2, outcome = $3 WHERE event_id = $1', [eventId, paymentId, r.applied ? 'access_ended' : r.full ? 'no_match' : 'partial']);
        return { duplicate: false, applied: r.applied };
      }
      if (!event.startsWith('subscription.') || !entity?.id || typeof entity.status !== 'string') return { duplicate: false, applied: false };
      const r = await applySubscriptionState(c, entity, now, 'webhook');
      return { duplicate: false, applied: r.applied };
    });
    metrics.inc('billing.webhook', { outcome: result.duplicate ? 'duplicate' : result.applied ? 'applied' : 'ignored' });
    return reply.code(200).send({ ok: true, ...result });
  });
}
