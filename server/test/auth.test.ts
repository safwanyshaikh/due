import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { Client, createUser, freshDb, makeApp, TestClock } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;
const clock = new TestClock(new Date('2026-10-30T10:00:00Z'));

beforeEach(async () => {
  await app?.close();
  await pool?.end();
  pool = await freshDb();
  clock.set('2026-10-30T10:00:00Z');
  app = await makeApp(pool, { clock, env: { ADMIN_SETUP_TOKEN: 'setup-token-123456' } });
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const owner = { email: 'Owner@Example.com', name: 'Owner', password: 'a-very-long-password' };

describe('setup', () => {
  it('rejects a wrong token, creates the first owner, then refuses further setup', async () => {
    const c = new Client(app);
    const bad = await c.post('/api/auth/setup', { ...owner, setupToken: 'nope' });
    expect(bad.statusCode).toBe(403);
    const short = await c.post('/api/auth/setup', { ...owner, password: 'short', setupToken: 'setup-token-123456' });
    expect(short.statusCode).toBe(400);
    expect(short.json().error.code).toBe('validation_error');

    const ok = await c.post('/api/auth/setup', { ...owner, setupToken: 'setup-token-123456' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().user).toMatchObject({ email: 'owner@example.com', role: 'owner' });
    expect(c.cookie).toBeTruthy();
    const me = await c.get('/api/auth/me');
    expect(me.json()).toMatchObject({ email: 'owner@example.com', role: 'owner' });

    const again = await new Client(app).post('/api/auth/setup', { ...owner, email: 'x@example.com', setupToken: 'setup-token-123456' });
    expect(again.statusCode).toBe(409);
    expect((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBe(1);
    const audit = await pool.query(`SELECT * FROM audit_log WHERE action = 'auth.setup'`);
    expect(audit.rowCount).toBe(1);
    // Password stored as scrypt hash only.
    const u = await pool.query('SELECT password_hash FROM users');
    expect(u.rows[0].password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
  });

  it('is disabled when ADMIN_SETUP_TOKEN is not set', async () => {
    const app2 = await makeApp(pool, { clock });
    const r = await new Client(app2).post('/api/auth/setup', { ...owner, setupToken: 'anything' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('setup_disabled');
    await app2.close();
  });
});

describe('login', () => {
  it('succeeds with correct credentials and records login history', async () => {
    await createUser(pool, 'ed@example.com', 'editor');
    const c = new Client(app);
    const bad = await c.post('/api/auth/login', { email: 'ed@example.com', password: 'wrong password!!' });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.message).toBe('Invalid email or password');
    const unknown = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong password!!' });
    expect(unknown.statusCode).toBe(401);
    const ok = await c.post('/api/auth/login', { email: 'ED@example.com', password: 'correct horse battery' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(ok.headers['set-cookie']).toMatch(/SameSite=Strict/i);
    const ev = await pool.query('SELECT email, success, reason FROM login_events ORDER BY id');
    expect(ev.rows.map((r) => [r.success, r.reason])).toEqual([
      [false, 'bad_password'],
      [false, 'unknown_user'],
      [true, null],
    ]);
    // Session token is never stored in clear.
    const s = await pool.query('SELECT id_hash FROM sessions');
    expect(s.rows[0].id_hash).not.toBe(c.cookie);
    expect(s.rows[0].id_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rate-limits after 10 failed attempts per IP+email in 15 minutes', async () => {
    await createUser(pool, 'ed@example.com', 'editor');
    const c = new Client(app);
    for (let i = 0; i < 10; i++) {
      const r = await c.post('/api/auth/login', { email: 'ed@example.com', password: 'wrong password!!' });
      expect(r.statusCode).toBe(401);
    }
    const blocked = await c.post('/api/auth/login', { email: 'ed@example.com', password: 'correct horse battery' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('rate_limited');
    // A different email from the same IP is not affected.
    await createUser(pool, 'v@example.com', 'viewer');
    expect((await c.post('/api/auth/login', { email: 'v@example.com', password: 'correct horse battery' })).statusCode).toBe(200);
    clock.advanceMinutes(16);
    expect((await c.post('/api/auth/login', { email: 'ed@example.com', password: 'correct horse battery' })).statusCode).toBe(200);
  });

  it('rejects disabled users', async () => {
    const id = await createUser(pool, 'd@example.com', 'viewer');
    await pool.query(`UPDATE users SET status = 'disabled' WHERE id = $1`, [id]);
    const r = await new Client(app).post('/api/auth/login', { email: 'd@example.com', password: 'correct horse battery' });
    expect(r.statusCode).toBe(401);
  });
});

describe('sessions', () => {
  it('expires after 12h idle and after 7 days absolute; logout revokes', async () => {
    await createUser(pool, 'a@example.com', 'admin');
    const c = await new Client(app).login('a@example.com');
    clock.advanceMinutes(11 * 60);
    expect((await c.get('/api/auth/me')).statusCode).toBe(200);
    clock.advanceMinutes(11 * 60); // 11h since last seen: still fine
    expect((await c.get('/api/auth/me')).statusCode).toBe(200);
    clock.advanceMinutes(12 * 60 + 1);
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);

    const c2 = await new Client(app).login('a@example.com');
    for (let i = 0; i < 16; i++) {
      clock.advanceMinutes(11 * 60);
      await c2.get('/api/auth/me');
    }
    expect((await c2.get('/api/auth/me')).statusCode).toBe(401); // > 7 days absolute

    const c3 = await new Client(app).login('a@example.com');
    const token = c3.cookie;
    expect((await c3.post('/api/auth/logout')).statusCode).toBe(200);
    c3.cookie = token;
    expect((await c3.get('/api/auth/me')).statusCode).toBe(401);
  });

  it('change-password requires the current password and revokes other sessions', async () => {
    await createUser(pool, 'a@example.com', 'admin');
    const c1 = await new Client(app).login('a@example.com');
    const c2 = await new Client(app).login('a@example.com');
    expect((await c1.post('/api/auth/change-password', { current: 'wrong', next: 'another long password' })).statusCode).toBe(403);
    expect((await c1.post('/api/auth/change-password', { current: 'correct horse battery', next: 'another long password' })).statusCode).toBe(200);
    expect((await c1.get('/api/auth/me')).statusCode).toBe(200);
    expect((await c2.get('/api/auth/me')).statusCode).toBe(401);
    await new Client(app).login('a@example.com', 'another long password');
  });
});

describe('CSRF guard', () => {
  it('rejects mutations without X-Requested-With or with a foreign Origin', async () => {
    await createUser(pool, 'a@example.com', 'admin');
    const c = await new Client(app).login('a@example.com');
    const noHeader = await app.inject({
      method: 'POST',
      url: '/api/admin/companies',
      payload: { name: 'X' },
      headers: { cookie: `due_session=${c.cookie}` },
    });
    expect(noHeader.statusCode).toBe(403);
    expect(noHeader.json().error.code).toBe('csrf_rejected');
    const foreign = await c.req('POST', '/api/admin/companies', { name: 'X' }, { origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe('csrf_rejected');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@example.com', password: 'x' } });
    expect(login.statusCode).toBe(403);
    expect((await pool.query('SELECT count(*)::int AS n FROM companies')).rows[0].n).toBe(0);
    const ok = await c.post('/api/admin/companies', { name: 'X' });
    expect(ok.statusCode).toBe(201);
  });
});

describe('admin endpoints require a session', () => {
  it('every /api/admin route returns 401 without a session', async () => {
    const routes: { method: string | string[]; url: string }[] = [];
    const app2 = await makeApp(pool, { routes });
    const admin = routes.filter((r) => r.url.startsWith('/api/admin'));
    expect(admin.length).toBeGreaterThan(40);
    const uuid = '00000000-0000-4000-8000-000000000000';
    for (const r of admin) {
      for (const method of [r.method].flat()) {
        if (method === 'HEAD') continue;
        const url = r.url
          .replace('/jobs/:id', '/jobs/monitor_sources')
          .replace(/:id/g, r.url.includes('snapshots') || r.url.includes('alerts') ? '1' : uuid);
        const res = await app2.inject({
          method: method as 'GET',
          url,
          headers: { 'x-requested-with': 'due-admin' },
          payload: method === 'GET' ? undefined : {},
        });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    }
    // A forged cookie does not help.
    const forged = await app2.inject({ method: 'GET', url: '/api/admin/dashboard', headers: { cookie: 'due_session=forged' } });
    expect(forged.statusCode).toBe(401);
    await app2.close();
  });
});
