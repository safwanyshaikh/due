import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMailer } from '../src/alerts.js';
import { computeEntitlement } from '../src/consumer/entitlements.js';
import type { Pool } from '../src/db.js';
import { redactSecrets } from '../src/health/index.js';
import { SETTING_SCHEMAS } from '../src/settings.js';
import { Client, freshDb, grantPlan, loggedIn, makeApp, RecordingMailer, signIn, TestClock } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;
let mailer: RecordingMailer;
const clock = new TestClock(new Date('2026-11-25T10:00:00Z'));
const RZP = {
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'rzp_test_secret',
  RAZORPAY_WEBHOOK_SECRET: 'whsec_test_0123456789',
};

beforeEach(async () => {
  await app?.close();
  await pool?.end();
  pool = await freshDb();
  clock.set('2026-11-25T10:00:00Z');
  mailer = new RecordingMailer();
  app = await makeApp(pool, { clock, mailer, env: RZP });
  await pool.query(`UPDATE plans SET provider_plan_ids = '{"monthly":"plan_PLUS1234567","yearly":"plan_PLUSYR12345"}' WHERE id = 'plus'`);
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const setBeta = (admin: Client, key: 'beta.plus_free' | 'beta.ends_on', value: unknown) => admin.patch('/api/admin/settings', { key, value });
const status = async () => (await app.inject({ method: 'GET', url: '/api/public/status' })).json();

describe('free public beta', () => {
  it('is off by default: free accounts stay Free and status says so', async () => {
    const c = await signIn(app, mailer, 'a@example.com');
    expect((await c.get('/api/account/entitlements')).json().plan).toBe('free');
    expect((await status()).beta).toEqual({ plusFree: false, endsOn: null });
  });

  it('settings are admin-only, validated and audit-logged', async () => {
    const admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
    const editor = await loggedIn(app, pool, 'editor@example.com', 'editor');
    expect((await setBeta(editor, 'beta.plus_free', true)).statusCode).toBe(403);
    expect((await setBeta(admin, 'beta.plus_free', 'yes')).statusCode).toBe(400);
    expect((await setBeta(admin, 'beta.ends_on', '31/12/2026')).statusCode).toBe(400);
    expect((await setBeta(admin, 'beta.ends_on', '2026-02-31')).statusCode).toBe(400);
    expect((await setBeta(admin, 'beta.plus_free', true)).statusCode).toBe(200);
    expect((await setBeta(admin, 'beta.ends_on', '2026-12-31')).statusCode).toBe(200);
    const s = (await admin.get('/api/admin/settings')).json();
    expect(s['beta.plus_free']).toBe(true);
    expect(s['beta.ends_on']).toBe('2026-12-31');
    const audit = await pool.query(`SELECT action, before, after FROM audit_log WHERE entity_id LIKE 'beta.%' ORDER BY id`);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[0]).toMatchObject({ action: 'settings.update', before: false, after: true });
    expect(SETTING_SCHEMAS['beta.ends_on'].safeParse(null).success).toBe(true);
  });

  it('grants Plus entitlements to every signed-in account server-side, and status reports it', async () => {
    const admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
    const c = await signIn(app, mailer, 'a@example.com');
    await setBeta(admin, 'beta.plus_free', true);
    await setBeta(admin, 'beta.ends_on', '2026-12-31');
    const ent = (await c.get('/api/account/entitlements')).json();
    expect(ent).toMatchObject({ plan: 'plus', status: 'active', beta: true, channel: null, periodEnd: null, billingPeriod: null });
    expect(ent.features).toContain('email_import');
    expect(ent.features).not.toContain('household_sharing');
    // Plus-gated server feature works.
    expect((await c.get('/api/account/uploads/count')).json().unlimited).toBe(true);
    expect(await status()).toMatchObject({ beta: { plusFree: true, endsOn: '2026-12-31' } });
    expect((await app.inject({ method: 'GET', url: '/api/public/plans' })).json().beta).toEqual({ plusFree: true, endsOn: '2026-12-31' });
  });

  it('ends by itself after the end date (IST) and when switched off; paid plans are untouched', async () => {
    const admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
    const c = await signIn(app, mailer, 'a@example.com');
    const accountId = (await pool.query(`SELECT id FROM consumer_accounts WHERE email = 'a@example.com'`)).rows[0].id as string;
    await setBeta(admin, 'beta.plus_free', true);
    await setBeta(admin, 'beta.ends_on', '2026-11-25');
    // 2026-11-25 23:00 IST is still inside the last day.
    clock.set('2026-11-25T17:30:00Z');
    expect((await computeEntitlement(pool, accountId, clock.fn())).plan).toBe('plus');
    clock.set('2026-11-25T18:31:00Z'); // 00:01 IST on the 26th
    expect((await computeEntitlement(pool, accountId, clock.fn())).plan).toBe('free');
    expect((await status()).beta).toEqual({ plusFree: false, endsOn: '2026-11-25' });
    await setBeta(admin, 'beta.ends_on', null);
    expect((await c.get('/api/account/entitlements')).json().plan).toBe('plus');
    await setBeta(admin, 'beta.plus_free', false);
    expect((await c.get('/api/account/entitlements')).json().plan).toBe('free');

    await grantPlan(pool, 'a@example.com', 'plus', new Date('2027-01-01T00:00:00Z'));
    await setBeta(admin, 'beta.plus_free', true);
    const paid = (await c.get('/api/account/entitlements')).json();
    expect(paid).toMatchObject({ plan: 'plus', channel: 'manual' });
    expect(paid.beta).toBeUndefined();
  });

  it('refuses checkout with a clear 409 while on, and the paid flow is unchanged once off', async () => {
    const admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
    const c = await signIn(app, mailer, 'a@example.com');
    await setBeta(admin, 'beta.plus_free', true);
    const r = await c.post('/api/account/checkout', { plan: 'plus', billingPeriod: 'monthly' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('beta_free');
    expect(r.json().error.message).toMatch(/free during the beta/i);
    expect(await pool.query('SELECT 1 FROM billing_subscriptions')).toHaveProperty('rowCount', 0);

    await setBeta(admin, 'beta.plus_free', false);
    // Past the beta guard the existing Razorpay path runs (it needs the network, so only the guard is asserted).
    const off = await c.post('/api/account/checkout', { plan: 'plus', billingPeriod: 'monthly' });
    expect(off.json().error?.code).not.toBe('beta_free');
  });
});

describe('admin SMTP test', () => {
  it('sends to the logged-in admin, audit-logs it, and requires the admin role', async () => {
    const admin = await loggedIn(app, pool, 'founder@example.com', 'admin');
    const viewer = await loggedIn(app, pool, 'viewer@example.com', 'viewer');
    expect((await app.inject({ method: 'POST', url: '/api/admin/health/smtp-test' })).statusCode).toBeGreaterThanOrEqual(401);
    expect((await viewer.post('/api/admin/health/smtp-test')).statusCode).toBe(403);
    const r = await admin.post('/api/admin/health/smtp-test');
    // The test app has no SMTP_URL configured, so a mailer alone is not enough: be explicit.
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('smtp_not_configured');

    const app2 = await makeApp(pool, { clock, mailer, env: { SMTP_URL: 'smtps://hello%40example.com:dummy-app-password@smtp.gmail.com:465' } });
    const admin2 = await new Client(app2).login('founder@example.com');
    const ok = await admin2.post('/api/admin/health/smtp-test', { to: 'attacker@example.com' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ ok: true, sentTo: 'founder@example.com' });
    expect(mailer.last().to).toEqual(['founder@example.com']);
    const audit = await pool.query(`SELECT after FROM audit_log WHERE action = 'health.smtp_test'`);
    expect(audit.rows[0].after).toMatchObject({ to: 'founder@example.com', ok: true });

    mailer.fail = true;
    const bad = await admin2.post('/api/admin/health/smtp-test');
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error.code).toBe('smtp_send_failed');
    expect(bad.body).not.toContain('dummy-app-password');
    await app2.close();
  });

  it('is rate-limited', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: { SMTP_URL: 'smtps://hello%40example.com:dummy-app-password@smtp.gmail.com:465' } });
    await loggedIn(app2, pool, 'founder@example.com', 'admin');
    const admin = await new Client(app2).login('founder@example.com');
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await admin.post('/api/admin/health/smtp-test')).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[6]).toBe(429);
    await app2.close();
  });

  it('redacts the SMTP URL and password from error text', () => {
    const url = 'smtps://hello%40example.com:p%40ss-word@smtp.gmail.com:465';
    expect(redactSecrets(`failed ${url} with p@ss-word`, url)).toBe('failed [smtp-url] with [redacted]');
  });
});

describe('mailer accepts smtps:// URLs (Google Workspace)', () => {
  afterAll(() => vi.doUnmock('nodemailer'));

  it('parses the documented URL: host, port 465, TLS, URL-decoded user', async () => {
    const nodemailer = await import('nodemailer');
    const t = nodemailer.createTransport('smtps://hello%40example.com:dummy-app-password@smtp.gmail.com:465') as unknown as {
      options: { host: string; port: number; secure: boolean; auth: { user: string; pass: string } };
    };
    expect(t.options).toMatchObject({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'hello@example.com', pass: 'dummy-app-password' } });
  });

  it('createMailer sends through the transport with the configured From', async () => {
    vi.resetModules();
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<m1@test>' });
    const createTransport = vi.fn().mockReturnValue({ sendMail });
    vi.doMock('nodemailer', () => ({ createTransport, default: { createTransport } }));
    const { createMailer: fresh } = await import('../src/alerts.js');
    const m = await fresh('smtps://hello%40example.com:dummy-app-password@smtp.gmail.com:465', 'Due <hello@example.com>');
    const r = await m!.send(['a@example.com'], 'Hi', 'Body');
    expect(createTransport).toHaveBeenCalledWith('smtps://hello%40example.com:dummy-app-password@smtp.gmail.com:465');
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'Due <hello@example.com>', to: 'a@example.com', subject: 'Hi' }));
    expect(r).toEqual({ messageId: '<m1@test>' });
    expect(await createMailer(null, null)).toBeNull();
  });
});

describe('store links in public status', () => {
  it('are null by default, https-only, admin-set and exposed in /api/public/status', async () => {
    expect((await status()).apps).toEqual({ androidUrl: null, iosUrl: null });
    const admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
    expect((await admin.patch('/api/admin/settings', { key: 'app.android_url', value: 'http://play.google.com/x' })).statusCode).toBe(400);
    expect((await admin.patch('/api/admin/settings', { key: 'app.ios_url', value: 'javascript:alert(1)' })).statusCode).toBe(400);
    const play = 'https://play.google.com/store/apps/details?id=com.example.due';
    expect((await admin.patch('/api/admin/settings', { key: 'app.android_url', value: play })).statusCode).toBe(200);
    expect((await status()).apps).toEqual({ androidUrl: play, iosUrl: null });
    expect((await admin.patch('/api/admin/settings', { key: 'app.android_url', value: null })).statusCode).toBe(200);
    expect((await status()).apps.androidUrl).toBeNull();
  });
});
