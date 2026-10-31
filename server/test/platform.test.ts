import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { workerDepsOf } from '../src/app.js';
import { computeWebhookSignature } from '../src/consumer/razorpay.js';
import type { Pool } from '../src/db.js';
import { startJob } from '../src/jobs/runner.js';
import { buildReport, ErrorReporter, parseDsn } from '../src/observability/errorReporter.js';
import { metrics } from '../src/observability/metrics.js';
import { redactObject, redactText } from '../src/observability/redact.js';
import {
  backoffMs,
  beat,
  claim,
  drainQueue,
  enqueue,
  PermanentJobError,
  processJob,
  recoverStale,
  registerHandler,
  unregisterHandler,
  type JobContext,
  type WorkerDeps,
} from '../src/queue/index.js';
import { AppClient, drain, freshDb, grantPlan, loggedIn, makeApp, monitorCtx, RecordingMailer, signIn, silentLog, TestClock } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;
let mailer: RecordingMailer;
const clock = new TestClock(new Date('2026-10-30T10:00:00Z'));

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
  for (const t of ['test.ok', 'test.flaky', 'test.perm', 'test.crash']) unregisterHandler(t);
});

const n = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);
const deps = (): WorkerDeps => ({ ...workerDepsOf(app), log: silentLog });

describe('durable queue', () => {
  it('enqueues idempotently and refuses raw content in payloads', async () => {
    const a = await enqueue(pool, { type: 'test.ok', payload: { x: 1 }, idempotencyKey: 'k-1', now: clock.now, correlationId: 'corr-12345678' });
    const b = await enqueue(pool, { type: 'test.ok', payload: { x: 2 }, idempotencyKey: 'k-1', now: clock.now });
    expect(a.deduped).toBe(false);
    expect(b).toEqual({ id: a.id, deduped: true });
    expect(await n('SELECT count(*) AS n FROM jobs_queue')).toBe(1);
    await expect(enqueue(pool, { type: 'test.ok', payload: { nested: { text: 'mail body' } } })).rejects.toThrow(/must not contain "text"/);
    await expect(enqueue(pool, { type: 'test.ok', payload: { refresh_token: 'x' } })).rejects.toThrow();
    await expect(enqueue(pool, { type: 'Bad Type' })).rejects.toThrow(/Invalid job type/);
    await expect(enqueue(pool, { type: 'test.ok', payload: { ids: 'x'.repeat(9000) } })).rejects.toThrow(/too large/);
    const row = (await pool.query('SELECT correlation_id, status, attempts, max_attempts FROM jobs_queue')).rows[0];
    expect(row).toEqual({ correlation_id: 'corr-12345678', status: 'queued', attempts: 0, max_attempts: 5 });
  });

  it('retries with exponential backoff, then dead-letters with a redacted error', async () => {
    const seen: JobContext[] = [];
    registerHandler('test.flaky', async (job) => {
      seen.push(job);
      throw Object.assign(new Error('SMTP rejected for alice@example.com: card 4111 1111 1111 1111 amount ₹649'), { code: 'smtp_failed' });
    });
    const { id } = await enqueue(pool, { type: 'test.flaky', maxAttempts: 3, now: clock.now });
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(20)).toBe(60 * 60_000);

    await drainQueue(deps(), { types: ['test.flaky'] });
    let job = (await pool.query('SELECT * FROM jobs_queue WHERE id = $1', [id])).rows[0];
    expect(job).toMatchObject({ status: 'failed', attempts: 1, last_error_code: 'smtp_failed' });
    expect(job.run_at.getTime() - clock.now.getTime()).toBe(30_000);
    expect(job.last_error_message).not.toMatch(/alice@example\.com|4111|649/);
    expect(job.last_error_message).toContain('[email]');
    // Not before the backoff.
    clock.advanceMinutes(0.4);
    expect((await drainQueue(deps(), { types: ['test.flaky'] })).processed).toBe(0);
    clock.advanceMinutes(0.2);
    await drainQueue(deps(), { types: ['test.flaky'] });
    job = (await pool.query('SELECT * FROM jobs_queue WHERE id = $1', [id])).rows[0];
    expect(job).toMatchObject({ status: 'failed', attempts: 2 });
    expect(job.run_at.getTime() - clock.now.getTime()).toBe(60_000);
    clock.advanceMinutes(1);
    await drainQueue(deps(), { types: ['test.flaky'] });
    job = (await pool.query('SELECT * FROM jobs_queue WHERE id = $1', [id])).rows[0];
    expect(job).toMatchObject({ status: 'dead', attempts: 3 });
    expect(job.finished_at).toBeTruthy();
    expect(seen.map((s) => s.attempt)).toEqual([1, 2, 3]);
    expect(seen.every((s) => s.correlationId === job.correlation_id)).toBe(true);

    // Admin can inspect and retry it.
    const viewer = await loggedIn(app, pool, 'viewer@example.com', 'viewer');
    const list = (await viewer.get('/api/admin/queue?status=dead')).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ id, type: 'test.flaky', status: 'dead', lastErrorCode: 'smtp_failed' });
    expect((await viewer.post(`/api/admin/queue/${id}/retry`)).statusCode).toBe(403);
    const editor = await loggedIn(app, pool, 'editor@example.com', 'editor');
    const retried = await editor.post(`/api/admin/queue/${id}/retry`);
    expect(retried.json()).toMatchObject({ status: 'queued', attempts: 0 });
    expect((await editor.post(`/api/admin/queue/${id}/retry`)).statusCode).toBe(409);
    const stats = (await viewer.get('/api/admin/queue/stats')).json();
    expect(stats.counts).toMatchObject({ queued: 1, dead: 0 });
    expect(await n(`SELECT count(*) AS n FROM audit_log WHERE action = 'queue.retry'`)).toBe(1);
  });

  it('permanent errors dead-letter immediately; unknown types are never claimed', async () => {
    registerHandler('test.perm', async () => {
      throw new PermanentJobError('bad_input', 'never works');
    });
    await enqueue(pool, { type: 'test.perm', now: clock.now });
    await enqueue(pool, { type: 'nobody.handles', now: clock.now });
    await drainQueue(deps());
    expect((await pool.query(`SELECT status, attempts FROM jobs_queue WHERE type = 'test.perm'`)).rows[0]).toEqual({ status: 'dead', attempts: 1 });
    expect((await pool.query(`SELECT status, attempts FROM jobs_queue WHERE type = 'nobody.handles'`)).rows[0]).toEqual({ status: 'queued', attempts: 0 });
  });

  it('claims with SKIP LOCKED: concurrent workers never take the same job', async () => {
    for (let i = 0; i < 10; i++) await enqueue(pool, { type: 'test.ok', now: clock.now });
    registerHandler('test.ok', async () => undefined);
    const [a, b] = await Promise.all([claim(pool, 'w-a', clock.now, 6, ['test.ok']), claim(pool, 'w-b', clock.now, 6, ['test.ok'])]);
    const ids = [...a, ...b].map((j) => j.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it('recovers jobs left running by a crashed worker (stale heartbeat) and dead-letters exhausted ones', async () => {
    registerHandler('test.crash', async () => undefined);
    const a = await enqueue(pool, { type: 'test.crash', now: clock.now });
    const b = await enqueue(pool, { type: 'test.crash', maxAttempts: 1, now: clock.now });
    await beat(pool, 'crashed-worker', clock.now);
    const claimed = await claim(pool, 'crashed-worker', clock.now, 2, ['test.crash']);
    expect(claimed).toHaveLength(2);
    // A live worker's jobs are left alone.
    expect(await recoverStale(pool, clock.now)).toEqual({ requeued: 0, dead: 0 });
    clock.advanceMinutes(3); // heartbeat now older than 2 minutes
    expect(await recoverStale(pool, clock.now)).toEqual({ requeued: 1, dead: 1 });
    expect((await pool.query('SELECT status, last_error_code, locked_by FROM jobs_queue WHERE id = $1', [a.id])).rows[0]).toEqual({
      status: 'queued',
      last_error_code: 'worker_lost',
      locked_by: null,
    });
    expect((await pool.query('SELECT status FROM jobs_queue WHERE id = $1', [b.id])).rows[0].status).toBe('dead');
    // The crashed worker cannot overwrite the outcome after recovery.
    await processJob(deps(), claimed.find((j) => j.id === a.id)!);
    expect((await pool.query('SELECT status FROM jobs_queue WHERE id = $1', [a.id])).rows[0].status).toBe('queued');
    await drainQueue(deps(), { types: ['test.crash'] });
    expect((await pool.query('SELECT status, attempts FROM jobs_queue WHERE id = $1', [a.id])).rows[0]).toEqual({ status: 'succeeded', attempts: 2 });
  });

  it('scheduled daily jobs enqueue once per period', async () => {
    const ctx = monitorCtx(pool, clock);
    const r1 = await (await startJob(ctx, 'billing_reconcile', 'manual'))!.done;
    const r2 = await (await startJob(ctx, 'billing_reconcile', 'manual'))!.done;
    expect(r1.stats).toMatchObject({ enqueued: 1, period: '2026-10-30' });
    expect(r2.stats).toMatchObject({ enqueued: 0 });
    // Without Razorpay the job succeeds as a no-op (reported not_configured in metrics).
    await drain(app);
    expect((await pool.query(`SELECT status FROM jobs_queue WHERE type = 'billing.reconcile'`)).rows[0].status).toBe('succeeded');
  });
});

describe('health and status', () => {
  it('live is process-only; ready needs the database and a fresh worker heartbeat', async () => {
    expect((await app.inject({ method: 'GET', url: '/health/live' })).json()).toEqual({ ok: true });
    const down = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ ok: false, checks: { db: 'ok', queue: 'error' } });
    await beat(pool, 'w1', clock.now);
    const up = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toMatchObject({ ok: true, checks: { db: 'ok', queue: 'ok' } });
    clock.advanceMinutes(3);
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(503);
  });

  it('admin integrations report every integration separately; missing optional ones are not_configured', async () => {
    await beat(pool, 'w1', clock.now);
    expect((await app.inject({ method: 'GET', url: '/api/admin/health/integrations' })).statusCode).toBe(401);
    const viewer = await loggedIn(app, pool, 'v@example.com', 'viewer');
    const r = (await viewer.get('/api/admin/health/integrations')).json();
    for (const k of ['db', 'queue', 'encryption', 'smtp', 'inbound', 'gmail_oauth', 'ocr_storage', 'billing', 'error_tracking']) {
      expect(r[k], k).toMatchObject({ status: expect.stringMatching(/^(ok|not_configured|degraded|error)$/), detail: expect.any(String) });
    }
    expect(r).toMatchObject({
      db: { status: 'ok' },
      queue: { status: 'ok' },
      encryption: { status: 'not_configured' },
      inbound: { status: 'not_configured' },
      billing: { status: 'not_configured' },
      gmail_oauth: { status: 'not_configured' },
      error_tracking: { status: 'not_configured' },
    });
    expect(r.smtp.status).toBe('not_configured'); // makeApp passes a mailer but no SMTP_URL
    expect(r.metrics.counters).toBeTypeOf('object');
    expect(JSON.stringify(r)).not.toMatch(/SESSION_SECRET|test-secret/);
  });

  it('public status shows integration modes honestly and the admin-set incident', async () => {
    const s = (await app.inject({ method: 'GET', url: '/api/public/status' })).json();
    expect(s).toEqual({ incident: null, integrations: { smtp: 'not_configured', inbound: 'not_configured', gmail: 'not_configured', billing: 'not_configured' } });
    const app2 = await makeApp(pool, {
      clock,
      mailer,
      env: {
        SMTP_URL: 'smtp://user:pass@smtp.postmarkapp.com:587',
        RAZORPAY_KEY_ID: 'rzp_test_abc',
        RAZORPAY_KEY_SECRET: 's',
        RAZORPAY_WEBHOOK_SECRET: 'w',
        INBOUND_EMAIL_DOMAIN: 'in.due.test',
        INBOUND_WEBHOOK_SECRET: 'secret-0123456789',
      },
    });
    expect((await app2.inject({ method: 'GET', url: '/api/public/status' })).json().integrations).toEqual({
      smtp: 'live',
      inbound: 'live',
      gmail: 'not_configured',
      billing: 'test_mode',
    });
    await app2.close();

    const editor = await loggedIn(app, pool, 'e@example.com', 'editor');
    expect((await editor.patch('/api/admin/incident', { level: 'major', message: 'Email reminders delayed' })).statusCode).toBe(403);
    const admin = await loggedIn(app, pool, 'a@example.com', 'admin');
    expect((await admin.patch('/api/admin/incident', { level: 'loud', message: 'x' })).statusCode).toBe(400);
    const set = await admin.patch('/api/admin/incident', { level: 'major', message: 'Email reminders delayed' });
    expect(set.json().incident).toMatchObject({ level: 'major', message: 'Email reminders delayed', updatedAt: clock.now.toISOString() });
    expect((await app.inject({ method: 'GET', url: '/api/public/status' })).json().incident).toMatchObject({ level: 'major' });
    await admin.patch('/api/admin/incident', { clear: true });
    expect((await app.inject({ method: 'GET', url: '/api/public/status' })).json().incident).toBeNull();
    expect(await n(`SELECT count(*) AS n FROM audit_log WHERE action LIKE 'incident.%'`)).toBe(2);
  });
});

describe('legal', () => {
  const FULL: Record<string, unknown> = {
    'legal.entity_name': 'Due Technologies Private Limited',
    'legal.address': '12 MG Road, Bengaluru 560001, India',
    'legal.grievance_officer_name': 'Asha Rao',
    'legal.grievance_email': 'grievance@due.in',
    'legal.support_email': 'support@due.in',
    'legal.incident_contact': 'security@due.in',
    'legal.privacy_policy_md': '# Privacy notice\nWe process...',
    'legal.terms_md': '# Terms\n...',
    'legal.deletion_policy_md': '# Deletion\n...',
    'legal.subprocessors': [{ name: 'Render', purpose: 'Hosting', region: 'US' }],
    'legal.effective_date': '2026-11-01',
  };

  it('is incomplete until every required field holds real content; placeholders are refused', async () => {
    const empty = (await app.inject({ method: 'GET', url: '/api/public/legal' })).json();
    expect(empty).toMatchObject({ complete: false, entityName: '', subprocessors: [] });
    expect(empty.missing).toContain('legal.grievance_email');
    const admin = await loggedIn(app, pool, 'a@example.com', 'admin');
    expect((await admin.patch('/api/admin/settings', { key: 'legal.grievance_email', value: 'grievance@example.com' })).statusCode).toBe(400);
    expect((await admin.patch('/api/admin/settings', { key: 'legal.subprocessors', value: [{ name: 'X' }] })).statusCode).toBe(400);
    for (const [key, value] of Object.entries(FULL)) {
      const r = await admin.patch('/api/admin/settings', { key, value });
      expect(r.statusCode, key).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/api/public/legal' })).json()).toMatchObject({
      complete: true,
      missing: [],
      grievanceOfficerName: 'Asha Rao',
      subprocessors: [{ name: 'Render', purpose: 'Hosting', region: 'US' }],
    });
    // Draft text keeps the launch gate closed.
    await admin.patch('/api/admin/settings', { key: 'legal.terms_md', value: 'DRAFT terms, TODO' });
    const after = await app.inject({ method: 'GET', url: '/api/public/legal' });
    expect(after.json()).toMatchObject({ complete: false, missing: ['legal.terms_md'] });
    // Never served stale from a cache: the admin's "complete/incomplete" view and the app update immediately.
    expect(after.headers['cache-control']).toBe('no-cache');
  });
});

describe('billing', () => {
  const RZP = { RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'rzp_test_secret', RAZORPAY_WEBHOOK_SECRET: 'whsec_test_0123456789' };

  it('public plans expose the admin-set tax note', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/public/plans' })).json().tax).toEqual({ note: null, pricesIncludeTax: true });
    const admin = await loggedIn(app, pool, 'a@example.com', 'admin');
    await admin.patch('/api/admin/settings', { key: 'billing.tax_note', value: 'Prices include 18% GST' });
    expect((await app.inject({ method: 'GET', url: '/api/public/plans' })).json().tax).toEqual({ note: 'Prices include 18% GST', pricesIncludeTax: true });
  });

  it('a full refund webhook ends paid access; partial refunds and replays change nothing', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: RZP });
    await signIn(app2, mailer, 'refund@example.com');
    const acct = (await pool.query('SELECT id FROM consumer_accounts')).rows[0].id;
    await pool.query(`INSERT INTO billing_subscriptions (id, account_id, plan, billing_period, status) VALUES ('sub_R', $1, 'plus', 'monthly', 'active')`, [acct]);
    await pool.query(
      `INSERT INTO entitlements (account_id, plan, billing_period, status, channel, provider_ref, current_period_end) VALUES ($1,'plus','monthly','active','razorpay','sub_R',$2)`,
      [acct, new Date('2026-11-30T00:00:00Z')],
    );
    const hook = (id: string, amountRefunded: number) => {
      const body = JSON.stringify({
        event: 'payment.refunded',
        payload: { payment: { entity: { id: 'pay_1', amount: 14900, amount_refunded: amountRefunded, subscription_id: 'sub_R' } } },
      });
      return app2.inject({
        method: 'POST',
        url: '/api/billing/razorpay/webhook',
        payload: body,
        headers: { 'content-type': 'application/json', 'x-razorpay-signature': computeWebhookSignature(RZP.RAZORPAY_WEBHOOK_SECRET, body), 'x-razorpay-event-id': id },
      });
    };
    expect((await hook('evt_partial', 5000)).json()).toMatchObject({ applied: false });
    expect((await pool.query('SELECT status FROM entitlements')).rows[0].status).toBe('active');
    expect((await hook('evt_full', 14900)).json()).toMatchObject({ applied: true });
    expect((await hook('evt_full', 14900)).json()).toMatchObject({ duplicate: true });
    expect((await pool.query('SELECT status FROM entitlements')).rows[0].status).toBe('expired');
    expect((await pool.query(`SELECT outcome FROM billing_events WHERE event_id = 'evt_full'`)).rows[0].outcome).toBe('access_ended');
    await app2.close();
  });

  it('billing.reconcile re-reads subscriptions from the provider and applies cancellations', async () => {
    const app2 = await makeApp(pool, { clock, mailer, env: RZP });
    await signIn(app2, mailer, 'rec@example.com');
    const acct = (await pool.query('SELECT id FROM consumer_accounts')).rows[0].id;
    await pool.query(`INSERT INTO billing_subscriptions (id, account_id, plan, billing_period, status) VALUES ('sub_C', $1, 'plus', 'monthly', 'active')`, [acct]);
    await pool.query(`INSERT INTO entitlements (account_id, plan, billing_period, status, channel, provider_ref) VALUES ($1,'plus','monthly','active','razorpay','sub_C')`, [acct]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ id: 'sub_C', status: 'halted', current_end: null }), { status: 200 });
    }) as unknown as typeof fetch;
    await enqueue(pool, { type: 'billing.reconcile', now: clock.now });
    await drainQueue({ ...workerDepsOf(app2), log: silentLog, fetchImpl });
    expect(calls).toEqual(['https://api.razorpay.com/v1/subscriptions/sub_C']);
    expect((await pool.query('SELECT status FROM entitlements')).rows[0].status).toBe('expired');
    expect(await n(`SELECT count(*) AS n FROM consumer_audit WHERE action = 'entitlement.reconcile'`)).toBe(1);
    await app2.close();
  });

  it('Free accounts get 5 counted uploads a month; Plus is unlimited', async () => {
    const c = await signIn(app, mailer, 'up@example.com');
    for (let i = 1; i <= 5; i++) expect((await c.post('/api/account/uploads/count')).json()).toMatchObject({ used: i, limit: 5, remaining: 5 - i });
    const over = await c.post('/api/account/uploads/count');
    expect(over.statusCode).toBe(402);
    expect(over.json().error).toMatchObject({ code: 'premium_required', details: { feature: 'document_upload', limit: 5 } });
    expect((await c.get('/api/account/uploads/count')).json()).toMatchObject({ used: 5, remaining: 0 });
    clock.set('2026-11-01T00:00:00Z'); // 05:30 IST on 1 Nov: a new month
    expect((await c.post('/api/account/uploads/count')).json()).toMatchObject({ month: '2026-11', used: 1 });
    await grantPlan(pool, 'up@example.com', 'plus');
    for (let i = 0; i < 6; i++) expect((await c.post('/api/account/uploads/count')).statusCode).toBe(200);
    expect((await c.get('/api/account/uploads/count')).json()).toMatchObject({ unlimited: true, limit: null });
    expect((await new AppClient(app).post('/api/account/uploads/count')).statusCode).toBe(401);
  });
});

describe('consent v2', () => {
  it('records policy version, scope and source; a withdrawal closes the open grant even for raw inserts', async () => {
    const c = await signIn(app, mailer, 'consent@example.com');
    const id = (await pool.query('SELECT id FROM consumer_accounts')).rows[0].id;
    expect((await c.post('/api/account/consents', { purpose: 'offer_personalisation', granted: true, policyVersion: 'offers-v1', scope: { categories: 'all' } })).statusCode).toBe(201);
    expect((await c.post('/api/account/consents', { purpose: 'not_a_purpose', granted: true, policyVersion: 'x' })).statusCode).toBe(400);
    // Older writers (e.g. a direct INSERT with only text_version) still get v2 columns.
    await pool.query(`INSERT INTO consent_records (account_id, purpose, granted, text_version, at) VALUES ($1, 'offer_personalisation', false, 'offers-v1', $2)`, [id, clock.now]);
    const rows = (await pool.query(`SELECT granted, policy_version, scope, source, granted_at, revoked_at FROM consent_records WHERE purpose = 'offer_personalisation' ORDER BY id`)).rows;
    expect(rows[0]).toMatchObject({ granted: true, policy_version: 'offers-v1', scope: { categories: 'all' }, source: 'app' });
    expect(rows[0].granted_at).toBeTruthy();
    expect(rows[0].revoked_at).toBeTruthy();
    expect(rows[1]).toMatchObject({ granted: false, policy_version: 'offers-v1', granted_at: null });
    expect((await c.get('/api/account/consents')).json().current.offer_personalisation.state).toBe('revoked');
  });
});

describe('observability', () => {
  it('accepts or issues x-request-id and counts requests', async () => {
    const before = metrics.counter('http.requests', { status: '2xx' });
    const own = await app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': 'abc-12345678' } });
    expect(own.headers['x-request-id']).toBe('abc-12345678');
    const bad = await app.inject({ method: 'GET', url: '/health/live', headers: { 'x-request-id': 'bad id with spaces <script>' } });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(metrics.counter('http.requests', { status: '2xx' })).toBe(before + 2);
  });

  it('redacts contact, financial and secret content', () => {
    const s = redactText('Mail bob@example.com card 5555 5555 5555 4444 Rs. 1,299 token=abcdef1234 https://x.test/reset?token=zzz PAN ABCDE1234F');
    expect(s).not.toMatch(/bob@|5555|1,299|abcdef1234|zzz|ABCDE1234F/);
    expect(redactObject({ email: 'a@b.co', nested: { subject: 'Netflix renewal', ok: 1 } })).toEqual({ email: '[redacted]', nested: { subject: '[redacted]', ok: 1 } });
  });

  it('error reports are scrubbed before they are sent to the Sentry-compatible endpoint', async () => {
    expect(parseDsn('https://pub123@o1.ingest.sentry.io/42')).toEqual({ endpoint: 'https://o1.ingest.sentry.io/api/42/store/', publicKey: 'pub123' });
    expect(parseDsn('not a dsn')).toBeNull();
    const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const rep = new ErrorReporter('https://pub123@o1.ingest.sentry.io/42', 'test', fetchImpl);
    await rep.capture(new Error('Failed for carol@example.com paying ₹649 with 4111111111111111'), { correlation_id: 'req-12345678' }, { body: 'raw mail' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers['x-sentry-auth']).toContain('sentry_key=pub123');
    expect(sent[0]!.body).not.toMatch(/carol@|649|4111111111111111|raw mail/);
    const report = buildReport(new Error('x'), { environment: 'test' });
    expect(report).not.toHaveProperty('request');
    expect(report).not.toHaveProperty('user');
  });
});
