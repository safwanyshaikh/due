import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { startJob } from '../src/jobs/runner.js';
import { AppClient, drain, freshDb, grantPlan, makeApp, monitorCtx, RecordingMailer, signIn, TestClock } from './helpers.js';

const KEY = `k1:${Buffer.alloc(32, 7).toString('base64')}`;
let pool: Pool;
let app: FastifyInstance;
let mailer: RecordingMailer;
const clock = new TestClock(new Date('2026-11-01T10:00:00Z'));

async function boot(withMailer = true) {
  await app?.close();
  await pool?.end();
  pool = await freshDb();
  clock.set('2026-11-01T10:00:00Z');
  mailer = new RecordingMailer();
  app = await makeApp(pool, { clock, mailer: withMailer ? mailer : null, env: { DATA_ENCRYPTION_KEY: KEY } });
}
beforeEach(() => boot());
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const NOMINEE = { name: 'Test Nominee', email: 'Nominee@Example.com', relationship: 'sibling', acknowledged: true };

describe('nomination (DPDP s.14)', () => {
  it('requires sign-in and explicit acknowledgement, stores sealed, exports, and deletes', async () => {
    expect((await new AppClient(app).get('/api/account/nomination')).statusCode).toBe(401);
    const c = await signIn(app, mailer, 'owner@example.com');
    const empty = (await c.get('/api/account/nomination')).json();
    expect(empty.nominee).toBeNull();
    expect(empty.notice).toContain('We never email or contact your nominee');

    expect((await c.put('/api/account/nomination', { ...NOMINEE, acknowledged: false })).statusCode).toBe(400);
    expect((await c.put('/api/account/nomination', { ...NOMINEE, email: 'owner@example.com' })).statusCode).toBe(400);
    const mailsBefore = mailer.sent.length;
    const put = await c.put('/api/account/nomination', NOMINEE);
    expect(put.statusCode).toBe(200);
    expect(put.json().nominee).toMatchObject({ name: 'Test Nominee', email: 'nominee@example.com', relationship: 'sibling' });
    expect(mailer.sent.length).toBe(mailsBefore); // the nominee is never emailed

    const raw = (await pool.query('SELECT data_enc FROM account_nominations')).rows[0].data_enc as string;
    expect(raw.startsWith('d1:')).toBe(true);
    expect(raw).not.toContain('Nominee');
    expect(JSON.stringify((await pool.query('SELECT * FROM consumer_audit WHERE action LIKE $1', ['nomination%'])).rows)).not.toContain('nominee@example.com');

    expect((await c.get('/api/account/nomination')).json().nominee.name).toBe('Test Nominee');
    expect((await c.put('/api/account/nomination', { ...NOMINEE, name: 'Changed' })).json().nominee.name).toBe('Changed');
    expect((await pool.query('SELECT count(*)::int AS n FROM account_nominations')).rows[0].n).toBe(1);

    const exp = (await c.get('/api/account/export')).json();
    expect(exp.nominee).toMatchObject({ name: 'Changed', email: 'nominee@example.com' });

    expect((await c.del('/api/account/nomination')).json().nominee).toBeNull();
    expect((await c.get('/api/account/nomination')).json().nominee).toBeNull();
  });

  it('does not open for another account and goes away with account deletion', async () => {
    const a = await signIn(app, mailer, 'a@example.com');
    await a.put('/api/account/nomination', NOMINEE);
    const b = await signIn(app, mailer, 'b@example.com');
    expect((await b.get('/api/account/nomination')).json().nominee).toBeNull();
    // A ciphertext copied to another account does not open (scope is bound).
    const ida = (await pool.query(`SELECT id FROM consumer_accounts WHERE email = 'a@example.com'`)).rows[0].id;
    const idb = (await pool.query(`SELECT id FROM consumer_accounts WHERE email = 'b@example.com'`)).rows[0].id;
    await pool.query(`INSERT INTO account_nominations (account_id, data_enc, created_at, updated_at) SELECT $2, data_enc, now(), now() FROM account_nominations WHERE account_id = $1`, [ida, idb]);
    expect((await b.get('/api/account/nomination')).json().nominee).toBeNull();

    const tok = (await a.post('/api/account/delete-request', {})).json().confirmationToken;
    expect((await a.del('/api/account', { confirmationToken: tok })).statusCode).toBe(202);
    await drain(app);
    expect((await pool.query('SELECT count(*)::int AS n FROM account_nominations WHERE account_id = $1', [ida])).rows[0].n).toBe(0);
  });
});

describe('dormant-account retention', () => {
  const ago = (months: number, extraDays = 0) => {
    const d = new Date(clock.now);
    d.setUTCMonth(d.getUTCMonth() - months);
    d.setUTCDate(d.getUTCDate() - extraDays);
    return d;
  };
  async function makeDormant(email: string, lastActive: Date) {
    await pool.query(
      `INSERT INTO consumer_accounts (email, created_at, last_login_at, status) VALUES ($1,$2,$2,'active')`,
      [email, lastActive],
    );
    return (await pool.query('SELECT id FROM consumer_accounts WHERE email = $1', [email])).rows[0].id as string;
  }
  async function sweep() {
    const s = await startJob(monitorCtx(pool, clock), 'dormant_retention', 'manual');
    await s!.done;
    await drain(app);
  }
  const count = async (id: string) => (await pool.query('SELECT count(*)::int AS n FROM consumer_accounts WHERE id = $1', [id])).rows[0].n as number;

  it('defaults to 24 months, minimum 12', async () => {
    const { DEFAULT_SETTINGS, SETTING_SCHEMAS } = await import('../src/settings.js');
    expect(DEFAULT_SETTINGS.retention.dormant_months).toBe(24);
    const base = { snapshots_days: 365, login_events_days: 365 };
    expect(SETTING_SCHEMAS.retention.safeParse({ ...base, dormant_months: 11 }).success).toBe(false);
    expect(SETTING_SCHEMAS.retention.safeParse({ ...base, dormant_months: 12 }).success).toBe(true);
    expect(SETTING_SCHEMAS.retention.parse(base).dormant_months).toBe(24);
  });

  it('warns at 30 then 7 days, then deletes; recent accounts and paid accounts are left alone', async () => {
    const dormant = await makeDormant('old@example.com', ago(24, -29)); // due in 29 days
    const recent = await makeDormant('recent@example.com', ago(3));
    const paid = await makeDormant('paid@example.com', ago(30));
    await grantPlan(pool, 'paid@example.com', 'plus', new Date('2027-06-01T00:00:00Z'));
    const syncOnly = await makeDormant('synced@example.com', ago(30));
    await pool.query(`INSERT INTO account_data (account_id, version, data, updated_at) VALUES ($1, 1, '{}', $2)`, [syncOnly, ago(1)]);

    await sweep();
    expect(mailer.sent.map((m) => m.to[0])).toEqual(['old@example.com']);
    expect(mailer.last().subject).toContain('30 days');
    clock.advanceMinutes(1440);
    await sweep(); // next day: no duplicate
    expect(mailer.sent.length).toBe(1);

    clock.advanceMinutes(21 * 1440); // 7 days left
    await sweep();
    expect(mailer.sent.length).toBe(2);
    expect(mailer.last().subject).toContain('7 days');
    expect(await count(dormant)).toBe(1);

    clock.advanceMinutes(6 * 1440); // due, but the 7-day warning is only 6 days old
    await sweep();
    expect(await count(dormant)).toBe(1);

    clock.advanceMinutes(2 * 1440);
    await sweep();
    expect(await count(dormant)).toBe(0);
    expect(await count(recent)).toBe(1);
    expect(await count(paid)).toBe(1);
    expect(await count(syncOnly)).toBe(1);
    expect(mailer.sent.every((m) => m.to[0] === 'old@example.com')).toBe(true);
  });

  it('a sign-in after a warning voids it', async () => {
    const id = await makeDormant('back@example.com', ago(24, -20));
    await sweep();
    expect(mailer.sent.length).toBe(1);
    await pool.query('UPDATE consumer_accounts SET last_login_at = $2 WHERE id = $1', [id, clock.now]);
    clock.advanceMinutes(1440);
    await sweep();
    expect((await pool.query('SELECT count(*)::int AS n FROM dormant_notices WHERE account_id = $1', [id])).rows[0].n).toBe(0);
    clock.advanceMinutes(40 * 1440);
    await sweep();
    expect(await count(id)).toBe(1);
  });

  it('never deletes without an email service, and honours the admin month setting', async () => {
    await boot(false);
    const id = await makeDormant('nomail@example.com', ago(40));
    await sweep();
    clock.advanceMinutes(60 * 1440);
    await sweep();
    expect(await count(id)).toBe(1);

    await boot();
    const young = await makeDormant('year@example.com', ago(13));
    await sweep();
    expect(mailer.sent.length).toBe(0); // 24 months: nothing due yet
    clock.advanceMinutes(1440);
    await pool.query(`INSERT INTO settings (key, value) VALUES ('retention', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [
      JSON.stringify({ snapshots_days: 365, login_events_days: 365, dormant_months: 12 }),
    ]);
    await sweep();
    expect(mailer.sent.map((m) => m.to[0])).toEqual(['year@example.com']);
    expect(await count(young)).toBe(1);
  });
});
