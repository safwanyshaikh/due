import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { SEED_DIR } from '../src/paths.js';
import { seedAll } from '../src/seed/registry.js';
import { freshDb, loggedIn, makeApp } from './helpers.js';

const REGISTRY = resolve(SEED_DIR, 'registry.json');
const PAYMENTS = resolve(SEED_DIR, 'registry-payments.json');
const OFFERS = resolve(SEED_DIR, 'offers.json');
const FIXTURE = resolve(import.meta.dirname, 'fixtures/registry-payments.sample.json');

let pool: Pool;
beforeAll(async () => {
  pool = await freshDb();
});
afterAll(async () => {
  await pool.end();
});

const n = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);

describe('seed:registry', () => {
  it.skipIf(!existsSync(REGISTRY))('imports the real registry.json (+ payments file if present) and offers idempotently', async () => {
    const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    const files = { registries: [REGISTRY, PAYMENTS], offers: OFFERS };
    const first = await seedAll(pool, files);
    const vendorSlugs = new Set<string>(reg.vendors.map((v: { slug: string }) => v.slug));
    if (existsSync(PAYMENTS)) {
      for (const v of JSON.parse(readFileSync(PAYMENTS, 'utf8')).vendors) vendorSlugs.add(v.slug);
    } else {
      expect(first.warnings.some((w) => w.includes('registry-payments.json'))).toBe(true);
    }
    expect(first.companiesCreated).toBe(vendorSlugs.size);
    expect(await n('SELECT count(*) AS n FROM companies')).toBe(vendorSlugs.size);
    expect(first.offersCreated).toBe(22);
    // Research evidence is source state only: no records are created by seeding.
    expect(await n('SELECT count(*) AS n FROM records')).toBe(0);
    expect(await n('SELECT count(*) AS n FROM snapshots')).toBe(0);
    for (const v of reg.vendors) {
      for (const s of v.sources) {
        const row = (await pool.query('SELECT s.* FROM sources s JOIN companies c ON c.id = s.company_id WHERE c.slug = $1 AND s.url = $2', [v.slug, s.url])).rows[0];
        expect(row, s.url).toBeTruthy();
        if (s.evidence?.status === 'inaccessible') {
          expect(row.status).toBe('inaccessible');
          expect(row.last_error).toBe(s.evidence.reason);
        }
      }
    }
    const second = await seedAll(pool, files);
    expect(second.companiesCreated).toBe(0);
    expect(second.sourcesCreated).toBe(0);
    expect(second.offersCreated).toBe(0);
    expect(second.offersExisting).toBe(22);
  });

  it('keeps offer facts from the catalog with research_snapshot status and their source URLs', async () => {
    const offers = (await pool.query('SELECT * FROM offers ORDER BY id')).rows;
    if (offers.length === 0) await seedAll(pool, { registries: [], offers: OFFERS });
    const rows = (await pool.query('SELECT * FROM offers')).rows;
    expect(rows).toHaveLength(22);
    expect(rows.every((r) => r.verification_status === 'research_snapshot' && r.source_urls.length > 0)).toBe(true);
    const jio = rows.find((r) => r.id === 'jio-prepaid-1029-prime');
    expect(jio).toMatchObject({ price_inr: 1029, provider: 'jio' });
    expect(jio.source_urls).toEqual(['https://www.jio.com/selfcare/plans/mobility/prepaid-plans-home/']);
    if (existsSync(REGISTRY)) expect(jio.source_ids.length).toBe(1);
  });

  it('maps evidence states, merges vendors by slug and stores offer patterns/partners as vendor_intel', async () => {
    const stats = await seedAll(pool, { registries: [REGISTRY, FIXTURE], offers: null });
    const src = async (url: string) => (await pool.query('SELECT * FROM sources WHERE url = $1', [url])).rows;
    const ok = (await src('https://pay.fixture.invalid/ok'))[0];
    expect(ok).toMatchObject({ status: 'active', last_error: null });
    expect(ok.last_success_at.toISOString()).toBe('2026-10-30T09:00:00.000Z');
    const fr = (await pool.query('SELECT * FROM fetch_runs WHERE source_id = $1', [ok.id])).rows;
    expect(fr).toHaveLength(1);
    expect(fr[0]).toMatchObject({ method: 'research_webfetch', outcome: 'unchanged' });
    expect((await src('https://pay.fixture.invalid/app'))[0]).toMatchObject({ status: 'inaccessible', last_error: 'Rendered client-side' });
    expect((await src('https://pay.fixture.invalid/blocked'))[0]).toMatchObject({ status: 'blocked_robots' });
    if (existsSync(REGISTRY)) {
      // The duplicate Jio URL from the second file is merged into the same company, not duplicated.
      expect(await src('https://www.jio.com/google-gemini-offer/')).toHaveLength(1);
      expect(await n(`SELECT count(*) AS n FROM companies WHERE slug = 'reliance-jio'`)).toBe(1);
    }
    expect(await n('SELECT count(*) AS n FROM records')).toBe(0);
    expect(stats.intelCreated).toBe(3);
    const again = await seedAll(pool, { registries: [REGISTRY, FIXTURE], offers: null });
    expect(again.intelCreated).toBe(0);
    expect(again.sourcesCreated).toBe(0);

    const app = await makeApp(pool);
    const viewer = await loggedIn(app, pool, 'seedviewer@example.com', 'viewer');
    const cid = (await pool.query(`SELECT id FROM companies WHERE slug = 'fixture-pay'`)).rows[0].id;
    const detail = (await viewer.get(`/api/admin/companies/${cid}`)).json();
    expect(detail.intel.map((i: { kind: string }) => i.kind).sort()).toEqual(['offer_pattern', 'partner', 'partner']);
    const pattern = detail.intel.find((i: { kind: string }) => i.kind === 'offer_pattern');
    expect(pattern).toMatchObject({ sourceUrl: 'https://pay.fixture.invalid/ok', verificationStatus: 'pending', method: 'test fixture' });
    await app.close();
  });

  it('skips missing files gracefully', async () => {
    const s = await seedAll(pool, { registries: ['/nonexistent/registry.json'], offers: '/nonexistent/offers.json' });
    expect(s.warnings).toHaveLength(2);
    expect(s.files).toHaveLength(0);
  });
});
