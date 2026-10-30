import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { FixtureServer, page } from './fixtures/httpServer.js';
import { Client, freshDb, loggedIn, makeApp, TestClock } from './helpers.js';

let pool: Pool;
let app: FastifyInstance;
let srv: FixtureServer;
let editor: Client;
let admin: Client;
const clock = new TestClock(new Date('2026-10-29T08:00:00Z'));
let body = page('Offer', '<p>Line one</p><p>Line two</p>');
let companyId = '';
let sourceId = '';

const n = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);

beforeAll(async () => {
  pool = await freshDb();
  srv = await new FixtureServer().start();
  srv.robots('User-agent: *\nAllow: /\n');
  srv.html('/offer', () => body);
  app = await makeApp(pool, { clock });
  editor = await loggedIn(app, pool, 'editor@example.com', 'editor');
  admin = await loggedIn(app, pool, 'admin@example.com', 'admin');
});
afterAll(async () => {
  await app.close();
  await srv.stop();
  await pool.end();
});

describe('companies and sources', () => {
  it('creates, lists, reads, updates, verifies and archives a company', async () => {
    const r = await editor.post('/api/admin/companies', { name: 'Acme Telecom', kind: 'vendor', official_website: 'https://acme.example', country: 'IN' });
    expect(r.statusCode).toBe(201);
    const c = r.json();
    expect(c).toMatchObject({ name: 'Acme Telecom', slug: 'acme-telecom', kind: 'vendor', officialWebsite: 'https://acme.example', verificationStatus: 'unverified', monitoringEnabled: true });
    companyId = c.id;
    expect((await editor.post('/api/admin/companies', { name: 'Acme Telecom' })).statusCode).toBe(409);
    expect((await editor.post('/api/admin/companies', { name: '' })).statusCode).toBe(400);
    expect((await editor.post('/api/admin/companies', { name: 'X', officialWebsite: 'javascript:alert(1)' })).statusCode).toBe(400);
    const list = await editor.get('/api/admin/companies?kind=vendor&q=acme');
    expect(list.json().total).toBe(1);
    expect(list.json().items[0].sourceCount).toBe(0);
    const p = await editor.patch(`/api/admin/companies/${companyId}`, { description: 'Mobile operator' });
    expect(p.json().description).toBe('Mobile operator');
    const v = await editor.post(`/api/admin/companies/${companyId}/verify`, { status: 'verified', note: 'Checked domain' });
    expect(v.json()).toMatchObject({ verificationStatus: 'verified', verificationNote: 'Checked domain' });
    expect(v.json().verifiedBy).toBeTruthy();
    const other = (await editor.post('/api/admin/companies', { name: 'Old Co' })).json();
    const a = await editor.post(`/api/admin/companies/${other.id}/archive`);
    expect(a.json().status).toBe('archived');
    expect((await editor.get('/api/admin/companies?status=active')).json().total).toBe(1);
    expect((await editor.get('/api/admin/companies/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('creates a source with frequency defaults, validates, runs and updates it', async () => {
    const r = await editor.post('/api/admin/sources', {
      companyId,
      url: srv.url('/offer'),
      label: 'Offer page',
      sourceCategory: 'product_page',
      isOfficial: true,
      priority: 'critical',
    });
    expect(r.statusCode).toBe(201);
    const s = r.json();
    expect(s).toMatchObject({ frequencyMinutes: 1440, status: 'active', enabled: true, extractionMethod: 'html_text' });
    sourceId = s.id;
    expect((await editor.post('/api/admin/sources', { companyId, url: srv.url('/offer'), label: 'dup', sourceCategory: 'product_page' })).statusCode).toBe(409);
    expect((await editor.post('/api/admin/sources', { companyId, url: 'ftp://x', label: 'bad', sourceCategory: 'product_page' })).statusCode).toBe(400);

    const v = await editor.post(`/api/admin/sources/${sourceId}/validate`);
    expect(v.statusCode).toBe(200);
    expect(v.json()).toMatchObject({ outcome: 'changed', robotsAllowed: true, httpStatus: 200, title: 'Offer', stored: true });
    // Validate again: unchanged → nothing stored.
    const v2 = (await editor.post(`/api/admin/sources/${sourceId}/validate`)).json();
    expect(v2).toMatchObject({ outcome: 'unchanged', stored: false });
    expect(await n('SELECT count(*) AS n FROM snapshots')).toBe(1);

    body = page('Offer', '<p>Line one</p><p>Line three</p>');
    clock.advanceMinutes(10);
    const run = (await editor.post(`/api/admin/sources/${sourceId}/run`)).json();
    expect(run).toMatchObject({ outcome: 'changed', sourceStatus: 'active', recordsModified: 1 });

    const runs = (await editor.get(`/api/admin/sources/${sourceId}/runs`)).json();
    expect(runs.items.map((x: { outcome: string }) => x.outcome)).toEqual(['changed', 'changed']);
    const snaps = (await editor.get(`/api/admin/sources/${sourceId}/snapshots`)).json();
    expect(snaps.total).toBe(2);
    expect(snaps.items[0].textContent).toBeUndefined();
    const [newer, older] = snaps.items;
    const one = (await editor.get(`/api/admin/snapshots/${newer.id}`)).json();
    expect(one.textContent).toContain('Line three');
    const diff = (await editor.get(`/api/admin/snapshots/${newer.id}/diff?against=${older.id}`)).json();
    expect(diff).toEqual({ id: newer.id, against: older.id, added: ['Line three'], removed: ['Line two'] });

    const patched = (await editor.patch(`/api/admin/sources/${sourceId}`, { enabled: false })).json();
    expect(patched.status).toBe('disabled');
    const skipped = (await editor.post(`/api/admin/sources/${sourceId}/run`)).json();
    expect(skipped.outcome).toBe('skipped_disabled');
    const re = (await editor.patch(`/api/admin/sources/${sourceId}`, { enabled: true, frequency_minutes: 720 })).json();
    expect(re).toMatchObject({ status: 'active', frequencyMinutes: 720 });
    const detail = (await editor.get(`/api/admin/companies/${companyId}`)).json();
    expect(detail.sources).toHaveLength(1);
    expect(detail.recentRecords).toHaveLength(1);
    expect(detail.intel).toEqual([]);
  });
});

describe('records', () => {
  it('reviews and manually corrects a record without losing history', async () => {
    const list = (await editor.get(`/api/admin/records?companyId=${companyId}&status=pending`)).json();
    expect(list.total).toBe(1);
    const id = list.items[0].id;
    expect(list.items[0].sourceUrl).toBe(srv.url('/offer'));
    const rev = await editor.post(`/api/admin/records/${id}/review`, { decision: 'approved', note: 'Matches page' });
    expect(rev.json()).toMatchObject({ verificationStatus: 'approved', reviewNote: 'Matches page' });
    const fix = await editor.patch(`/api/admin/records/${id}`, { title: 'Offer (corrected)', note: 'Typo' });
    expect(fix.json()).toMatchObject({ title: 'Offer (corrected)', currentVersion: 3 });
    const detail = (await editor.get(`/api/admin/records/${id}`)).json();
    expect(detail.versions.map((v: { changeType: string }) => v.changeType)).toEqual(['manual_correction', 'modified', 'new']);
    expect(detail.versions[0].changedBy).toBeTruthy();
    const viewer = await loggedIn(app, pool, 'viewer@example.com', 'viewer');
    expect((await viewer.post(`/api/admin/records/${id}/review`, { decision: 'rejected' })).statusCode).toBe(403);
  });
});

describe('jobs', () => {
  it('runs a job manually and logs it in job_runs', async () => {
    const r = await editor.post('/api/admin/jobs/monitor_sources/run');
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ jobId: 'monitor_sources', triggeredBy: 'manual', status: 'running' });
    let runs;
    for (let i = 0; i < 50; i++) {
      runs = (await editor.get('/api/admin/job-runs?jobId=monitor_sources')).json();
      if (runs.items[0].status !== 'running') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(runs.items[0]).toMatchObject({ status: 'success', triggeredBy: 'manual' });
    expect((await editor.get('/api/admin/jobs')).json().items.find((j: { id: string }) => j.id === 'monitor_sources').lastRunAt).toBeTruthy();
    const p = await admin.patch('/api/admin/jobs/retention_cleanup', { enabled: false, interval_minutes: 720 });
    expect(p.json()).toMatchObject({ enabled: false, intervalMinutes: 720 });
    expect((await editor.post('/api/admin/jobs/nope/run')).statusCode).toBe(400);
  });
});

describe('dashboard', () => {
  it('reports counts equal to SQL counts', async () => {
    const d = (await editor.get('/api/admin/dashboard')).json();
    const since = new Date(clock.now.getTime() - 7 * 86400_000);
    expect(d.companies).toBe(await n(`SELECT count(*) AS n FROM companies WHERE kind = 'company' AND status = 'active'`));
    expect(d.vendors).toBe(await n(`SELECT count(*) AS n FROM companies WHERE kind = 'vendor' AND status = 'active'`));
    expect(d.activeSources).toBe(await n('SELECT count(*) AS n FROM sources WHERE enabled'));
    expect(d.monitoredSources).toBe(
      await n(`SELECT count(*) AS n FROM sources s JOIN companies c ON c.id = s.company_id WHERE s.enabled AND c.monitoring_enabled AND c.status = 'active'`),
    );
    expect(d.newRecords7d).toBe(await n('SELECT count(*) AS n FROM records WHERE first_seen_at >= $1', [since]));
    expect(d.updatedRecords7d).toBe(
      await n(`SELECT count(DISTINCT record_id) AS n FROM record_versions WHERE change_type <> 'new' AND captured_at >= $1`, [since]),
    );
    expect(d.failedFetches7d).toBe(await n(`SELECT count(*) AS n FROM fetch_runs WHERE outcome = 'error' AND started_at >= $1`, [since]));
    expect(d.pendingVerification).toBe(await n(`SELECT count(*) AS n FROM records WHERE verification_status = 'pending'`));
    expect(d.vendors).toBe(1);
    expect(d.newRecords7d).toBe(1);
    expect(d.updatedRecords7d).toBe(1);
    expect(d.latestRuns.length).toBe(await n('SELECT least(count(*), 10) AS n FROM job_runs'));
    expect(d.automation.jobs).toHaveLength(5);
  });
});

describe('export', () => {
  it('CSV and JSON carry source attribution', async () => {
    const csv = await editor.get('/api/admin/export/records.csv');
    expect(csv.statusCode).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toMatch(/attachment; filename="due-records-2026-10-29\.csv"/);
    const [header, row] = csv.body.trim().split('\r\n');
    expect(header).toContain('source_url');
    expect(header).toContain('retrieved_at');
    expect(header).toContain('extraction_method');
    expect(row).toContain(srv.url('/offer'));
    expect(row).toContain('html_text');
    const json = (await editor.get('/api/admin/export/records.json')).json();
    expect(json.attribution).toMatch(/source/);
    expect(json.records).toHaveLength(1);
    expect(json.records[0].source).toMatchObject({ url: srv.url('/offer'), label: 'Offer page', isOfficial: true, extractionMethod: 'html_text' });
    expect(json.records[0].source.retrievedAt).toBeTruthy();
    expect(await n(`SELECT count(*) AS n FROM audit_log WHERE action LIKE 'export.%'`)).toBe(2);
  });
});

describe('categories, settings, alerts, offers', () => {
  it('manages categories (admin) and settings with validation', async () => {
    const c = await admin.post('/api/admin/categories', { name: 'Telecom' });
    expect(c.statusCode).toBe(201);
    expect((await admin.post('/api/admin/categories', { name: 'Telecom' })).statusCode).toBe(409);
    expect((await admin.patch(`/api/admin/categories/${c.json().id}`, { description: 'Mobile' })).json().description).toBe('Mobile');
    expect((await admin.del(`/api/admin/categories/${c.json().id}`)).statusCode).toBe(200);

    const s = (await admin.get('/api/admin/settings')).json();
    expect(s.retry).toEqual({ base_minutes: 30, max_minutes: 1440, max_attempts_before_inaccessible: 8 });
    expect(s.frequency_defaults).toEqual({ critical: 1440, regular: 10080, secondary: 10080 });
    expect((await admin.patch('/api/admin/settings', { key: 'retry', value: { base_minutes: 10 } })).statusCode).toBe(400);
    expect((await admin.patch('/api/admin/settings', { key: 'unknown', value: 1 })).statusCode).toBe(400);
    const u = await admin.patch('/api/admin/settings', { key: 'retry', value: { base_minutes: 15, max_minutes: 720, max_attempts_before_inaccessible: 5 } });
    expect(u.json().retry.base_minutes).toBe(15);
    expect(await n(`SELECT count(*) AS n FROM audit_log WHERE action = 'settings.update'`)).toBe(1);
  });

  it('lists and marks alerts read', async () => {
    const all = (await editor.get('/api/admin/alerts?unread=1')).json();
    expect(all.items.length).toBeGreaterThan(0);
    const id = all.items[0].id;
    expect((await editor.post(`/api/admin/alerts/${id}/read`)).json().readAt).toBeTruthy();
    expect((await editor.get('/api/admin/alerts?unread=1')).json().unreadCount).toBe(all.unreadCount - 1);
  });

  it('creates and patches offers; public catalog has the contract shape', async () => {
    const created = await editor.post('/api/admin/offers', {
      id: 'acme-offer',
      provider: 'acme',
      productFamily: 'Acme plans',
      name: 'Acme plan with streaming',
      benefitType: 'bundle',
      sourceUrls: [srv.url('/offer'), 'https://acme.example/terms'],
      details: { sources: [{ url: 'https://acme.example/terms', label: 'Acme terms', kind: 'terms' }] },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: 'acme-offer', verificationStatus: 'pending' });
    const p = await editor.patch('/api/admin/offers/acme-offer', { confidence: 'medium' });
    expect(p.json().confidence).toBe('medium');
    const app2 = await makeApp(pool, { clock });
    const pub = await app2.inject({ method: 'GET', url: '/api/public/catalog', headers: { origin: 'https://app.example.test' } });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['access-control-allow-origin']).toBe('https://app.example.test');
    expect(pub.headers['cache-control']).toBe('public, max-age=300');
    const cat = pub.json();
    expect(cat.generatedAt).toBe('2026-10-29T08:10:00.000Z');
    const offer = cat.offers.find((o: { id: string }) => o.id === 'acme-offer');
    expect(offer).toMatchObject({ provider: 'acme', name: 'Acme plan with streaming', confidence: 'medium' });
    expect(offer.sources).toEqual([
      { url: srv.url('/offer'), label: 'Offer page', category: 'product_page', lastCheckedAt: expect.any(String), status: 'active' },
      { url: 'https://acme.example/terms', label: 'Acme terms', category: 'terms', lastCheckedAt: null, status: 'not_monitored' },
    ]);
    const evil = await app2.inject({ method: 'GET', url: '/api/public/catalog', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    await app2.close();
  });
});

describe('platform', () => {
  it('health reports db and scheduler state; security headers are set', async () => {
    expect((await editor.req('POST', '/api/admin/jobs/retention_cleanup/run')).statusCode).toBeLessThan(300);
    const h = await app.inject({ method: 'GET', url: '/api/health' });
    expect(h.json()).toMatchObject({ ok: true, db: true, scheduler: { lastRunAt: expect.any(String) } });
    expect(h.headers['x-content-type-options']).toBe('nosniff');
    expect(h.headers['x-frame-options']).toBe('DENY');
    expect(h.headers['referrer-policy']).toBe('no-referrer');
    const me = await editor.get('/api/auth/me');
    expect(me.headers['cache-control']).toBe('no-store');
    const big = await editor.req('POST', '/api/admin/companies', { name: 'x'.repeat(300 * 1024) });
    expect(big.statusCode).toBe(413);
    expect((await app.inject({ method: 'GET', url: '/api/nope' })).json()).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });
});
