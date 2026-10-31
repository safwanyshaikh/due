import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadGmailConfig } from '../src/config.js';
import type { Pool } from '../src/db.js';
import { registerGmailJobs } from '../src/gmail/index.js';
import { buildAuthorizeUrl, normaliseScopes, readIdToken, scopesMatch } from '../src/gmail/google.js';
import { parseTokenKeys, seal, TokenKeyMissingError, unseal } from '../src/gmail/keys.js';
import { classifyMessage, extractMessage, htmlToPlainText } from '../src/gmail/mime.js';
import { buildQueries } from '../src/gmail/scan.js';
import { GMAIL_CONSENT_VERSION, MAX_MANUAL_SCANS_PER_DAY } from '../src/gmail/service.js';
import { drainQueue } from '../src/queue/index.js';
import { CLIENT_ID, CLIENT_SECRET, GoogleMock, idToken, message } from './googleMock.js';
import { AppClient, freshDb, grantPlan, makeApp, RecordingMailer, signIn, silentLog, TestClock } from './helpers.js';

const K1 = Buffer.alloc(32, 1).toString('base64');
const K2 = Buffer.alloc(32, 2).toString('base64');
const REDIRECT = 'https://due.example.test/api/account/gmail/callback';
const GMAIL_ENV = {
  GOOGLE_CLIENT_ID: CLIENT_ID,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: REDIRECT,
  GMAIL_TOKEN_KEYS: `k1:${K1}`,
  GMAIL_OAUTH_MODE: 'test',
};

let pool: Pool;
let app: FastifyInstance;
let mailer: RecordingMailer;
const google = new GoogleMock();
const clock = new TestClock(new Date('2026-10-30T10:00:00Z'));

async function setup(env: Record<string, string> = GMAIL_ENV) {
  await app?.close();
  await pool?.end();
  pool = await freshDb();
  clock.set('2026-10-30T10:00:00Z');
  mailer = new RecordingMailer();
  app = await makeApp(pool, { clock, mailer, env });
  app.deps.config.gmail.endpoints = google.endpoints();
  google.reset();
  google.nowSec = () => Math.floor(clock.now.getTime() / 1000);
}

beforeAll(async () => {
  await google.start();
});
beforeEach(async () => {
  await setup();
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
  await google.stop();
});

const n = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);

async function plusUser(email: string): Promise<AppClient> {
  const c = await signIn(app, mailer, email);
  await grantPlan(pool, email, 'plus');
  return c;
}

async function startConnect(c: AppClient): Promise<{ state: string; challenge: string; url: URL }> {
  const r = await c.post('/api/account/gmail/connect', { consentVersion: GMAIL_CONSENT_VERSION });
  expect(r.statusCode, r.body).toBe(200);
  const url = new URL(r.json().authorizeUrl);
  return { state: url.searchParams.get('state')!, challenge: url.searchParams.get('code_challenge')!, url };
}

function callbackUrl(state: string, code: string) {
  return `/api/account/gmail/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}&scope=x`;
}

/** Full connect: Due -> (simulated) Google consent -> callback. Returns the redirect location. */
async function connect(c: AppClient, gmail: string, opts: { scope?: string } = {}): Promise<string> {
  const { state, challenge } = await startConnect(c);
  const code = google.issueCode(challenge, { email: gmail, scope: opts.scope });
  const r = await c.get(callbackUrl(state, code));
  expect(r.statusCode).toBe(302);
  return r.headers.location as string;
}

function workerDeps() {
  return { pool, config: app.deps.config, clock: clock.fn, mailer: null, log: silentLog };
}

async function drain() {
  registerGmailJobs();
  return drainQueue(workerDeps(), { types: ['gmail.scan'] });
}

async function identityOf(c: AppClient, email: string) {
  const r = await c.get('/api/account/identities');
  return (r.json().items as { id: string; email: string; status: string; kind: string }[]).find((i) => i.email === email)!;
}

const NETFLIX_TEXT = 'Hi, your Netflix Standard plan renews on 12 Nov 2026.\nAmount: ₹649 per month.\nManage: https://www.netflix.com/account';

/** Paths Due is allowed to touch at Google. */
function assertReadOnly() {
  for (const r of google.requests) {
    const ok =
      (r.method === 'POST' && (r.path === '/token' || r.path === '/revoke')) ||
      (r.method === 'GET' && /^\/gmail\/v1\/users\/me\/messages(\/[A-Za-z0-9_-]+(\/attachments\/[A-Za-z0-9_-]+)?)?$/.test(r.path));
    expect(ok, `${r.method} ${r.path}`).toBe(true);
    expect(r.path).not.toMatch(/send|modify|trash|delete|batch|labels|import|insert|drafts|settings/);
  }
}

describe('gmail config and helpers (unit)', () => {
  it('derives honest modes from the environment', () => {
    expect(loadGmailConfig({}).mode).toBe('not_configured');
    expect(loadGmailConfig({}).missing).toEqual(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI', 'GMAIL_TOKEN_KEYS']);
    expect(loadGmailConfig({ ...GMAIL_ENV, GMAIL_OAUTH_MODE: undefined }).mode).toBe('test_mode');
    expect(loadGmailConfig({ ...GMAIL_ENV, GMAIL_OAUTH_MODE: 'verification_pending' }).mode).toBe('verification_pending');
    expect(loadGmailConfig({ ...GMAIL_ENV, GMAIL_OAUTH_MODE: 'live' }).mode).toBe('live');
    expect(loadGmailConfig({ ...GMAIL_ENV, GMAIL_OAUTH_MODE: 'bogus' }).mode).toBe('not_configured');
    expect(loadGmailConfig({ ...GMAIL_ENV, GOOGLE_REDIRECT_URI: 'http://evil.example/cb' }).mode).toBe('not_configured');
    expect(loadGmailConfig({ ...GMAIL_ENV, GMAIL_TOKEN_KEYS: 'k1:short' }).missing[0]).toMatch(/GMAIL_TOKEN_KEYS \(invalid/);
  });

  it('encrypts tokens with the current key and decrypts by kid after rotation', () => {
    const old = parseTokenKeys(`k1:${K1}`)!;
    const rotated = parseTokenKeys(`k2:${K2},k1:${K1}`)!;
    const s = seal(old, 'rt-secret', 'refresh:abc');
    expect(s.kid).toBe('k1');
    expect(s.value).not.toContain('rt-secret');
    expect(unseal(rotated, s.kid, s.value, 'refresh:abc')).toBe('rt-secret');
    expect(seal(rotated, 'x', 'c').kid).toBe('k2');
    // Bound to its row/field: another context fails.
    expect(() => unseal(rotated, s.kid, s.value, 'refresh:other')).toThrow();
    expect(() => unseal(parseTokenKeys(`k2:${K2}`)!, s.kid, s.value, 'refresh:abc')).toThrow(TokenKeyMissingError);
    expect(() => parseTokenKeys(`k1:${K1},k1:${K2}`)).toThrow(/repeated/);
  });

  it('builds the authorize URL with PKCE S256, offline access, forced consent and no incremental scopes', () => {
    const u = new URL(buildAuthorizeUrl(loadGmailConfig(GMAIL_ENV).endpoints, { clientId: CLIENT_ID, redirectUri: REDIRECT, state: 's', codeChallenge: 'c' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/gmail.readonly');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('include_granted_scopes')).toBe('false');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('redirect_uri')).toBe(REDIRECT);
  });

  it('compares scopes exactly and validates ID token claims', () => {
    expect(scopesMatch(['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly'])).toBe(true);
    expect(scopesMatch(['openid', 'email'])).toBe(false);
    expect(scopesMatch(['openid', 'email', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.modify'])).toBe(false);
    expect(normaliseScopes(['email', 'profile'])).toEqual(['https://www.googleapis.com/auth/userinfo.email']);
    const now = new Date('2026-10-30T10:00:00Z');
    const good = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', email: 'A@Gmail.com', email_verified: true, exp: now.getTime() / 1000 + 60 };
    expect(readIdToken(idToken(good), CLIENT_ID, now)).toEqual({ sub: '1', email: 'a@gmail.com', emailVerified: true });
    expect(readIdToken(idToken({ ...good, aud: 'other' }), CLIENT_ID, now)).toBeNull();
    expect(readIdToken(idToken({ ...good, iss: 'https://evil' }), CLIENT_ID, now)).toBeNull();
  });

  it('builds category and keyword-only queries, plus sender filters', () => {
    const q = buildQueries({ since: null, senderFilters: ['netflix.com', 'bad filter'] });
    expect(q).toHaveLength(3);
    expect(q[0]).toMatch(/^\{category:updates category:promotions category:personal\} \{subscription renewal trial/);
    expect(q[0]).toContain('"school fee"');
    expect(q[1]).not.toContain('category:');
    expect(q[1]).toMatch(/newer_than:365d$/);
    expect(q[2]).toBe('{from:netflix.com} newer_than:365d');
    expect(buildQueries({ since: new Date('2026-10-01T00:00:00Z'), senderFilters: [] })[1]).toMatch(/after:1790812800$/);
  });

  it('reads text/plain, falls back to stripped HTML, and never treats attachments as body', () => {
    const plain = extractMessage(message('a', { from: 'Netflix <info@mailer.netflix.com>', subject: 'Renewal', text: 'plain body', html: '<b>html</b>' }));
    expect(plain.text).toBe('plain body');
    expect(plain.fromDomain).toBe('mailer.netflix.com');
    const html = extractMessage(message('b', { from: 'x@y.com', subject: 's', html: '<style>p{}</style><script>alert(1)</script><p>Total &#8377;499</p><a href="javascript:x">link</a>' }));
    expect(html.textSource).toBe('html');
    expect(html.text).toContain('Total ₹499');
    expect(html.text).not.toMatch(/script|alert|javascript|style/);
    const att = extractMessage(message('c', { from: 'x@y.com', subject: 's', text: 'body', attachment: { filename: 'bill.txt', mimeType: 'text/plain', text: 'secret' } }));
    expect(att.text).toBe('body');
    expect(att.attachmentCount).toBe(1);
    expect(htmlToPlainText('a&nbsp;&amp;&lt;b&gt;')).toBe('a &<b>');
    expect(classifyMessage('Your free trial ends soon', '', false)).toBe('trial');
    expect(classifyMessage('Hello', 'lunch on friday?', false)).toBe('irrelevant');
  });
});

describe('gmail status and plan gating', () => {
  it('reports not_configured and refuses to connect (503) without credentials', async () => {
    await setup({});
    const st = await new AppClient(app).get('/api/account/gmail/status');
    expect(st.statusCode).toBe(200);
    expect(st.json().mode).toBe('not_configured');
    expect(st.json().missing).toContain('GOOGLE_CLIENT_ID');
    expect(st.json().scopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    const c = await plusUser('nc@example.com');
    const r = await c.post('/api/account/gmail/connect', { consentVersion: GMAIL_CONSENT_VERSION });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('gmail_not_configured');
    const cb = await c.get('/api/account/gmail/callback?state=x&code=y');
    expect(cb.headers.location).toBe('/?gmail=error&reason=not_configured');
    expect(await n('SELECT count(*) AS n FROM email_identities')).toBe(0);
  });

  it('reports test_mode with its blocker when configured for Google testing', async () => {
    const st = (await new AppClient(app).get('/api/account/gmail/status')).json();
    expect(st.mode).toBe('test_mode');
    expect(st.blocker).toMatch(/test users/);
    expect(st.consentVersion).toBe(GMAIL_CONSENT_VERSION);
  });

  it('requires Plus to connect or scan; disconnect is always allowed', async () => {
    const free = await signIn(app, mailer, 'free@example.com');
    const r = await free.post('/api/account/gmail/connect', { consentVersion: GMAIL_CONSENT_VERSION });
    expect(r.statusCode).toBe(402);
    expect(r.json().error.code).toBe('premium_required');
    expect(await n('SELECT count(*) AS n FROM oauth_states')).toBe(0);
    const anon = await new AppClient(app).post('/api/account/gmail/connect', { consentVersion: GMAIL_CONSENT_VERSION });
    expect(anon.statusCode).toBe(401);

    // Plus connects; then the plan lapses: scans are refused and queued scans stop, disconnect works.
    const c = await plusUser('lapse@example.com');
    await connect(c, 'lapse@gmail.com');
    const ident = await identityOf(c, 'lapse@gmail.com');
    await pool.query(`UPDATE entitlements SET status = 'expired' WHERE account_id = (SELECT id FROM consumer_accounts WHERE email = 'lapse@example.com')`);
    const scan = await c.post(`/api/account/gmail/${ident.id}/scan`);
    expect(scan.statusCode).toBe(402);
    await drain();
    const run = (await pool.query(`SELECT status, error_code FROM gmail_scan_runs WHERE identity_id = $1`, [ident.id])).rows[0];
    expect(run).toEqual({ status: 'cancelled', error_code: 'premium_required' });
    expect(google.count('GET', '/gmail')).toBe(0);
    const d = await c.post(`/api/account/gmail/${ident.id}/disconnect`, { deleteImported: false });
    expect(d.statusCode).toBe(200);
  });

  it('rejects a stale consent version', async () => {
    const c = await plusUser('cv@example.com');
    const r = await c.post('/api/account/gmail/connect', { consentVersion: 'old' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('consent_version_mismatch');
  });
});

describe('gmail OAuth state and PKCE', () => {
  it('connects: stores only a hashed state, exchanges with the PKCE verifier, encrypts tokens and records consent', async () => {
    const c = await plusUser('ok@example.com');
    const { state, challenge, url } = await startConnect(c);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    const st = (await pool.query('SELECT * FROM oauth_states')).rows;
    expect(st).toHaveLength(1);
    expect(st[0].state_hash).not.toBe(state);
    expect(JSON.stringify(st)).not.toContain(state);
    expect(st[0].expires_at.getTime() - st[0].created_at.getTime()).toBe(10 * 60 * 1000);

    const code = google.issueCode(challenge, { email: 'Me@Gmail.com' });
    const r = await c.get(callbackUrl(state, code));
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toMatch(/^\/\?gmail=connected&identity=[0-9a-f-]{36}$/);
    const tokenCall = google.requests.find((x) => x.path === '/token')!;
    expect(tokenCall.form.grant_type).toBe('authorization_code');
    expect(tokenCall.form.redirect_uri).toBe(REDIRECT);
    expect(tokenCall.form.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    const ident = await identityOf(c, 'me@gmail.com');
    expect(ident).toMatchObject({ kind: 'gmail', status: 'active', consentVersion: GMAIL_CONSENT_VERSION });
    const conn = (await pool.query('SELECT * FROM gmail_connections')).rows[0];
    expect(conn.token_kid).toBe('k1');
    expect(conn.google_sub).toBe('sub-Me@Gmail.com');
    expect(JSON.stringify(conn)).not.toMatch(/rt-secret|"at-\d/);
    expect(conn.refresh_token_enc).toMatch(/^g1:/);
    const consent = (await pool.query(`SELECT granted, text_version, source FROM consent_records WHERE purpose = 'gmail'`)).rows;
    expect(consent).toEqual([{ granted: true, text_version: GMAIL_CONSENT_VERSION, source: 'oauth' }]);
    // An initial scan was queued; its payload carries ids only.
    const job = (await pool.query(`SELECT payload FROM jobs_queue WHERE type = 'gmail.scan'`)).rows[0];
    expect(Object.keys(job.payload).sort()).toEqual(['identityId', 'runId']);
    // Identity view never exposes tokens.
    expect(JSON.stringify((await c.get('/api/account/identities')).json())).not.toMatch(/rt-secret|token_enc/);
  });

  it('rejects a wrong state, a replayed state, an expired state, another account, and a changed redirect URI', async () => {
    const c = await plusUser('st@example.com');

    const bad = await c.get(callbackUrl('not-a-real-state', 'code'));
    expect(bad.headers.location).toBe('/?gmail=error&reason=invalid_state');

    const first = await startConnect(c);
    const code = google.issueCode(first.challenge, { email: 'st@gmail.com' });
    expect((await c.get(callbackUrl(first.state, code))).headers.location).toMatch(/gmail=connected/);
    const replay = await c.get(callbackUrl(first.state, code));
    expect(replay.headers.location).toBe('/?gmail=error&reason=state_replayed');

    const exp = await startConnect(c);
    clock.advanceMinutes(11);
    const late = await c.get(callbackUrl(exp.state, google.issueCode(exp.challenge, { email: 'st@gmail.com' })));
    expect(late.headers.location).toBe('/?gmail=error&reason=state_expired');

    const other = await plusUser('other@example.com');
    const mine = await startConnect(c);
    const stolen = await other.get(callbackUrl(mine.state, google.issueCode(mine.challenge, { email: 'x@gmail.com' })));
    expect(stolen.headers.location).toBe('/?gmail=error&reason=account_mismatch');
    const anon = await new AppClient(app).get(callbackUrl((await startConnect(c)).state, 'c'));
    expect(anon.headers.location).toBe('/?gmail=error&reason=account_mismatch');

    const redir = await startConnect(c);
    app.deps.config.gmail.oauth!.redirectUri = 'https://due.example.test/other/callback';
    const wrong = await c.get(callbackUrl(redir.state, google.issueCode(redir.challenge, { email: 'st@gmail.com' })));
    expect(wrong.headers.location).toBe('/?gmail=error&reason=redirect_mismatch');
    app.deps.config.gmail.oauth!.redirectUri = REDIRECT;

    // A code whose PKCE challenge does not match the stored verifier is refused by the token endpoint.
    const pk = await startConnect(c);
    const forged = await c.get(callbackUrl(pk.state, google.issueCode('forged-challenge', { email: 'st@gmail.com' })));
    expect(forged.headers.location).toBe('/?gmail=error&reason=token_exchange_failed');

    // User denied at Google.
    const den = await startConnect(c);
    const denied = await c.get(`/api/account/gmail/callback?state=${encodeURIComponent(den.state)}&error=access_denied`);
    expect(denied.headers.location).toBe('/?gmail=error&reason=access_denied');
    expect(await n(`SELECT count(*) AS n FROM email_identities WHERE kind = 'gmail'`)).toBe(1);
  });

  it('marks scope_mismatch, keeps no token and revokes the grant when scopes differ', async () => {
    const c = await plusUser('scope@example.com');
    const loc = await connect(c, 'scope@gmail.com', { scope: 'openid https://www.googleapis.com/auth/userinfo.email' });
    expect(loc).toBe('/?gmail=error&reason=scope_mismatch');
    const ident = await identityOf(c, 'scope@gmail.com');
    expect(ident.status).toBe('error');
    expect((ident as unknown as { statusReason: string }).statusReason).toBe('scope_mismatch');
    const conn = (await pool.query('SELECT * FROM gmail_connections')).rows[0];
    expect(conn.refresh_token_enc).toBeNull();
    expect(conn.revoked_at).not.toBeNull();
    expect(google.revoked.length).toBeGreaterThan(0);
    const scan = await c.post(`/api/account/gmail/${ident.id}/scan`);
    expect(scan.statusCode).toBe(409);
    expect(scan.json().error.code).toBe('identity_not_active');

    // Broader-than-disclosed scope is also refused.
    const loc2 = await connect(c, 'scope2@gmail.com', {
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify',
    });
    expect(loc2).toBe('/?gmail=error&reason=scope_mismatch');

    // Reconnecting with the right scopes clears the error.
    expect(await connect(c, 'scope@gmail.com')).toMatch(/gmail=connected/);
    expect((await identityOf(c, 'scope@gmail.com')).status).toBe('active');

    // A refresh that reports different scopes flags the identity again.
    await pool.query(`UPDATE gmail_connections SET expires_at = $1`, [new Date('2026-10-30T09:00:00Z')]);
    google.refreshScope = 'openid https://www.googleapis.com/auth/userinfo.email';
    await drain();
    expect((await identityOf(c, 'scope@gmail.com')).status).toBe('error');
    assertReadOnly();
  });
});

describe('gmail scan', () => {
  it('imports review candidates read-only, dedupes by message id and fingerprint, and skips attachments by default', async () => {
    const c = await plusUser('scan@example.com');
    google.addMessage(message('m1', { from: 'Netflix <info@mailer.netflix.com>', subject: 'Your membership will renew', text: NETFLIX_TEXT }));
    // Same content, different Gmail id (e.g. a copy in another label): fingerprint duplicate.
    google.addMessage(message('m2', { from: 'Netflix <info@mailer.netflix.com>', subject: 'Your membership will renew', text: NETFLIX_TEXT, messageId: '<m2-other@mail.test>' }));
    google.addMessage(message('m3', { from: 'friend@example.org', subject: 'Lunch?', text: 'See you at noon on friday' }));
    google.addMessage(
      message('m4', {
        from: 'Airtel <bills@airtel.in>',
        subject: 'Your postpaid bill is ready',
        text: 'Your Airtel postpaid bill of Rs 799 is due on 15 Nov 2026.',
        attachment: { filename: 'bill.txt', mimeType: 'text/plain', text: 'ATTACHMENT-ONLY ₹123456' },
      }),
      'ATTACHMENT-ONLY ₹123456',
    );
    await connect(c, 'scan@gmail.com');
    const ident = await identityOf(c, 'scan@gmail.com');
    const res = await drain();
    expect(res.byStatus).toEqual({ succeeded: 1 });

    const events = (await pool.query(`SELECT * FROM user_events WHERE intake_type = 'gmail' ORDER BY created_at`)).rows;
    expect(events).toHaveLength(2);
    const netflix = events.find((e) => e.source_meta.gmailMessageId === 'm1')!;
    expect(netflix.identity_id).toBe(ident.id);
    expect(netflix.extracted_fields.amountInr).toBe(649);
    expect(netflix.extracted_fields.renewalDate).toBe('2026-11-12');
    expect(netflix.confidence.amountInr).toBeGreaterThan(0);
    expect(netflix.source_meta).toMatchObject({ source: 'gmail', fromDomain: 'mailer.netflix.com', messageClass: 'renewal', date: '2026-10-20T08:00:00.000Z' });
    expect(netflix.source_meta.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(netflix.raw_text).toBeNull(); // no DATA_ENCRYPTION_KEY: no body stored
    const airtel = events.find((e) => e.source_meta.gmailMessageId === 'm4')!;
    expect(airtel.source_meta.attachmentsSkipped).toBe(1);
    expect(JSON.stringify(airtel)).not.toContain('123456');
    expect(google.count('GET', '/gmail/v1/users/me/messages/m4/attachments')).toBe(0);

    const run = (await pool.query('SELECT * FROM gmail_scan_runs WHERE identity_id = $1', [ident.id])).rows[0];
    expect(run).toMatchObject({ status: 'succeeded', trigger: 'initial', messages_listed: 4, messages_new: 4, events_created: 2, duplicates: 1, attachments_skipped: 1 });
    expect(await n('SELECT count(*) AS n FROM gmail_messages_seen WHERE identity_id = $1', [ident.id])).toBe(4);
    const lists = google.requests.filter((r) => r.path === '/gmail/v1/users/me/messages');
    expect(lists.some((r) => r.query.q!.startsWith('{category:updates'))).toBe(true);
    expect(lists.some((r) => !r.query.q!.includes('category:'))).toBe(true);
    expect(google.requests.filter((r) => /messages\/m\d$/.test(r.path)).every((r) => r.query.format === 'full')).toBe(true);

    // Review queue shows them with intake type 'gmail'.
    const q = (await c.get('/api/intake/events')).json();
    expect(q.items.filter((i: { intakeType: string }) => i.intakeType === 'gmail')).toHaveLength(2);
    const view = (await c.get('/api/account/identities')).json().items[0];
    expect(view.lastScanStatus).toBe('ok');
    expect(view.lastScanAt).toBe('2026-10-30T10:00:00.000Z');

    // Rescan: seen ids are not fetched again and nothing is duplicated; the window is incremental.
    const before = google.count('GET', '/gmail/v1/users/me/messages/');
    clock.advanceMinutes(60);
    const scan = await c.post(`/api/account/gmail/${ident.id}/scan`);
    expect(scan.statusCode).toBe(202);
    await drain();
    expect(google.count('GET', '/gmail/v1/users/me/messages/')).toBe(before);
    expect(await n(`SELECT count(*) AS n FROM user_events WHERE intake_type = 'gmail'`)).toBe(2);
    const lastList = google.requests.filter((r) => r.path === '/gmail/v1/users/me/messages').pop()!;
    expect(lastList.query.q).toMatch(/after:\d+$/);

    // A forwarded copy of the same message already in the queue is not duplicated by Gmail either.
    assertReadOnly();
    const methods = new Set(google.requests.map((r) => `${r.method} ${r.path.replace(/messages\/.+$/, 'messages/:id')}`));
    expect([...methods].sort()).toEqual(['GET /gmail/v1/users/me/messages', 'GET /gmail/v1/users/me/messages/:id', 'POST /token']);
  });

  it('reads small text attachments only when the user enables them, and stores an encrypted excerpt only with DATA_ENCRYPTION_KEY', async () => {
    await setup({ ...GMAIL_ENV, DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') });
    const c = await plusUser('att@example.com');
    google.addMessage(
      message('a1', {
        from: 'School <fees@school.edu.in>',
        subject: 'School fee reminder',
        text: 'Term school fee reminder.',
        attachment: { filename: 'fee.txt', mimeType: 'text/plain', text: 'Amount due Rs 15,000 by 10 Nov 2026' },
      }),
      'Amount due Rs 15,000 by 10 Nov 2026',
    );
    await connect(c, 'att@gmail.com');
    const ident = await identityOf(c, 'att@gmail.com');
    await pool.query(`DELETE FROM jobs_queue`);
    await pool.query(`DELETE FROM gmail_scan_runs`);
    const p = await c.patch(`/api/account/identities/${ident.id}`, { attachmentsEnabled: true });
    expect(p.statusCode).toBe(200);
    expect((await c.post(`/api/account/gmail/${ident.id}/scan`)).statusCode).toBe(202);
    await drain();
    expect(google.count('GET', '/gmail/v1/users/me/messages/a1/attachments/')).toBe(1);
    const e = (await pool.query(`SELECT * FROM user_events WHERE intake_type = 'gmail'`)).rows[0];
    expect(e.extracted_fields.amountInr).toBe(15000);
    expect(e.source_meta.messageClass).toBe('school_fee');
    expect(e.raw_text).toMatch(/^v1:/);
    expect(e.raw_retention_until.getTime() - clock.now.getTime()).toBe(3 * 86400_000);
    assertReadOnly();
  });

  it('rate limits scans: one in progress per identity and at most 4 manual scans a day', async () => {
    const c = await plusUser('rl@example.com');
    await connect(c, 'rl@gmail.com');
    const ident = await identityOf(c, 'rl@gmail.com');
    // The initial scan is still queued.
    const busy = await c.post(`/api/account/gmail/${ident.id}/scan`);
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error.code).toBe('scan_in_progress');
    await drain();
    for (let i = 0; i < MAX_MANUAL_SCANS_PER_DAY; i++) {
      expect((await c.post(`/api/account/gmail/${ident.id}/scan`)).statusCode).toBe(202);
      await drain();
    }
    const over = await c.post(`/api/account/gmail/${ident.id}/scan`);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('scan_limit');
    clock.advanceMinutes(24 * 60 + 1);
    expect((await c.post(`/api/account/gmail/${ident.id}/scan`)).statusCode).toBe(202);
  });

  it('refreshes expired tokens and re-encrypts them under the newest key after rotation', async () => {
    const c = await plusUser('rot@example.com');
    google.addMessage(message('r1', { from: 'Netflix <info@mailer.netflix.com>', subject: 'Renewal', text: NETFLIX_TEXT }));
    await connect(c, 'rot@gmail.com');
    app.deps.config.gmail.oauth!.tokenKeys = parseTokenKeys(`k2:${K2},k1:${K1}`)!;
    // Token still fresh: re-encrypted without contacting Google.
    await drain();
    let conn = (await pool.query('SELECT * FROM gmail_connections')).rows[0];
    expect(conn.token_kid).toBe('k2');
    expect(google.requests.filter((r) => r.form.grant_type === 'refresh_token')).toHaveLength(0);
    // k1 retired entirely: still works; an expired token is refreshed and stored under k2.
    app.deps.config.gmail.oauth!.tokenKeys = parseTokenKeys(`k2:${K2}`)!;
    await pool.query(`UPDATE gmail_connections SET expires_at = $1`, [new Date('2026-10-30T09:00:00Z')]);
    clock.advanceMinutes(60);
    expect((await c.post(`/api/account/gmail/${(await identityOf(c, 'rot@gmail.com')).id}/scan`)).statusCode).toBe(202);
    await drain();
    conn = (await pool.query('SELECT * FROM gmail_connections')).rows[0];
    expect(conn.token_kid).toBe('k2');
    expect(conn.expires_at.getTime()).toBeGreaterThan(clock.now.getTime());
    expect(google.requests.filter((r) => r.form.grant_type === 'refresh_token')).toHaveLength(1);
    // A key ring without the stored kid flags the identity instead of failing silently.
    app.deps.config.gmail.oauth!.tokenKeys = parseTokenKeys(`k3:${K1}`)!;
    await pool.query(`UPDATE gmail_connections SET expires_at = $1`, [new Date('2026-10-30T09:00:00Z')]);
    clock.advanceMinutes(60);
    await c.post(`/api/account/gmail/${(await identityOf(c, 'rot@gmail.com')).id}/scan`);
    await drain();
    const ident = (await c.get('/api/account/identities')).json().items[0];
    expect(ident).toMatchObject({ status: 'error', statusReason: 'token_key_missing' });
  });

  it('marks token_revoked when Google rejects the refresh token', async () => {
    const c = await plusUser('rev@example.com');
    await connect(c, 'rev@gmail.com');
    await pool.query(`UPDATE gmail_connections SET expires_at = $1`, [new Date('2026-10-30T09:00:00Z')]);
    google.revoked.push(...google.refreshTokens.keys());
    await drain();
    const ident = (await c.get('/api/account/identities')).json().items[0];
    expect(ident).toMatchObject({ status: 'error', statusReason: 'token_revoked', lastScanStatus: 'error', lastScanErrorCode: 'token_revoked' });
    expect((await pool.query('SELECT refresh_token_enc FROM gmail_connections')).rows[0].refresh_token_enc).toBeNull();
  });
});

describe('gmail disconnect and identity data', () => {
  it('disconnect revokes at Google, wipes tokens, stops queued scans immediately, and can delete imported data', async () => {
    const c = await plusUser('dis@example.com');
    google.addMessage(message('d1', { from: 'Netflix <info@mailer.netflix.com>', subject: 'Renewal', text: NETFLIX_TEXT }));
    await connect(c, 'dis@gmail.com');
    const ident = await identityOf(c, 'dis@gmail.com');
    await drain();
    expect(await n(`SELECT count(*) AS n FROM user_events WHERE identity_id = $1`, [ident.id])).toBe(1);

    // Queue another scan, then disconnect before the worker runs it.
    clock.advanceMinutes(60);
    expect((await c.post(`/api/account/gmail/${ident.id}/scan`)).statusCode).toBe(202);
    const gmailCallsBefore = google.count('GET', '/gmail');
    const d = await c.post(`/api/account/gmail/${ident.id}/disconnect`, { deleteImported: false });
    expect(d.statusCode).toBe(200);
    // Seen-ids (message ids only) are always dropped on disconnect; events stay unless deleteImported.
    expect(d.json()).toMatchObject({ ok: true, revoked: true, deleted: { events: 0, seen: 1 } });
    expect(google.revoked.some((t) => t.startsWith('rt-secret-'))).toBe(true);
    const conn = (await pool.query('SELECT * FROM gmail_connections')).rows[0];
    expect(conn).toMatchObject({ access_token_enc: null, refresh_token_enc: null, token_kid: null });
    expect(conn.revoked_at).not.toBeNull();
    expect((await identityOf(c, 'dis@gmail.com')).status).toBe('disconnected');
    await drain();
    expect(google.count('GET', '/gmail')).toBe(gmailCallsBefore);
    expect((await pool.query(`SELECT status FROM gmail_scan_runs ORDER BY requested_at DESC LIMIT 1`)).rows[0].status).toBe('cancelled');
    const consents = (await pool.query(`SELECT granted FROM consent_records WHERE purpose = 'gmail' ORDER BY id`)).rows.map((r) => r.granted);
    expect(consents).toEqual([true, false]);
    // Imported data kept (deleteImported false), further scans refused.
    expect(await n(`SELECT count(*) AS n FROM user_events WHERE identity_id = $1`, [ident.id])).toBe(1);
    expect((await c.post(`/api/account/gmail/${ident.id}/scan`)).statusCode).toBe(409);

    // Second disconnect with deleteImported removes the derived events too.
    const d2 = await c.post(`/api/account/gmail/${ident.id}/disconnect`, { deleteImported: true });
    expect(d2.json().deleted).toEqual({ events: 1, seen: 0 });
    expect(await n(`SELECT count(*) AS n FROM user_events WHERE intake_type = 'gmail'`)).toBe(0);
    assertReadOnly();
  });

  it('stops a scan mid-run when the identity is disconnected', async () => {
    const c = await plusUser('mid@example.com');
    for (let i = 0; i < 5; i++) google.addMessage(message(`x${i}`, { from: 'Netflix <info@mailer.netflix.com>', subject: `Renewal ${i}`, text: `${NETFLIX_TEXT}\nref ${i}` }));
    await connect(c, 'mid@gmail.com');
    const ident = await identityOf(c, 'mid@gmail.com');
    // Simulate a disconnect landing while the scan runs: flip status after the first message fetch.
    let fetched = 0;
    const handler = google.server!.listeners('request')[0] as (...a: unknown[]) => void;
    google.server!.removeAllListeners('request');
    google.server!.on('request', (req: { url?: string; method?: string }, res: unknown) => {
      if (req.method === 'GET' && /messages\/x\d/.test(req.url ?? '') && ++fetched === 1) {
        void pool.query(`UPDATE email_identities SET status = 'disconnected' WHERE id = $1`, [ident.id]).then(() => handler(req, res));
        return;
      }
      handler(req, res);
    });
    await drain();
    google.server!.removeAllListeners('request');
    google.server!.on('request', handler);
    expect(fetched).toBe(1);
    const run = (await pool.query(`SELECT status, error_code FROM gmail_scan_runs WHERE identity_id = $1`, [ident.id])).rows[0];
    expect(run).toEqual({ status: 'cancelled', error_code: 'identity_not_active' });
  });

  it('isolates identities between accounts', async () => {
    const a = await plusUser('a@example.com');
    const b = await plusUser('b@example.com');
    google.addMessage(message('i1', { from: 'Netflix <info@mailer.netflix.com>', subject: 'Renewal', text: NETFLIX_TEXT }));
    await connect(a, 'shared@gmail.com');
    await drain();
    const ia = await identityOf(a, 'shared@gmail.com');
    expect((await b.get('/api/account/identities')).json().items).toEqual([]);
    expect((await b.post(`/api/account/gmail/${ia.id}/scan`)).statusCode).toBe(404);
    expect((await b.post(`/api/account/gmail/${ia.id}/disconnect`, {})).statusCode).toBe(404);
    expect((await b.get(`/api/account/gmail/${ia.id}/scans`)).statusCode).toBe(404);
    expect((await b.del(`/api/account/identities/${ia.id}?deleteData=true`)).statusCode).toBe(404);
    expect((await b.patch(`/api/account/identities/${ia.id}`, { label: 'x' })).statusCode).toBe(404);
    expect((await b.get('/api/intake/events')).json().items).toEqual([]);
    // B may link the same Gmail address to their own account: a separate identity, never merged.
    await connect(b, 'shared@gmail.com');
    const ib = await identityOf(b, 'shared@gmail.com');
    expect(ib.id).not.toBe(ia.id);
    await drain();
    expect(await n(`SELECT count(*) AS n FROM user_events WHERE intake_type = 'gmail'`)).toBe(2);
    expect(await n(`SELECT count(DISTINCT account_id) AS n FROM user_events WHERE intake_type = 'gmail'`)).toBe(2);
    expect((await a.get('/api/account/identities')).json().items).toHaveLength(1);
  });

  it('manages work/family/forwarding identities and deletes identity data on request', async () => {
    const c = await signIn(app, mailer, 'ids@example.com');
    const w = await c.post('/api/account/identities', { kind: 'work', label: 'Work', email: 'Me@Corp.example', consentVersion: 'v1' });
    expect(w.statusCode).toBe(201);
    expect(w.json().identity).toMatchObject({ kind: 'work', email: 'me@corp.example', status: 'active', consentVersion: 'v1' });
    expect((await c.post('/api/account/identities', { kind: 'work', label: 'Dup', email: 'me@corp.example' })).statusCode).toBe(409);
    expect((await c.post('/api/account/identities', { kind: 'family', label: 'Family', email: 'me@corp.example' })).statusCode).toBe(201);
    expect((await c.post('/api/account/identities', { kind: 'gmail', label: 'G', email: 'g@gmail.com' })).statusCode).toBe(400);
    const id = w.json().identity.id;
    const p = await c.patch(`/api/account/identities/${id}`, { label: 'Office', status: 'paused' });
    expect(p.json().identity).toMatchObject({ label: 'Office', status: 'paused' });
    expect((await c.patch(`/api/account/identities/${id}`, { attachmentsEnabled: true })).statusCode).toBe(400);
    expect((await c.del(`/api/account/identities/${id}`)).statusCode).toBe(200);
    expect((await c.get('/api/account/identities')).json().items).toHaveLength(1);

    // Gmail identity delete: keep vs delete derived data.
    await grantPlan(pool, 'ids@example.com', 'plus');
    google.addMessage(message('k1', { from: 'Netflix <info@mailer.netflix.com>', subject: 'Renewal', text: NETFLIX_TEXT }));
    await connect(c, 'keep@gmail.com');
    await drain();
    const keep = await identityOf(c, 'keep@gmail.com');
    const r1 = await c.del(`/api/account/identities/${keep.id}?deleteData=false`);
    expect(r1.json()).toMatchObject({ ok: true, revoked: true, deleted: { events: 0, seen: 1 } });
    // Event kept, detached from the deleted identity.
    expect((await pool.query(`SELECT identity_id FROM user_events WHERE intake_type = 'gmail'`)).rows).toEqual([{ identity_id: null }]);
    expect(await n('SELECT count(*) AS n FROM gmail_connections')).toBe(0);

    google.messages.clear();
    google.addMessage(message('k2', { from: 'Spotify <no-reply@spotify.com>', subject: 'Your Premium renews', text: 'Spotify Premium renews on 1 Dec 2026. Total ₹119 per month.' }));
    await connect(c, 'gone@gmail.com');
    await drain();
    const gone = await identityOf(c, 'gone@gmail.com');
    expect(await n('SELECT count(*) AS n FROM user_events WHERE identity_id = $1', [gone.id])).toBe(1);
    const r2 = await c.del(`/api/account/identities/${gone.id}?deleteData=true`);
    expect(r2.json().deleted).toEqual({ events: 1, seen: 1 });
    expect(await n(`SELECT count(*) AS n FROM user_events WHERE intake_type = 'gmail'`)).toBe(1); // the kept one only
    expect(await n('SELECT count(*) AS n FROM gmail_messages_seen')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM email_identities WHERE kind = $1', ['gmail'])).toBe(0);
    assertReadOnly();
  });
});
