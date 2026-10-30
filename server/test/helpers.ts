import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import type { Role } from '../src/auth/roles.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createPool, type Pool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import type { MonitorContext } from '../src/monitor/engine.js';
import { MonitorRuntime } from '../src/monitor/runtime.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:55432/due_test';
export const BASE = 'http://localhost:80';

export function testConfig(env: Record<string, string> = {}): AppConfig {
  const c = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DB,
    SESSION_SECRET: 'test-secret-test-secret-test-secret-0123',
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
  opts: { clock?: TestClock; env?: Record<string, string>; routes?: { method: string | string[]; url: string }[] } = {},
): Promise<FastifyInstance> {
  const app = await buildApp({
    pool,
    config: testConfig(opts.env),
    clock: opts.clock?.fn,
    logger: false,
    onRoute: opts.routes ? (r) => opts.routes!.push(r) : undefined,
  });
  await app.ready();
  return app;
}

export async function createUser(pool: Pool, email: string, role: Role, password = 'correct horse battery'): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id`,
    [email, email.split('@')[0], await hashPassword(password), role],
  );
  return r.rows[0]!.id;
}

/** Minimal client that keeps the session cookie and sends the CSRF headers. */
export class Client {
  cookie: string | null = null;
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
  async login(email: string, password = 'correct horse battery') {
    const r = await this.post('/api/auth/login', { email, password });
    if (r.statusCode !== 200) throw new Error(`login failed: ${r.statusCode} ${r.body}`);
    return this;
  }
}

export async function loggedIn(app: FastifyInstance, pool: Pool, email: string, role: Role): Promise<Client> {
  await createUser(pool, email, role);
  return new Client(app).login(email);
}
