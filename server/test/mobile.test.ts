import type { FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { AppClient, freshDb, makeApp, RecordingMailer, TestClock, AGE } from './helpers.js';

const IOS = 'capacitor://localhost';
const ANDROID = 'https://localhost';
const WEB = 'https://evil.example';

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
});

const H = (origin: string, extra: Record<string, string> = {}) => ({ origin, 'x-requested-with': 'due-app', ...extra });

async function nativeSignIn(origin = IOS): Promise<string> {
  const c = new AppClient(app);
  await c.req('POST', '/api/account/magic-link', { email: 'asha@example.com' }, H(origin));
  const v = await c.req('POST', '/api/account/verify', { ...AGE, token: mailer.lastToken(), tokenTransport: 'bearer', deviceLabel: 'Due on iOS' }, H(origin));
  expect(v.statusCode).toBe(200);
  const body = v.json();
  expect(v.cookies).toHaveLength(0); // no cookie is ever set for the native app
  expect(body.tokenType).toBe('Bearer');
  return body.sessionToken as string;
}

describe('mobile origins config', () => {
  it('defaults to the two Capacitor origins and can be overridden or disabled', () => {
    const base = { DATABASE_URL: 'postgres://x/y', SESSION_SECRET: 'x'.repeat(32) };
    expect(loadConfig(base).mobileAppOrigins).toEqual([IOS, ANDROID]);
    expect(loadConfig({ ...base, MOBILE_APP_ORIGINS: 'https://a.test/, capacitor://b' }).mobileAppOrigins).toEqual(['https://a.test', 'capacitor://b']);
    expect(loadConfig({ ...base, MOBILE_APP_ORIGINS: '' }).mobileAppOrigins).toEqual([]);
  });
});

describe('CORS for the native app', () => {
  it('answers preflight for Capacitor origins on the consumer API without credentials', async () => {
    for (const origin of [IOS, ANDROID]) {
      const r = await app.inject({
        method: 'OPTIONS',
        url: '/api/account/data',
        headers: { origin, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'authorization,content-type,x-requested-with' },
      });
      expect(r.statusCode).toBe(204);
      expect(r.headers['access-control-allow-origin']).toBe(origin);
      expect(r.headers['access-control-allow-credentials']).toBeUndefined();
      expect(r.headers['access-control-allow-headers']).toContain('Authorization');
      expect(r.headers['access-control-allow-methods']).toContain('PUT');
      expect(r.headers.vary).toContain('Origin');
    }
  });

  it('grants nothing to other origins', async () => {
    for (const origin of [WEB, 'http://localhost', 'capacitor://localhost.evil.test', 'https://localhost:8443']) {
      const r = await app.inject({ method: 'OPTIONS', url: '/api/account/data', headers: { origin, 'access-control-request-method': 'GET' } });
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      const g = await app.inject({ method: 'GET', url: '/api/account/me', headers: { origin } });
      expect(g.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('grants nothing on admin, auth, billing or inbound routes, even to the Capacitor origins', async () => {
    for (const url of ['/api/admin/offers', '/api/auth/login', '/api/auth/me', '/api/billing/webhook', '/api/inbound/email']) {
      const pre = await app.inject({ method: 'OPTIONS', url, headers: { origin: IOS, 'access-control-request-method': 'POST' } });
      expect(pre.headers['access-control-allow-origin'], url).toBeUndefined();
      const post = await app.inject({ method: 'POST', url, payload: {}, headers: H(IOS) });
      expect(post.headers['access-control-allow-origin'], url).toBeUndefined();
      expect([401, 403, 404, 400, 429, 503], url).toContain(post.statusCode);
    }
  });

  it('public endpoints are readable (GET only, no credentials) by the app', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: IOS } });
    expect(r.headers['access-control-allow-origin']).toBe(IOS);
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
    const pre = await app.inject({ method: 'OPTIONS', url: '/api/public/legal', headers: { origin: IOS, 'access-control-request-method': 'POST' } });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('is off entirely when MOBILE_APP_ORIGINS is empty', async () => {
    const off = await makeApp(pool, { env: { MOBILE_APP_ORIGINS: '' } });
    const r = await off.inject({ method: 'OPTIONS', url: '/api/account/me', headers: { origin: IOS, 'access-control-request-method': 'GET' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    const post = await off.inject({ method: 'POST', url: '/api/account/magic-link', payload: { email: 'a@b.co' }, headers: H(IOS) });
    expect(post.statusCode).toBe(403);
    await off.close();
  });
});

describe('native bearer-token session', () => {
  it('verify issues a bearer token (no cookie) that authenticates the account API', async () => {
    const token = await nativeSignIn();
    const me = await app.inject({ method: 'GET', url: '/api/account/me', headers: { origin: IOS, authorization: `Bearer ${token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().account.email).toBe('asha@example.com');
    expect(me.headers['access-control-allow-origin']).toBe(IOS);
    const consent = await app.inject({
      method: 'POST',
      url: '/api/account/consents',
      payload: { purpose: 'sync_backup', granted: true, policyVersion: 'sync-backup-v1' },
      headers: H(IOS, { authorization: `Bearer ${token}` }),
    });
    expect(consent.statusCode).toBe(201);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/account/data',
      payload: { baseVersion: 0, data: { hello: 'world' } },
      headers: H(IOS, { authorization: `Bearer ${token}` }),
    });
    expect(put.statusCode).toBe(200);
  });

  it('stores only a hash and shows the device in the session list', async () => {
    const token = await nativeSignIn(ANDROID);
    const r = await pool.query('SELECT count(*)::int AS n FROM consumer_sessions WHERE id_hash = $1', [token]);
    expect(r.rows[0].n).toBe(0);
    const list = await app.inject({ method: 'GET', url: '/api/account/sessions', headers: { origin: ANDROID, authorization: `Bearer ${token}` } });
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].current).toBe(true);
  });

  it('rejects the token without a Capacitor origin (bearer is not an auth path for web origins)', async () => {
    const token = await nativeSignIn();
    for (const origin of [undefined, WEB, 'https://localhost:9999']) {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (origin) headers.origin = origin;
      const me = await app.inject({ method: 'GET', url: '/api/account/me', headers });
      expect(me.statusCode, String(origin)).toBe(401);
    }
  });

  it('ignores cookies sent by a Capacitor origin (no ambient credentials cross-origin)', async () => {
    // A cookie session obtained the normal way (web)...
    const web = new AppClient(app);
    await web.post('/api/account/magic-link', { email: 'asha@example.com' });
    await web.post('/api/account/verify', { ...AGE, token: mailer.lastToken() });
    expect((await web.get('/api/account/me')).statusCode).toBe(200);
    // ...is not honoured when the request comes from the native origin.
    const r = await web.req('GET', '/api/account/me', undefined, { origin: IOS });
    expect(r.statusCode).toBe(401);
  });

  it('refuses bearer issuance to non-mobile origins', async () => {
    const c = new AppClient(app);
    await c.post('/api/account/magic-link', { email: 'asha@example.com' });
    const token = mailer.lastToken();
    for (const headers of [{}, { origin: WEB }] as Record<string, string>[]) {
      const v = await c.req('POST', '/api/account/verify', { ...AGE, token, tokenTransport: 'bearer' }, { 'x-requested-with': 'due-app', ...headers });
      expect(v.statusCode).toBeGreaterThanOrEqual(400);
      expect(v.json().sessionToken).toBeUndefined();
    }
    // The link was not consumed by the refused attempts: a cookie sign-in still works.
    expect((await c.post('/api/account/verify', { ...AGE, token })).statusCode).toBe(200);
  });

  it('a Capacitor origin cannot call CSRF-protected admin routes', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: {}, headers: { origin: IOS, 'x-requested-with': 'due-admin' } });
    expect(r.statusCode).toBe(403);
  });

  it('logout revokes the bearer session', async () => {
    const token = await nativeSignIn();
    const auth = { authorization: `Bearer ${token}` };
    const out = await app.inject({ method: 'POST', url: '/api/account/logout', payload: {}, headers: H(IOS, auth) });
    expect(out.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/api/account/me', headers: { origin: IOS, ...auth } });
    expect(me.statusCode).toBe(401);
  });

  it('rejects malformed bearer headers', async () => {
    for (const authorization of ['Bearer', 'Bearer short', 'Basic abcdefghijklmnopqrstuvwxyz', `Bearer ${'a'.repeat(300)}`]) {
      const me = await app.inject({ method: 'GET', url: '/api/account/me', headers: { origin: IOS, authorization } });
      expect(me.statusCode).toBe(401);
    }
  });
});

describe('App Links / Universal Links association files', () => {
  const FP = Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0').toUpperCase()).join(':');

  it('are 404 until configured (and never fall through to the SPA)', async () => {
    for (const url of ['/.well-known/assetlinks.json', '/.well-known/apple-app-site-association']) {
      const r = await app.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(404);
      expect(r.json().error.code).toBe('not_found');
    }
  });

  it('serve assetlinks.json and the AASA as JSON when env is set', async () => {
    const a = await makeApp(pool, { env: { ANDROID_SHA256_CERT_FINGERPRINTS: `${FP.toLowerCase()}, nonsense`, APPLE_TEAM_ID: 'abcde12345' } });
    const al = await a.inject({ method: 'GET', url: '/.well-known/assetlinks.json' });
    expect(al.statusCode).toBe(200);
    expect(al.headers['content-type']).toContain('application/json');
    expect(al.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: { namespace: 'android_app', package_name: 'com.karigarai.due', sha256_cert_fingerprints: [FP] },
      },
    ]);
    const aasa = await a.inject({ method: 'GET', url: '/.well-known/apple-app-site-association' });
    expect(aasa.statusCode).toBe(200);
    expect(aasa.headers['content-type']).toContain('application/json');
    expect(aasa.json().applinks.details[0]).toEqual({ appIDs: ['ABCDE12345.com.karigarai.due'], components: [{ '/': '/api/account/verify' }] });
    await a.close();
  });

  it('ignores malformed values', async () => {
    const a = await makeApp(pool, { env: { ANDROID_SHA256_CERT_FINGERPRINTS: 'AA:BB', APPLE_TEAM_ID: 'short' } });
    expect((await a.inject({ method: 'GET', url: '/.well-known/assetlinks.json' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/.well-known/apple-app-site-association' })).statusCode).toBe(404);
    await a.close();
  });
});
