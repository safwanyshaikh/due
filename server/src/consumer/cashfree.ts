import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db.js';
import { one } from '../db.js';
import { AppError } from '../http/errors.js';
import { consumerAudit } from './context.js';
import { CASHFREE } from './cashfree.config.js';
import type { BillingPeriod } from './entitlements.js';
import { applySubscriptionState, type RazorpaySubscription } from './razorpay.js';

export interface CashfreeCredentials {
  appId: string;
  secretKey: string;
  webhookSecret: string;
  env: 'sandbox' | 'production';
}

/** base64(HMAC-SHA256(timestamp + rawBody)) keyed with the webhook secret, as Cashfree documents for PG webhooks. */
export function computeCashfreeSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(timestamp + rawBody, 'utf8').digest('base64');
}

export function verifyCashfreeSignature(secret: string, timestamp: string | undefined, rawBody: string, signature: string | undefined): boolean {
  if (!timestamp || !signature) return false;
  const expected = Buffer.from(computeCashfreeSignature(secret, timestamp, rawBody));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const unavailable = (message = 'Payments are not available yet') => new AppError(503, 'payments_unavailable', message);

export interface CashfreeSubscription {
  subscription_id: string;
  cf_subscription_id?: string;
  subscription_status: string;
  subscription_session_id?: string;
  subscription_payment_link?: string;
  authorisation_details?: { authorization_link?: string };
}

/** Thin Cashfree Subscriptions client (real network calls through an injectable fetch; never faked in production). */
export class CashfreeClient {
  constructor(
    private readonly creds: CashfreeCredentials,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${CASHFREE.baseUrl[this.creds.env]}${path}`, {
        method,
        headers: {
          'x-client-id': this.creds.appId,
          'x-client-secret': this.creds.secretKey,
          'x-api-version': CASHFREE.apiVersion,
          'content-type': 'application/json',
        },
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
        const j = JSON.parse(text) as { message?: string };
        if (j.message) reason = j.message;
      } catch {
        /* keep status */
      }
      throw new AppError(502, 'payment_provider_error', `Payment provider rejected the request: ${reason}`);
    }
    return JSON.parse(text) as T;
  }

  /** The plan (and so the price) is fixed at Cashfree; the client of Due never supplies an amount. */
  createSubscription(input: {
    subscriptionId: string;
    planId: string;
    customer: { name: string; email: string; phone: string };
    returnUrl: string;
    billingPeriod: BillingPeriod;
    tags: Record<string, string>;
  }): Promise<CashfreeSubscription> {
    return this.call('POST', CASHFREE.paths.createSubscription, {
      subscription_id: input.subscriptionId,
      customer_details: { customer_name: input.customer.name, customer_email: input.customer.email, customer_phone: input.customer.phone },
      plan_details: { plan_id: input.planId },
      authorization_details: {
        authorization_amount: CASHFREE.authorizationAmountInr,
        authorization_amount_refund: true,
        payment_methods: ['upi', 'card', 'enach'],
      },
      subscription_meta: { return_url: input.returnUrl },
      subscription_tags: input.tags,
    });
  }

  fetchSubscription(id: string): Promise<CashfreeSubscription> {
    return this.call('GET', CASHFREE.paths.fetchSubscription(id));
  }

  /** Cashfree cancels immediately and stops future charges; Due keeps access until the paid period ends. */
  cancel(id: string): Promise<unknown> {
    return this.call('POST', CASHFREE.paths.manageSubscription(id), { subscription_id: id, action: 'CANCEL' });
  }

  hostedCheckoutUrl(sub: CashfreeSubscription): string | null {
    const link = sub.subscription_payment_link ?? sub.authorisation_details?.authorization_link;
    if (link) return link;
    return sub.subscription_session_id ? `${CASHFREE.hostedCheckout[this.creds.env]}${encodeURIComponent(sub.subscription_session_id)}` : null;
  }
}

export function newCashfreeSubscriptionId(): string {
  return `due_${randomBytes(12).toString('hex')}`;
}

/** Provider status -> Due's neutral status vocabulary (shared with Razorpay's). Unknown states change nothing. */
export function normaliseCashfreeStatus(status: string | undefined): string {
  return (status && CASHFREE.statusMap[status.toUpperCase()]) || 'pending';
}

/** Neutral snapshot of a fetched subscription, shaped for applySubscriptionState. */
export function toNeutralSubscription(sub: CashfreeSubscription): RazorpaySubscription {
  return { id: sub.subscription_id, status: normaliseCashfreeStatus(sub.subscription_status) };
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export interface CashfreeEvent {
  type: string;
  eventTime: Date | null;
  subscriptionId: string | null;
  status: string | null;
  paymentStatus: string | null;
  paymentDate: Date | null;
}

/** Tolerant parse of a Cashfree subscription webhook body (envelope { type, event_time, data }). */
export function parseCashfreeEvent(body: unknown): CashfreeEvent {
  const b = obj(body);
  const data = obj(b.data);
  const details = obj(data.subscription_details);
  const payment = obj(data.payment ?? data.payment_details);
  const date = (v: unknown) => {
    const s = str(v);
    const d = s ? new Date(s) : null;
    return d && !Number.isNaN(d.getTime()) ? d : null;
  };
  return {
    type: str(b.type) ?? 'unknown',
    eventTime: date(b.event_time),
    subscriptionId: str(details.subscription_id) ?? str(data.subscription_id) ?? str(payment.subscription_id),
    status: str(details.subscription_status) ?? str(data.subscription_status),
    paymentStatus: (str(payment.payment_status) ?? str(data.payment_status))?.toUpperCase() ?? null,
    paymentDate: date(payment.payment_schedule_date ?? data.payment_schedule_date ?? payment.payment_initiated_date ?? data.payment_initiated_date),
  };
}

function addPeriod(from: Date, period: BillingPeriod): Date {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (period === 'yearly' ? 12 : 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/**
 * Applies one verified Cashfree event (idempotency is the caller's billing_events insert). Only subscriptions Due
 * created at checkout are ever touched. Late events are ignored by event time; a late snapshot never revives an ended
 * subscription (applySubscriptionState). A failed renewal keeps access for CASHFREE.graceDays, once per failure streak.
 */
export async function applyCashfreeEvent(q: Queryable, ev: CashfreeEvent, now: Date): Promise<{ applied: boolean; outcome: string }> {
  if (!ev.subscriptionId) return { applied: false, outcome: 'no_subscription' };
  const sub = await one<{ account_id: string | null; billing_period: BillingPeriod; provider: string; last_event_at: Date | null; grace_until: Date | null }>(
    q,
    'SELECT account_id, billing_period, provider, last_event_at, grace_until FROM billing_subscriptions WHERE id = $1 FOR UPDATE',
    [ev.subscriptionId],
  );
  if (!sub || sub.provider !== 'cashfree' || !sub.account_id) return { applied: false, outcome: 'unknown_subscription' };
  const at = ev.eventTime ?? now;
  if (sub.last_event_at && at.getTime() < sub.last_event_at.getTime()) return { applied: false, outcome: 'stale' };
  await q.query('UPDATE billing_subscriptions SET last_event_at = $2 WHERE id = $1', [ev.subscriptionId, at]);

  const isPayment = ev.type.includes('PAYMENT') && ev.paymentStatus !== null;
  if (isPayment && ev.paymentStatus === 'FAILED') {
    if (sub.grace_until) return { applied: false, outcome: 'grace_already_granted' };
    const grace = new Date(now.getTime() + CASHFREE.graceDays * 86_400_000);
    const ent = await one<{ current_period_end: Date | null; provider_ref: string | null; status: string }>(
      q,
      'SELECT current_period_end, provider_ref, status FROM entitlements WHERE account_id = $1 FOR UPDATE',
      [sub.account_id],
    );
    await q.query('UPDATE billing_subscriptions SET grace_until = $2 WHERE id = $1', [ev.subscriptionId, grace]);
    if (!ent || ent.provider_ref !== ev.subscriptionId || ent.status === 'expired') return { applied: false, outcome: 'payment_failed_no_access' };
    const end = ent.current_period_end && ent.current_period_end > grace ? ent.current_period_end : grace;
    await q.query('UPDATE entitlements SET current_period_end = $2, updated_at = $3 WHERE account_id = $1', [sub.account_id, end, now]);
    await consumerAudit(q, sub.account_id, 'entitlement.payment_failed_grace', 'entitlement', sub.account_id, { currentPeriodEnd: ent.current_period_end }, { currentPeriodEnd: end, graceDays: CASHFREE.graceDays }, now);
    return { applied: true, outcome: 'grace_granted' };
  }
  if (isPayment && ev.paymentStatus !== 'SUCCESS') return { applied: false, outcome: 'payment_ignored' };

  let status: string;
  let end: Date | null = null;
  if (isPayment) {
    status = 'active';
    end = addPeriod(ev.paymentDate ?? at, sub.billing_period);
    await q.query('UPDATE billing_subscriptions SET grace_until = NULL WHERE id = $1', [ev.subscriptionId]);
  } else if (ev.status) {
    status = normaliseCashfreeStatus(ev.status);
    if (status === 'active') {
      // Authorised but nothing charged yet: grant one paid period from activation unless a later end is known.
      const ent = await one<{ current_period_end: Date | null }>(q, 'SELECT current_period_end FROM entitlements WHERE account_id = $1', [sub.account_id]);
      end = ent?.current_period_end && ent.current_period_end > now ? ent.current_period_end : addPeriod(now, sub.billing_period);
    }
  } else {
    return { applied: false, outcome: 'ignored' };
  }
  const r = await applySubscriptionState(q, { id: ev.subscriptionId, status, current_end: end ? Math.floor(end.getTime() / 1000) : null }, now, 'webhook', 'cashfree');
  return { applied: r.applied, outcome: r.applied ? 'applied' : 'no_change' };
}

export { unavailable as cashfreeUnavailable };
