import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Mailer } from '../src/alerts.js';
import { buildApp, workerDepsOf } from '../src/app.js';
import { drainQueue, type WorkerDeps } from '../src/queue/index.js';
import { hashPassword } from '../src/auth/password.js';
import type { Role } from '../src/auth/roles.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool, type Pool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import type { MonitorContext } from '../src/monitor/engine.js';
import { MonitorRuntime } from '../src/monitor/runtime.js';
import { encryptTotpSecret, generateTotpSecret, totpCode, totpStep } from '../src/auth/totp.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:55432/due_test';
export const BASE = 'http://localhost:80';
export const TEST_SESSION_SECRET = 'test-secret-test-secret-test-secret-0123';

/** Authenticator secrets of test admin users, by email (set by createUser and by enrolment through Client.login). */
export const totpSecrets = new Map<string, string>();

/** The current 6-digit code for a secret at the app's clock. */
export function currentTotp(app: FastifyInstance, secret: string, offsetSteps = 0): string {
  return totpCode(secret, totpStep(app.deps.clock()) + offsetSteps);
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  const c = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    SESSION_SECRET: TEST_SESSION_SECRET,
    PUBLIC_BASE_URL: BASE,
    PUBLIC_APP_ORIGIN: 'https://app.example.test',
    ADMIN_DIST: '/nonexistent-admin-dist',
    ...env,
  });
  c.monitor = { ...c.monitor, hostGapMs: 0, timeoutMs: 1500, allowPrivateHosts: true };
  return c;
}

export async function freshDb(): Promise<Pool> {
  const pool = createPool(TEST_DB, 10);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await runMigrations(pool);
  return pool;
}

export class TestClock {
  constructor(public now: Date) {}
  fn = () => new Date(this.now);
  advanceMinutes(m: number) {
    this.now = new Date(this.now.getTime() + m * 60_000);
  }
  set(d: string | Date) {
    this.now = new Date(d);
  }
}

export const silentLog = { info() {}, warn() {}, error() {} };

export function monitorCtx(pool: Pool, clock: TestClock, config = testConfig()): MonitorContext {
  return { pool, clock: clock.fn, mailer: null, runtime: new MonitorRuntime(config.monitor), log: silentLog };
}

export async function makeApp(
  pool: Pool,
  opts: {
    clock?: TestClock;
    env?: Record<string, string>;
    routes?: { method: string | string[]; url: string }[];
    mailer?: Mailer | null;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<FastifyInstance> {
  const app = await buildApp({
    pool,
    config: testConfig(opts.env),
    clock: opts.clock?.fn,
    mailer: opts.mailer ?? null,
    fetchImpl: opts.fetchImpl,
    logger: false,
    onRoute: opts.routes ? (r) => opts.routes!.push(r) : undefined,
  });
  await app.ready();
  return app;
}

/** Creates an admin user with an enrolled authenticator (secret kept in `totpSecrets`), unless `mfa` is false. */
export async function createUser(pool: Pool, email: string, role: Role, password = 'correct horse battery', mfa = true): Promise<string> {
  const secret = generateTotpSecret();
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, role, totp_secret_enc, totp_enrolled_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [email, email.split('@')[0], await hashPassword(password), role, mfa ? encryptTotpSecret(TEST_SESSION_SECRET, secret) : null, mfa ? new Date() : null],
  );
  if (mfa) totpSecrets.set(email.toLowerCase(), secret);
  return r.rows[0]!.id;
}

/**
 * Minimal client that keeps the session cookie and sends the CSRF headers. login() completes the 2-step sign-in
 * (and enrolment) with the user's authenticator secret, and a 403 reauth_required is answered with a fresh code
 * and retried once, as the admin UI does.
 */
export class Client {
  cookie: string | null = null;
  email: string | null = null;
  recoveryCodes: string[] = [];
  constructor(
    private readonly app: FastifyInstance,
    private readonly csrf = true,
  ) {}

  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const h: Record<string, string> = { ...headers };
    if (this.csrf && method !== 'GET') {
      h['x-requested-with'] ??= 'due-admin';
      h.origin ??= BASE;
    }
    if (this.cookie) h.cookie = `due_session=${this.cookie}`;
    const res = await this.app.inject({ method: method as 'GET', url, payload: body as object, headers: h });
    const set = res.cookies.find((c) => c.name === 'due_session');
    if (set) this.cookie = set.value || null;
    if (res.statusCode === 403 && this.email && url !== '/api/auth/reauth' && res.json()?.error?.code === 'reauth_required') {
      const ok = await this.reauth();
      if (ok.statusCode === 200) return this.req(method, url, body, headers);
    }
    return res;
  }
  get(url: string) {
    return this.req('GET', url);
  }
  post(url: string, body: unknown = {}) {
    return this.req('POST', url, body);
  }
  patch(url: string, body: unknown) {
    return this.req('PATCH', url, body);
  }
  del(url: string) {
    return this.req('DELETE', url);
  }
  /** A code for `email` that has not been used yet (test-only: clears the replay marker first). */
  async freshCode(email: string): Promise<string> {
    const secret = totpSecrets.get(email.toLowerCase());
    if (!secret) throw new Error(`no authenticator secret for ${email}`);
    await this.app.deps.pool.query('UPDATE users SET totp_last_step = NULL WHERE email = $1', [email.toLowerCase()]);
    return currentTotp(this.app, secret);
  }
  async reauth() {
    return this.req('POST', '/api/auth/reauth', { code: await this.freshCode(this.email!) });
  }
  /** Completes the second step of a login/setup/reset response (TOTP or enrolment). */
  async finishSecondStep(email: string, first: LightMyRequestResponse): Promise<LightMyRequestResponse> {
    const step = first.json() as { status?: string; challengeToken?: string; enrolment?: { secret: string } };
    if (step.status === 'enrol_required') {
      totpSecrets.set(email.toLowerCase(), step.enrolment!.secret);
      const r = await this.post('/api/auth/mfa/enrol', { challengeToken: step.challengeToken, code: currentTotp(this.app, step.enrolment!.secret) });
      if (r.statusCode === 200) {
        this.email = email.toLowerCase();
        this.recoveryCodes = r.json().recoveryCodes;
      }
      return r;
    }
    if (step.status !== 'mfa_required') throw new Error(`unexpected second step: ${first.body}`);
    const r = await this.post('/api/auth/mfa', { challengeToken: step.challengeToken, code: await this.freshCode(email) });
    if (r.statusCode === 200) this.email = email.toLowerCase();
    return r;
  }
  async login(email: string, password = 'correct horse battery') {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.statusCode !== 200) throw new Error(`login failed: ${r.statusCode} ${r.body}`);
    const done = await this.finishSecondStep(email, r);
    if (done.statusCode !== 200) throw new Error(`second step failed: ${done.statusCode} ${done.body}`);
    return this;
  }
}

export async function loggedIn(app: FastifyInstance, pool: Pool, email: string, role: Role): Promise<Client> {
  await createUser(pool, email, role);
  return new Client(app).login(email);
}

/** Test-only mailer that records messages instead of sending them. */
export class RecordingMailer implements Mailer {
  sent: { to: string[]; subject: string; text: string }[] = [];
  fail = false;
  async send(to: string[], subject: string, text: string) {
    if (this.fail) throw new Error('SMTP down');
    this.sent.push({ to, subject, text });
    return { messageId: `<test-${this.sent.length}@local>` };
  }
  last() {
    return this.sent[this.sent.length - 1]!;
  }
  /** Extracts the token from the last message's link (`token=` or `household_invite=`). */
  lastToken(param = 'token'): string {
    const m = new RegExp(`[?&#]${param}=([A-Za-z0-9_-]+)`).exec(this.last().text);
    if (!m) throw new Error('no token in email');
    return m[1]!;
  }
}

/** Consumer-app client: keeps due_acct / due_intake cookies and sends X-Requested-With: due-app. */
export class AppClient {
  cookies: Record<string, string> = {};
  constructor(
    private readonly app: FastifyInstance,
    private readonly csrf = true,
  ) {}
  async req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
    const h: Record<string, string> = { ...headers };
    if (this.csrf && method !== 'GET') {
      h['x-requested-with'] ??= 'due-app';
      h.origin ??= BASE;
    }
    const jar = Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (jar) h.cookie = jar;
    const res = await this.app.inject({ method: method as 'GET', url, payload: body as object, headers: h });
    for (const c of res.cookies) {
      if (c.value) this.cookies[c.name] = c.value;
      else delete this.cookies[c.name];
    }
    return res;
  }
  get(url: string) {
    return this.req('GET', url);
  }
  post(url: string, body: unknown = {}) {
    return this.req('POST', url, body);
  }
  put(url: string, body: unknown) {
    return this.req('PUT', url, body);
  }
  patch(url: string, body: unknown) {
    return this.req('PATCH', url, body);
  }
  del(url: string, body?: unknown) {
    return this.req('DELETE', url, body);
  }
}

/** The 18+ declaration and notice version the app sends with every sign-in confirmation (M8). */
export const AGE = { ageConfirmed: true, noticeVersion: 'privacy-2026-11-v1' } as const;

/** Signs in through the real magic-link flow. */
/** Records the explicit 'sync_backup' grant the app makes when sync is turned on (uploads need it, M9). */
export async function grantSyncConsent(c: AppClient): Promise<void> {
  const r = await c.post('/api/account/consents', { purpose: 'sync_backup', granted: true, policyVersion: 'sync-backup-v1' });
  if (r.statusCode !== 201) throw new Error(`consent failed: ${r.statusCode} ${r.body}`);
}

export async function signIn(app: FastifyInstance, mailer: RecordingMailer, email: string, opts: { syncConsent?: boolean } = {}): Promise<AppClient> {
  const c = new AppClient(app);
  const r = await c.post('/api/account/magic-link', { email });
  if (r.statusCode !== 202) throw new Error(`magic link failed: ${r.statusCode} ${r.body}`);
  const v = await c.post('/api/account/verify', { ...AGE, token: mailer.lastToken() });
  if (v.statusCode !== 200) throw new Error(`verify failed: ${v.statusCode} ${v.body}`);
  if (opts.syncConsent) await grantSyncConsent(c);
  return c;
}

export async function grantPlan(pool: Pool, accountEmail: string, plan: 'plus' | 'household', periodEnd: Date | null = null): Promise<void> {
  await pool.query(
    `INSERT INTO entitlements (account_id, plan, billing_period, status, current_period_end, channel)
     SELECT id, $2, 'monthly', 'active', $3, 'manual' FROM consumer_accounts WHERE email = $1
     ON CONFLICT (account_id) DO UPDATE SET plan = EXCLUDED.plan, status = 'active', current_period_end = EXCLUDED.current_period_end`,
    [accountEmail, plan, periodEnd],
  );
}

/** Runs every due queue job in-process with the app's deps (the test clock, mailer and config). */
export async function drain(app: FastifyInstance, overrides: Partial<WorkerDeps> = {}) {
  return drainQueue({ ...workerDepsOf(app), log: silentLog, ...overrides });
}
