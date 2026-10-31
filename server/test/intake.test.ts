import type { FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { decryptText } from '../src/intake/crypto.js';
import { parseDate, parseMessage, redactSensitive } from '../src/intake/parser.js';
import { generateAlias } from '../src/intake/service.js';
import { startJob } from '../src/jobs/runner.js';
import { AppClient, drain, freshDb, grantPlan, loggedIn, makeApp, monitorCtx, RecordingMailer, signIn, TestClock } from './helpers.js';

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

/** Webhook delivery followed by the queue run that parses it. */
async function deliver(a: FastifyInstance, payload: object) {
  const r = await sendPostmark(a, payload);
  await drain(a);
  return r;
}

/** Guest (temporary) session: manual entry, pasted text and documents only. */
async function tempSession(a: FastifyInstance = app) {
  const c = new AppClient(a);
  const r = await c.post('/api/intake/session', { consentTextVersion: 'intake-2026-10' });
  expect(r.statusCode).toBe(201);
  return { c, session: r.json() as { alias: null; live: boolean; forwarding: string; allowedIntake: string[] } };
}

/** Signed-in Plus account with a forwarding alias. */
async function forwarder(email: string, a: FastifyInstance = app) {
  const c = await signIn(a, mailer, email);
  await grantPlan(pool, email, 'plus');
  const r = await c.post('/api/intake/alias', { consentTextVersion: 'intake-2026-10' });
  expect(r.statusCode).toBe(201);
  return { c, alias: r.json() as { alias: string; address: string; live: boolean; status: string } };
}

describe('aliases', () => {
  it('guest sessions get no forwarding alias; Plus accounts get unique aliases', async () => {
    const g = await tempSession();
    expect(g.session).toMatchObject({ alias: null, live: false, forwarding: 'sign_in_required', allowedIntake: ['manual', 'shared_sms', 'document'] });
    expect(g.c.cookies.due_intake).toBeTruthy();
    expect(await n(`SELECT count(*) AS n FROM consent_records WHERE purpose = 'documents' AND granted AND temp_session_id IS NOT NULL`)).toBe(1);
    expect(await n('SELECT count(*) AS n FROM intake_aliases')).toBe(0);
    expect((await g.c.post('/api/intake/alias/rotate')).statusCode).toBe(404);
    // Repeating the call keeps the same session.
    expect((await g.c.post('/api/intake/session', { consentTextVersion: 'v' })).json().alias).toBeNull();

    const a = await forwarder('a1@example.com');
    const b = await forwarder('b1@example.com');
    expect(a.alias.alias).toMatch(/^u[a-z2-7]{12}$/);
    expect(a.alias.alias).not.toBe(b.alias.alias);
    expect(a.alias).toMatchObject({ address: `${a.alias.alias}@inbox.due.test`, live: true, status: 'active' });
    expect(await n(`SELECT count(*) AS n FROM consent_records WHERE purpose = 'forwarding' AND granted`)).toBe(2);
    const gen = new Set(Array.from({ length: 2000 }, generateAlias));
    expect([...gen].every((x) => /^u[a-z2-7]{12}$/.test(x))).toBe(true);
    expect(gen.size).toBe(2000);
    await expect(pool.query(`INSERT INTO intake_aliases (alias, account_id) SELECT $1, account_id FROM intake_aliases LIMIT 1`, [a.alias.alias])).rejects.toThrow();
  });

  it('forwarding needs Plus: Free accounts get 402, and mail to an account that lost Plus is rejected', async () => {
    const free = await signIn(app, mailer, 'free@example.com');
    const r = await free.post('/api/intake/alias', { consentTextVersion: 'v1' });
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toMatchObject({ code: 'premium_required', details: { feature: 'email_import' } });
    const { alias } = await forwarder('lapsed@example.com');
    await pool.query(`UPDATE entitlements SET status = 'expired', current_period_end = $1`, [new Date('2026-10-01T00:00:00Z')]);
    const rej = await sendPostmark(app, postmark(alias.address));
    expect(rej.statusCode).toBe(403);
    expect(rej.json().error.code).toBe('premium_required');
    expect(await n('SELECT count(*) AS n FROM inbound_messages')).toBe(0);
  });

  it('reports live:false when inbound email is not configured, and the webhook is unavailable', async () => {
    const app2 = await makeApp(pool, { clock, mailer });
    const { alias } = await forwarder('nolive@example.com', app2);
    expect(alias.live).toBe(false);
    expect(alias.address).toBeNull();
    const r = await sendPostmark(app2, postmark('uaaaaa@inbox.due.test'));
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('intake_unavailable');
    await app2.close();
  });

  it('rotates, pauses and resumes; paused, rotated and guest aliases reject mail', async () => {
    const { c, alias } = await forwarder('rot@example.com');
    const addr = alias.address;
    expect((await c.post('/api/intake/alias/pause')).json().status).toBe('paused');
    const paused = await sendPostmark(app, postmark(addr));
    expect(paused.statusCode).toBe(403);
    expect(paused.json().error.code).toBe('alias_rejected');
    expect((await c.post('/api/intake/alias/resume')).json().status).toBe('active');
    const rotated = (await c.post('/api/intake/alias/rotate')).json();
    expect(rotated.alias).not.toBe(alias.alias);
    expect((await sendPostmark(app, postmark(addr))).statusCode).toBe(403);
    expect((await deliver(app, postmark(rotated.address))).statusCode).toBe(200);
    expect((await sendPostmark(app, postmark('uzzzzz@inbox.due.test'))).statusCode).toBe(403);
    expect((await sendPostmark(app, postmark('someone@other.test'))).statusCode).toBe(403);
    // An alias issued to a guest session before forwarding became a Plus feature no longer routes.
    const g = await tempSession();
    void g;
    const sid = (await pool.query('SELECT id FROM intake_temp_sessions')).rows[0].id;
    await pool.query(`INSERT INTO intake_aliases (alias, temp_session_id, status) VALUES ('ubbbbb', $1, 'active')`, [sid]);
    expect((await sendPostmark(app, postmark('ubbbbb@inbox.due.test'))).statusCode).toBe(403);
    expect(await n('SELECT count(*) AS n FROM user_events')).toBe(1);
  });

  it('legacy 5-character aliases issued before go-live keep routing', async () => {
    const { alias } = await forwarder('legacy@example.com');
    await pool.query(`UPDATE intake_aliases SET alias = 'uabcde' WHERE alias = $1`, [alias.alias]);
    const r = await sendPostmark(app, postmark('uabcde@inbox.due.test'));
    expect(r.statusCode).toBe(200);
    await expect(pool.query(`UPDATE intake_aliases SET alias = 'uabcdef' WHERE alias = 'uabcde'`)).rejects.toThrow();
  });

  it('rate-limits unknown aliases per IP (429 after 30 a minute) without affecting known aliases', async () => {
    const { alias } = await forwarder('rl@example.com');
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
    expect((await unknownFrom('203.0.113.10', 0)).statusCode).toBe(403);
    const known = await app.inject({
      method: 'POST',
      url: '/api/inbound/email',
      payload: postmark(alias.address),
      headers: { authorization: basic(SECRET) },
      remoteAddress: '203.0.113.9',
    });
    expect(known.statusCode).toBe(200);
    clock.advanceMinutes(1);
    expect((await unknownFrom('203.0.113.9', 31)).statusCode).toBe(403);
  });

  it('signed-in Plus accounts create an alias with consent', async () => {
    const acct = await signIn(app, mailer, 'alias@example.com');
    await grantPlan(pool, 'alias@example.com', 'plus');
    expect((await acct.get('/api/intake/alias')).json()).toEqual({ alias: null, live: true });
    const r = await acct.post('/api/intake/alias', { consentTextVersion: 'intake-2026-10' });
    expect(r.statusCode).toBe(201);
    expect(r.json().alias).toMatch(/^u[a-z2-7]{12}$/);
    expect((await acct.get('/api/account/consents')).json().current).toMatchObject({
      forwarding: { state: 'granted', policyVersion: 'intake-2026-10' },
      email_intake: { state: 'granted' },
    });
    expect((await acct.post('/api/intake/session', { consentTextVersion: 'v' })).statusCode).toBe(409);
  });
});

describe('inbound webhook', () => {
  it('rejects bad authentication without storing anything', async () => {
    const { alias } = await forwarder('auth@example.com');
    expect((await sendPostmark(app, postmark(alias.address), 'wrong')).statusCode).toBe(401);
    const none = await app.inject({ method: 'POST', url: '/api/inbound/email', payload: postmark(alias.address) });
    expect(none.statusCode).toBe(401);
    expect(none.json().error.code).toBe('invalid_signature');
    expect(await n('SELECT count(*) AS n FROM inbound_messages')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM jobs_queue')).toBe(0);
  });

  it('stores a sealed minimal message, parses it on the queue, encrypts redacted raw text and dedupes', async () => {
    const { c, alias } = await forwarder('parse@example.com');
    const r = await sendPostmark(app, postmark(alias.address));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, queued: true, duplicate: false });
    // Nothing is parsed inside the request: the message waits, sealed, for inbound.parse.
    expect(await n('SELECT count(*) AS n FROM user_events')).toBe(0);
    const stored = (await pool.query('SELECT body, status FROM inbound_messages')).rows[0];
    expect(stored.status).toBe('received');
    expect(stored.body.startsWith('v1:')).toBe(true);
    expect(stored.body).not.toContain('Netflix');
    const job = (await pool.query(`SELECT type, payload, status, correlation_id FROM jobs_queue`)).rows[0];
    expect(job).toMatchObject({ type: 'inbound.parse', status: 'queued', payload: { inboundMessageId: r.json().inboundMessageId } });
    expect(job.correlation_id).toBe(r.headers['x-request-id']);
    await drain(app);
    expect((await pool.query('SELECT body, status, user_event_id FROM inbound_messages')).rows[0]).toMatchObject({ body: null, status: 'processed' });

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

    // Same Message-ID: answered as a duplicate at the webhook, nothing stored or queued.
    const sameId = await sendPostmark(app, postmark(alias.address, { text: netflixText('different body') }));
    expect(sameId.json()).toMatchObject({ duplicate: true, queued: false });
    // Same content with another Message-ID: queued, then deduped by fingerprint in the parse job.
    const sameContent = await deliver(app, postmark(alias.address, { messageId: '<other@x>', text: `\n${netflixText()}\n\n` }));
    expect(sameContent.json().queued).toBe(true);
    expect(await n('SELECT count(*) AS n FROM user_events')).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM inbound_messages WHERE status = 'duplicate'`)).toBe(1);
  });

  it('accepts Mailgun signed form posts and rejects bad signatures with 406/401', async () => {
    const { c, alias } = await forwarder('mg@example.com');
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
    await drain(app);
    const ev = (await c.get('/api/intake/events')).json().items[0];
    expect(ev.extractedFields).toMatchObject({ provider: 'Spotify', trialEndDate: '2026-11-05', amountInr: 119, billingCycle: 'monthly', commitmentType: 'trial' });
    const elsewhere = await app.inject({ method: 'POST', url: '/api/telemetry', payload: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(elsewhere.statusCode).toBe(415);
  });

  it('stores structured fields only when DATA_ENCRYPTION_KEY is missing (the held message is wiped after parsing)', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: { INBOUND_EMAIL_DOMAIN: 'inbox.due.test', INBOUND_WEBHOOK_SECRET: SECRET } });
    const { c, alias } = await forwarder('nokey@example.com', app2);
    expect((await sendPostmark(app2, postmark(alias.address))).statusCode).toBe(200);
    expect((await pool.query('SELECT body FROM inbound_messages')).rows[0].body.startsWith('plain:')).toBe(true);
    await drain(app2);
    expect((await pool.query('SELECT body FROM inbound_messages')).rows[0].body).toBeNull();
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
    const { c, alias } = await forwarder('tpl@example.com');
    await deliver(app, postmark(alias.address));
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
    const { c, alias } = await forwarder('review@example.com');
    await deliver(app, postmark(alias.address));
    const id = (await c.get('/api/intake/events')).json().items[0].id;

    const edited = await c.patch(`/api/intake/events/${id}`, { fields: { amountInr: 499, benefit: null } });
    expect(edited.json().event.extractedFields.amountInr).toBe(499);
    expect(edited.json().event.confidence.amountInr).toBe(1);
    const confirmed = await c.post(`/api/intake/events/${id}/confirm`);
    expect(confirmed.json().event.reviewStatus).toBe('confirmed');
    expect(confirmed.json().offerMatches).toEqual([expect.objectContaining({ offerId: 'netflix-standard', label: 'Possible benefit to verify', eligibility: 'unconfirmed' })]);
    expect((await pool.query('SELECT * FROM offers')).rows).toEqual(offersBefore);
    expect(await n('SELECT count(*) AS n FROM offer_matches WHERE account_id IS NOT NULL')).toBe(1);

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
    expect((await deliver(app, postmark(alias.address))).json().duplicate).toBe(false);
    expect((await c.get('/api/intake/events')).json().items).toHaveLength(1);
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

describe('document upload allowance on /api/intake/events', () => {
  const doc = (i: number) => ({ intakeType: 'document', text: `Airtel bill ${i}. Amount Rs. ${500 + i} due on 15-11-2026` });

  it('guests: 5 documents a month (India time), then 402 premium_required; manual and SMS stay free', async () => {
    const { c } = await tempSession();
    for (let i = 0; i < 5; i++) expect((await c.post('/api/intake/events', doc(i))).statusCode).toBe(201);
    const over = await c.post('/api/intake/events', doc(9));
    expect(over.statusCode).toBe(402);
    expect(over.json().error).toMatchObject({ code: 'premium_required', details: { feature: 'document_upload', limit: 5 } });
    expect(await n(`SELECT count(*) AS n FROM user_events WHERE intake_type = 'document'`)).toBe(5);
    expect((await c.post('/api/intake/events', { intakeType: 'manual', fields: { provider: 'School' } })).statusCode).toBe(201);
    expect((await c.post('/api/intake/events', { intakeType: 'shared_sms', text: 'Jio bill Rs. 299 due 20-11-2026' })).statusCode).toBe(201);
    // 2026-10-31T18:30Z is midnight on 1 November in India: a new month.
    clock.set('2026-10-31T18:31:00Z');
    expect((await c.post('/api/intake/events', doc(10))).statusCode).toBe(201);
  });

  it('Free accounts share the allowance with /api/account/uploads/count; Plus is unlimited; duplicates are not counted', async () => {
    const c = await signIn(app, mailer, 'free@example.com');
    for (let i = 0; i < 3; i++) expect((await c.post('/api/account/uploads/count', {})).statusCode).toBe(200);
    expect((await c.post('/api/intake/events', doc(0))).statusCode).toBe(201);
    // Same document again: a duplicate, not a second upload.
    expect((await c.post('/api/intake/events', doc(0))).statusCode).toBe(200);
    expect((await c.get('/api/account/uploads/count')).json()).toMatchObject({ used: 4, remaining: 1 });
    expect((await c.post('/api/intake/events', doc(1))).statusCode).toBe(201);
    const over = await c.post('/api/intake/events', doc(2));
    expect(over.statusCode).toBe(402);
    expect(over.json().error.code).toBe('premium_required');
    // The rejected document was rolled back, not stored.
    expect(await n(`SELECT count(*) AS n FROM user_events WHERE intake_type = 'document'`)).toBe(2);
    expect((await c.post('/api/account/uploads/count', {})).statusCode).toBe(402);

    await grantPlan(pool, 'free@example.com', 'plus');
    for (let i = 3; i < 6; i++) expect((await c.post('/api/intake/events', doc(i))).statusCode).toBe(201);
    expect((await c.get('/api/account/uploads/count')).json()).toMatchObject({ unlimited: true, limit: null });
  });
});

describe('privacy isolation', () => {
  it('user B cannot read or act on A’s events or alias; temp sessions cannot read account events', async () => {
    const { c: a, alias: aliasA } = await forwarder('a@example.com');
    await deliver(app, postmark(aliasA.address));
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
    await t.c.post('/api/intake/events', { intakeType: 'document', text: netflixText('temp copy') });
    expect((await a.get('/api/intake/events')).json().items).toHaveLength(1);
    expect((await new AppClient(app).get('/api/intake/events')).statusCode).toBe(401);
    expect((await pool.query(`SELECT raw_text FROM user_events WHERE id = $1`, [idA])).rows[0].raw_text).toBeTruthy();
  });
});

describe('temporary session lifecycle', () => {
  it('expires after 7 days; retention.purge deletes its events; raw text is purged after retention', async () => {
    const t = await tempSession();
    await t.c.post('/api/intake/events', { intakeType: 'document', text: netflixText() });
    const { alias: aliasK } = await forwarder('keep@example.com');
    await deliver(app, postmark(aliasK.address));
    const ctx = monitorCtx(pool, clock);

    clock.advanceMinutes(7 * 1440 + 1);
    expect((await t.c.get('/api/intake/events')).statusCode).toBe(401);
    const run = await (await startJob(ctx, 'intake_purge', 'manual'))!.done;
    expect(run.stats).toMatchObject({ enqueued: 1 });
    // The same hour never enqueues a second purge.
    expect((await (await startJob(ctx, 'intake_purge', 'manual'))!.done).stats).toMatchObject({ enqueued: 0 });
    await drain(app);
    expect((await pool.query(`SELECT status FROM jobs_queue WHERE type = 'retention.purge'`)).rows).toEqual([{ status: 'succeeded' }]);
    expect(await n('SELECT count(*) AS n FROM user_events WHERE temp_session_id IS NOT NULL')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM intake_temp_sessions')).toBe(0);
    expect(await n(`SELECT count(*) AS n FROM user_events WHERE account_id IS NOT NULL AND raw_text IS NULL`)).toBe(1);
  });

  it('claim-intake moves temporary events and consents to the account', async () => {
    const t = await tempSession();
    await t.c.post('/api/intake/events', { intakeType: 'document', text: netflixText() });
    const r = await t.c.post('/api/account/magic-link', { email: 'claim@example.com' });
    expect(r.statusCode).toBe(202);
    await t.c.post('/api/account/verify', { token: mailer.lastToken() });
    const claim = await t.c.post('/api/account/claim-intake');
    expect(claim.statusCode).toBe(200);
    expect(claim.json()).toMatchObject({ moved: 1, aliasTransferred: false, alias: { alias: null } });
    expect(t.c.cookies.due_intake).toBeUndefined();
    expect((await t.c.get('/api/intake/events')).json().items).toHaveLength(1);
    expect((await t.c.get('/api/account/consents')).json().current.documents).toMatchObject({ granted: true });
    expect((await t.c.post('/api/account/claim-intake')).json().error.code).toBe('no_intake_session');
    clock.advanceMinutes(8 * 1440);
    await (await startJob(monitorCtx(pool, clock), 'intake_purge', 'manual'))!.done;
    await drain(app);
    expect(await n('SELECT count(*) AS n FROM user_events WHERE account_id IS NOT NULL')).toBe(1);
  });

  it('withdrawing forwarding consent pauses forwarding; account deletion (async) removes intake data', async () => {
    const { c: acct, alias: al } = await forwarder('del@example.com');
    await deliver(app, postmark(al.address));
    // The legacy purpose name is still accepted and maps to 'forwarding'.
    expect((await acct.post('/api/account/consents', { purpose: 'email_intake', granted: false, textVersion: 'v1' })).statusCode).toBe(201);
    expect((await acct.get('/api/intake/alias')).json().status).toBe('paused');
    expect((await acct.get('/api/account/consents')).json().current.forwarding).toMatchObject({ state: 'revoked' });
    const exp = (await acct.get('/api/account/export')).json();
    expect(exp.account.email).toBe('del@example.com');
    // Deletion is refused while a paid subscription is active only for Razorpay plans; this one is manual.
    const tok = (await acct.post('/api/account/delete-request')).json().confirmationToken;
    expect((await acct.del('/api/account', { confirmationToken: tok })).statusCode).toBe(202);
    await drain(app);
    expect(await n('SELECT count(*) AS n FROM user_events')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM consent_records')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM inbound_messages')).toBe(0);
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
