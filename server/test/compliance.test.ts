import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Pool } from '../src/db.js';
import { AGE, AppClient, BASE, Client, createUser, freshDb, grantPlan, loggedIn, makeApp, RecordingMailer, testConfig, TestClock } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;
let mailer: RecordingMailer;
const clock = new TestClock(new Date('2026-11-25T10:00:00Z'));

beforeEach(async () => {
  await app?.close();
  await pool?.end();
  pool = await freshDb();
  clock.set('2026-11-25T10:00:00Z');
  mailer = new RecordingMailer();
  app = await makeApp(pool, { clock, mailer });
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

export const FULL_LEGAL: Record<string, unknown> = {
  'legal.entity_name': 'Sample Labs Private Limited',
  'legal.address': '1 Sample Street, Bengaluru 560001, India',
  'legal.grievance_officer_name': 'Grievance Officer',
  'legal.grievance_email': 'grievance@due.in',
  'legal.support_email': 'support@due.in',
  'legal.incident_contact': 'security@due.in',
  'legal.privacy_policy_md': '# Privacy notice\nWe process...',
  'legal.terms_md': '# Terms\n...',
  'legal.deletion_policy_md': '# Deletion\n...',
  'legal.refund_policy_md': '# refund_policy_md\n...',
  'legal.delivery_policy_md': '# delivery_policy_md\n...',
  'legal.contact_md': '# contact_md\n...',
  'legal.cookies_md': '# cookies_md\n...',
  'legal.subprocessors': [{ name: 'Render', purpose: 'Hosting', region: 'US' }],
  'legal.effective_date': '2026-11-01',
};

export async function completeLegal(p: Pool): Promise<void> {
  for (const [k, v] of Object.entries(FULL_LEGAL)) {
    await p.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, JSON.stringify(v)]);
  }
}

const H = { 'x-requested-with': 'due-app', origin: BASE };

describe('M2: DATA_ENCRYPTION_KEY', () => {
  const base = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y', SESSION_SECRET: 'x'.repeat(40) };
  const key = Buffer.alloc(32, 1).toString('base64');
  it('production refuses to start with inbound mail or Gmail but no key', () => {
    expect(() => loadConfig({ ...base, INBOUND_EMAIL_DOMAIN: 'in.example.test', INBOUND_WEBHOOK_SECRET: 's'.repeat(20) })).toThrow(/DATA_ENCRYPTION_KEY is required/);
    expect(() => loadConfig({ ...base, INBOUND_EMAIL_DOMAIN: 'in.example.test', INBOUND_WEBHOOK_SECRET: 's'.repeat(20) })).toThrow(/inbound email/);
    expect(() =>
      loadConfig({
        ...base,
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_REDIRECT_URI: 'https://due.example/api/account/gmail/callback',
        GMAIL_TOKEN_KEYS: `k1:${key}`,
      }),
    ).toThrow(/Gmail/);
    expect(loadConfig({ ...base, INBOUND_EMAIL_DOMAIN: 'in.example.test', INBOUND_WEBHOOK_SECRET: 's'.repeat(20), DATA_ENCRYPTION_KEY: key }).inboundEmailDomain).toBe('in.example.test');
    // Synced backups are sealed with it too (H3): production never starts without it.
    expect(() => loadConfig(base)).toThrow(/backup and sync/);
    expect(loadConfig({ NODE_ENV: 'development', DATABASE_URL: 'postgres://x/y', SESSION_SECRET: 'x'.repeat(40) }).dataEncryptionKey).toBeNull();
    // A key ring keeps the key id of the current key.
    expect(loadConfig({ ...base, DATA_ENCRYPTION_KEY: `k2026:${key}` }).dataEncryptionKey!.current.kid).toBe('k2026');
  });
});

async function requestLink(c: AppClient, email: string) {
  const r = await c.post('/api/account/magic-link', { email });
  expect(r.statusCode).toBe(202);
  return mailer.lastToken();
}

describe('M8: 18+ confirmation at sign-in', () => {
  it('requires the 18+ declaration (the link stays usable) and records it with the notice version', async () => {
    const c = new AppClient(app);
    const token = await requestLink(c, 'adult@example.com');
    const missing = await c.post('/api/account/verify', { token });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('age_confirmation_required');
    expect((await pool.query('SELECT count(*)::int AS n FROM consumer_accounts')).rows[0].n).toBe(0);
    const ok = await c.post('/api/account/verify', { ...AGE, token });
    expect(ok.statusCode).toBe(200);
    const rows = (await pool.query(`SELECT purpose, granted, policy_version, scope FROM consent_records ORDER BY id`)).rows;
    expect(rows).toEqual([
      { purpose: 'age_18_plus', granted: true, policy_version: AGE.noticeVersion, scope: { method: 'self_declaration' } },
      { purpose: 'account', granted: true, policy_version: AGE.noticeVersion, scope: {} },
    ]);
    // Later sign-ins do not ask again.
    const again = new AppClient(app);
    const t2 = await requestLink(again, 'adult@example.com');
    expect((await again.post('/api/account/verify', { token: t2 })).statusCode).toBe(200);
    // The declaration cannot be posted (or withdrawn) through the consents API.
    expect((await c.post('/api/account/consents', { purpose: 'age_18_plus', granted: false, policyVersion: 'x' })).statusCode).toBe(400);
  });
});

describe('M9: explicit consent and the legal-details gate', () => {
  it('in production, new accounts are refused until the legal details are complete; existing accounts still sign in', async () => {
    const config = { ...testConfig(), isProduction: true };
    const prod = await buildApp({ pool, config, clock: clock.fn, mailer, logger: false });
    await prod.ready();
    try {
      const c = new AppClient(prod);
      const token = await requestLink(c, 'early@example.com');
      const r = await c.post('/api/account/verify', { ...AGE, token });
      expect(r.statusCode).toBe(503);
      expect(r.json().error.code).toBe('signup_unavailable');
      expect(r.json().error.message).toMatch(/legal and grievance details/);
      expect((await pool.query('SELECT count(*)::int AS n FROM consumer_accounts')).rows[0].n).toBe(0);
      await completeLegal(pool);
      const ok = await c.post('/api/account/verify', { ...AGE, token });
      expect(ok.statusCode).toBe(200);
    } finally {
      await prod.close();
    }
  });

  it('forwarded mail is refused without an explicit forwarding grant (never-withdrawn is not consent)', async () => {
    const SECRET = 'inbound-secret-0123456789';
    const app2 = await makeApp(pool, {
      clock,
      mailer,
      env: { INBOUND_EMAIL_DOMAIN: 'inbox.due.test', INBOUND_WEBHOOK_SECRET: SECRET, DATA_ENCRYPTION_KEY: Buffer.alloc(32, 2).toString('base64') },
    });
    const c = new AppClient(app2);
    const t = await requestLink(c, 'fwd@example.com');
    expect((await c.post('/api/account/verify', { ...AGE, token: t })).statusCode).toBe(200);
    const acct = (await pool.query(`SELECT id FROM consumer_accounts`)).rows[0].id;
    await grantPlan(pool, 'fwd@example.com', 'plus');
    // An alias without a forwarding grant (e.g. created before consent was recorded).
    await pool.query(`INSERT INTO intake_aliases (account_id, alias, status) VALUES ($1, 'uzzqqa', 'active')`, [acct]);
    const r = await app2.inject({
      method: 'POST',
      url: '/api/inbound/email',
      payload: {
        From: 'me@gmail.com',
        FromFull: { Email: 'me@gmail.com' },
        To: 'uzzqqa@inbox.due.test',
        ToFull: [{ Email: 'uzzqqa@inbox.due.test' }],
        OriginalRecipient: 'uzzqqa@inbox.due.test',
        Subject: 'Fwd: Renewal',
        MessageID: 'pm-1',
        TextBody: 'Netflix Rs 649 renews on 12/12/2026',
        Headers: [{ Name: 'Message-ID', Value: '<m-1@mail.gmail.com>' }],
      },
      headers: { authorization: `Basic ${Buffer.from(`postmark:${SECRET}`).toString('base64')}` },
    });
    expect(r.statusCode).toBeLessThan(500);
    expect(JSON.stringify(r.json())).toContain('consent_withdrawn');
    expect((await pool.query(`SELECT count(*)::int AS n FROM inbound_messages WHERE status = 'received'`)).rows[0].n).toBe(0);
    await app2.close();
  });
});

void H;

describe('H4: retention, breach notices and log shipping', () => {
  it('keeps admin sign-in history and audit rows for 365 days, analytics for 13 months', async () => {
    const { DEFAULT_SETTINGS } = await import('../src/settings.js');
    expect(DEFAULT_SETTINGS.retention.login_events_days).toBe(365);
    const { retentionPurge } = await import('../src/queue/handlers.js');
    const old = new Date('2025-11-01T00:00:00Z'); // > 365 days before 2026-11-25
    const recent = new Date('2025-12-01T00:00:00Z'); // < 365 days
    await pool.query(`INSERT INTO audit_log (action, entity_type, at) VALUES ('x', 'y', $1), ('x', 'y', $2)`, [old, recent]);
    await pool.query(`INSERT INTO consumer_audit (action, entity, at) VALUES ('x', 'y', $1), ('x', 'y', $2)`, [old, recent]);
    await pool.query(`INSERT INTO telemetry_events (anon_id, name, props, at) VALUES ('anon-1234567890', 'import_approved', '{}', $1), ('anon-1234567890', 'import_approved', '{}', $2)`, [
      new Date('2025-10-20T00:00:00Z'),
      recent,
    ]);
    await retentionPurge({ deps: { pool, clock: clock.fn, config: testConfig(), mailer: null, log: { info() {}, warn() {}, error() {} } }, payload: {} } as never);
    expect((await pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM consumer_audit')).rows[0].n).toBe(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM telemetry_events')).rows[0].n).toBe(1);
  });

  it('breach notices: open incident, fixed template, owners alerted, another owner approves, one email per account (M-B)', async () => {
    await completeLegal(pool);
    const ids: string[] = [];
    for (const e of ['one@example.com', 'two@example.com']) {
      const c = new AppClient(app);
      const t = await requestLink(c, e);
      expect((await c.post('/api/account/verify', { ...AGE, token: t })).statusCode).toBe(200);
      ids.push((await pool.query('SELECT id FROM consumer_accounts WHERE email = $1', [e])).rows[0].id);
    }
    const viewer = await loggedIn(app, pool, 'viewer@example.com', 'viewer');
    const fields = {
      discoveredOn: '24 November 2026',
      whatHappened: 'A backup file was readable by the public for two hours.',
      dataAffected: 'Your email address and your synced items.',
      whatWeDid: 'We closed the exposure and rotated the keys.',
      whatYouCanDo: 'Sign out of devices you do not recognise in the Due app.',
    };
    const draft = { incidentRef: 'INC-2026-11-01', fields, accountIds: ids };
    expect((await viewer.post('/api/admin/incident/notices', draft)).statusCode).toBe(403);
    const admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
    // No open incident record: refused.
    expect((await admin.post('/api/admin/incident/notices', draft)).json().error.code).toBe('incident_not_open');
    expect((await admin.post('/api/admin/incident/records', { incidentRef: 'INC-2026-11-01', title: 'Backup exposure' })).statusCode).toBe(201);
    // Links, addresses and phone numbers are refused in every placeholder.
    for (const bad of ['Verify at https://due-verify.example now', 'Visit due-login.com today', 'Write to help@due.example', 'Call 98765 43210 now please']) {
      expect((await admin.post('/api/admin/incident/notices', { ...draft, fields: { ...fields, whatYouCanDo: bad } })).statusCode, bad).toBe(400);
    }
    await createUser(pool, 'owner1@example.com', 'owner');
    await createUser(pool, 'owner2@example.com', 'owner');
    mailer.sent = [];
    const d = await admin.post('/api/admin/incident/notices', draft);
    expect(d.statusCode).toBe(201);
    // Every owner is alerted; nothing goes to the accounts yet.
    expect(mailer.sent.map((m) => m.to[0]).sort()).toEqual(['owner1@example.com', 'owner2@example.com']);
    const id = d.json().id;
    // Admins cannot approve; the author cannot approve their own draft.
    expect((await admin.post(`/api/admin/incident/notices/${id}/approve`)).statusCode).toBe(403);
    const o1 = await new Client(app).login('owner1@example.com');
    const own = await o1.post('/api/admin/incident/notices', draft);
    expect((await o1.post(`/api/admin/incident/notices/${own.json().id}/approve`)).statusCode).toBe(403);
    mailer.sent = [];
    const dry = await o1.post(`/api/admin/incident/notices/${id}/approve`, { dryRun: true });
    expect(dry.json()).toMatchObject({ dryRun: true, wouldSend: 2 });
    expect(mailer.sent).toHaveLength(0);
    const r = await o1.post(`/api/admin/incident/notices/${id}/approve`);
    expect(r.json()).toMatchObject({ sent: 2, failed: 0 });
    const toAccounts = mailer.sent.filter((m) => m.subject.startsWith('Important: a security incident'));
    expect(toAccounts.map((m) => m.to)).toEqual([['one@example.com'], ['two@example.com']]);
    expect(toAccounts[0]!.text).toContain('Grievance Officer: Grievance Officer <grievance@due.in>');
    expect(toAccounts[0]!.text).not.toMatch(/https?:/);
    // A second approval of the same notice does nothing; the other draft skips accounts already notified.
    expect((await o1.post(`/api/admin/incident/notices/${id}/approve`)).statusCode).toBe(409);
    const o2 = await new Client(app).login('owner2@example.com');
    expect((await o2.post(`/api/admin/incident/notices/${own.json().id}/approve`)).json()).toMatchObject({ sent: 0, alreadyNotified: 2 });
    const audit = (await pool.query(`SELECT after FROM audit_log WHERE action = 'incident.notify_accounts'`)).rows;
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain('@example.com');
  });

  it('ships redacted logs and audit rows to LOG_SINK_URL (cursor advances only on success)', async () => {
    const { shipAuditRows } = await import('../src/observability/auditShip.js');
    const { LogSink } = await import('../src/observability/logSink.js');
    const posts: { kind: string; body: string; auth: string | null }[] = [];
    let ok = true;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      posts.push({ kind: h['x-due-kind']!, body: String(init.body), auth: h.authorization ?? null });
      return new Response('', { status: ok ? 200 : 500 });
    }) as unknown as typeof fetch;
    const sink = { url: 'https://logs.ap-south-1.example/ingest', token: 'sink-token', service: 'test', fetchImpl };
    await pool.query(`INSERT INTO audit_log (action, entity_type, after, at) VALUES ('user.update', 'user', $1, now())`, [JSON.stringify({ email: 'person@example.com', name: 'Sample Person', displayName: 'Sample Person' })]);
    // Rows younger than 5 minutes wait (a lower id may still be committing).
    expect((await shipAuditRows(pool, sink, new Date())).audit_log).toBe(0);
    const later = new Date(Date.now() + 10 * 60 * 1000);
    ok = false;
    expect((await shipAuditRows(pool, sink, later)).audit_log).toBe(-1);
    ok = true;
    expect((await shipAuditRows(pool, sink, later)).audit_log).toBe(1);
    expect((await shipAuditRows(pool, sink, later)).audit_log).toBe(0);
    const shipped = posts.filter((p) => p.kind === 'audit').at(-1)!;
    expect(shipped.auth).toBe('Bearer sink-token');
    expect(shipped.body).toContain('user.update');
    expect(shipped.body).not.toContain('person@example.com');
    expect(shipped.body).not.toContain('Sample Person');

    const ls = new LogSink({ ...sink, flushMs: 10_000 });
    ls.write('{"level":30,"msg":"hello"}\n');
    await ls.flush();
    expect(posts.at(-1)).toMatchObject({ kind: 'log' });
    expect(posts.at(-1)!.body).toContain('"msg":"hello"');
  });
});

describe('M4: complete account export', () => {
  it('every table with an account column is covered by the export (fails when a new table is added)', async () => {
    const { EXPORT_COVERAGE } = await import('../src/routes/account.js');
    const tables = (
      await pool.query<{ table_name: string }>(
        `SELECT DISTINCT table_name FROM information_schema.columns
          WHERE table_schema = 'public' AND column_name IN ('account_id', 'owner_account_id')`,
      )
    ).rows.map((r) => r.table_name);
    // Tables linked through a parent (identity, household) are covered with it.
    const viaParent = ['gmail_connections', 'gmail_scan_runs', 'household_data', 'household_members'];
    for (const t of [...tables, ...viaParent]) expect(EXPORT_COVERAGE[t], `table ${t} is not in EXPORT_COVERAGE`).toBeTruthy();
  });

  it('exports consents, intake, identities and preferences', async () => {
    const c = new AppClient(app);
    const t = await requestLink(c, 'export@example.com');
    expect((await c.post('/api/account/verify', { ...AGE, token: t })).statusCode).toBe(200);
    await c.post('/api/account/consents', { purpose: 'sync_backup', granted: true, policyVersion: 'sync-v1' });
    const ex = (await c.get('/api/account/export')).json();
    expect(ex.format).toBe('due-account-export/2');
    expect(ex.consents.map((r: { purpose: string }) => r.purpose).sort()).toEqual(['account', 'age_18_plus', 'sync_backup']);
    for (const k of ['intakeAliases', 'intakeEvents', 'emailIdentities', 'gmailConnections', 'notificationPreferences', 'uploadCounters', 'inboundMessages', 'deletionRequests']) {
      expect(Array.isArray(ex[k]), k).toBe(true);
    }
  });
});

describe('M3: analytics opt-in', () => {
  it('a signed-in account needs the analytics consent; events are purged with the account', async () => {
    const c = new AppClient(app);
    const t = await requestLink(c, 'metrics@example.com');
    expect((await c.post('/api/account/verify', { ...AGE, token: t })).statusCode).toBe(200);
    const batch = { anonId: 'anon_device_0001', optedIn: true, events: [{ name: 'import_ignored', props: { raw_kind: 'csv_row' } }] };
    expect((await c.post('/api/telemetry', batch)).statusCode).toBe(403);
    await c.post('/api/account/consents', { purpose: 'analytics', granted: true, policyVersion: 'telemetry-2026-10' });
    expect((await c.post('/api/telemetry', batch)).statusCode).toBe(202);
    // The same device also sent anonymous events before signing in.
    await app.inject({ method: 'POST', url: '/api/telemetry', payload: batch });
    expect((await pool.query('SELECT count(*)::int AS n FROM telemetry_events')).rows[0].n).toBe(2);
    const req = (await c.post('/api/account/delete-request')).json();
    expect((await c.del('/api/account', { confirmationToken: req.confirmationToken })).statusCode).toBe(202);
    const { drain } = await import('./helpers.js');
    await drain(app);
    expect((await pool.query('SELECT count(*)::int AS n FROM telemetry_events')).rows[0].n).toBe(0);
  });
});

describe('L3: unsubscribe tokens carry a key version and expire', () => {
  it('accepts a fresh token, refuses an expired, foreign-version or tampered one; legacy links work until the cutoff', async () => {
    const { unsubscribeToken, verifyUnsubscribeToken } = await import('../src/consumer/notifications.js');
    const secret = 's'.repeat(40);
    const id = '00000000-0000-4000-8000-000000000001';
    const issued = new Date('2026-11-25T10:00:00Z');
    const t = unsubscribeToken(secret, id, 'email', issued);
    expect(t.startsWith('u2.')).toBe(true);
    expect(verifyUnsubscribeToken(secret, t, issued)).toEqual({ accountId: id, channel: 'email' });
    expect(verifyUnsubscribeToken(secret, t, new Date('2027-12-31T10:00:00Z'))).toBeNull();
    expect(verifyUnsubscribeToken(secret, t.replace(/^u2\./, 'u3.'), issued)).toBeNull();
    expect(verifyUnsubscribeToken('x'.repeat(40), t, issued)).toBeNull();
    const { hmacSha256 } = await import('../src/util.js');
    const legacy = `${Buffer.from(`${id}.email`).toString('base64url')}.${hmacSha256(secret, `unsubscribe:${id}:email`).slice(0, 40)}`;
    expect(verifyUnsubscribeToken(secret, legacy, issued)).toEqual({ accountId: id, channel: 'email' });
    expect(verifyUnsubscribeToken(secret, legacy, new Date('2028-01-01T00:00:00Z'))).toBeNull();
  });
});

describe('L5: household invitation emails', () => {
  it('strip links from names and cap invitations per household and per recipient', async () => {
    const { plainName } = await import('../src/routes/household.js');
    const tagged = plainName('Home <a href="x">click</a> https://evil.example/login');
    expect(tagged).not.toMatch(/[<>"]|https|evil/);
    expect(plainName('Sharma family verify-at bank-login.com now')).toBe('Sharma family verify-at now');
    expect(plainName('Free money www.evil.example')).toBe('Free money');
    await completeLegal(pool);
    const c = new AppClient(app);
    const t = await requestLink(c, 'owner@example.com');
    expect((await c.post('/api/account/verify', { ...AGE, token: t })).statusCode).toBe(200);
    await pool.query(`UPDATE plans SET active = true WHERE id = 'household'`);
    await grantPlan(pool, 'owner@example.com', 'household');
    expect((await c.post('/api/account/household', { name: 'Home https://evil.example/pay' })).statusCode).toBe(201);
    const first = await c.post('/api/account/household/invites', { email: 'a1@example.com' });
    expect(first.statusCode).toBe(201);
    expect(mailer.last().subject).toBe('You’re invited to share "Home" on Due'.replace('’', "'"));
    expect(mailer.last().text).not.toContain('evil.example');
    // Re-inviting one address: at most 3 a day (each re-invite replaces nothing; the cap stops the flood).
    await pool.query(`UPDATE household_invites SET used_at = now()`);
    for (let i = 0; i < 2; i++) {
      expect((await c.post('/api/account/household/invites', { email: 'a1@example.com' })).statusCode).toBe(201);
      await pool.query(`UPDATE household_invites SET used_at = now()`);
    }
    const capped = await c.post('/api/account/household/invites', { email: 'a1@example.com' });
    expect(capped.statusCode).toBe(429);
  });
});

describe('L7: production headers', () => {
  it('sends HSTS with preload, upgrade-insecure-requests on pages, and no cross-domain policies', async () => {
    const prod = await buildApp({ pool, config: { ...testConfig(), isProduction: true }, clock: clock.fn, logger: false });
    await prod.ready();
    try {
      const r = await prod.inject({ method: 'GET', url: '/health/live' });
      expect(r.headers['strict-transport-security']).toBe('max-age=63072000; includeSubDomains; preload');
      expect(r.headers['content-security-policy']).toContain('upgrade-insecure-requests');
      expect(r.headers['x-permitted-cross-domain-policies']).toBe('none');
      const api = await prod.inject({ method: 'GET', url: '/api/public/legal' });
      expect(api.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    } finally {
      await prod.close();
    }
  });
});

describe('H3: synced documents are sealed per account and per household', () => {
  const KEY = Buffer.alloc(32, 6).toString('base64');
  it('stores ciphertext only, re-seals older plain rows on the next sync, and opens with a rotated ring', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: { DATA_ENCRYPTION_KEY: `k1:${KEY}` } });
    const c = new AppClient(app2);
    const t = await requestLink(c, 'sealed@example.com');
    expect((await c.post('/api/account/verify', { ...AGE, token: t })).statusCode).toBe(200);
    await c.post('/api/account/consents', { purpose: 'sync_backup', granted: true, policyVersion: 'sync-v1' });
    const doc = { commitments: [{ id: 'x', amount: 12345, provider: 'HDFC' }] };
    expect((await c.put('/api/account/data', { baseVersion: 0, data: doc })).statusCode).toBe(200);
    const row = (await pool.query('SELECT data, data_enc FROM account_data')).rows[0];
    expect(row.data).toEqual({});
    expect(row.data_enc).toMatch(/^d1:k1:/);
    expect(row.data_enc).not.toContain('HDFC');
    expect((await c.get('/api/account/data')).json()).toMatchObject({ version: 1, data: doc });
    // A ciphertext moved to another account's row does not open (scope is bound as AAD).
    const { openDoc } = await import('../src/consumer/syncCrypto.js');
    const { parseDataKeys } = await import('../src/intake/crypto.js');
    expect(() => openDoc(parseDataKeys(`k1:${KEY}`)!, 'account:00000000-0000-4000-8000-000000000000', row.data_enc)).toThrow();
    // A row from before encryption is sealed on its next read.
    await pool.query(`UPDATE account_data SET data = $1, data_enc = NULL`, [JSON.stringify(doc)]);
    expect((await c.get('/api/account/data')).json().data).toEqual(doc);
    expect((await pool.query('SELECT data_enc FROM account_data')).rows[0].data_enc).toMatch(/^d1:k1:/);
    await app2.close();
    // Rotation: a new current key; the old one stays in the ring until rows are re-sealed.
    const app3 = await makeApp(pool, { clock, mailer, env: { DATA_ENCRYPTION_KEY: `k2:${Buffer.alloc(32, 7).toString('base64')},k1:${KEY}` } });
    const c3 = new AppClient(app3);
    c3.cookies = c.cookies;
    expect((await c3.get('/api/account/data')).json().data).toEqual(doc);
    expect((await pool.query('SELECT data_enc FROM account_data')).rows[0].data_enc).toMatch(/^d2:|^d1:k2:/);
    await app3.close();
  });
});
