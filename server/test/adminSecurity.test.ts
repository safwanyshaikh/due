import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { totpCode, totpStep, verifyTotp, base32Decode, base32Encode } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import type { Pool } from '../src/db.js';
import { BASE, Client, createUser, currentTotp, freshDb, makeApp, RecordingMailer, testConfig, TestClock, totpSecrets } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;
const clock = new TestClock(new Date('2026-11-25T10:00:00Z'));

beforeEach(async () => {
  await app?.close();
  await pool?.end();
  pool = await freshDb();
  clock.set('2026-11-25T10:00:00Z');
  app = await makeApp(pool, { clock });
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

const H = { 'x-requested-with': 'due-admin', origin: BASE };

describe('TOTP primitives', () => {
  it('matches the RFC 6238 SHA-1 test vector and refuses replays', () => {
    // RFC 6238 Appendix B secret "12345678901234567890", T = 59 s -> 94287082 (8 digits); 6 digits = 287082.
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpCode(secret, 1)).toBe('287082');
    const now = new Date(59_000);
    expect(verifyTotp(secret, '287082', now, null)).toBe(1);
    expect(verifyTotp(secret, '287082', now, 1)).toBeNull();
    expect(verifyTotp(secret, '000000', now, null)).toBeNull();
    expect(totpStep(new Date(60_000))).toBe(2);
  });
});

describe('H1: client IP and rate limits', () => {
  it('ignores spoofed left-most X-Forwarded-For entries with TRUST_PROXY_HOPS=1', async () => {
    await createUser(pool, 'admin@example.com', 'admin');
    const app2 = await makeApp(pool, { clock, env: { TRUST_PROXY_HOPS: '1' } });
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) {
      const r = await app2.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@example.com', password: `wrong-password-${i}` },
        headers: { ...H, 'x-forwarded-for': `203.0.113.${i + 1}, 10.0.0.1` },
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10).every((c) => c === 429)).toBe(true);
    const ips = (await pool.query(`SELECT DISTINCT ip FROM login_events`)).rows.map((r) => r.ip);
    expect(ips).toEqual(['10.0.0.1']);
    await app2.close();
  });

  it('defaults to 1 trusted hop in production and 0 elsewhere (X-Forwarded-For ignored)', async () => {
    const base = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(40), DATA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') };
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).trustProxyHops).toBe(1);
    expect(loadConfig({ ...base, NODE_ENV: 'development' }).trustProxyHops).toBe(0);
    expect(loadConfig({ ...base, NODE_ENV: 'production', TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
    await createUser(pool, 'admin@example.com', 'admin');
    await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'admin@example.com', password: 'nope-nope' }, headers: { ...H, 'x-forwarded-for': '203.0.113.9' } });
    const ips = (await pool.query(`SELECT ip FROM login_events`)).rows.map((r) => r.ip);
    expect(ips).toEqual(['127.0.0.1']);
  });

  it('caps failed sign-ins per email across IPs (20 an hour)', async () => {
    await createUser(pool, 'admin@example.com', 'admin');
    const app2 = await makeApp(pool, { clock, env: { TRUST_PROXY_HOPS: '1' } });
    const codes: number[] = [];
    for (let i = 0; i < 22; i++) {
      // A different real client IP each time (the right-most entry, appended by the proxy).
      const r = await app2.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'admin@example.com', password: `wrong-password-${i}` },
        headers: { ...H, 'x-forwarded-for': `198.51.100.${i + 1}` },
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429]);
    // The correct password does not help while the cap holds.
    const ok = await app2.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'correct horse battery' },
      headers: { ...H, 'x-forwarded-for': '192.0.2.50' },
    });
    expect(ok.statusCode).toBe(429);
    clock.advanceMinutes(61);
    const later = await app2.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: 'admin@example.com', password: 'correct horse battery' },
      headers: { ...H, 'x-forwarded-for': '192.0.2.50' },
    });
    expect(later.statusCode).toBe(200);
    await app2.close();
  });

  it('caps magic links per email regardless of IP', async () => {
    const mailer = new RecordingMailer();
    const app2 = await makeApp(pool, { clock, mailer, env: { TRUST_PROXY_HOPS: '1' } });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await app2.inject({
        method: 'POST',
        url: '/api/account/magic-link',
        payload: { email: 'person@example.com' },
        headers: { 'x-requested-with': 'due-app', origin: BASE, 'x-forwarded-for': `198.51.100.${i + 1}` },
      });
      codes.push(r.statusCode);
    }
    expect(codes.filter((c) => c === 202)).toHaveLength(10);
    expect(codes.slice(10)).toEqual([429, 429]);
    // Daily cap: after the hour passes, at most 20 a day.
    for (let h = 0; h < 3; h++) {
      clock.advanceMinutes(61);
      for (let i = 0; i < 10; i++) {
        await app2.inject({
          method: 'POST',
          url: '/api/account/magic-link',
          payload: { email: 'person@example.com' },
          headers: { 'x-requested-with': 'due-app', origin: BASE, 'x-forwarded-for': `203.0.113.${h * 10 + i + 1}` },
        });
      }
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM magic_links WHERE email = 'person@example.com'`)).rows[0].n).toBe(20);
    await app2.close();
  });
});

describe('H2: mandatory 2-step verification', () => {
  it('a user without an authenticator must enrol before getting a session; recovery codes are stored hashed', async () => {
    await createUser(pool, 'new@example.com', 'admin', 'correct horse battery', false);
    const c = new Client(app);
    const first = await c.post('/api/auth/login', { email: 'new@example.com', password: 'correct horse battery' });
    expect(first.json().status).toBe('enrol_required');
    const { challengeToken, enrolment } = first.json();
    expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
    // Admin API is closed until enrolment completes.
    expect((await c.get('/api/auth/me')).statusCode).toBe(401);
    const wrong = await c.post('/api/auth/mfa/enrol', { challengeToken, code: '000000' });
    expect(wrong.statusCode).toBe(401);
    const ok = await c.post('/api/auth/mfa/enrol', { challengeToken, code: currentTotp(app, enrolment.secret) });
    expect(ok.statusCode).toBe(200);
    const codes: string[] = ok.json().recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    const stored = (await pool.query('SELECT code_hash FROM admin_recovery_codes')).rows.map((r) => r.code_hash);
    expect(stored).toHaveLength(10);
    for (const code of codes) expect(stored.join(' ')).not.toContain(code);
    const u = (await pool.query(`SELECT totp_secret_enc FROM users WHERE email = 'new@example.com'`)).rows[0];
    expect(u.totp_secret_enc).toMatch(/^k1:/);
    expect(u.totp_secret_enc).not.toContain(enrolment.secret);
    expect((await c.get('/api/auth/me')).json()).toMatchObject({ mfaEnrolled: true, recoveryCodesRemaining: 10 });
    // The challenge is single use.
    expect((await new Client(app).post('/api/auth/mfa/enrol', { challengeToken, code: currentTotp(app, enrolment.secret, 1) })).statusCode).toBe(400);
  });

  it('rejects a wrong or replayed code, limits attempts, and accepts each recovery code once', async () => {
    await createUser(pool, 'ed@example.com', 'editor');
    const secret = totpSecrets.get('ed@example.com')!;
    const login = async () => (await new Client(app).post('/api/auth/login', { email: 'ed@example.com', password: 'correct horse battery' })).json().challengeToken as string;
    let ch = await login();
    const code = currentTotp(app, secret);
    expect((await new Client(app).post('/api/auth/mfa', { challengeToken: ch, code })).statusCode).toBe(200);
    // Same code again (replay) fails.
    ch = await login();
    expect((await new Client(app).post('/api/auth/mfa', { challengeToken: ch, code })).statusCode).toBe(401);
    // Five wrong codes burn the challenge.
    for (let i = 0; i < 4; i++) expect((await new Client(app).post('/api/auth/mfa', { challengeToken: ch, code: '123456' })).statusCode).toBe(401);
    expect((await new Client(app).post('/api/auth/mfa', { challengeToken: ch, code: currentTotp(app, secret, 1) })).statusCode).toBe(400);

    // Recovery codes: enrol a user through the flow to get them.
    await createUser(pool, 'own@example.com', 'owner', 'correct horse battery', false);
    const owner = await new Client(app).login('own@example.com');
    const rc = owner.recoveryCodes[0]!;
    const c = new Client(app);
    const step = await c.post('/api/auth/login', { email: 'own@example.com', password: 'correct horse battery' });
    const used = await c.post('/api/auth/mfa', { challengeToken: step.json().challengeToken, code: rc.toLowerCase() });
    expect(used.statusCode).toBe(200);
    expect(used.json()).toMatchObject({ via: 'recovery_code', recoveryCodesRemaining: 9 });
    const step2 = await new Client(app).post('/api/auth/login', { email: 'own@example.com', password: 'correct horse battery' });
    expect((await new Client(app).post('/api/auth/mfa', { challengeToken: step2.json().challengeToken, code: rc })).statusCode).toBe(401);
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'auth.recovery_code_used'`)).rows[0].n).toBe(1);
  });

  it('owner/admin changes need a fresh code (re-authentication); reads and editor work do not', async () => {
    await createUser(pool, 'a@example.com', 'admin');
    await createUser(pool, 'v@example.com', 'viewer');
    const a = await new Client(app).login('a@example.com');
    const vid = (await pool.query(`SELECT id FROM users WHERE email = 'v@example.com'`)).rows[0].id;
    // Fresh after sign-in.
    expect((await a.patch(`/api/admin/users/${vid}`, { name: 'V1' })).statusCode).toBe(200);
    clock.advanceMinutes(11);
    const email = a.email;
    a.email = null; // stop the helper from answering the re-auth prompt
    const stale = await a.patch(`/api/admin/users/${vid}`, { name: 'V2' });
    expect(stale.statusCode).toBe(403);
    expect(stale.json().error.code).toBe('reauth_required');
    expect((await a.get('/api/admin/users')).statusCode).toBe(200);
    expect((await a.post('/api/admin/companies', { name: 'Editor-level work' })).statusCode).toBe(201);
    expect((await a.post('/api/auth/reauth', { code: '000000' })).statusCode).toBe(401);
    a.email = email;
    expect((await a.reauth()).statusCode).toBe(200);
    expect((await a.patch(`/api/admin/users/${vid}`, { name: 'V2' })).statusCode).toBe(200);
    expect((await a.get('/api/auth/me')).json().reauthValidUntil).toBeTruthy();
  });

  it('an admin can reset another user’s 2-step verification (they enrol again)', async () => {
    await createUser(pool, 'a@example.com', 'admin');
    const vid = await createUser(pool, 'v@example.com', 'viewer');
    const a = await new Client(app).login('a@example.com');
    const v = await new Client(app).login('v@example.com');
    expect((await a.post(`/api/admin/users/${vid}/reset-mfa`)).statusCode).toBe(200);
    expect((await v.get('/api/auth/me')).statusCode).toBe(401);
    const again = await new Client(app).post('/api/auth/login', { email: 'v@example.com', password: 'correct horse battery' });
    expect(again.json().status).toBe('enrol_required');
    expect((await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.reset_mfa'`)).rows[0].n).toBe(1);
  });

  it('uses __Host- cookie names in production and ignores the old cookie names', async () => {
    await createUser(pool, 'a@example.com', 'admin');
    const config = { ...testConfig(), isProduction: true };
    const app2 = await buildApp({ pool, config, clock: clock.fn, logger: false });
    await app2.ready();
    try {
      const first = await app2.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@example.com', password: 'correct horse battery' }, headers: H });
      const r = await app2.inject({
        method: 'POST',
        url: '/api/auth/mfa',
        payload: { challengeToken: first.json().challengeToken, code: currentTotp(app2, totpSecrets.get('a@example.com')!) },
        headers: H,
      });
      expect(r.statusCode).toBe(200);
      const set = r.cookies.find((c) => c.name === '__Host-due_session')!;
      expect(set).toBeTruthy();
      expect(set.secure).toBe(true);
      expect(set.path).toBe('/');
      expect(set.domain).toBeUndefined();
      expect((await app2.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `__Host-due_session=${set.value}` } })).statusCode).toBe(200);
      // The pre-prefix cookie name is no longer read: those sessions just sign in again.
      expect((await app2.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: `due_session=${set.value}` } })).statusCode).toBe(401);
    } finally {
      await app2.close();
    }
  });

  it('ADMIN_ALLOWED_IPS hides the admin console and API from other addresses', async () => {
    await createUser(pool, 'a@example.com', 'admin');
    const app2 = await makeApp(pool, { clock, env: { TRUST_PROXY_HOPS: '1', ADMIN_ALLOWED_IPS: '198.51.100.0/24, 2001:db8::1' } });
    const login = (ip: string) =>
      app2.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@example.com', password: 'correct horse battery' }, headers: { ...H, 'x-forwarded-for': ip } });
    expect((await login('203.0.113.5')).statusCode).toBe(404);
    expect((await login('198.51.100.20')).statusCode).toBe(200);
    expect((await app2.inject({ method: 'GET', url: '/admin/', headers: { 'x-forwarded-for': '203.0.113.5' } })).statusCode).toBe(404);
    // Consumer API is not affected.
    expect((await app2.inject({ method: 'GET', url: '/api/public/legal', headers: { 'x-forwarded-for': '203.0.113.5' } })).statusCode).toBe(200);
    expect(() => testConfig({ ADMIN_ALLOWED_IPS: 'not-an-ip' })).toThrow(/ADMIN_ALLOWED_IPS/);
    await app2.close();
  });
});
