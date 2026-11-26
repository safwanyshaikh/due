import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consumerAudit, currentAccount, entitlementOf, requireAccount } from '../consumer/context.js';
import { betaState, computeEntitlement, getBetaState, getPlan, listPlans, PAID_PLAN_IDS, publicPlan, type PlanRow } from '../consumer/entitlements.js';
import { CashfreeClient, applyCashfreeEvent, newCashfreeSubscriptionId, parseCashfreeEvent, toNeutralSubscription, verifyCashfreeSignature } from '../consumer/cashfree.js';
import { CASHFREE } from '../consumer/cashfree.config.js';
import { activeProvider, providerConfigured, providerPlanId } from '../consumer/billing-provider.js';
import { taxDisplay } from '../consumer/tax.js';
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
import { isMobileOrigin } from '../http/security.js';
import { getSettings } from '../settings.js';
import { normaliseKeys, sha256 } from '../util.js';

function checkoutAvailability(p: PlanRow, configured: boolean, provider: 'razorpay' | 'cashfree') {
  return {
    monthly: configured && p.price_inr_monthly !== null && Boolean(providerPlanId(p, provider, 'monthly')),
    yearly: configured && p.price_inr_yearly !== null && Boolean(providerPlanId(p, provider, 'yearly')),
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
 * L8: deleting an account stops its paid subscription at the gateway first (no further charges), instead of
 * refusing the deletion. Throws 409 subscription_cancel_failed when the gateway cannot be reached.
 */
export async function cancelSubscriptionForDeletion(app: FastifyInstance, accountId: string, now: Date): Promise<boolean> {
  const { pool, config } = app.deps;
  const ent = await one<{ provider_ref: string | null; channel: string | null; status: string }>(
    pool,
    'SELECT provider_ref, channel, status FROM entitlements WHERE account_id = $1',
    [accountId],
  );
  if (!ent || (ent.channel !== 'razorpay' && ent.channel !== 'cashfree') || ent.status !== 'active' || !ent.provider_ref) return false;
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (app.deps.fetchImpl ?? globalThis.fetch)(input, init)) as typeof fetch;
  try {
    if (ent.channel === 'cashfree') {
      if (!config.cashfree) throw new Error('cashfree not configured');
      await new CashfreeClient(config.cashfree, fetchImpl).cancel(ent.provider_ref);
    } else {
      if (!config.razorpay) throw new Error('razorpay not configured');
      await new RazorpayClient(config.razorpay, fetchImpl).cancelNow(ent.provider_ref);
    }
  } catch {
    throw new AppError(409, 'subscription_cancel_failed', 'We could not stop your subscription with the payment provider just now, so the account was not deleted. Try again in a few minutes.');
  }
  await withTransaction(pool, async (c) => {
    await c.query(`UPDATE entitlements SET status = 'cancelled', updated_at = $2 WHERE account_id = $1`, [accountId, now]);
    await consumerAudit(c, accountId, 'subscription.cancelled_for_deletion', 'entitlement', accountId, { status: 'active' }, { status: 'cancelled' }, now);
  });
  return true;
}

/**
 * Plans, checkout (Razorpay Subscriptions), restore, cancel and the provider webhook.
 * Without Razorpay credentials and plan ids every payment path returns 503 payments_unavailable.
 */
export async function billingRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock, config } = app.deps;
  const fetchImpl = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (app.deps.fetchImpl ?? globalThis.fetch)(input, init)) as typeof fetch;
  const client = () => {
    if (!config.razorpay) throw paymentsUnavailable();
    return new RazorpayClient(config.razorpay, fetchImpl);
  };
  const cashfree = () => {
    if (!config.cashfree) throw paymentsUnavailable();
    return new CashfreeClient(config.cashfree, fetchImpl);
  };

  app.get('/api/public/plans', async (req, reply) => {
    const plans = (await listPlans(pool)).filter((p) => p.active);
    const settings = await getSettings(pool);
    const terms = settings.billing_terms;
    const provider = activeProvider(config);
    // Store rules (Apple 3.1.1, Google Play Billing): no purchase inside the native apps until the owner decides
    // on in-app purchase. The native app sees payments as unavailable, so it shows no purchase UI (PAYMENTS.md).
    const native = isMobileOrigin(req.headers.origin, config.mobileAppOrigins);
    const configured = !native && providerConfigured(config, provider);
    const tax = taxDisplay(settings);
    reply.header('Cache-Control', 'public, max-age=60');
    reply.header('Vary', 'Origin');
    const beta = betaState(settings, clock());
    return {
      beta,
      currency: 'INR',
      plans: plans.map((p) => ({ ...publicPlan(p), checkoutAvailable: checkoutAvailability(p, configured, provider) })),
      terms: {
        renewal: terms.renewal,
        cancellation: terms.cancellation,
        refund: terms.refund,
        legalReviewStatus: terms.legal_review_status,
      },
      cancellationPath: CANCELLATION_PATH,
      tax: { note: tax.note, pricesIncludeTax: tax.pricesIncludeTax, gstRegistered: tax.gstRegistered, gstin: tax.gstin },
      purchaseChannel: configured ? provider : null,
      paymentsAvailable: configured && plans.some((p) => Object.values(checkoutAvailability(p, true, provider)).some(Boolean)),
      ...(native ? { inAppPurchase: 'not_offered' } : {}),
    };
  });

  app.post('/api/account/checkout', { preHandler: requireAccount }, async (req, reply) => {
    const a = currentAccount(req);
    if (isMobileOrigin(req.headers.origin, config.mobileAppOrigins)) {
      throw new AppError(403, 'not_sold_in_app', 'Paid plans are not sold in the app.');
    }
    // billingPeriod has no default: yearly is only ever used when explicitly chosen.
    const body = parse(z.object({ plan: z.enum(PAID_PLAN_IDS), billingPeriod: z.enum(['monthly', 'yearly']), customerPhone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a 10-digit Indian mobile number').optional() }).strict(), normaliseKeys(req.body));
    // Free public beta: nothing is charged while it runs. Turning the beta off restores the paid flow unchanged.
    const beta = await getBetaState(pool, clock());
    if (beta.plusFree) {
      throw new AppError(409, 'beta_free', 'Due Plus is free during the beta, so there is nothing to buy right now. Nothing will be charged.', {
        endsOn: beta.endsOn,
      });
    }
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
    const provider = activeProvider(config);
    const planId = providerPlanId(plan, provider, body.billingPeriod);
    const terms = (await getSettings(pool)).billing_terms;
    const tax = taxDisplay(await getSettings(pool));
    const now = clock();
    if (provider === 'cashfree') {
      const cf = cashfree();
      if (!planId) throw paymentsUnavailable('Checkout for this plan is not configured yet');
      if (!body.customerPhone) throw new AppError(400, 'phone_required', 'A mobile number is needed to set up UPI AutoPay or a card mandate');
      const subscriptionId = newCashfreeSubscriptionId();
      const base = config.publicBaseUrl ?? '';
      // The amount is fixed by the Cashfree plan; nothing price-related comes from the client.
      const sub = await cf.createSubscription({
        subscriptionId,
        planId,
        customer: { name: a.displayName ?? a.email.split('@')[0]!, email: a.email, phone: body.customerPhone },
        returnUrl: `${base}/#/plans`,
        billingPeriod: body.billingPeriod,
        tags: { account_id: a.id, plan: body.plan, billing_period: body.billingPeriod },
      });
      await withTransaction(pool, async (c) => {
        await c.query(
          `INSERT INTO billing_subscriptions (id, account_id, plan, billing_period, status, provider, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,'cashfree',$6,$6)
           ON CONFLICT (id) DO NOTHING`,
          [subscriptionId, a.id, body.plan, body.billingPeriod, 'created', now],
        );
        await consumerAudit(c, a.id, 'checkout.created', 'billing_subscription', subscriptionId, null, { provider: 'cashfree', plan: body.plan, billingPeriod: body.billingPeriod, amountInr: price }, now);
      });
      return reply.code(201).send({
        provider: 'cashfree',
        env: config.cashfree!.env,
        subscriptionId,
        subscriptionSessionId: sub.subscription_session_id ?? null,
        shortUrl: cf.hostedCheckoutUrl(sub),
        plan: body.plan,
        billingPeriod: body.billingPeriod,
        amountInr: price,
        renewal: body.billingPeriod === 'yearly' ? 'Renews every year until you cancel.' : 'Renews every month until you cancel.',
        cancellationPath: CANCELLATION_PATH,
        terms,
        tax: { gstRegistered: tax.gstRegistered, gstin: tax.gstin, note: tax.note },
      });
    }
    const rp = client();
    if (!planId) throw paymentsUnavailable('Checkout for this plan is not configured yet');
    const sub = await rp.createSubscription({
      planId,
      billingPeriod: body.billingPeriod,
      notes: { account_id: a.id, plan: body.plan, billing_period: body.billingPeriod },
    });
    await withTransaction(pool, async (c) => {
      await c.query(
        `INSERT INTO billing_subscriptions (id, account_id, plan, billing_period, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)
         ON CONFLICT (id) DO NOTHING`,
        [sub.id, a.id, body.plan, body.billingPeriod, sub.status, now],
      );
      await consumerAudit(c, a.id, 'checkout.created', 'billing_subscription', sub.id, null, { plan: body.plan, billingPeriod: body.billingPeriod, amountInr: price }, now);
    });
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
      tax: { gstRegistered: tax.gstRegistered, gstin: tax.gstin, note: tax.note },
    });
  });

  /** Restore purchase: re-reads the latest subscription from Razorpay when configured, otherwise from the database. */
  app.post('/api/account/restore', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const now = clock();
    let source: 'provider' | 'database' = 'database';
    const latest = await one<{ id: string; provider: string }>(
      pool,
      'SELECT id, provider FROM billing_subscriptions WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [a.id],
    );
    if (latest?.provider === 'cashfree' && config.cashfree) {
      const sub = toNeutralSubscription(await cashfree().fetchSubscription(latest.id));
      await withTransaction(pool, (c) => applySubscriptionState(c, sub, now, 'restore', 'cashfree'));
      source = 'provider';
    } else if (latest && latest.provider !== 'cashfree' && config.razorpay) {
      const sub = await client().fetchSubscription(latest.id);
      await withTransaction(pool, (c) => applySubscriptionState(c, sub, now, 'restore'));
      source = 'provider';
    }
    return { source, entitlements: await computeEntitlement(pool, a.id, now) };
  });

  app.post('/api/account/subscription/cancel', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    if (!config.razorpay && !config.cashfree) throw paymentsUnavailable();
    const ent = await one<{ provider_ref: string | null; channel: string | null; status: string }>(
      pool,
      'SELECT provider_ref, channel, status FROM entitlements WHERE account_id = $1',
      [a.id],
    );
    if (!ent || (ent.channel !== 'razorpay' && ent.channel !== 'cashfree') || !ent.provider_ref || ent.status !== 'active') {
      throw new AppError(400, 'no_active_subscription', 'There is no active subscription to cancel');
    }
    // Razorpay cancels at cycle end; Cashfree stops future charges at once. Either way Due keeps access until the paid period ends.
    if (ent.channel === 'cashfree') await cashfree().cancel(ent.provider_ref);
    else await client().cancelAtCycleEnd(ent.provider_ref);
    const now = clock();
    await withTransaction(pool, async (c) => {
      await c.query(`UPDATE entitlements SET status = 'cancelled', updated_at = $2 WHERE account_id = $1`, [a.id, now]);
      await consumerAudit(c, a.id, 'subscription.cancel_requested', 'entitlement', a.id, { status: 'active' }, { status: 'cancelled', atPeriodEnd: true }, now);
    });
    return { ok: true, entitlements: await computeEntitlement(pool, a.id, now) };
  });

  /**
   * Cashfree subscription webhooks: signature = base64(HMAC-SHA256(timestamp + rawBody)). Each distinct delivery is
   * applied once (billing_events), late events are ignored by event time, and entitlements change only from here,
   * the reconcile job or a status fetch, never from the browser.
   */
  app.post('/api/billing/webhook/cashfree', async (req, reply) => {
    if (!config.cashfree) throw paymentsUnavailable();
    const raw = req.rawBody ?? '';
    const sig = req.headers[CASHFREE.webhook.signatureHeader];
    const ts = req.headers[CASHFREE.webhook.timestampHeader];
    if (!verifyCashfreeSignature(config.cashfree.webhookSecret, typeof ts === 'string' ? ts : undefined, raw, typeof sig === 'string' ? sig : undefined, clock())) {
      metrics.inc('billing.webhook', { outcome: 'invalid_signature', provider: 'cashfree' });
      throw new AppError(400, 'invalid_signature', 'Webhook signature verification failed');
    }
    const ev = parseCashfreeEvent(req.body);
    const eventId = `cf:${sha256(`${ts}${raw}`)}`;
    const now = clock();
    const result = await withTransaction(pool, async (c) => {
      const ins = await c.query(
        `INSERT INTO billing_events (event_id, event, subscription_id, received_at, provider) VALUES ($1,$2,$3,$4,'cashfree') ON CONFLICT DO NOTHING`,
        [eventId, ev.type, ev.subscriptionId, now],
      );
      if (!ins.rowCount) return { duplicate: true, applied: false, outcome: 'duplicate' };
      const r = await applyCashfreeEvent(c, ev, now);
      await c.query('UPDATE billing_events SET outcome = $2 WHERE event_id = $1', [eventId, r.outcome]);
      return { duplicate: false, ...r };
    });
    metrics.inc('billing.webhook', { outcome: result.duplicate ? 'duplicate' : result.applied ? 'applied' : 'ignored', provider: 'cashfree' });
    return reply.code(200).send({ ok: true, duplicate: result.duplicate, applied: result.applied });
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
