import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { decryptText } from '../src/intake/crypto.js';
import { parseDate, parseMessage, redactSensitive } from '../src/intake/parser.js';
import { generateAlias } from '../src/intake/service.js';
import { startJob } from '../src/jobs/runner.js';
import { AppClient, freshDb, loggedIn, makeApp, monitorCtx, RecordingMailer, signIn, TestClock } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;
let mailer: RecordingMailer;
const clock = new TestClock(new Date('2026-10-30T10:00:00Z'));
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'inbound-secret-0123456789';
const LIVE = { INBOUND_EMAIL_DOMAIN: 'inbox.due.test', INBOUND_WEBHOOK_SECRET: SECRET, DATA_ENCRYPTION_KEY: KEY_B64 };
const CARD = '4111 1111 1111 1111';

beforeEach(async () => {
  await app?.close();
  await pool?.end();
  pool = await freshDb();
  clock.set('2026-10-30T10:00:00Z');
  mailer = new RecordingMailer();
  app = await makeApp(pool, { clock, mailer, env: LIVE });
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const n = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);
const basic = (pass: string) => `Basic ${Buffer.from(`postmark:${pass}`).toString('base64')}`;

function netflixText(extra = '') {
  return [
    '---------- Forwarded message ---------',
    'From: Netflix <info@mailer.netflix.com>',
    'Date: Thu, 29 Oct 2026',
    'Subject: Your membership will renew',
    '',
    'Hi, your Netflix Standard plan renews on 12 Nov 2026.',
    'Amount: ₹649 per month.',
    `Card ${CARD} will be charged.`,
    'Manage: https://www.netflix.com/account?x=1',
    extra,
  ].join('\n');
}

function postmark(to: string, opts: { messageId?: string; text?: string; subject?: string } = {}) {
  return {
    From: 'me@gmail.com',
    FromFull: { Email: 'me@gmail.com' },
    To: to,
    ToFull: [{ Email: to }],
    OriginalRecipient: to,
    Subject: opts.subject ?? 'Fwd: Your membership will renew',
    MessageID: 'pm-1',
    TextBody: opts.text ?? netflixText(),
    Headers: [{ Name: 'Message-ID', Value: opts.messageId ?? '<abc-1@mail.gmail.com>' }],
  };
}

async function sendPostmark(a: FastifyInstance, payload: object, pass = SECRET) {
  return a.inject({ method: 'POST', url: '/api/inbound/email', payload, headers: { authorization: basic(pass) } });
}

async function tempSession(a: FastifyInstance = app) {
  const c = new AppClient(a);
  const r = await c.post('/api/intake/session', { consentTextVersion: 'intake-2026-10' });
  expect(r.statusCode).toBe(201);
  return { c, alias: r.json() as { alias: string; address: string; live: boolean; status: string } };
}

describe('aliases', () => {
  it('creates a unique alias per temporary session and reports live state', async () => {
    const a = await tempSession();
    const b = await tempSession();
    expect(a.alias.alias).toMatch(/^u[a-z2-7]{12}$/);
    expect(a.alias.alias).not.toBe(b.alias.alias);
    expect(a.alias).toMatchObject({ address: `${a.alias.alias}@inbox.due.test`, live: true, status: 'active' });
    expect(a.c.cookies.due_intake).toBeTruthy();
    expect(await n(`SELECT count(*) AS n FROM consent_records WHERE purpose = 'email_intake' AND granted`)).toBe(2);
    // Repeating the call returns the same session/alias.
    expect((await a.c.post('/api/intake/session', { consentTextVersion: 'v' })).json().alias).toBe(a.alias.alias);
    const gen = new Set(Array.from({ length: 2000 }, generateAlias));
    expect([...gen].every((x) => /^u[a-z2-7]{12}$/.test(x))).toBe(true);
    // ~60 bits: 2000 draws never collide.
    expect(gen.size).toBe(2000);
    // DB enforces uniqueness even if a collision were generated.
    await expect(pool.query(`INSERT INTO intake_aliases (alias, temp_session_id) SELECT $1, temp_session_id FROM intake_aliases LIMIT 1`, [a.alias.alias])).rejects.toThrow();
  });

  it('reports live:false when inbound email is not configured, and the webhook is unavailable', async () => {
    const app2 = await makeApp(pool, { clock, mailer });
    const { alias } = await tempSession(app2);
    expect(alias.live).toBe(false);
    expect(alias.address).toBeNull();
    const r = await sendPostmark(app2, postmark('uaaaaa@inbox.due.test'));
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('intake_unavailable');
    await app2.close();
  });

  it('rotates, pauses and resumes; paused and rotated aliases reject mail', async () => {
    const { c, alias } = await tempSession();
    const addr = alias.address;
    expect((await c.post('/api/intake/alias/pause')).json().status).toBe('paused');
    const paused = await sendPostmark(app, postmark(addr));
    expect(paused.statusCode).toBe(403);
    expect(paused.json().error.code).toBe('alias_rejected');
    expect((await c.post('/api/intake/alias/resume')).json().status).toBe('active');
    const rotated = (await c.post('/api/intake/alias/rotate')).json();
    expect(rotated.alias).not.toBe(alias.alias);
    expect((await sendPostmark(app, postmark(addr))).statusCode).toBe(403);
    expect((await sendPostmark(app, postmark(rotated.address))).statusCode).toBe(200);
    expect((await sendPostmark(app, postmark('uzzzzz@inbox.due.test'))).statusCode).toBe(403);
    expect((await sendPostmark(app, postmark('someone@other.test'))).statusCode).toBe(403);
    expect(await n('SELECT count(*) AS n FROM user_events')).toBe(1);
  });

  it('legacy 5-character aliases issued before go-live keep routing', async () => {
    const { alias } = await tempSession();
    await pool.query(`UPDATE intake_aliases SET alias = 'uabcde' WHERE alias = $1`, [alias.alias]);
    const r = await sendPostmark(app, postmark('uabcde@inbox.due.test'));
    expect(r.statusCode).toBe(200);
    // Other lengths are still refused by the database.
    await expect(pool.query(`UPDATE intake_aliases SET alias = 'uabcdef' WHERE alias = 'uabcde'`)).rejects.toThrow();
  });

  it('rate-limits unknown aliases per IP (429 after 30 a minute) without affecting known aliases', async () => {
    const { alias } = await tempSession();
    const unknownFrom = (ip: string, i: number) =>
      app.inject({
        method: 'POST',
        url: '/api/inbound/email',
        payload: postmark(`u${'a'.repeat(11)}${'bcdefghijklmnopqrstuvwxyz234567'[i % 31]}@inbox.due.test`, { messageId: `<probe-${i}@x>` }),
        headers: { authorization: basic(SECRET) },
        remoteAddress: ip,
      });
    for (let i = 0; i < 30; i++) expect((await unknownFrom('203.0.113.9', i)).statusCode).toBe(403);
    const limited = await unknownFrom('203.0.113.9', 30);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBe('60');
    // Another IP is unaffected, and a known alias from the limited IP is still delivered.
    expect((await unknownFrom('203.0.113.10', 0)).statusCode).toBe(403);
    const known = await app.inject({
      method: 'POST',
      url: '/api/inbound/email',
      payload: postmark(alias.address),
      headers: { authorization: basic(SECRET) },
      remoteAddress: '203.0.113.9',
    });
    expect(known.statusCode).toBe(200);
    // The window resets after a minute.
    clock.advanceMinutes(1);
    expect((await unknownFrom('203.0.113.9', 31)).statusCode).toBe(403);
  });

  it('signed-in accounts create an alias with consent', async () => {
    const acct = await signIn(app, mailer, 'alias@example.com');
    expect((await acct.get('/api/intake/alias')).json()).toEqual({ alias: null, live: true });
    const r = await acct.post('/api/intake/alias', { consentTextVersion: 'intake-2026-10' });
    expect(r.statusCode).toBe(201);
    expect(r.json().alias).toMatch(/^u[a-z2-7]{12}$/);
    expect((await acct.post('/api/intake/session', { consentTextVersion: 'v' })).statusCode).toBe(409);
  });
});

describe('inbound webhook', () => {
  it('rejects bad authentication without storing anything', async () => {
    const { alias } = await tempSession();
    expect((await sendPostmark(app, postmark(alias.address), 'wrong')).statusCode).toBe(401);
    const none = await app.inject({ method: 'POST', url: '/api/inbound/email', payload: postmark(alias.address) });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('invalid_signature');
    expect(await n('SELECT count(*) AS n FROM user_events')).toBe(0);
  });

  it('parses a forwarded receipt, encrypts redacted raw text at rest, and dedupes by Message-ID and fingerprint', async () => {
    const { c, alias } = await tempSession();
    const r = await sendPostmark(app, postmark(alias.address));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, duplicate: false, reviewStatus: 'needs_review' });

    const list = (await c.get('/api/intake/events')).json();
    expect(list.items).toHaveLength(1);
    const ev = list.items[0];
    expect(ev.extractedFields).toMatchObject({
      provider: 'Netflix',
      amountInr: 649,
      billingCycle: 'monthly',
      renewalDate: '2026-11-12',
      senderDomain: 'mailer.netflix.com',
      links: ['https://www.netflix.com/account?x=1'],
    });
    expect(ev.confidence.amountInr).toBeGreaterThan(0.5);
    expect(ev.confidence.provider).toBeLessThan(1);
    expect(ev).toMatchObject({ intakeType: 'forwarded_email', sourceDomain: 'mailer.netflix.com', rawAvailable: true });

    const row = (await pool.query('SELECT raw_text, raw_retention_until FROM user_events')).rows[0];
    expect(row.raw_text.startsWith('v1:')).toBe(true);
    expect(row.raw_text).not.toContain('Netflix');
    expect(row.raw_retention_until.toISOString()).toBe('2026-11-06T10:00:00.000Z');
    const plain = decryptText(Buffer.from(KEY_B64, 'base64'), row.raw_text);
    expect(plain).toContain('renews on 12 Nov 2026');
    expect(plain).not.toContain(CARD);
    expect(plain).toContain('[card ending 1111]');
    const detail = (await c.get(`/api/intake/events/${ev.id}`)).json();
    expect(detail.event.rawText).toContain('renews on 12 Nov 2026');

    const sameId = await sendPostmark(app, postmark(alias.address, { text: netflixText('different body') }));
    expect(sameId.json().duplicate).toBe(true);
    // Same content forwarded again with another Message-ID and extra forward whitespace.
    const sameContent = await sendPostmark(app, postmark(alias.address, { messageId: '<other@x>', text: `\n${netflixText()}\n\n` }));
    expect(sameContent.json().duplicate).toBe(true);
    expect(await n('SELECT count(*) AS n FROM user_events')).toBe(1);
  });

  it('accepts Mailgun signed form posts and rejects bad signatures with 406/401', async () => {
    const { c, alias } = await tempSession();
    const timestamp = String(Math.floor(clock.now.getTime() / 1000));
    const token = 'tok-abc';
    const signature = createHmac('sha256', SECRET).update(timestamp + token).digest('hex');
    const form = (sig: string, recipient = alias.address) =>
      new URLSearchParams({
        recipient,
        sender: 'me@gmail.com',
        subject: 'Fwd: Trial ending',
        'body-plain': 'From: Spotify <no-reply@spotify.com>\nYour free trial ends on 05/11/2026. Then ₹119/month.',
        'Message-Id': '<mg-1@x>',
        timestamp,
        token,
        signature: sig,
      }).toString();
    const send = (payload: string) => app.inject({ method: 'POST', url: '/api/inbound/email', payload, headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await send(form('0'.repeat(64)))).statusCode).toBe(401);
    expect((await send(form(signature, 'unknown@inbox.due.test'))).statusCode).toBe(406);
    const ok = await send(form(signature));
    expect(ok.statusCode).toBe(200);
    const ev = (await c.get('/api/intake/events')).json().items[0];
    expect(ev.extractedFields).toMatchObject({ provider: 'Spotify', trialEndDate: '2026-11-05', amountInr: 119, billingCycle: 'monthly', commitmentType: 'trial' });
    // Form bodies are only accepted by the inbound route.
    const elsewhere = await app.inject({ method: 'POST', url: '/api/telemetry', payload: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(elsewhere.statusCode).toBe(415);
  });

  it('stores structured fields only when DATA_ENCRYPTION_KEY is missing', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: { INBOUND_EMAIL_DOMAIN: 'inbox.due.test', INBOUND_WEBHOOK_SECRET: SECRET } });
    const { c, alias } = await tempSession(app2);
    expect((await sendPostmark(app2, postmark(alias.address))).statusCode).toBe(200);
    const row = (await pool.query('SELECT raw_text, raw_retention_until, extracted_fields FROM user_events')).rows[0];
    expect(row.raw_text).toBeNull();
    expect(row.raw_retention_until).toBeNull();
    expect(row.extracted_fields.amountInr).toBe(649);
    expect((await c.get('/api/intake/events')).json().rawStorage).toBe('disabled');
    await app2.close();
  });

  it('uses an admin parser template for the sender domain', async () => {
    const admin = await loggedIn(app, pool, 'ed@example.com', 'editor');
    const t = await admin.post('/api/admin/parser-templates', {
      senderDomain: 'netflix.com',
      messageClass: 'renewal',
      rules: { provider: 'Netflix India', service: 'Netflix Standard', amountPattern: 'Amount:\\s*₹\\s*([\\d,]+)' },
    });
    expect(t.statusCode).toBe(201);
    expect((await admin.post('/api/admin/parser-templates', { senderDomain: 'x.com', messageClass: 'a', rules: { amountPattern: '(' } })).statusCode).toBe(400);
    const { c, alias } = await tempSession();
    await sendPostmark(app, postmark(alias.address));
    const ev = (await c.get('/api/intake/events')).json().items[0];
    expect(ev.parserVersion).toBe(`template:${t.json().id}@1`);
    expect(ev.extractedFields).toMatchObject({ provider: 'Netflix India', service: 'Netflix Standard', amountInr: 649 });
    expect(ev.confidence.provider).toBe(0.95);
    expect((await admin.get('/api/admin/parser-templates')).json().items).toHaveLength(1);
  });
});

describe('review actions, export and delete', () => {
  it('edits, confirms with a private offer match, exports and deletes', async () => {
    await pool.query(
      `INSERT INTO offers (id, provider, product_family, name, benefit_type, source_urls, computed_status, verification_status)
       VALUES ('netflix-standard', 'Netflix', 'ott', 'Netflix Standard', 'recurring_entitlement', '{https://www.netflix.com/in/}', 'active_verify', 'pending')`,
    );
    const offersBefore = (await pool.query('SELECT * FROM offers')).rows;
    const { c, alias } = await tempSession();
    await sendPostmark(app, postmark(alias.address));
    const id = (await c.get('/api/intake/events')).json().items[0].id;

    const edited = await c.patch(`/api/intake/events/${id}`, { fields: { amountInr: 499, benefit: null } });
    expect(edited.json().event.extractedFields.amountInr).toBe(499);
    expect(edited.json().event.confidence.amountInr).toBe(1);
    const confirmed = await c.post(`/api/intake/events/${id}/confirm`);
    expect(confirmed.json().event.reviewStatus).toBe('confirmed');
    expect(confirmed.json().offerMatches).toEqual([expect.objectContaining({ offerId: 'netflix-standard', label: 'Possible benefit to verify', eligibility: 'unconfirmed' })]);
    // The public offer is reused unchanged: no user content flows into public tables.
    expect((await pool.query('SELECT * FROM offers')).rows).toEqual(offersBefore);
    expect(await n('SELECT count(*) AS n FROM offer_matches WHERE account_id IS NULL AND temp_session_id IS NOT NULL')).toBe(1);

    const ex = await c.get(`/api/intake/events/${id}/export`);
    expect(ex.headers['content-disposition']).toMatch(/attachment/);
    expect(ex.json().record).toMatchObject({ id, fields: { amountInr: 499 } });
    expect(JSON.stringify(ex.json())).not.toContain('v1:');

    expect((await c.del(`/api/intake/events/${id}/raw`)).statusCode).toBe(200);
    expect((await pool.query('SELECT raw_text FROM user_events')).rows[0].raw_text).toBeNull();
    expect((await c.del(`/api/intake/events/${id}`)).statusCode).toBe(200);
    const after = (await pool.query('SELECT review_status, extracted_fields FROM user_events')).rows[0];
    expect(after).toEqual({ review_status: 'deleted', extracted_fields: {} });
    expect((await c.get('/api/intake/events')).json().items).toHaveLength(0);
    expect((await c.get(`/api/intake/events/${id}`)).statusCode).toBe(404);
    expect(await n('SELECT count(*) AS n FROM offer_matches')).toBe(0);
    // A deliberately re-forwarded deleted message is accepted again.
    expect((await sendPostmark(app, postmark(alias.address))).json().duplicate).toBe(false);
  });

  it('accepts one shared SMS and manual fields; unparseable text is marked unreadable', async () => {
    const { c } = await tempSession();
    const sms = await c.post('/api/intake/events', { intakeType: 'shared_sms', text: 'Your Airtel postpaid bill of Rs. 599 is due on 15-11-2026. OTP is 482913' });
    expect(sms.statusCode).toBe(201);
    expect(sms.json().event.extractedFields).toMatchObject({ amountInr: 599, dueDate: '2026-11-15' });
    const raw = (await pool.query(`SELECT raw_text FROM user_events WHERE intake_type = 'shared_sms'`)).rows[0].raw_text;
    expect(decryptText(Buffer.from(KEY_B64, 'base64'), raw)).not.toContain('482913');
    expect((await c.post('/api/intake/events', { intakeType: 'shared_sms', text: 'hello there' })).json().event.reviewStatus).toBe('unreadable');
    const manual = await c.post('/api/intake/events', { intakeType: 'manual', fields: { provider: 'School', amountInr: 12000, dueDate: '2026-12-01' } });
    expect(manual.json().event).toMatchObject({ reviewStatus: 'needs_review', confidence: { provider: 1, amountInr: 1 } });
  });
});

describe('intake quota', () => {
  it('caps shared/manual submissions per owner per day like forwarded email', async () => {
    const { c } = await tempSession();
    const sid = (await pool.query('SELECT id FROM intake_temp_sessions')).rows[0].id;
    await pool.query(
      `INSERT INTO user_events (temp_session_id, intake_type, message_fingerprint, review_status, parser_version, created_at, updated_at)
       SELECT $1, 'manual', 'fp-' || g, 'needs_review', 'test', $2, $2 FROM generate_series(1, 100) g`,
      [sid, clock.now],
    );
    const r = await c.post('/api/intake/events', { intakeType: 'manual', fields: { provider: 'School' } });
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('quota_exceeded');
    clock.advanceMinutes(24 * 60 + 1);
    expect((await c.post('/api/intake/events', { intakeType: 'manual', fields: { provider: 'School' } })).statusCode).toBe(201);
  });
});

describe('privacy isolation', () => {
  it('user B cannot read or act on A’s events or alias; temp sessions cannot read account events', async () => {
    const a = await signIn(app, mailer, 'a@example.com');
    const aliasA = (await a.post('/api/intake/alias', { consentTextVersion: 'v1' })).json();
    await sendPostmark(app, postmark(aliasA.address));
    const idA = (await a.get('/api/intake/events')).json().items[0].id;

    const b = await signIn(app, mailer, 'b@example.com');
    expect((await b.get('/api/intake/events')).json().items).toHaveLength(0);
    expect((await b.get('/api/intake/alias')).json().alias).toBeNull();
    for (const [m, u] of [
      ['GET', `/api/intake/events/${idA}`],
      ['POST', `/api/intake/events/${idA}/confirm`],
      ['POST', `/api/intake/events/${idA}/ignore`],
      ['PATCH', `/api/intake/events/${idA}`],
      ['DELETE', `/api/intake/events/${idA}/raw`],
      ['DELETE', `/api/intake/events/${idA}`],
      ['GET', `/api/intake/events/${idA}/export`],
    ] as const) {
      const r = await b.req(m, u, m === 'PATCH' ? { fields: { amountInr: 1 } } : m === 'GET' ? undefined : {});
      expect(r.statusCode, `${m} ${u}`).toBe(404);
    }
    const t = await tempSession();
    expect((await t.c.get('/api/intake/events')).json().items).toHaveLength(0);
    expect((await t.c.get(`/api/intake/events/${idA}`)).statusCode).toBe(404);
    // A's temp-session events are invisible to A's account until claimed, and vice versa.
    await sendPostmark(app, postmark(t.alias.address, { messageId: '<t@x>', text: netflixText('temp copy') }));
    expect((await a.get('/api/intake/events')).json().items).toHaveLength(1);
    expect((await new AppClient(app).get('/api/intake/events')).statusCode).toBe(401);
    expect((await pool.query(`SELECT raw_text FROM user_events WHERE id = $1`, [idA])).rows[0].raw_text).toBeTruthy();
  });
});

describe('temporary session lifecycle', () => {
  it('expires after 7 days; purge deletes its events and retires the alias; raw text is purged after retention', async () => {
    const t = await tempSession();
    await sendPostmark(app, postmark(t.alias.address));
    const acct = await signIn(app, mailer, 'keep@example.com');
    const aliasK = (await acct.post('/api/intake/alias', { consentTextVersion: 'v1' })).json();
    await sendPostmark(app, postmark(aliasK.address));
    const ctx = monitorCtx(pool, clock);

    clock.advanceMinutes(7 * 1440 + 1);
    expect((await t.c.get('/api/intake/events')).statusCode).toBe(401);
    expect((await sendPostmark(app, postmark(t.alias.address, { messageId: '<late@x>', text: 'late' }))).statusCode).toBe(403);
    const run = await (await startJob(ctx, 'intake_purge', 'manual'))!.done;
    expect(run.stats).toMatchObject({ temp_sessions_expired: 1, raw_purged: 2 });
    expect(await n('SELECT count(*) AS n FROM user_events WHERE temp_session_id IS NOT NULL')).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM user_events WHERE account_id IS NOT NULL AND raw_text IS NULL`)).toBe(1);
    // The retired alias remains as a tombstone and can never be re-issued.
    expect((await pool.query('SELECT status, temp_session_id FROM intake_aliases WHERE alias = $1', [t.alias.alias])).rows[0]).toEqual({ status: 'rotated', temp_session_id: null });
  });

  it('claim-intake moves temporary events, consents and the alias to the account', async () => {
    const t = await tempSession();
    await sendPostmark(app, postmark(t.alias.address));
    // Sign in on the same device (same cookie jar).
    const r = await t.c.post('/api/account/magic-link', { email: 'claim@example.com' });
    expect(r.statusCode).toBe(202);
    await t.c.post('/api/account/verify', { token: mailer.lastToken() });
    const claim = await t.c.post('/api/account/claim-intake');
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ moved: 1, aliasTransferred: true, alias: { alias: t.alias.alias } });
    expect(t.c.cookies.due_intake).toBeUndefined();
    expect((await t.c.get('/api/intake/events')).json().items).toHaveLength(1);
    expect((await t.c.get('/api/account/consents')).json().current.email_intake).toMatchObject({ granted: true });
    // Mail to the same alias now lands in the account.
    await sendPostmark(app, postmark(t.alias.address, { messageId: '<2@x>', text: netflixText('second') }));
    expect((await t.c.get('/api/intake/events')).json().items).toHaveLength(2);
    expect((await t.c.post('/api/account/claim-intake')).json().error.code).toBe('no_intake_session');
    // Purge never touches claimed events.
    clock.advanceMinutes(8 * 1440);
    await (await startJob(monitorCtx(pool, clock), 'intake_purge', 'manual'))!.done;
    expect(await n('SELECT count(*) AS n FROM user_events WHERE account_id IS NOT NULL')).toBe(2);
  });

  it('withdrawing email_intake consent pauses forwarding; account deletion removes intake data', async () => {
    const acct = await signIn(app, mailer, 'del@example.com');
    const al = (await acct.post('/api/intake/alias', { consentTextVersion: 'v1' })).json();
    await sendPostmark(app, postmark(al.address));
    expect((await acct.post('/api/account/consents', { purpose: 'email_intake', granted: false, textVersion: 'v1' })).statusCode).toBe(201);
    expect((await acct.get('/api/intake/alias')).json().status).toBe('paused');
    const exp = (await acct.get('/api/account/export')).json();
    expect(exp.account.email).toBe('del@example.com');
    const tok = (await acct.post('/api/account/delete-request')).json().confirmationToken;
    expect((await acct.del('/api/account', { confirmationToken: tok })).statusCode).toBe(200);
    expect(await n('SELECT count(*) AS n FROM user_events')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM consent_records')).toBe(0);
    expect((await pool.query('SELECT status, account_id FROM intake_aliases')).rows[0]).toEqual({ status: 'rotated', account_id: null });
  });
});

describe('parser units', () => {
  it('parses Indian date formats and redacts identifiers', () => {
    expect(parseDate('12/11/2026')).toBe('2026-11-12');
    expect(parseDate('Nov 3, 2026')).toBe('2026-11-03');
    expect(parseDate('3rd December 2026')).toBe('2026-12-03');
    expect(parseDate('31/02/2026')).toBeNull();
    const red = redactSensitive('Aadhaar 1234 5678 9012, PAN ABCDE1234F, CVV: 123, card 5555-5555-5555-4444');
    expect(red).not.toMatch(/1234 5678 9012|ABCDE1234F|: 123\b|5555-5555-5555-4444/);
    expect(red).toContain('[card ending 4444]');
    const p = parseMessage({ text: 'Thanks for your order', subject: 'hi', envelopeSenderDomain: 'gmail.com' });
    expect(p.unreadable).toBe(true);
    expect(p.sourceDomain).toBeNull();
  });
});
