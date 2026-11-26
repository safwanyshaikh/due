import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { workerDepsOf } from '../src/app.js';
import { CASHFREE } from '../src/consumer/cashfree.config.js';
import { computeCashfreeSignature, verifyCashfreeSignature } from '../src/consumer/cashfree.js';
import { computeEntitlement } from '../src/consumer/entitlements.js';
import { taxDisplay } from '../src/consumer/tax.js';
import type { Pool } from '../src/db.js';
import { enqueue, drainQueue } from '../src/queue/index.js';
import { freshDb, loggedIn, makeApp, RecordingMailer, signIn, silentLog, TestClock, type AppClient } from './helpers.js';

// Dummy values only. The adapter is exercised against a mocked HTTP layer, never the real Cashfree.
const CF = {
  BILLING_PROVIDER: 'cashfree',
  CASHFREE_APP_ID: 'TEST_APP_ID_DUMMY',
  CASHFREE_SECRET_KEY: 'cfsk_test_dummy_secret_0123456789',
  CASHFREE_ENV: 'sandbox',
};
const SECRET = CF.CASHFREE_SECRET_KEY;

let pool: Pool;
let app: FastifyInstance;
let mailer: RecordingMailer;
let calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[];
const clock = new TestClock(new Date('2026-12-01T10:00:00Z'));

const fetchImpl = (async (url: string, init: RequestInit) => {
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ url: String(url), method: String(init.method), headers: init.headers as Record<string, string>, body });
  if (String(url).endsWith('/subscriptions') && init.method === 'POST') {
    return new Response(JSON.stringify({ subscription_id: body.subscription_id, cf_subscription_id: '123', subscription_status: 'INITIALIZED', subscription_session_id: 'sess_dummy_1' }), { status: 200 });
  }
  if (String(url).endsWith('/manage')) return new Response(JSON.stringify({ subscription_status: 'CANCELLED' }), { status: 200 });
  const id = decodeURIComponent(String(url).split('/subscriptions/')[1] ?? '');
  return new Response(JSON.stringify({ subscription_id: id, subscription_status: 'ACTIVE' }), { status: 200 });
}) as unknown as typeof fetch;

beforeEach(async () => {
  await app?.close();
  await pool?.end();
  pool = await freshDb();
  clock.set('2026-12-01T10:00:00Z');
  calls = [];
  mailer = new RecordingMailer();
  app = await makeApp(pool, { clock, mailer, env: CF, fetchImpl });
  await pool.query(`UPDATE plans SET provider_plan_ids = '{"cashfree":{"monthly":"due_plus_monthly","yearly":"due_plus_yearly"}}' WHERE id = 'plus'`);
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

let seq = 0;
function webhook(type: string, data: Record<string, unknown>, eventTime = clock.now.toISOString(), secret = SECRET, ts = String(clock.now.getTime() + seq++)) {
  const raw = JSON.stringify({ type, event_time: eventTime, data });
  return {
    raw,
    send: (a: FastifyInstance = app) =>
      a.inject({
        method: 'POST',
        url: '/api/billing/webhook/cashfree',
        payload: raw,
        headers: {
          'content-type': 'application/json',
          'x-webhook-timestamp': ts,
          'x-webhook-signature': computeCashfreeSignature(secret, ts, raw),
        },
      }),
  };
}
const statusEvent = (id: string, status: string, at?: string) => webhook('SUBSCRIPTION_STATUS_CHANGED', { subscription_details: { subscription_id: id, subscription_status: status } }, at);
const paymentEvent = (id: string, payment_status: 'SUCCESS' | 'FAILED', at?: string, date = '2026-12-01T10:00:00Z') =>
  webhook('SUBSCRIPTION_PAYMENT_' + (payment_status === 'SUCCESS' ? 'SUCCESS' : 'FAILED'), { payment: { subscription_id: id, payment_status, payment_schedule_date: date } }, at);

async function checkout(c: AppClient) {
  const r = await c.post('/api/account/checkout', { plan: 'plus', billingPeriod: 'monthly', customerPhone: '9876543210' });
  expect(r.statusCode).toBe(201);
  return r.json().subscriptionId as string;
}
// Evaluated at the test clock without an HTTP session (account sessions idle out after 30 days).
const planNow = async (email: string) => {
  const id = (await pool.query('SELECT id FROM consumer_accounts WHERE email = $1', [email])).rows[0].id;
  return (await computeEntitlement(pool, id, clock.fn())).plan;
};
const ent = async (email: string) =>
  (await pool.query(`SELECT e.* FROM entitlements e JOIN consumer_accounts a ON a.id = e.account_id WHERE a.email = $1`, [email])).rows[0];

describe('provider selection', () => {
  it('defaults to razorpay; cashfree needs its credentials and its own plan ids', async () => {
    const def = await makeApp(pool, { clock, mailer });
    expect(def.deps.config.billingProvider).toBe('razorpay');
    expect((await def.inject({ method: 'GET', url: '/api/public/plans' })).json().purchaseChannel).toBeNull();
    await def.close();
    const plans = (await app.inject({ method: 'GET', url: '/api/public/plans' })).json();
    expect(plans.purchaseChannel).toBe('cashfree');
    expect(plans.paymentsAvailable).toBe(true);
    expect(plans.plans.find((p: { id: string }) => p.id === 'plus').checkoutAvailable).toEqual({ monthly: true, yearly: true });
    // Razorpay-style ids do not make a Cashfree checkout available.
    await pool.query(`UPDATE plans SET provider_plan_ids = '{"monthly":"plan_ABC12345"}' WHERE id = 'plus'`);
    const again = (await app.inject({ method: 'GET', url: '/api/public/plans' })).json();
    expect(again.plans.find((p: { id: string }) => p.id === 'plus').checkoutAvailable).toEqual({ monthly: false, yearly: false });
  });

  it('shows the active provider and per-provider plan ids in admin', async () => {
    const admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
    expect((await admin.patch('/api/admin/plans/plus', { providerPlanIds: { cashfree: { monthly: 'bad id!' } } })).statusCode).toBe(400);
    const r = await admin.patch('/api/admin/plans/plus', { providerPlanIds: { monthly: 'plan_RZP12345', cashfree: { monthly: 'due_plus_m2', yearly: null } } });
    expect(r.statusCode).toBe(200);
    expect(r.json().providerPlanIds).toEqual({ monthly: 'plan_RZP12345', cashfree: { monthly: 'due_plus_m2' } });
    const list = (await admin.get('/api/admin/plans')).json();
    expect(list).toMatchObject({ billingProvider: 'cashfree', paymentsConfigured: true, providers: { razorpay: { configured: false }, cashfree: { configured: true, env: 'sandbox' } } });
  });
});

describe('cashfree checkout', () => {
  it('calls Cashfree with versioned headers and the plan id only, and never unlocks Plus from checkout', async () => {
    const c = await signIn(app, mailer, 'a@example.com');
    expect((await c.post('/api/account/checkout', { plan: 'plus', billingPeriod: 'monthly' })).json().error.code).toBe('phone_required');
    expect((await c.post('/api/account/checkout', { plan: 'plus', billingPeriod: 'monthly', amountInr: 1, customerPhone: '9876543210' })).statusCode).toBe(400);
    const id = await checkout(c);
    const call = calls.find((x) => x.method === 'POST')!;
    expect(call.url).toBe('https://sandbox.cashfree.com/pg/subscriptions');
    expect(call.headers).toMatchObject({ 'x-client-id': CF.CASHFREE_APP_ID, 'x-api-version': CASHFREE.apiVersion });
    expect(call.body).toMatchObject({ subscription_id: id, plan_details: { plan_id: 'due_plus_monthly' }, customer_details: { customer_email: 'a@example.com' } });
    expect(JSON.stringify(call.body)).not.toMatch(/plan_recurring_amount|"amount"/);
    expect((await pool.query('SELECT provider, status FROM billing_subscriptions WHERE id = $1', [id])).rows[0]).toEqual({ provider: 'cashfree', status: 'created' });
    expect(await ent('a@example.com')).toBeUndefined();
    expect((await c.get('/api/account/entitlements')).json().plan).toBe('free');
  });
});

describe('cashfree webhooks', () => {
  it('verifies signatures (valid, tampered, wrong secret, missing headers)', async () => {
    const t1 = String(clock.now.getTime());
    const t2 = String(clock.now.getTime() + 1);
    expect(verifyCashfreeSignature('s', t1, 'body', computeCashfreeSignature('s', t1, 'body'), clock.now)).toBe(true);
    expect(verifyCashfreeSignature('s', t2, 'body', computeCashfreeSignature('s', t1, 'body'), clock.now)).toBe(false);
    expect(verifyCashfreeSignature('s', '1', 'body', computeCashfreeSignature('s', '1', 'body'), clock.now)).toBe(false);
    expect(verifyCashfreeSignature('s', undefined, 'body', 'x')).toBe(false);
    const c = await signIn(app, mailer, 'a@example.com');
    const id = await checkout(c);
    const ok = statusEvent(id, 'ACTIVE');
    expect((await webhook('SUBSCRIPTION_STATUS_CHANGED', { subscription_details: { subscription_id: id, subscription_status: 'ACTIVE' } }, undefined, 'wrong-secret').send()).statusCode).toBe(400);
    const tampered = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook/cashfree',
      payload: ok.raw.replace('ACTIVE', 'CANCELLED'),
      headers: { 'content-type': 'application/json', 'x-webhook-timestamp': '1', 'x-webhook-signature': computeCashfreeSignature(SECRET, '1', ok.raw) },
    });
    expect(tampered.statusCode).toBe(400);
    // A correctly signed delivery outside the 5-minute window (replay) is refused.
    const oldTs = String(clock.now.getTime() - 6 * 60 * 1000);
    const replay = await app.inject({
      method: 'POST',
      url: '/api/billing/webhook/cashfree',
      payload: ok.raw,
      headers: { 'content-type': 'application/json', 'x-webhook-timestamp': oldTs, 'x-webhook-signature': computeCashfreeSignature(SECRET, oldTs, ok.raw) },
    });
    expect(replay.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/billing/webhook/cashfree', payload: ok.raw, headers: { 'content-type': 'application/json' } })).statusCode).toBe(400);
    expect(await ent('a@example.com')).toBeUndefined();
    expect((await ok.send()).json()).toMatchObject({ ok: true, applied: true });
  });

  it('activates from a verified event, is idempotent on replay, and ignores unknown subscriptions', async () => {
    const c = await signIn(app, mailer, 'a@example.com');
    const id = await checkout(c);
    const ev = statusEvent(id, 'ACTIVE');
    expect((await ev.send()).json()).toMatchObject({ duplicate: false, applied: true });
    const first = await ent('a@example.com');
    expect(first).toMatchObject({ plan: 'plus', status: 'active', channel: 'cashfree', provider_ref: id });
    expect(new Date(first.current_period_end).getTime()).toBeGreaterThan(clock.now.getTime());
    expect((await ev.send()).json()).toMatchObject({ duplicate: true, applied: false });
    expect(Number((await pool.query(`SELECT count(*) AS n FROM consumer_audit WHERE action = 'entitlement.webhook'`)).rows[0].n)).toBe(1);
    expect((await c.get('/api/account/entitlements')).json()).toMatchObject({ plan: 'plus', channel: 'cashfree' });
    expect((await statusEvent('due_not_ours', 'ACTIVE').send()).json().applied).toBe(false);
  });

  it('payment success sets the paid period; out-of-order and late events cannot revive or downgrade', async () => {
    const c = await signIn(app, mailer, 'a@example.com');
    const id = await checkout(c);
    await statusEvent(id, 'ACTIVE', '2026-12-01T10:00:00Z').send();
    await paymentEvent(id, 'SUCCESS', '2026-12-01T10:05:00Z', '2026-12-01T10:05:00Z').send();
    expect(new Date((await ent('a@example.com')).current_period_end).toISOString()).toBe('2027-01-01T10:05:00.000Z');
    // Older event arriving late is ignored.
    expect((await statusEvent(id, 'ON_HOLD', '2026-12-01T10:01:00Z').send()).json().applied).toBe(false);
    expect((await ent('a@example.com')).status).toBe('active');
    // Cancelled, then a stale ACTIVE snapshot (newer timestamp but ended subscription) must not revive it.
    await statusEvent(id, 'CANCELLED', '2026-12-02T10:00:00Z').send();
    expect((await ent('a@example.com')).status).toBe('cancelled');
    await statusEvent(id, 'ACTIVE', '2026-12-03T10:00:00Z').send();
    expect((await ent('a@example.com')).status).toBe('cancelled');
    // Access lasts to the end of the paid period, then stops.
    expect((await c.get('/api/account/entitlements')).json().plan).toBe('plus');
    clock.set('2027-01-02T00:00:00Z');
    expect(await planNow('a@example.com')).toBe('free');
  });

  it('a failed renewal keeps access for the grace period once, and a later success resets it', async () => {
    const c = await signIn(app, mailer, 'a@example.com');
    const id = await checkout(c);
    await paymentEvent(id, 'SUCCESS', '2026-12-01T10:00:00Z', '2026-12-01T10:00:00Z').send();
    await statusEvent(id, 'ACTIVE', '2026-12-01T10:01:00Z').send();
    // Renewal charge fails after the period ended.
    clock.set('2027-01-01T11:00:00Z');
    expect(await planNow('a@example.com')).toBe('free');
    await paymentEvent(id, 'FAILED', '2027-01-01T10:30:00Z').send();
    const graceEnd = new Date(clock.now.getTime() + CASHFREE.graceDays * 86_400_000).toISOString();
    expect(new Date((await ent('a@example.com')).current_period_end).toISOString()).toBe(graceEnd);
    expect((await ent('a@example.com')).status).toBe('active');
    expect(await planNow('a@example.com')).toBe('plus');
    // A second failure does not extend the grace.
    clock.set('2027-01-02T11:00:00Z');
    await paymentEvent(id, 'FAILED', '2027-01-02T10:30:00Z').send();
    expect(new Date((await ent('a@example.com')).current_period_end).toISOString()).toBe(graceEnd);
    // After the grace period access ends, even while the provider has the subscription ON_HOLD.
    await statusEvent(id, 'ON_HOLD', '2027-01-02T10:40:00Z').send();
    clock.set('2027-01-05T00:00:00Z');
    expect(await planNow('a@example.com')).toBe('free');
    // Payment recovers: paid again, grace reset.
    await paymentEvent(id, 'SUCCESS', '2027-01-05T10:00:00Z', '2027-01-05T10:00:00Z').send();
    expect((await pool.query('SELECT grace_until FROM billing_subscriptions WHERE id = $1', [id])).rows[0].grace_until).toBeNull();
    expect(await planNow('a@example.com')).toBe('plus');
  });

  it('cancel stops future charges at Cashfree but keeps access until the paid period ends', async () => {
    const c = await signIn(app, mailer, 'a@example.com');
    const id = await checkout(c);
    await paymentEvent(id, 'SUCCESS', '2026-12-01T10:00:00Z', '2026-12-01T10:00:00Z').send();
    await statusEvent(id, 'ACTIVE', '2026-12-01T10:01:00Z').send();
    const r = await c.post('/api/account/subscription/cancel');
    expect(r.statusCode).toBe(200);
    const manage = calls.find((x) => x.url.endsWith('/manage'))!;
    expect(manage.body).toEqual({ subscription_id: id, action: 'CANCEL' });
    expect(r.json().entitlements).toMatchObject({ plan: 'plus', status: 'cancelled', channel: 'cashfree' });
    await statusEvent(id, 'CANCELLED', '2026-12-01T10:05:00Z').send();
    expect((await ent('a@example.com')).status).toBe('cancelled');
    expect((await c.get('/api/account/entitlements')).json().plan).toBe('plus');
  });

  it('billing.reconcile re-reads Cashfree subscriptions and applies the provider state', async () => {
    const c = await signIn(app, mailer, 'a@example.com');
    const id = await checkout(c);
    await paymentEvent(id, 'SUCCESS', '2026-12-01T10:00:00Z', '2026-12-01T10:00:00Z').send();
    calls.length = 0;
    const recFetch = (async (url: string) => {
      calls.push({ url: String(url), method: 'GET', headers: {}, body: undefined });
      return new Response(JSON.stringify({ subscription_id: id, subscription_status: 'COMPLETED' }), { status: 200 });
    }) as unknown as typeof fetch;
    await enqueue(pool, { type: 'billing.reconcile', now: clock.now });
    await drainQueue({ ...workerDepsOf(app), log: silentLog, fetchImpl: recFetch });
    expect(calls.map((x) => x.url)).toEqual([`https://sandbox.cashfree.com/pg/subscriptions/${id}`]);
    expect((await ent('a@example.com')).status).toBe('expired');
  });
});

describe('GST wording and invoices', () => {
  const base = { 'billing.tax_note': null, 'billing.prices_include_tax': true, 'billing.gst_registered': false, 'billing.gstin': null } as const;
  it('unregistered: no GST charged or shown, invoice says so', () => {
    const t = taxDisplay(base);
    expect(t).toMatchObject({ gstRegistered: false, gstin: null, pricesIncludeTax: false, invoiceLines: ['Not registered under GST'] });
    expect(t.note).not.toMatch(/18%/);
  });
  it('registered with GSTIN: incl. 18% GST wording and GSTIN on invoices; registered without GSTIN stays unregistered', () => {
    const t = taxDisplay({ ...base, 'billing.gst_registered': true, 'billing.gstin': '27AAAAA0000A1Z2' });
    expect(t).toMatchObject({ gstRegistered: true, note: 'Prices include 18% GST.', invoiceLines: ['GSTIN: 27AAAAA0000A1Z2', 'Prices include 18% GST.'] });
    expect(taxDisplay({ ...base, 'billing.gst_registered': true }).gstRegistered).toBe(false);
  });
  it('GSTIN validation checks format and checksum (made-up GSTIN only)', async () => {
    const { isValidGstin, gstinCheckChar } = await import('../src/consumer/gstin.js');
    expect(gstinCheckChar('27AAAAA0000A1Z')).toBe('2');
    expect(isValidGstin('27AAAAA0000A1Z2')).toBe(true);
    expect(isValidGstin('27AAAAA0000A1Z3')).toBe(false); // wrong check character
    expect(isValidGstin('99AAAAA0000A1Z2')).toBe(false); // state code
    expect(isValidGstin('27AAAAA0000A1Y2')).toBe(false); // 14th char must be Z
    expect(isValidGstin('27AAAAA0000A1Z')).toBe(false); // length
  });

  it('settings validate the GSTIN and checkout carries the tax block', async () => {
    const admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
    expect((await admin.patch('/api/admin/settings', { key: 'billing.gstin', value: 'NOT-A-GSTIN' })).statusCode).toBe(400);
    expect((await admin.patch('/api/admin/settings', { key: 'billing.gst_registered', value: 'yes' })).statusCode).toBe(400);
    const c = await signIn(app, mailer, 'a@example.com');
    const r = await c.post('/api/account/checkout', { plan: 'plus', billingPeriod: 'monthly', customerPhone: '9876543210' });
    expect(r.json().tax).toMatchObject({ gstRegistered: false, gstin: null });
  });
});
