import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { computeWebhookSignature } from '../src/consumer/razorpay.js';
import { inQuietHours } from '../src/consumer/reminders.js';
import type { Pool } from '../src/db.js';
import { startJob } from '../src/jobs/runner.js';
import { buildApp, loggerOptions } from '../src/app.js';
import { AppClient, grantPlan, loggedIn, makeApp, monitorCtx, RecordingMailer, signIn, TestClock, freshDb, testConfig } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;
let mailer: RecordingMailer;
const clock = new TestClock(new Date('2026-10-30T10:00:00Z'));
const RZP = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec_test_0123456789',
};

beforeEach(async () => {
  await app?.close();
  await pool?.end();
  pool = await freshDb();
  clock.set('2026-10-30T10:00:00Z');
  mailer = new RecordingMailer();
  app = await makeApp(pool, { clock, mailer });
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const n = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);

describe('magic link sign-in', () => {
  it('sends a single-use link that opens a session and creates the account', async () => {
    const c = new AppClient(app);
    const r = await c.post('/api/account/magic-link', { email: 'Asha@Example.com' });
    expect(r.statusCode).toBe(202);
    expect(r.json().ok).toBe(true);
    expect(mailer.last().to).toEqual(['asha@example.com']);
    expect(mailer.last().text).toContain('/api/account/verify?token=');
    const token = mailer.lastToken();
    // Token stored only as a hash.
    expect(await n('SELECT count(*) AS n FROM magic_links WHERE token_hash = $1', [token])).toBe(0);

    const v = await c.post('/api/account/verify', { token });
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ created: true, account: { email: 'asha@example.com' }, entitlements: { plan: 'free' } });
    expect(v.headers['set-cookie']).toMatch(/due_acct=.*HttpOnly/i);
    expect(v.headers['set-cookie']).toMatch(/SameSite=Lax/i);
    expect((await c.get('/api/account/me')).json().account.email).toBe('asha@example.com');

    // Second use fails, with a fresh client.
    const again = await new AppClient(app).post('/api/account/verify', { token });
    expect(again.statusCode).toBe(400);
    expect(again.json().error.code).toBe('invalid_token');
  });

  it('expires after 15 minutes', async () => {
    const c = new AppClient(app);
    await c.post('/api/account/magic-link', { email: 'b@example.com' });
    const token = mailer.lastToken();
    clock.advanceMinutes(16);
    const v = await c.post('/api/account/verify', { token });
    expect(v.statusCode).toBe(400);
    expect(c.cookies.due_acct).toBeUndefined();
  });

  it('GET verify (the e-mailed link) never consumes the token; it redirects to the app to confirm, and POST consumes once', async () => {
    const c = new AppClient(app);
    await c.post('/api/account/magic-link', { email: 'g@example.com' });
    const token = mailer.lastToken();
    // Link scanners may open the link any number of times: no session, token still unused.
    for (let i = 0; i < 3; i++) {
      const r = await new AppClient(app).get(`/api/account/verify?token=${token}`);
      expect(r.statusCode).toBe(303);
      expect(r.headers.location).toBe(`/?account=confirm&token=${token}`);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.cookies.find((k) => k.name === 'due_acct')).toBeUndefined();
    }
    expect(await n('SELECT count(*) AS n FROM magic_links WHERE used_at IS NOT NULL')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM consumer_accounts')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM consumer_sessions')).toBe(0);

    // The app's "Confirm sign-in on this device" button POSTs the token: it works once.
    const ok = await c.post('/api/account/verify', { token, deviceLabel: 'Chrome on Android' });
    expect(ok.statusCode).toBe(200);
    expect(c.cookies.due_acct).toBeTruthy();
    expect((await c.get('/api/account/sessions')).json().items[0].deviceLabel).toBe('Chrome on Android');
    expect((await new AppClient(app).post('/api/account/verify', { token })).statusCode).toBe(400);
    expect(await n('SELECT count(*) AS n FROM magic_links WHERE used_at IS NOT NULL')).toBe(1);
    // After use the e-mailed link reports an invalid link rather than offering confirmation again.
    expect((await new AppClient(app).get(`/api/account/verify?token=${token}`)).headers.location).toBe('/?account=link-invalid');

    const bad = await new AppClient(app).get(`/api/account/verify?token=${'x'.repeat(30)}`);
    expect(bad.statusCode).toBe(303);
    expect(bad.headers.location).toBe('/?account=link-invalid');
    expect(bad.cookies.find((k) => k.name === 'due_acct')).toBeUndefined();
    expect((await new AppClient(app).get('/api/account/verify?token=%3Cscript%3E')).headers.location).toBe('/?account=link-invalid');
  });

  it('rate-limits per IP + email', async () => {
    const c = new AppClient(app);
    for (let i = 0; i < 5; i++) expect((await c.post('/api/account/magic-link', { email: 'r@example.com' })).statusCode).toBe(202);
    const limited = await c.post('/api/account/magic-link', { email: 'r@example.com' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect(await n(`SELECT count(*) AS n FROM magic_links WHERE email = 'r@example.com'`)).toBe(5);
    // Another address from the same IP is unaffected.
    expect((await c.post('/api/account/magic-link', { email: 'other@example.com' })).statusCode).toBe(202);
    clock.advanceMinutes(16);
    expect((await c.post('/api/account/magic-link', { email: 'r@example.com' })).statusCode).toBe(202);
  });

  it('request logs never contain the magic-link token', async () => {
    const lines: string[] = [];
    const stream = { write: (l: string) => void lines.push(l) };
    const app2 = await buildApp({ pool, config: testConfig(), clock: clock.fn, mailer, logger: { ...loggerOptions(true), stream } });
    await app2.ready();
    try {
      await new AppClient(app2).post('/api/account/magic-link', { email: 'logs@example.com' });
      const token = mailer.lastToken();
      await app2.inject({ method: 'GET', url: `/api/account/verify?token=${token}` });
      await app2.inject({ method: 'GET', url: `/?household_invite=${token}` });
      // The app's confirmation screen URL (the GET verify redirect target) carries the token too.
      await app2.inject({ method: 'GET', url: `/?account=confirm&token=${token}` });
      const out = lines.join('');
      expect(out).toContain('/api/account/verify?token=[redacted]');
      expect(out).toContain('/?account=confirm&token=[redacted]');
      expect(out).not.toContain(token);
    } finally {
      await app2.close();
    }
  });

  it('never builds e-mailed links from request headers in production (host-header poisoning)', async () => {
    const config = { ...testConfig(), isProduction: true, publicBaseUrl: null, trustProxy: true };
    const app2 = await buildApp({ pool, config, clock: clock.fn, mailer, logger: false });
    await app2.ready();
    try {
      const r = await app2.inject({
        method: 'POST',
        url: '/api/account/magic-link',
        payload: { email: 'victim@example.com' },
        headers: { 'x-requested-with': 'due-app', host: 'evil.example', 'x-forwarded-host': 'evil.example' },
      });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe('email_unavailable');
      expect(mailer.sent).toHaveLength(0);
      expect(await n(`SELECT count(*) AS n FROM magic_links`)).toBe(0);
    } finally {
      await app2.close();
    }
  });

  it('returns 503 email_unavailable without SMTP and never creates a link or session', async () => {
    const app2 = await makeApp(pool, { clock, mailer: null });
    const c = new AppClient(app2);
    const r = await c.post('/api/account/magic-link', { email: 'x@example.com' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('email_unavailable');
    expect(await n('SELECT count(*) AS n FROM magic_links')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM consumer_sessions')).toBe(0);
    expect(c.cookies.due_acct).toBeUndefined();
    await app2.close();
  });

  it('reports a send failure instead of pretending', async () => {
    mailer.fail = true;
    const r = await new AppClient(app).post('/api/account/magic-link', { email: 'f@example.com' });
    expect(r.statusCode).toBe(502);
    expect(await n('SELECT count(*) AS n FROM magic_links')).toBe(0);
  });

  it('requires X-Requested-With: due-app on account mutations', async () => {
    const r = await new AppClient(app, false).post('/api/account/magic-link', { email: 'c@example.com' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('csrf_rejected');
    const adminHeader = await new AppClient(app).req('POST', '/api/account/magic-link', { email: 'c@example.com' }, { 'x-requested-with': 'due-admin' });
    expect(adminHeader.statusCode).toBe(403);
  });
});

describe('sessions and devices', () => {
  it('lists devices, revokes one, and logs out everywhere', async () => {
    const phone = await signIn(app, mailer, 'dev@example.com');
    const laptop = await signIn(app, mailer, 'dev@example.com');
    const list = (await laptop.get('/api/account/sessions')).json().items;
    expect(list).toHaveLength(2);
    const phoneId = (await phone.get('/api/account/me')).json().sessionId;
    expect(list.find((s: { id: string }) => s.id === phoneId).current).toBe(false);

    const rev = await laptop.post(`/api/account/sessions/${phoneId}/revoke`);
    expect(rev.statusCode).toBe(200);
    expect((await phone.get('/api/account/me')).statusCode).toBe(401);
    expect((await laptop.get('/api/account/me')).statusCode).toBe(200);
    // Another account cannot revoke this account's sessions.
    const other = await signIn(app, mailer, 'other@example.com');
    const laptopId = (await laptop.get('/api/account/me')).json().sessionId;
    expect((await other.post(`/api/account/sessions/${laptopId}/revoke`)).statusCode).toBe(404);

    const all = await laptop.post('/api/account/logout-all');
    expect(all.json().revoked).toBe(1);
    expect((await laptop.get('/api/account/me')).statusCode).toBe(401);
    expect(await n(`SELECT count(*) AS n FROM consumer_audit WHERE action = 'session.revoked'`)).toBe(1);
  });

  it('expires after 30 idle days', async () => {
    const c = await signIn(app, mailer, 'idle@example.com');
    clock.advanceMinutes(29 * 1440);
    expect((await c.get('/api/account/me')).statusCode).toBe(200);
    clock.advanceMinutes(31 * 1440);
    expect((await c.get('/api/account/me')).statusCode).toBe(401);
  });
});

describe('backup and sync', () => {
  it('uses optimistic concurrency and returns the server copy on conflict', async () => {
    const a = await signIn(app, mailer, 'sync@example.com');
    const b = await signIn(app, mailer, 'sync@example.com');
    expect((await a.get('/api/account/data')).json()).toEqual({ version: 0, data: null, updatedAt: null });
    const w1 = await a.put('/api/account/data', { baseVersion: 0, data: { items: [1] } });
    expect(w1.statusCode).toBe(200);
    expect(w1.json().version).toBe(1);
    const stale = await b.put('/api/account/data', { baseVersion: 0, data: { items: [2] } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('version_conflict');
    expect(stale.json().error.details.server).toMatchObject({ version: 1, data: { items: [1] } });
    expect((await b.put('/api/account/data', { baseVersion: 1, data: { items: [1, 2] } })).json().version).toBe(2);
    expect((await a.get('/api/account/data')).json()).toMatchObject({ version: 2, data: { items: [1, 2] } });
    expect(await n(`SELECT count(*) AS n FROM consumer_audit WHERE action = 'data.updated'`)).toBe(2);
  });

  it('rejects non-objects, oversize documents and anonymous access', async () => {
    const a = await signIn(app, mailer, 'v@example.com');
    expect((await a.put('/api/account/data', { baseVersion: 0, data: [1, 2] })).statusCode).toBe(400);
    const big = await a.put('/api/account/data', { baseVersion: 0, data: { blob: 'x'.repeat(2 * 1024 * 1024 + 10) } });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('payload_too_large');
    expect((await new AppClient(app).get('/api/account/data')).statusCode).toBe(401);
  });
});

const offerHousehold = () => pool.query(`UPDATE plans SET active = true WHERE id = 'household'`);

describe('entitlements and household sharing', () => {
  it('household is not sold by default: hidden from public plans, checkout refused, sharing routes closed', async () => {
    expect((await pool.query(`SELECT active FROM plans WHERE id = 'household'`)).rows[0].active).toBe(false);
    const plans = (await app.inject({ method: 'GET', url: '/api/public/plans' })).json();
    expect(plans.plans.map((p: { id: string }) => p.id)).toEqual(['free', 'plus']);

    const app2 = await makeApp(pool, { clock, mailer, env: RZP });
    await pool.query(`UPDATE plans SET provider_plan_ids = '{"monthly":"plan_HH12345678"}' WHERE id = 'household'`);
    const c = await signIn(app2, mailer, 'hh@example.com');
    const r = await c.post('/api/account/checkout', { plan: 'household', billingPeriod: 'monthly' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('plan_unavailable');
    expect(await n('SELECT count(*) AS n FROM billing_subscriptions')).toBe(0);
    await app2.close();

    // Even a manually granted household entitlement does not unlock sharing while the plan is inactive.
    const owner = await signIn(app, mailer, 'manual-hh@example.com');
    await grantPlan(pool, 'manual-hh@example.com', 'household');
    expect((await owner.get('/api/account/entitlements')).json().features).not.toContain('household_sharing');
    for (const [m, u] of [
      ['GET', '/api/account/household'],
      ['POST', '/api/account/household'],
      ['POST', '/api/account/household/invites'],
      ['POST', '/api/account/household/accept'],
      ['GET', '/api/account/household/data'],
    ] as const) {
      const res = await owner.req(m, u, m === 'GET' ? undefined : { name: 'Home', email: 'x@example.com', token: 'x'.repeat(20) });
      expect(res.statusCode, `${m} ${u}`).toBe(403);
      expect(res.json().error.code).toBe('plan_unavailable');
    }
    expect((await new AppClient(app).get('/api/account/household')).statusCode).toBe(401);
  });

  it('blocks Free users from household endpoints with premium_required', async () => {
    await offerHousehold();
    const free = await signIn(app, mailer, 'free@example.com');
    const ent = (await free.get('/api/account/entitlements')).json();
    expect(ent).toMatchObject({ plan: 'free', status: 'active' });
    expect(ent.features).toContain('backup');
    expect(ent.features).not.toContain('household_sharing');
    for (const [m, u] of [
      ['GET', '/api/account/household'],
      ['POST', '/api/account/household'],
      ['POST', '/api/account/household/invites'],
      ['GET', '/api/account/household/data'],
    ] as const) {
      const r = await free.req(m, u, m === 'GET' ? undefined : { name: 'Home', email: 'x@example.com' });
      expect(r.statusCode, `${m} ${u}`).toBe(402);
      expect(r.json().error.code).toBe('premium_required');
    }
    // Plus does not include household sharing either.
    await grantPlan(pool, 'free@example.com', 'plus');
    expect((await free.get('/api/account/household')).statusCode).toBe(402);
    expect((await free.get('/api/account/entitlements')).json().features).toContain('reminder_email');
  });

  it('owner creates a household, invites, member accepts and both share versioned data; access ends with the plan', async () => {
    await offerHousehold();
    const owner = await signIn(app, mailer, 'owner@example.com');
    await grantPlan(pool, 'owner@example.com', 'household', new Date('2026-11-15T00:00:00Z'));
    expect((await owner.post('/api/account/household', { name: 'Home' })).statusCode).toBe(201);
    const inv = await owner.post('/api/account/household/invites', { email: 'Member@Example.com' });
    expect(inv.statusCode).toBe(201);
    const token = mailer.lastToken('household_invite');

    const wrong = await signIn(app, mailer, 'wrong@example.com');
    expect((await wrong.post('/api/account/household/accept', { token })).json().error.code).toBe('invite_email_mismatch');
    const member = await signIn(app, mailer, 'member@example.com');
    const acc = await member.post('/api/account/household/accept', { token });
    expect(acc.statusCode).toBe(200);
    expect((await member.post('/api/account/household/accept', { token })).statusCode).toBe(400);

    const view = (await owner.get('/api/account/household')).json();
    expect(view.members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([
      ['owner@example.com', 'owner'],
      ['member@example.com', 'member'],
    ]);
    expect((await member.put('/api/account/household/data', { baseVersion: 0, data: { shared: true } })).json().version).toBe(1);
    expect((await owner.put('/api/account/household/data', { baseVersion: 0, data: {} })).statusCode).toBe(409);
    expect((await owner.get('/api/account/household/data')).json().data).toEqual({ shared: true });

    clock.set('2026-11-16T00:00:00Z');
    expect((await member.get('/api/account/household/data')).statusCode).toBe(402);
    expect((await owner.get('/api/account/entitlements')).json()).toMatchObject({ plan: 'free', status: 'expired' });
    // Owner can still remove the member after the plan lapses.
    const memberId = view.members[1].accountId;
    expect((await owner.del(`/api/account/household/members/${memberId}`)).statusCode).toBe(200);
  });
});

describe('payments', () => {
  it('checkout, restore-with-provider and cancel are unavailable without Razorpay configuration', async () => {
    const c = await signIn(app, mailer, 'pay@example.com');
    const r = await c.post('/api/account/checkout', { plan: 'plus', billingPeriod: 'monthly' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('payments_unavailable');
    expect((await c.post('/api/account/subscription/cancel')).json().error.code).toBe('payments_unavailable');
    const restore = await c.post('/api/account/restore');
    expect(restore.json()).toMatchObject({ source: 'database', entitlements: { plan: 'free' } });
    const wh = await app.inject({ method: 'POST', url: '/api/billing/razorpay/webhook', payload: { event: 'subscription.activated' } });
    expect(wh.statusCode).toBe(503);
    expect(await n('SELECT count(*) AS n FROM entitlements')).toBe(0);
  });

  it('checkout without a billing period is rejected (no default to yearly) and needs plan ids even when keys exist', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: RZP });
    const c = await signIn(app2, mailer, 'p2@example.com');
    expect((await c.post('/api/account/checkout', { plan: 'plus' })).statusCode).toBe(400);
    const r = await c.post('/api/account/checkout', { plan: 'plus', billingPeriod: 'yearly' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('payments_unavailable');
    await app2.close();
  });

  it('webhook verifies the HMAC signature, applies entitlements idempotently and handles cancellation', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: RZP });
    const c = await signIn(app2, mailer, 'sub@example.com');
    const acct = (await c.get('/api/account/me')).json().account.id;
    await pool.query(`INSERT INTO billing_subscriptions (id, account_id, plan, billing_period, status) VALUES ('sub_TEST1', $1, 'plus', 'monthly', 'created')`, [acct]);
    const periodEnd = Math.floor(new Date('2026-11-20T10:00:00Z').getTime() / 1000);
    const send = (body: object, sig: string | null, eventId: string) => {
      const raw = JSON.stringify(body);
      return app2.inject({
        method: 'POST',
        url: '/api/billing/razorpay/webhook',
        payload: raw,
        headers: {
          'content-type': 'application/json',
          'x-razorpay-event-id': eventId,
          ...(sig === null ? {} : { 'x-razorpay-signature': sig === 'valid' ? computeWebhookSignature(RZP.RAZORPAY_WEBHOOK_SECRET, raw) : sig }),
        },
      });
    };
    const activated = { event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_TEST1', status: 'active', current_end: periodEnd } } } };

    const missing = await send(activated, null, 'evt_0');
    expect(missing.statusCode).toBe(400);
    const forged = await send(activated, computeWebhookSignature('wrong-secret', JSON.stringify(activated)), 'evt_0');
    expect(forged.statusCode).toBe(400);
    expect(forged.json().error.code).toBe('invalid_signature');
    expect((await c.get('/api/account/entitlements')).json().plan).toBe('free');

    const ok = await send(activated, 'valid', 'evt_1');
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, applied: true, duplicate: false });
    const ent = (await c.get('/api/account/entitlements')).json();
    expect(ent).toMatchObject({ plan: 'plus', status: 'active', billingPeriod: 'monthly', channel: 'razorpay', periodEnd: '2026-11-20T10:00:00.000Z' });
    expect((await send(activated, 'valid', 'evt_1')).json().duplicate).toBe(true);

    const cancelled = { event: 'subscription.cancelled', payload: { subscription: { entity: { id: 'sub_TEST1', status: 'cancelled', current_end: periodEnd } } } };
    expect((await send(cancelled, 'valid', 'evt_2')).json().applied).toBe(true);
    expect((await c.get('/api/account/entitlements')).json()).toMatchObject({ plan: 'plus', status: 'cancelled' });
    // A late, out-of-order 'active' snapshot never revives a cancelled subscription.
    const late = { event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_TEST1', status: 'active', current_end: periodEnd } } } };
    expect((await send(late, 'valid', 'evt_3')).json().applied).toBe(false);
    expect((await c.get('/api/account/entitlements')).json()).toMatchObject({ plan: 'plus', status: 'cancelled' });
    clock.set('2026-11-21T00:00:00Z');
    expect((await c.get('/api/account/entitlements')).json()).toMatchObject({ plan: 'free', status: 'expired' });
    expect(await n(`SELECT count(*) AS n FROM consumer_audit WHERE action = 'entitlement.webhook'`)).toBe(2);
    await app2.close();
  });

  it('cancel-at-period-end survives restore (the provider still reports the subscription as active)', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: RZP });
    const c = await signIn(app2, mailer, 'cancel@example.com');
    const acct = (await c.get('/api/account/me')).json().account.id;
    const periodEnd = Math.floor(new Date('2026-11-20T10:00:00Z').getTime() / 1000);
    await pool.query(`INSERT INTO billing_subscriptions (id, account_id, plan, billing_period, status) VALUES ('sub_C1', $1, 'plus', 'monthly', 'active')`, [acct]);
    await pool.query(
      `INSERT INTO entitlements (account_id, plan, billing_period, status, current_period_end, channel, provider_ref) VALUES ($1,'plus','monthly','active',$2,'razorpay','sub_C1')`,
      [acct, new Date(periodEnd * 1000)],
    );
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'sub_C1', status: 'active', current_end: periodEnd }), { status: 200 })) as typeof fetch;
    try {
      expect((await c.post('/api/account/subscription/cancel')).json().entitlements).toMatchObject({ plan: 'plus', status: 'cancelled' });
      const r = await c.post('/api/account/restore');
      expect(r.json()).toMatchObject({ source: 'provider', entitlements: { plan: 'plus', status: 'cancelled' } });
    } finally {
      globalThis.fetch = realFetch;
      await app2.close();
    }
  });

  it('public plans expose admin-editable prices and terms pending legal review', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/public/plans' });
    const body = r.json();
    expect(body.currency).toBe('INR');
    expect(body.plans.map((p: { id: string; priceInrMonthly: number | null; priceInrYearly: number | null }) => [p.id, p.priceInrMonthly, p.priceInrYearly])).toEqual([
      ['free', null, null],
      ['plus', 149, 1299],
    ]);
    expect(body.terms.legalReviewStatus).toBe('pending');
    expect(body.terms.refund).toMatch(/pending legal review/i);
    expect(body.paymentsAvailable).toBe(false);
    expect(body.cancellationPath).toBeTruthy();

    const admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
    const p = await admin.patch('/api/admin/plans/plus', { priceInrMonthly: 179, providerPlanIds: { monthly: 'plan_ABC123xyz' } });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ priceInrMonthly: 179, providerPlanIds: { monthly: 'plan_ABC123xyz' } });
    const editor = await loggedIn(app, pool, 'ed@example.com', 'editor');
    expect((await editor.patch('/api/admin/plans/plus', { priceInrMonthly: 1 })).statusCode).toBe(403);
    const terms = await admin.patch('/api/admin/settings', {
      key: 'billing_terms',
      value: { renewal: 'R', cancellation: 'C', refund: 'Refund within 7 days.', legal_review_status: 'reviewed' },
    });
    expect(terms.statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/api/public/plans' })).json();
    expect(after.plans.find((x: { id: string }) => x.id === 'plus').priceInrMonthly).toBe(179);
    expect(after.terms).toMatchObject({ refund: 'Refund within 7 days.', legalReviewStatus: 'reviewed' });
    expect((await admin.get('/api/admin/plans')).json().items).toHaveLength(3);
    // Activating a plan in the admin panel publishes it.
    expect((await admin.patch('/api/admin/plans/household', { active: true })).json()).toMatchObject({ active: true });
    const withHousehold = (await app.inject({ method: 'GET', url: '/api/public/plans' })).json();
    expect(withHousehold.plans.map((p: { id: string }) => p.id)).toEqual(['free', 'plus', 'household']);
  });

  it('blocks a second checkout while a plan is active or cancelled but still in its paid period', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: RZP });
    await pool.query(`UPDATE plans SET provider_plan_ids = '{"monthly":"plan_PLUS1234567"}' WHERE id = 'plus'`);
    const c = await signIn(app2, mailer, 'twice@example.com');
    const acct = (await c.get('/api/account/me')).json().account.id;
    await pool.query(
      `INSERT INTO entitlements (account_id, plan, billing_period, status, current_period_end, channel, provider_ref)
       VALUES ($1,'plus','monthly','active','2026-11-20T10:00:00Z','razorpay','sub_X1')`,
      [acct],
    );
    const checkout = () => c.post('/api/account/checkout', { plan: 'plus', billingPeriod: 'monthly' });
    let r = await checkout();
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('already_subscribed');
    await pool.query(`UPDATE entitlements SET status = 'cancelled' WHERE account_id = $1`, [acct]);
    r = await checkout();
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('already_subscribed');
    expect(r.json().error.message).toMatch(/end of the paid period/);
    // After the period ends checkout proceeds to the provider (stubbed here).
    clock.set('2026-11-21T00:00:00Z');
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 'sub_NEW1', status: 'created', short_url: 'https://rzp.io/i/x' }), { status: 200 })) as typeof fetch;
    try {
      r = await checkout();
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ subscriptionId: 'sub_NEW1', plan: 'plus' });
    } finally {
      globalThis.fetch = realFetch;
      await app2.close();
    }
  });

  it('manual (operator-granted) plans cannot be cancelled through the provider', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: RZP });
    const c = await signIn(app2, mailer, 'manual@example.com');
    await grantPlan(pool, 'manual@example.com', 'plus');
    expect((await c.get('/api/account/entitlements')).json()).toMatchObject({ plan: 'plus', channel: 'manual' });
    const r = await c.post('/api/account/subscription/cancel');
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('no_active_subscription');
    await app2.close();
  });
});

describe('reminder delivery worker', () => {
  const plan = (remindAt: string, extra: object = {}) => ({
    obligationRef: 'ob-1',
    title: 'Netflix',
    dueDate: '2026-11-02',
    remindAt,
    channel: 'email',
    timezone: 'Asia/Kolkata',
    quietHours: { start: '22:00', end: '07:00' },
    ...extra,
  });

  it('records unavailable for Free users, sends for entitled users, and defers during quiet hours', async () => {
    const c = await signIn(app, mailer, 'rem@example.com');
    const put = await c.put('/api/account/data', { baseVersion: 0, data: {}, reminders: [plan('2026-10-30T10:00:00Z')] });
    expect(put.json().reminders).toEqual({ stored: 1, emailDelivery: 'premium_required' });
    const ctx = { ...monitorCtx(pool, clock), mailer };
    const before = mailer.sent.length;
    let run = await (await startJob(ctx, 'consumer_reminders', 'manual'))!.done;
    expect(run.stats).toMatchObject({ due: 1, unavailable: 1, sent: 0 });
    expect(mailer.sent.length).toBe(before);
    const d = (await c.get('/api/account/reminders')).json();
    expect(d.deliveries[0]).toMatchObject({ status: 'unavailable', error: expect.stringContaining('premium_required') });

    await grantPlan(pool, 'rem@example.com', 'plus');
    // 17:00 UTC = 22:30 IST -> inside quiet hours.
    clock.set('2026-10-31T17:00:00Z');
    await c.put('/api/account/reminders', { items: [plan('2026-10-31T16:00:00Z', { obligationRef: 'ob-2' })] });
    run = await (await startJob(ctx, 'consumer_reminders', 'manual'))!.done;
    expect(run.stats).toMatchObject({ due: 1, deferred_quiet_hours: 1, sent: 0 });
    clock.set('2026-11-01T02:00:00Z'); // 07:30 IST
    run = await (await startJob(ctx, 'consumer_reminders', 'manual'))!.done;
    expect(run.stats).toMatchObject({ due: 1, sent: 1 });
    expect(mailer.last()).toMatchObject({ to: ['rem@example.com'], subject: 'Reminder: Netflix is due on 2026-11-02' });
    const sent = (await c.get('/api/account/reminders')).json().deliveries[0];
    expect(sent).toMatchObject({ status: 'sent', providerMessageId: expect.stringContaining('test-') });
    // Not delivered twice.
    run = await (await startJob(ctx, 'consumer_reminders', 'manual'))!.done;
    expect(run.stats.due).toBe(0);
  });

  it('records unavailable when SMTP is not configured', async () => {
    const c = await signIn(app, mailer, 'nosmtp@example.com');
    await grantPlan(pool, 'nosmtp@example.com', 'plus');
    await c.put('/api/account/reminders', { items: [plan('2026-10-30T09:00:00Z')] });
    const run = await (await startJob({ ...monitorCtx(pool, clock), mailer: null }, 'consumer_reminders', 'manual'))!.done;
    expect(run.stats.unavailable).toBe(1);
    const row = (await pool.query('SELECT status, error FROM reminder_deliveries')).rows[0];
    expect(row.status).toBe('unavailable');
    expect(row.error).toMatch(/SMTP/);
  });

  it('quiet-hour windows wrap midnight and respect the time zone', () => {
    expect(inQuietHours(new Date('2026-10-30T17:00:00Z'), 'Asia/Kolkata', '22:00', '07:00')).toBe(true); // 22:30
    expect(inQuietHours(new Date('2026-10-30T01:00:00Z'), 'Asia/Kolkata', '22:00', '07:00')).toBe(true); // 06:30
    expect(inQuietHours(new Date('2026-10-30T02:00:00Z'), 'Asia/Kolkata', '22:00', '07:00')).toBe(false); // 07:30
    expect(inQuietHours(new Date('2026-10-30T13:00:00Z'), 'Asia/Kolkata', '13:00', '14:00')).toBe(false); // 18:30
    expect(inQuietHours(new Date('2026-10-30T13:00:00Z'), 'UTC', '13:00', '14:00')).toBe(true);
    expect(inQuietHours(new Date(), 'UTC', null, null)).toBe(false);
  });
});

describe('consents take effect', () => {
  const consent = (c: AppClient, purpose: string, granted: boolean) =>
    c.post('/api/account/consents', { purpose, granted, textVersion: `${purpose}-2026-10` });

  it("withdrawn 'sync_backup' makes the server refuse uploads (403 consent_required) until granted again", async () => {
    const c = await signIn(app, mailer, 'consent-sync@example.com');
    expect((await c.put('/api/account/data', { baseVersion: 0, data: { a: 1 } })).statusCode).toBe(200);
    expect((await consent(c, 'sync_backup', false)).statusCode).toBe(201);
    const r = await c.put('/api/account/data', { baseVersion: 1, data: { a: 2 } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('consent_required');
    expect((await c.get('/api/account/data')).json()).toMatchObject({ version: 1, data: { a: 1 } });
    await consent(c, 'sync_backup', true);
    expect((await c.put('/api/account/data', { baseVersion: 1, data: { a: 2 } })).json().version).toBe(2);
  });

  it("withdrawn 'reminders_email' makes the reminder job skip email and record unavailable / consent_withdrawn", async () => {
    const c = await signIn(app, mailer, 'consent-rem@example.com');
    await grantPlan(pool, 'consent-rem@example.com', 'plus');
    await c.put('/api/account/reminders', {
      items: [{ obligationRef: 'ob-1', title: 'Netflix', dueDate: '2026-11-02', remindAt: '2026-10-30T09:00:00Z', channel: 'email', timezone: 'UTC', quietHours: null }],
    });
    await consent(c, 'reminders_email', false);
    const before = mailer.sent.length;
    const run = await (await startJob({ ...monitorCtx(pool, clock), mailer }, 'consumer_reminders', 'manual'))!.done;
    expect(run.stats).toMatchObject({ due: 1, sent: 0, unavailable: 1 });
    expect(mailer.sent.length).toBe(before);
    const row = (await pool.query('SELECT status, error FROM reminder_deliveries')).rows[0];
    expect(row).toEqual({ status: 'unavailable', error: 'consent_withdrawn' });
  });
});

describe('telemetry', () => {
  it('accepts allow-listed events without cookies and rejects unknown names and PII', async () => {
    const post = (body: object) => app.inject({ method: 'POST', url: '/api/telemetry', payload: body });
    const ok = await post({ anonId: 'anon_12345678', events: [{ name: 'first_obligation_completed', props: { source: 'manual', count: 1 } }] });
    expect(ok.statusCode).toBe(202);
    const unknown = await post({ anonId: 'anon_12345678', events: [{ name: 'page_view' }] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.code).toBe('unknown_event');
    expect((await post({ anonId: 'anon_12345678', events: [{ name: 'churn_reason', props: { reason: 'me@example.com' } }] })).statusCode).toBe(400);
    expect((await post({ anonId: 'anon_12345678', events: [{ name: 'churn_reason', props: { email: 'x' } }] })).statusCode).toBe(400);
    expect((await post({ anonId: 'anon_12345678', events: [{ name: 'churn_reason', props: { ref: '9876543210' } }] })).statusCode).toBe(400);
    expect(await n('SELECT count(*) AS n FROM telemetry_events')).toBe(1);
    const admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
    const stats = (await admin.get('/api/admin/consumer-stats')).json();
    expect(stats.telemetry30d.first_obligation_completed).toBe(1);
    expect(stats).toMatchObject({ accounts: 0, households: 0 });
  });
});

describe('export and delete', () => {
  it('exports everything stored and deletes the account with a confirmation token', async () => {
    const c = await signIn(app, mailer, 'gone@example.com');
    await c.put('/api/account/data', { baseVersion: 0, data: { obligations: [{ id: 'a' }] } });
    await c.patch('/api/account/me', { displayName: 'Gone' });
    const ex = await c.get('/api/account/export');
    expect(ex.statusCode).toBe(200);
    expect(ex.headers['content-disposition']).toMatch(/attachment/);
    const doc = ex.json();
    expect(doc.account).toMatchObject({ email: 'gone@example.com', displayName: 'Gone' });
    expect(doc.data).toMatchObject({ version: 1, data: { obligations: [{ id: 'a' }] } });
    expect(doc.sessions).toHaveLength(1);
    expect(JSON.stringify(doc)).not.toMatch(/id_hash|idHash|token_hash/);

    expect((await c.del('/api/account', { confirmationToken: '123.abc-not-valid' })).json().error.code).toBe('invalid_confirmation');
    const tok = (await c.post('/api/account/delete-request')).json().confirmationToken;
    const del = await c.del('/api/account', { confirmationToken: tok });
    expect(del.statusCode).toBe(200);
    expect(await n('SELECT count(*) AS n FROM consumer_accounts')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM account_data')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM consumer_sessions')).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM magic_links`)).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM consumer_audit WHERE action = 'account.deleted' AND account_id IS NULL`)).toBe(1);
    expect((await c.get('/api/account/me')).statusCode).toBe(401);
  });

  it('refuses deletion while a paid subscription is active', async () => {
    const c = await signIn(app, mailer, 'paid@example.com');
    await pool.query(`UPDATE consumer_accounts SET status = 'active'`);
    await pool.query(
      `INSERT INTO entitlements (account_id, plan, billing_period, status, channel, provider_ref)
       SELECT id, 'plus', 'monthly', 'active', 'razorpay', 'sub_X' FROM consumer_accounts`,
    );
    const tok = (await c.post('/api/account/delete-request')).json().confirmationToken;
    const del = await c.del('/api/account', { confirmationToken: tok });
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('active_subscription');
  });
});
