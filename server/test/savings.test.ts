import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { labelProblem, roundSaved } from '../src/savings/schemas.js';
import { hasFreshOfficialSource, seedSavings } from '../src/savings/repo.js';
import { Client, freshDb, loggedIn, makeApp, TestClock } from './helpers.js';

const NOW = new Date('2026-11-24T10:00:00Z');
const FIXTURE = resolve(import.meta.dirname, 'fixtures/savings-seed.json');

function moduleBody(over: Record<string, unknown> = {}) {
  return {
    id: 'swiggy-one-in',
    detect: { merchantAliases: ['SWIGGY ONE'], senderDomains: ['swiggy.in'], keywords: [] },
    provider: 'Swiggy',
    product: 'Swiggy One',
    category: 'food',
    country: 'IN',
    cityPack: null,
    rules: { prices: [{ label: 'Monthly', priceInr: null, periodDays: 30 }] },
    valueKind: 'membership_breakeven',
    proof: { signal: 'charge_stopped', description: 'Charge stops' },
    nudge: { trigger: 'before_renewal', leadDays: 3 },
    legalRole: 'information',
    sources: [{ url: 'https://example.test/swiggy-one', label: 'Official', kind: 'official', lastVerifiedAt: '2026-11-10T00:00:00Z' }],
    actionUrl: 'https://example.test/swiggy-one',
    actionLabel: 'Open',
    ...over,
  };
}

let pool: Pool;
let app: FastifyInstance;
let clock: TestClock;
let editor: Client;
let viewer: Client;

beforeAll(async () => {
  pool = await freshDb();
  clock = new TestClock(NOW);
  app = await makeApp(pool, { clock });
  editor = await loggedIn(app, pool, 'ed@example.test', 'editor');
  viewer = await loggedIn(app, pool, 'view@example.test', 'viewer');
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE savings_modules, city_packs, research_requests, savings_reports, audit_log RESTART IDENTITY');
});

const pub = (method: 'GET' | 'POST', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object });

describe('PII guard and rounding (pure)', () => {
  it('rejects labels that could carry personal data', () => {
    expect(labelProblem('Uber One')).toBeNull();
    // M6: any digit (any script) or other symbol is refused; letters & + ' . - are allowed.
    expect(labelProblem('Jio 5G')).toMatch(/digits/);
    expect(labelProblem('९८७६५४३२१०')).toMatch(/digits/);
    expect(labelProblem('HDFC 1234')).toMatch(/digits/);
    expect(labelProblem('9876/543/210')).toBeTruthy();
    expect(labelProblem('Tata Play')).toBeNull();
    expect(labelProblem("Marks & Spencer's")).toBeNull();
    expect(labelProblem('Swiggy One+')).toBeNull();
    expect(labelProblem('ज़ी फ़ाइव')).toBeNull();
    expect(labelProblem('a'.repeat(61))).toMatch(/60/);
    expect(labelProblem('me@example.com')).toMatch(/email/);
    expect(labelProblem('@handle')).toBeTruthy();
    expect(labelProblem('see https://x.test')).toBeTruthy();
    expect(labelProblem('www.shop.test')).toBeTruthy();
    expect(labelProblem('shop.com')).toBeTruthy();
    expect(labelProblem('Acct 98765')).toBeTruthy();
    expect(labelProblem('98765 43210')).toBeTruthy();
    expect(labelProblem('Plan 1234')).toMatch(/digits/);
    expect(labelProblem('   ')).toBeTruthy();
  });
  it('rounds saved amounts to the nearest 10', () => {
    expect(roundSaved(123)).toBe(120);
    expect(roundSaved(125)).toBe(130);
    expect(roundSaved(1)).toBe(10);
    expect(roundSaved(100_000)).toBe(100_000);
  });
  it('requires an official source checked within 30 days', () => {
    const src = (kind: string, at: string | null) => ({ sources: [{ url: 'https://x.test', label: 'x', kind, lastVerifiedAt: at }] }) as never;
    expect(hasFreshOfficialSource(src('official', '2026-11-01T00:00:00Z'), NOW)).toBe(true);
    expect(hasFreshOfficialSource(src('official', '2026-10-01T00:00:00Z'), NOW)).toBe(false);
    expect(hasFreshOfficialSource(src('official', null), NOW)).toBe(false);
    expect(hasFreshOfficialSource(src('press', '2026-11-20T00:00:00Z'), NOW)).toBe(false);
  });
});

describe('admin: modules', () => {
  it('requires a session and the editor role to write', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/savings/modules' })).statusCode).toBe(401);
    expect((await viewer.get('/api/admin/savings/modules')).statusCode).toBe(200);
    expect((await viewer.post('/api/admin/savings/modules', moduleBody())).statusCode).toBe(403);
  });

  it('creates as research, updates bump the version, and every change is audited', async () => {
    const c = await editor.post('/api/admin/savings/modules', moduleBody());
    expect(c.statusCode).toBe(201);
    expect(c.json()).toMatchObject({ id: 'swiggy-one-in', version: 1, status: 'research' });
    expect((await editor.post('/api/admin/savings/modules', moduleBody())).statusCode).toBe(409);

    const u = await editor.req('PUT', '/api/admin/savings/modules/swiggy-one-in', moduleBody({ product: 'Swiggy One Lite' }));
    expect(u.json()).toMatchObject({ version: 2, product: 'Swiggy One Lite' });
    const p = await editor.patch('/api/admin/savings/modules/swiggy-one-in', { actionLabel: 'Go' });
    expect(p.json()).toMatchObject({ version: 3, actionLabel: 'Go', product: 'Swiggy One Lite' });
    expect((await editor.req('PUT', '/api/admin/savings/modules/other-id', moduleBody())).statusCode).toBe(400);
    expect((await editor.get('/api/admin/savings/modules/swiggy-one-in')).json()).toMatchObject({ version: 3 });
    expect((await editor.get('/api/admin/savings/modules/nope')).statusCode).toBe(404);

    const audit = await pool.query(`SELECT action FROM audit_log WHERE entity_type = 'savings_module' ORDER BY id`);
    expect(audit.rows.map((r) => r.action)).toEqual(['savings.module.create', 'savings.module.update', 'savings.module.update']);
  });

  it('validates the 8-field card (zod)', async () => {
    expect((await editor.post('/api/admin/savings/modules', moduleBody({ sources: [] }))).statusCode).toBe(400);
    expect((await editor.post('/api/admin/savings/modules', moduleBody({ valueKind: 'magic' }))).statusCode).toBe(400);
    expect((await editor.post('/api/admin/savings/modules', moduleBody({ id: 'Bad Id' }))).statusCode).toBe(400);
    expect((await editor.post('/api/admin/savings/modules', moduleBody({ status: 'verified' }))).statusCode).toBe(422);
  });

  it('verify needs an official source checked within 30 days; retire hides it from the catalog', async () => {
    await editor.post('/api/admin/savings/modules', moduleBody({ id: 'stale-one', sources: [{ url: 'https://example.test/a', label: 'A', kind: 'official', lastVerifiedAt: '2026-09-01T00:00:00Z' }] }));
    expect((await editor.post('/api/admin/savings/modules/stale-one/verify')).statusCode).toBe(422);
    await editor.post('/api/admin/savings/modules', moduleBody({ id: 'press-one', sources: [{ url: 'https://example.test/a', label: 'A', kind: 'press', lastVerifiedAt: '2026-11-20T00:00:00Z' }] }));
    expect((await editor.post('/api/admin/savings/modules/press-one/verify')).statusCode).toBe(422);
    await editor.post('/api/admin/savings/modules', moduleBody());
    const v = await editor.post('/api/admin/savings/modules/swiggy-one-in/verify');
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ status: 'verified', version: 2 });
    expect((await editor.post('/api/admin/savings/modules/missing/verify')).statusCode).toBe(404);
    // A verified module cannot be edited into an unverifiable state.
    const bad = await editor.req('PUT', '/api/admin/savings/modules/swiggy-one-in', moduleBody({ status: 'verified', sources: [{ url: 'https://example.test/a', label: 'A', kind: 'official', lastVerifiedAt: null }] }));
    expect(bad.statusCode).toBe(422);

    expect((await editor.post('/api/admin/savings/modules/swiggy-one-in/retire')).json()).toMatchObject({ status: 'retired' });
    const cat = (await pub('GET', '/api/public/savings/catalog')).json();
    expect(cat.modules.map((m: { id: string }) => m.id)).not.toContain('swiggy-one-in');
  });
});

describe('admin: city packs and research queue', () => {
  const pack = { name: 'Mumbai', country: 'in', localities: ['Thane'], passes: [], typicalFareInr: { cab: 250 }, status: 'research' };
  it('upserts packs', async () => {
    const a = await editor.req('PUT', '/api/admin/savings/city-packs/in-mmr', pack);
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ id: 'in-mmr', country: 'IN' });
    const b = await editor.req('PUT', '/api/admin/savings/city-packs/in-mmr', { ...pack, name: 'Mumbai MMR' });
    expect(b.statusCode).toBe(200);
    expect((await viewer.get('/api/admin/savings/city-packs')).json().items).toHaveLength(1);
    expect((await editor.get('/api/admin/savings/city-packs/in-mmr')).json().name).toBe('Mumbai MMR');
    expect((await editor.req('PUT', '/api/admin/savings/city-packs/in-mmr', { ...pack, typicalFareInr: { rocket: 5 } })).statusCode).toBe(400);
  });

  it('lists research by request count and links a module', async () => {
    await pub('POST', '/api/public/savings/research', { providerLabel: 'Zing TV', category: 'ott' });
    for (let i = 0; i < 3; i++) await pub('POST', '/api/public/savings/research', { providerLabel: 'Pocket FM', category: 'music' });
    const list = (await viewer.get('/api/admin/savings/research')).json().items;
    expect(list.map((r: { providerLabel: string }) => r.providerLabel)).toEqual(['Pocket FM', 'Zing TV']);
    expect(list[0]).toMatchObject({ requestCount: 3, status: 'open' });
    await editor.post('/api/admin/savings/modules', moduleBody());
    const id = list[0].id;
    expect((await editor.patch(`/api/admin/savings/research/${id}`, { status: 'done', moduleId: 'nope' })).statusCode).toBe(404);
    const ok = await editor.patch(`/api/admin/savings/research/${id}`, { status: 'done', moduleId: 'swiggy-one-in' });
    expect(ok.json()).toMatchObject({ status: 'done', moduleId: 'swiggy-one-in' });
    expect((await viewer.patch(`/api/admin/savings/research/${id}`, { status: 'open' })).statusCode).toBe(403);
    expect((await editor.get('/api/admin/savings/research?status=open')).json().items).toHaveLength(1);
  });
});

describe('public: catalog', () => {
  it('serves verified and research, never retired, with a content hash version and cache header', async () => {
    await editor.post('/api/admin/savings/modules', moduleBody({ id: 'a-research' }));
    await editor.post('/api/admin/savings/modules', moduleBody({ id: 'b-verified' }));
    await editor.post('/api/admin/savings/modules/b-verified/verify');
    await editor.post('/api/admin/savings/modules', moduleBody({ id: 'c-retired' }));
    await editor.post('/api/admin/savings/modules/c-retired/retire');
    await editor.req('PUT', '/api/admin/savings/city-packs/in-mmr', { name: 'Mumbai', country: 'IN', localities: [], typicalFareInr: {}, status: 'research',
      passes: [{ id: 'p1', operator: 'X', mode: 'bus', name: 'Old', priceInr: null, periodDays: null, trips: null, coverage: [], status: 'retired', sources: [], actionUrl: null }] });
    await new Promise((r) => setTimeout(r, 0));
    const res = await pub('GET', '/api/public/savings/catalog');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=300');
    const body = res.json();
    expect(body.modules.map((m: { id: string }) => m.id).sort()).toEqual(['a-research', 'b-verified'].sort());
    expect(body.cityPacks[0].passes).toEqual([]);
    expect(body.version).toMatch(/^[0-9a-f]{16}$/);
    expect(body.generatedAt).toBe(NOW.toISOString());
  });
});

describe('public: research requests', () => {
  it('queues, increments the count, and answers known for an existing module', async () => {
    const a = await pub('POST', '/api/public/savings/research', { providerLabel: 'Zing TV', category: 'ott', cityPack: 'in-mmr' });
    expect(a.json()).toEqual({ status: 'queued' });
    await pub('POST', '/api/public/savings/research', { providerLabel: 'zing  tv', category: 'ott' });
    const row = (await pool.query('SELECT * FROM research_requests')).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ request_count: 2, city_pack: 'in-mmr', status: 'open' });

    await editor.post('/api/admin/savings/modules', moduleBody());
    const k = await pub('POST', '/api/public/savings/research', { providerLabel: 'swiggy one', category: 'food' });
    expect(k.json()).toEqual({ status: 'known', moduleId: 'swiggy-one-in' });
    const alias = await pub('POST', '/api/public/savings/research', { providerLabel: 'Swiggy One', category: 'food' });
    expect(alias.json().status).toBe('known');
    expect((await pool.query('SELECT 1 FROM research_requests')).rowCount).toBe(1);
  });

  it('rejects labels with personal data and stores nothing', async () => {
    for (const providerLabel of ['x'.repeat(61), 'me@example.com', 'https://pay.test/abc', 'Acct 123456', 'www.bank.test']) {
      const r = await pub('POST', '/api/public/savings/research', { providerLabel, category: 'other' });
      expect(r.statusCode, providerLabel).toBe(400);
    }
    expect((await pub('POST', '/api/public/savings/research', { providerLabel: 'Ok', category: 'bogus' })).statusCode).toBe(400);
    expect((await pub('POST', '/api/public/savings/research', { providerLabel: 'Ok', category: 'ott', amount: 99 })).statusCode).toBe(400);
    expect((await pool.query('SELECT 1 FROM research_requests')).rowCount).toBe(0);
  });
});

describe('public: reports, community, rate limits', () => {
  it('stores rounded anonymous reports and validates input', async () => {
    const ok = await pub('POST', '/api/public/savings/report', { moveKind: 'period_switch', moduleId: 'jio-plan', cityPack: 'in-mmr', savedMonthlyInr: 123 });
    expect(ok.statusCode).toBe(204);
    expect((await pool.query('SELECT * FROM savings_reports')).rows[0]).toMatchObject({ move_kind: 'period_switch', module_id: 'jio-plan', saved_monthly_inr: 120 });
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('savings_reports','research_requests')`)).rows.map((r) => r.column_name);
    expect(cols.some((c) => /account|user|email|amount/.test(c))).toBe(false);
    for (const bad of [{ moveKind: 'x', savedMonthlyInr: 100 }, { moveKind: 'overlap', savedMonthlyInr: 0 }, { moveKind: 'overlap', savedMonthlyInr: 100_001 }, { moveKind: 'overlap', savedMonthlyInr: 100, email: 'a@b.c' }]) {
      expect((await pub('POST', '/api/public/savings/report', bad)).statusCode).toBe(400);
    }
  });

  it('shows community items only at 20 or more reports, with the median', async () => {
    await editor.post('/api/admin/savings/modules', moduleBody());
    const ins = (n: number, kind: string, mod: string | null, city: string, v: (i: number) => number) =>
      pool.query(
        `INSERT INTO savings_reports (move_kind, module_id, city_pack, saved_monthly_inr)
         SELECT $1, $2, $3, (CASE WHEN $5 = 'ramp' THEN i * 10 ELSE 200 END) FROM generate_series(1, $4::int) i`,
        [kind, mod, city, n, v(1) === 0 ? 'flat' : 'ramp'],
      );
    await ins(19, 'overlap', 'jio-plan', 'in-mmr', () => 0);
    await ins(21, 'membership_breakeven', 'swiggy-one-in', 'in-mmr', () => 1); // medians of 10..210 = 110
    await ins(25, 'period_switch', null, 'in-blr', () => 0);
    const r = (await pub('GET', '/api/public/savings/community?cityPack=in-mmr')).json();
    expect(r.threshold).toBe(20);
    expect(r.items).toEqual([{ moveKind: 'membership_breakeven', moduleId: 'swiggy-one-in', label: 'Swiggy One', reports: 21, medianSavedMonthlyInr: 110 }]);
    const all = (await pub('GET', '/api/public/savings/community')).json();
    expect(all.items.map((i: { moveKind: string }) => i.moveKind).sort()).toEqual(['membership_breakeven', 'period_switch']);
    // One more report pushes the 19-report item over the threshold.
    await pub('POST', '/api/public/savings/report', { moveKind: 'overlap', moduleId: 'jio-plan', cityPack: 'in-mmr', savedMonthlyInr: 200 });
    expect((await pub('GET', '/api/public/savings/community?cityPack=in-mmr')).json().items).toHaveLength(2);
    expect((await pub('GET', '/api/public/savings/community?cityPack=Bad%20Id')).statusCode).toBe(400);
  });

  it('limits reports to 10 an hour per IP', async () => {
    const own = await makeApp(pool, { clock });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) {
        codes.push((await own.inject({ method: 'POST', url: '/api/public/savings/report', payload: { moveKind: 'overlap', savedMonthlyInr: 50 } })).statusCode);
      }
      expect(codes.slice(0, 10).every((c) => c === 204)).toBe(true);
      expect(codes[10]).toBe(429);
    } finally {
      await own.close();
    }
  });
});

describe('seed', () => {
  it('is a no-op when the file is missing', async () => {
    const r = await seedSavings(pool, resolve(import.meta.dirname, 'fixtures/does-not-exist.json'), NOW);
    expect(r).toMatchObject({ file: null, modulesInserted: 0, packsInserted: 0 });
  });

  it('loads valid entries once, skips bad ones, downgrades stale verification, and never overwrites edits', async () => {
    const r = await seedSavings(pool, FIXTURE, NOW);
    expect(r).toMatchObject({ modulesInserted: 1, packsInserted: 1 });
    expect(r.skipped.some((s) => s.includes('broken-one'))).toBe(true);
    expect((await pool.query(`SELECT status FROM savings_modules WHERE id = 'uber-one-in'`)).rows[0].status).toBe('verified');

    await editor.patch('/api/admin/savings/modules/uber-one-in', { actionLabel: 'Edited by admin' });
    const again = await seedSavings(pool, FIXTURE, NOW);
    expect(again).toMatchObject({ modulesInserted: 0, packsInserted: 0 });
    expect((await editor.get('/api/admin/savings/modules/uber-one-in')).json()).toMatchObject({ actionLabel: 'Edited by admin', version: 2 });

    await pool.query('TRUNCATE savings_modules');
    const later = await seedSavings(pool, FIXTURE, new Date('2027-03-01T00:00:00Z'));
    expect(later.modulesInserted).toBe(1);
    expect(later.skipped.some((s) => s.includes('stored as research'))).toBe(true);
    expect((await pool.query(`SELECT status FROM savings_modules WHERE id = 'uber-one-in'`)).rows[0].status).toBe('research');
  });
});
