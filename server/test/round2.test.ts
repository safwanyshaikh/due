import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { decodePath } from '../src/http/paths.js';
import { AGE, AppClient, BASE, Client, createUser, freshDb, loggedIn, makeApp, RecordingMailer, TestClock } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;
let mailer: RecordingMailer;
const clock = new TestClock(new Date('2026-11-26T10:00:00Z'));

beforeEach(async () => {
  await app?.close();
  await pool?.end();
  pool = await freshDb();
  clock.set('2026-11-26T10:00:00Z');
  mailer = new RecordingMailer();
  app = await makeApp(pool, { clock, mailer });
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

export async function consumer(a: FastifyInstance, m: RecordingMailer, email: string): Promise<AppClient> {
  const c = new AppClient(a);
  expect((await c.post('/api/account/magic-link', { email })).statusCode).toBe(202);
  expect((await c.post('/api/account/verify', { ...AGE, token: m.lastToken() })).statusCode).toBe(200);
  return c;
}

describe('M-A: every hook matches the decoded, routed path', () => {
  it('decodes percent-encoding (also double) and collapses slashes', () => {
    expect(decodePath('/%61pi/admin/users?x=1')).toBe('/api/admin/users');
    expect(decodePath('/%2561pi/auth/login')).toBe('/api/auth/login');
    expect(decodePath('//api//admin')).toBe('/api/admin');
    expect(decodePath('/%E0%A4%A')).toBe('/%E0%A4%A');
  });

  it('the admin IP allowlist, CSRF guard and no-store apply to encoded paths', async () => {
    await createUser(pool, 'a@example.com', 'admin');
    const app2 = await makeApp(pool, { clock, mailer, env: { TRUST_PROXY_HOPS: '1', ADMIN_ALLOWED_IPS: '198.51.100.0/24' } });
    for (const url of ['/%61pi/admin/users', '/api/%61dmin/users', '/%61pi/auth/login']) {
      const r = await app2.inject({ method: 'GET', url, headers: { 'x-forwarded-for': '203.0.113.5' } });
      expect(r.statusCode, url).toBe(404);
    }
    await app2.close();
    const c = await consumer(app, mailer, 'p@example.com');
    const noCsrf = await app.inject({ method: 'POST', url: '/api/%61ccount/logout-all', headers: { cookie: `due_acct=${c.cookies.due_acct}` } });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('csrf_rejected');
    const me = await app.inject({ method: 'GET', url: '/api/%61ccount/me', headers: { cookie: `due_acct=${c.cookies.due_acct}` } });
    expect(me.statusCode).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
  });
});

void Client;
void loggedIn;
void BASE;

describe('M-C: credential resets for admin-level accounts', () => {
  it('only an owner can reset another admin; the link is never returned when SMTP is configured', async () => {
    await createUser(pool, 'own@example.com', 'owner');
    await createUser(pool, 'adm@example.com', 'admin');
    const adm2 = await createUser(pool, 'adm2@example.com', 'admin');
    const ed = await createUser(pool, 'ed@example.com', 'editor');
    const admin = await new Client(app).login('adm@example.com');
    expect((await admin.post(`/api/admin/users/${adm2}/reset-link`)).statusCode).toBe(403);
    expect((await admin.post(`/api/admin/users/${adm2}/reset-mfa`)).statusCode).toBe(403);
    // Editors can still be helped by an admin, but the link goes to their inbox only.
    const r = await admin.post(`/api/admin/users/${ed}/reset-link`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ resetLink: null, emailed: true });
    expect(mailer.last().to).toEqual(['ed@example.com']);
    const owner = await new Client(app).login('own@example.com');
    const o = await owner.post(`/api/admin/users/${adm2}/reset-link`);
    expect(o.statusCode).toBe(200);
    expect(o.json().resetLink).toBeNull();
    expect((await owner.post(`/api/admin/users/${adm2}/reset-mfa`)).statusCode).toBe(200);
    const created = await admin.post('/api/admin/users', { email: 'new@example.com', name: 'New', role: 'viewer' });
    expect(created.json()).toMatchObject({ setupLink: null, emailed: true });
  });
});

describe('M-D: withdrawing consent stops the processing', () => {
  const consent = (c: AppClient, purpose: string, granted: boolean) =>
    c.post('/api/account/consents', { purpose, granted, policyVersion: 'v1' });

  it('sync_backup withdrawal erases the server copy; gmail withdrawal disconnects and blocks scans', async () => {
    const c = await consumer(app, mailer, 'w@example.com');
    const id = (await pool.query(`SELECT id FROM consumer_accounts`)).rows[0].id;
    await consent(c, 'sync_backup', true);
    expect((await c.put('/api/account/data', { baseVersion: 0, data: { a: 1 } })).statusCode).toBe(200);
    const w = await consent(c, 'sync_backup', false);
    expect(w.json().serverCopyErased).toBe(true);
    expect((await pool.query('SELECT count(*)::int AS n FROM account_data')).rows[0].n).toBe(0);

    const ident = (
      await pool.query(
        `INSERT INTO email_identities (account_id, kind, label, email, status, consent_version, consented_at, created_at, updated_at)
         VALUES ($1, 'gmail', 'Gmail', 'w@gmail.example', 'active', 'gmail-v1', now(), now(), now()) RETURNING id`,
        [id],
      )
    ).rows[0].id;
    await consent(c, 'gmail', true);
    const g = await consent(c, 'gmail', false);
    expect(g.json().gmailDisconnected).toBe(1);
    expect((await pool.query('SELECT status FROM email_identities WHERE id = $1', [ident])).rows[0].status).toBe('disconnected');
    // A scan queued earlier does nothing without the consent.
    await pool.query(`UPDATE email_identities SET status = 'active' WHERE id = $1`, [ident]);
    const run = (await pool.query(`INSERT INTO gmail_scan_runs (identity_id, trigger, status, requested_at) VALUES ($1, 'manual', 'queued', now()) RETURNING id`, [ident])).rows[0].id;
    const { runGmailScan } = await import('../src/gmail/scan.js');
    const r = await runGmailScan({ pool, config: app.deps.config, clock: clock.fn }, { runId: run, identityId: ident });
    expect(r).toMatchObject({ status: 'cancelled', code: 'consent_withdrawn' });
  });

  it('household data needs the household consent; withdrawing it leaves the household', async () => {
    await pool.query(`UPDATE plans SET active = true WHERE id = 'household'`);
    const { grantPlan } = await import('./helpers.js');
    const owner = await consumer(app, mailer, 'o@example.com');
    await grantPlan(pool, 'o@example.com', 'household');
    expect((await owner.post('/api/account/household', { name: 'Home' })).statusCode).toBe(201);
    await owner.post('/api/account/household/invites', { email: 'm@example.com' });
    const token = mailer.lastToken('household_invite');
    const member = await consumer(app, mailer, 'm@example.com');
    expect((await member.post('/api/account/household/accept', { token })).statusCode).toBe(200);
    expect((await member.get('/api/account/household/data')).statusCode).toBe(200);
    const w = await consent(member, 'household', false);
    expect(w.json().household).toBe('left');
    expect((await member.get('/api/account/household/data')).statusCode).not.toBe(200);
    expect((await owner.get('/api/account/household/data')).statusCode).toBe(200);
  });
});

describe('M-E: plaintext sync rows are sealed by a backfill job', () => {
  it('seals dormant plain rows in both tables without anyone syncing', async () => {
    const key = Buffer.alloc(32, 8).toString('base64');
    const app2 = await makeApp(pool, { clock, mailer, env: { DATA_ENCRYPTION_KEY: `k9:${key}` } });
    await consumer(app2, mailer, 'dormant@example.com');
    const id = (await pool.query(`SELECT id FROM consumer_accounts`)).rows[0].id;
    await pool.query(`INSERT INTO account_data (account_id, version, data, updated_at) VALUES ($1, 3, $2, now())`, [id, JSON.stringify({ secret: 'PLAIN-MARKER' })]);
    // Raw intake text from before row binding (v2, no AAD).
    const { encryptText, decryptText, parseDataKeys } = await import('../src/intake/crypto.js');
    const ring = parseDataKeys(`k9:${key}`)!;
    const ev = (
      await pool.query(
        `INSERT INTO user_events (account_id, intake_type, message_fingerprint, extracted_fields, confidence, review_status, raw_text, raw_retention_until, parser_version)
         VALUES ($1, 'manual', 'fp-1', '{}', '{}', 'needs_review', $2, now() + interval '7 days', 'v1') RETURNING id`,
        [id, encryptText(ring, 'legacy text')],
      )
    ).rows[0].id;
    const { enqueue } = await import('../src/queue/index.js');
    await enqueue(pool, { type: 'sync.seal_backfill', now: clock.fn() });
    const { drain } = await import('./helpers.js');
    await drain(app2);
    const row = (await pool.query('SELECT data, data_enc FROM account_data')).rows[0];
    expect(row.data).toEqual({});
    expect(row.data_enc).toMatch(/^d1:k9:/);
    expect(row.data_enc).not.toContain('PLAIN-MARKER');
    const raw = (await pool.query('SELECT raw_text FROM user_events WHERE id = $1', [ev])).rows[0].raw_text;
    expect(raw).toMatch(/^v3:k9:/);
    expect(decryptText(ring, raw, `user_events:${ev}`)).toBe('legacy text');
    await app2.close();
  });
});

describe('M-F: client IP evidence and an optional platform client-IP header', () => {
  it('uses CLIENT_IP_HEADER when it holds a valid IP, else the hop count', async () => {
    await createUser(pool, 'a@example.com', 'admin');
    const app2 = await makeApp(pool, { clock, mailer, env: { TRUST_PROXY_HOPS: '1', CLIENT_IP_HEADER: 'CF-Connecting-IP' } });
    const H = { 'x-requested-with': 'due-admin', origin: BASE };
    const send = (headers: Record<string, string>) =>
      app2.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@example.com', password: 'wrong-password-x' }, headers: { ...H, ...headers } });
    await send({ 'cf-connecting-ip': '198.51.100.77', 'x-forwarded-for': '6.6.6.6, 10.0.0.1' });
    await send({ 'cf-connecting-ip': 'not-an-ip', 'x-forwarded-for': '6.6.6.6, 10.0.0.1' });
    const ips = (await pool.query('SELECT ip FROM login_events ORDER BY id')).rows.map((r) => r.ip);
    expect(ips).toEqual(['198.51.100.77', '10.0.0.1']);
    await app2.close();
  });
});

describe('Lows: enrolment race, code guessing, editor writes', () => {
  it('two concurrent enrolments with one challenge give one session', async () => {
    await createUser(pool, 'n@example.com', 'admin', 'correct horse battery', false);
    const first = await new Client(app).post('/api/auth/login', { email: 'n@example.com', password: 'correct horse battery' });
    const { challengeToken, enrolment } = first.json();
    const { currentTotp } = await import('./helpers.js');
    const code = currentTotp(app, enrolment.secret);
    const [a, b] = await Promise.all([
      new Client(app).post('/api/auth/mfa/enrol', { challengeToken, code }),
      new Client(app).post('/api/auth/mfa/enrol', { challengeToken, code }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 400]);
    expect((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE revoked_at IS NULL')).rows[0].n).toBe(1);
  });

  it('wrong codes raise an alert at 5 and lock the second step at 8 per hour', async () => {
    await createUser(pool, 'g@example.com', 'editor');
    const tryOnce = async () => {
      const step = await new Client(app).post('/api/auth/login', { email: 'g@example.com', password: 'correct horse battery' });
      return new Client(app).post('/api/auth/mfa', { challengeToken: step.json().challengeToken, code: '000000' });
    };
    for (let i = 0; i < 5; i++) await tryOnce();
    expect((await pool.query(`SELECT count(*)::int AS n FROM alerts WHERE title LIKE 'Repeated wrong 2-step codes%'`)).rows[0].n).toBe(1);
    for (let i = 0; i < 3; i++) await tryOnce();
    const locked = await tryOnce();
    expect(locked.statusCode).toBe(429);
    expect(locked.json().error.code).toBe('mfa_locked');
  });

  it('editor writes need a code from the last 30 minutes', async () => {
    await createUser(pool, 'e@example.com', 'editor');
    const e = await new Client(app).login('e@example.com');
    expect((await e.post('/api/admin/companies', { name: 'One' })).statusCode).toBe(201);
    clock.advanceMinutes(31);
    await e.get('/api/auth/me');
    const email = e.email;
    e.email = null;
    const stale = await e.post('/api/admin/companies', { name: 'Two' });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('reauth_required');
    e.email = email;
    expect((await e.post('/api/admin/companies', { name: 'Two' })).statusCode).toBe(201);
  });
});

describe('store rules: no purchase inside the native apps', () => {
  it('the native app sees payments as unavailable and cannot start a checkout', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: { RAZORPAY_KEY_ID: 'rzp_test_abc', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' } });
    const IOS = 'capacitor://localhost';
    const plans = (await app2.inject({ method: 'GET', url: '/api/public/plans', headers: { origin: IOS } })).json();
    expect(plans).toMatchObject({ paymentsAvailable: false, purchaseChannel: null, inAppPurchase: 'not_offered' });
    const c = new AppClient(app2);
    const H = { origin: IOS, 'x-requested-with': 'due-app' };
    await c.req('POST', '/api/account/magic-link', { email: 'n@example.com' }, H);
    const v = await c.req('POST', '/api/account/verify', { ...AGE, token: mailer.lastToken(), tokenTransport: 'bearer' }, H);
    const token = v.json().sessionToken;
    const r = await app2.inject({ method: 'POST', url: '/api/account/checkout', payload: { plan: 'plus', billingPeriod: 'monthly' }, headers: { ...H, authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('not_sold_in_app');
    await app2.close();
  });
});
