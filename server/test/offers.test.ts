import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { startJob } from '../src/jobs/runner.js';
import { recomputeAllStatuses, refreshOfferSource } from '../src/monitor/offers.js';
import { normaliseDate, parseObservation } from '../src/monitor/parser.js';
import { computeStatus, effectiveConfidence, type StatusInput } from '../src/monitor/status.js';
import { seedAll } from '../src/seed/registry.js';
import { SEED_DIR } from '../src/paths.js';
import { resolve } from 'node:path';
import { FixtureServer, page } from './fixtures/httpServer.js';
import { Client, drain, freshDb, loggedIn, makeApp, monitorCtx, TestClock } from './helpers.js';

const NOW = new Date('2026-10-30T09:00:00Z');

function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    official_end_at: null,
    terms_status: 'active',
    page_status: 'visible',
    verification_status: 'pending',
    benefit_value: {},
    details: {},
    last_successful_check_at: new Date('2026-10-30T08:00:00Z'),
    last_confirmed_at: null,
    observed_at: null,
    freshness_window_hours: 168,
    ...over,
  };
}

describe('status rules (pure)', () => {
  it('expires on a passed official end date and on unavailable terms', () => {
    expect(computeStatus(input({ official_end_at: '2026-10-29' }), NOW)).toMatchObject({ status: 'expired', reason: 'official_end_passed' });
    expect(computeStatus(input({ official_end_at: '2026-10-30' }), NOW).status).toBe('active');
    expect(computeStatus(input({ terms_status: 'unavailable', page_status: 'unknown' }), NOW)).toMatchObject({ status: 'expired', reason: 'terms_unavailable' });
    expect(computeStatus(input({ terms_status: 'expired', page_status: 'unavailable' }), NOW).status).toBe('expired');
  });

  it('is conflicting when the landing page is visible but the terms are unavailable or expired', () => {
    expect(computeStatus(input({ terms_status: 'unavailable', page_status: 'visible' }), NOW)).toMatchObject({
      status: 'conflicting',
      reason: 'landing_visible_terms_unavailable',
    });
    expect(computeStatus(input({ terms_status: 'expired' }), NOW).status).toBe('conflicting');
    expect(computeStatus(input({ terms_status: 'conflicting' }), NOW).status).toBe('conflicting');
  });

  it('keeps personalised, app-only, provider-only and never-confirmed offers at active_verify; a landing page alone is unknown', () => {
    expect(computeStatus(input({ benefit_value: { personalised: true } }), NOW)).toMatchObject({ status: 'active_verify', reason: 'personalised_or_app_only' });
    expect(computeStatus(input({ details: { appOnly: true } }), NOW).status).toBe('active_verify');
    expect(computeStatus(input({ page_status: 'login_required' }), NOW).status).toBe('active_verify');
    expect(computeStatus(input({ details: { eligibility: [{ verification: 'provider_only' }] } }), NOW).reason).toBe('provider_only_eligibility');
    expect(computeStatus(input({ last_successful_check_at: null, last_confirmed_at: new Date('2026-10-30T00:00:00Z') }), NOW)).toMatchObject({
      status: 'active_verify',
      reason: 'not_yet_confirmed_by_engine',
    });
    expect(computeStatus(input({ terms_status: 'unknown' }), NOW)).toMatchObject({ status: 'unknown', reason: 'landing_page_only' });
    expect(computeStatus(input(), NOW)).toMatchObject({ status: 'active', reason: 'terms_and_page_active' });
  });

  it('stale policy: beyond the window active becomes active_verify; beyond twice the window it is unknown', () => {
    const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000);
    expect(computeStatus(input({ last_successful_check_at: at(100) }), NOW).status).toBe('active');
    const stale = computeStatus(input({ last_successful_check_at: at(200) }), NOW);
    expect(stale).toMatchObject({ status: 'active_verify', reason: 'stale_beyond_freshness_window', baseStatus: 'active' });
    expect(stale.freshness).toMatchObject({ state: 'stale', windowHours: 168 });
    expect(computeStatus(input({ last_successful_check_at: at(400) }), NOW)).toMatchObject({ status: 'unknown', reason: 'stale_beyond_twice_freshness_window' });
    expect(computeStatus(input({ last_successful_check_at: at(400), benefit_value: { personalised: true } }), NOW).status).toBe('unknown');
    // Expired and conflicting are not softened by staleness.
    expect(computeStatus(input({ last_successful_check_at: at(400), terms_status: 'expired' }), NOW).status).toBe('conflicting');
    expect(computeStatus(input({ last_successful_check_at: null, last_confirmed_at: null }), NOW).status).toBe('unknown');
    expect(effectiveConfidence('high', stale)).toBe('medium');
    expect(effectiveConfidence('high', computeStatus(input({ terms_status: 'unknown' }), NOW))).toBe('low');
  });

  it('parses declared fields only, and reports 404 terms as unavailable', () => {
    expect(normaliseDate('31 Dec 2026')).toBe('2026-12-31');
    expect(normaliseDate('31/12/2026')).toBe('2026-12-31');
    expect(normaliseDate('2026-02-30')).toBeNull();
    const rules = { price: { pattern: '₹\\s?([\\d,]+)', group: 1 }, officialEnd: { pattern: 'valid till (\\d{1,2} \\w+ \\d{4})', group: 1 } };
    expect(parseObservation({ offerId: 'x', sourceCategory: 'pricing', httpStatus: 200, text: 'Plan ₹1,029 valid till 31 Dec 2026', rules })).toEqual({
      price: 1029,
      billing_period: null,
      benefit_value: null,
      official_start: null,
      official_end: '2026-12-31',
      page_status: 'visible',
      terms_status: null,
    });
    expect(parseObservation({ offerId: 'x', sourceCategory: 'terms', httpStatus: 404, text: null, rules: {} }).terms_status).toBe('unavailable');
    expect(parseObservation({ offerId: 'x', sourceCategory: 'terms', httpStatus: 200, text: 'This offer has ended.', rules: { expiredPattern: 'offer has ended' } }).terms_status).toBe(
      'expired',
    );
  });
});

describe('offer intelligence engine (Postgres)', () => {
  let pool: Pool;
  let srv: FixtureServer;
  let app: FastifyInstance;
  let editor: Client;
  let viewer: Client;
  let admin: Client;
  const clock = new TestClock(NOW);
  let companyId: string;
  let pageSource: string;
  let termsSource: string;
  let planHtml = '';

  const n = async (sql: string, p: unknown[] = []) => Number((await pool.query(sql, p)).rows[0].n);
  const offer = async (id: string) => (await pool.query('SELECT * FROM offers WHERE id = $1', [id])).rows[0];

  beforeAll(async () => {
    srv = await new FixtureServer().start();
  });
  afterAll(async () => {
    await app?.close();
    await srv.stop();
    await pool?.end();
  });

  beforeEach(async () => {
    await app?.close();
    await pool?.end();
    pool = await freshDb();
    clock.set(NOW);
    srv.routes.clear();
    srv.robots('User-agent: *\nAllow: /\n');
    planHtml = page('Acme 1029 plan', '<p>Acme prepaid plan ₹1,029 with streaming. Offer valid till 31 Dec 2026.</p>');
    srv.html('/plan', () => planHtml);
    srv.html('/terms', () => page('Acme terms', '<p>Terms and conditions for the Acme streaming offer apply.</p>'));
    app = await makeApp(pool, { clock });
    editor = await loggedIn(app, pool, 'editor@due.test', 'editor');
    viewer = await loggedIn(app, pool, 'viewer@due.test', 'viewer');
    admin = await loggedIn(app, pool, 'admin@due.test', 'admin');
    companyId = (await pool.query(`INSERT INTO companies (kind, name, slug, provider_family) VALUES ('vendor','Acme','acme','jio') RETURNING id`)).rows[0].id;
    const src = async (path: string, category: string) =>
      (
        await pool.query(
          `INSERT INTO sources (company_id, url, label, source_category, frequency_minutes, next_check_at) VALUES ($1,$2,$3,$4,1440,$5) RETURNING id`,
          [companyId, srv.url(path), `Acme ${path}`, category, NOW],
        )
      ).rows[0].id as string;
    pageSource = await src('/plan', 'pricing');
    termsSource = await src('/terms', 'terms');
    const created = await editor.post('/api/admin/offers', {
      id: 'acme-1029',
      provider: 'acme',
      productFamily: 'Acme prepaid',
      name: 'Acme ₹999 plan with streaming',
      benefitType: 'bundle',
      priceInr: 999,
      billingPeriod: 'none',
      sourceUrls: [srv.url('/plan'), srv.url('/terms')],
      termsStatus: 'active',
      pageStatus: 'visible',
      confidence: 'high',
      sku: '1029',
      freshnessWindowHours: 168,
      providerFamily: 'jio',
    });
    expect(created.statusCode).toBe(201);
    // Never engine-confirmed yet: cannot be active.
    expect(created.json()).toMatchObject({ status: 'unknown', statusReason: 'never_checked' });
    const pv = await admin.post('/api/admin/parser-versions', {
      sourceId: pageSource,
      version: 'v1',
      rules: { price: { pattern: '₹\\s?([\\d,]+)' }, officialEnd: { pattern: 'valid till (\\d{1,2} \\w+ \\d{4})' } },
      activate: true,
    });
    expect(pv.statusCode).toBe(201);
  });

  it('a refresh appends an observation, queues changes for review (not applied) and dedupes by fingerprint', async () => {
    const ctx = monitorCtx(pool, clock);
    const r1 = await refreshOfferSource(ctx, pageSource);
    expect(r1).toMatchObject({ ok: true, offers: 1, observationsAdded: 1, reviewsQueued: 2 });
    const o = await offer('acme-1029');
    expect(Number(o.price_inr)).toBe(999); // not auto-applied
    expect(o.official_end_at).toBeNull();
    expect(o.last_successful_check_at.toISOString()).toBe(NOW.toISOString());
    const obs = (await pool.query('SELECT * FROM offer_observations WHERE offer_id = $1', ['acme-1029'])).rows;
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ parser_version: 'v1', source_id: pageSource, origin: 'engine' });
    expect(obs[0].fields).toMatchObject({ price: 1029, official_end: '2026-12-31', page_status: 'visible' });
    expect(obs[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
    const reviews = (await pool.query(`SELECT change_kind, proposed, current FROM offer_review_queue ORDER BY change_kind`)).rows;
    expect(reviews).toEqual([
      { change_kind: 'expiry', proposed: { official_end: '2026-12-31' }, current: { official_end: null } },
      { change_kind: 'price', proposed: { price: 1029 }, current: { price: 999 } },
    ]);

    clock.advanceMinutes(60);
    const r2 = await refreshOfferSource(ctx, pageSource);
    expect(r2).toMatchObject({ ok: true, observationsAdded: 0, reviewsQueued: 0 });
    expect(await n('SELECT count(*)::int AS n FROM offer_observations')).toBe(1);
    expect(await n('SELECT count(*)::int AS n FROM offer_review_queue')).toBe(2);
    expect((await offer('acme-1029')).last_successful_check_at.toISOString()).toBe(clock.now.toISOString());

    // A real change appends a second observation; history is kept.
    planHtml = page('Acme 1029 plan', '<p>Acme prepaid plan ₹1,049 with streaming. Offer valid till 31 Dec 2026.</p>');
    clock.advanceMinutes(60);
    expect((await refreshOfferSource(ctx, pageSource)).observationsAdded).toBe(1);
    const hist = await viewer.get('/api/admin/offers/acme-1029/observations');
    expect(hist.statusCode).toBe(200);
    const items = hist.json().items;
    expect(items).toHaveLength(2);
    expect(items[0].diff).toEqual([{ field: 'price', from: 1029, to: 1049 }]);
    expect(items[1].firstForSource).toBe(true);
  });

  it('observations and status transitions are append-only', async () => {
    await refreshOfferSource(monitorCtx(pool, clock), pageSource);
    await expect(pool.query(`UPDATE offer_observations SET fingerprint = 'x'`)).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM offer_observations')).rejects.toThrow(/append-only/);
    expect(await n('SELECT count(*)::int AS n FROM offer_status_transitions')).toBeGreaterThan(0);
    await expect(pool.query('DELETE FROM offer_status_transitions')).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM offers WHERE id = 'acme-1029'`)).rejects.toThrow();
  });

  it('approve applies the change with audit and a status transition; reject records the decision only', async () => {
    await refreshOfferSource(monitorCtx(pool, clock), pageSource);
    const list = await viewer.get('/api/admin/review');
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(2);
    const price = list.json().items.find((i: { changeKind: string }) => i.changeKind === 'price');
    const expiry = list.json().items.find((i: { changeKind: string }) => i.changeKind === 'expiry');
    expect(price).toMatchObject({ offerName: 'Acme ₹999 plan with streaming', sourceUrl: srv.url('/plan'), parserVersion: 'v1' });

    expect((await viewer.post(`/api/admin/review/${price.id}/approve`, { note: 'x' })).statusCode).toBe(403);
    const ok = await editor.post(`/api/admin/review/${price.id}/approve`, { note: 'Checked the plans page' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().review).toMatchObject({ status: 'approved', note: 'Checked the plans page' });
    expect(Number((await offer('acme-1029')).price_inr)).toBe(1029);
    expect((await editor.post(`/api/admin/review/${price.id}/approve`, {})).statusCode).toBe(409);
    const audits = (await pool.query(`SELECT action, entity_id FROM audit_log WHERE action LIKE 'offer.review%' ORDER BY id`)).rows;
    expect(audits).toEqual([
      { action: 'offer.review.apply', entity_id: 'acme-1029' },
      { action: 'offer.review.approve', entity_id: String(price.id) },
    ]);

    const rej = await editor.post(`/api/admin/review/${expiry.id}/reject`, { note: 'Banner date, not the terms' });
    expect(rej.json().review).toMatchObject({ status: 'rejected' });
    expect((await offer('acme-1029')).official_end_at).toBeNull();
    expect(await n(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'offer.review.reject'`)).toBe(1);

    // Terms page disappears: proposed terms_status=unavailable; approving makes the offer conflicting (landing still visible).
    srv.routes.delete('/terms');
    const t = await refreshOfferSource(monitorCtx(pool, clock), termsSource);
    expect(t).toMatchObject({ ok: true, observationsAdded: 1, reviewsQueued: 1 });
    expect((await offer('acme-1029')).terms_status).toBe('active');
    const statusItem = (await viewer.get('/api/admin/review')).json().items[0];
    expect(statusItem).toMatchObject({ changeKind: 'status', proposed: { terms_status: 'unavailable' } });
    const ap = await editor.post(`/api/admin/review/${statusItem.id}/approve`, {});
    expect(ap.json().offerStatus).toBe('conflicting');
    const tr = (await pool.query(`SELECT * FROM offer_status_transitions WHERE offer_id = 'acme-1029' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(tr).toMatchObject({ to_status: 'conflicting', reason: 'landing_visible_terms_unavailable', actor: 'admin', actor_email: 'editor@due.test' });
  });

  it('a failed refresh keeps the last good observation and shows last successful vs last attempted check', async () => {
    const ctx = monitorCtx(pool, clock);
    await refreshOfferSource(ctx, pageSource);
    const good = await offer('acme-1029');
    srv.routes.set('/plan', (_q, res) => res.writeHead(500).end('down'));
    clock.advanceMinutes(120);
    const r = await refreshOfferSource(ctx, pageSource);
    expect(r).toMatchObject({ ok: false, permanent: false });
    const after = await offer('acme-1029');
    expect(after.last_successful_check_at.toISOString()).toBe(good.last_successful_check_at.toISOString());
    expect(after.last_attempted_check_at.toISOString()).toBe(clock.now.toISOString());
    expect(after.last_check_error).toMatch(/HTTP 500/);
    expect(Number(after.price_inr)).toBe(999);
    expect(after.computed_status).toBe(good.computed_status);
    expect(await n('SELECT count(*)::int AS n FROM offer_observations')).toBe(1);

    // Through the durable queue: the job fails (and will retry) without touching the observation.
    await pool.query(`UPDATE sources SET next_check_at = $1, consecutive_failures = 0`, [clock.now]);
    const enq = await editor.post('/api/admin/offers/acme-1029/refresh');
    expect(enq.statusCode).toBe(202);
    expect(enq.json().jobs).toHaveLength(2);
    const d = await drain(app);
    expect(d.byStatus).toMatchObject({ failed: 1, succeeded: 1 });
    expect(await n(`SELECT count(*)::int AS n FROM jobs_queue WHERE type = 'offers.refresh' AND status = 'failed' AND last_error_code = 'fetch_failed'`)).toBe(1);
    expect(await n('SELECT count(*)::int AS n FROM offer_observations WHERE source_id = $1', [pageSource])).toBe(1);
    const detail = (await viewer.get('/api/admin/offers/acme-1029')).json();
    expect(detail.lastSuccessfulCheckAt).toBeTruthy();
    expect(detail.lastAttemptedCheckAt).toBeTruthy();
    expect(detail.lastCheckError).toMatch(/HTTP 500/);
  });

  it('the periodic job applies the stale policy and records each transition; the public catalog shows freshness', async () => {
    const ctx = monitorCtx(pool, clock);
    await refreshOfferSource(ctx, termsSource);
    expect((await offer('acme-1029')).computed_status).toBe('active');
    clock.advanceMinutes(170 * 60);
    expect(await recomputeAllStatuses(pool, clock.now)).toEqual({ checked: 1, transitions: 1 });
    expect((await offer('acme-1029')).computed_status).toBe('active_verify');
    clock.advanceMinutes(170 * 60);
    expect((await recomputeAllStatuses(pool, clock.now)).transitions).toBe(1);
    expect((await offer('acme-1029')).computed_status).toBe('unknown');
    expect((await recomputeAllStatuses(pool, clock.now)).transitions).toBe(0);
    const trs = (await pool.query(`SELECT from_status, to_status, reason, actor FROM offer_status_transitions WHERE offer_id = 'acme-1029' ORDER BY id`)).rows;
    expect(trs.slice(-3)).toEqual([
      { from_status: 'unknown', to_status: 'active', reason: 'terms_and_page_active', actor: 'system' },
      { from_status: 'active', to_status: 'active_verify', reason: 'stale_beyond_freshness_window', actor: 'system' },
      { from_status: 'active_verify', to_status: 'unknown', reason: 'stale_beyond_twice_freshness_window', actor: 'system' },
    ]);

    const pub = await app.inject({ method: 'GET', url: '/api/public/catalog' });
    const o = pub.json().offers.find((x: { id: string }) => x.id === 'acme-1029');
    expect(o).toMatchObject({
      status: 'unknown',
      statusReason: 'stale_beyond_twice_freshness_window',
      confidence: 'high',
      effectiveConfidence: 'low',
      freshness: { state: 'expired_window', windowHours: 168 },
      sku: '1029',
      providerFamily: 'jio',
    });
    expect(o.lastSuccessfulCheckAt).toBe(NOW.toISOString());
    expect(o.sources.map((s: { url: string }) => s.url)).toEqual([srv.url('/plan'), srv.url('/terms')]);
  });

  it('the scheduler enqueues one offers.refresh per due source and respects the source cadence', async () => {
    const ctx = monitorCtx(pool, clock);
    const run = await startJob(ctx, 'offers_refresh', 'manual');
    expect((await run!.done).stats).toMatchObject({ due: 2, enqueued: 2 });
    const again = await startJob(ctx, 'offers_refresh', 'manual');
    expect((await again!.done).stats).toMatchObject({ due: 0, enqueued: 0 });
    expect((await drain(app)).byStatus).toMatchObject({ succeeded: 2 });
    expect(await n('SELECT count(*)::int AS n FROM offer_observations')).toBe(2);
    clock.advanceMinutes(1441);
    expect((await (await startJob(ctx, 'offers_refresh', 'manual'))!.done).stats).toMatchObject({ due: 2, enqueued: 2 });
    const status = await startJob(ctx, 'offers_status', 'manual');
    expect((await status!.done).stats).toMatchObject({ enqueued: 1 });
  });

  it('parser versions: Admin creates/activates (one active per scope); Editors and Viewers cannot', async () => {
    const body = { sourceId: pageSource, version: 'v2', rules: { price: { pattern: 'Rs\\.?\\s?(\\d+)' } } };
    expect((await editor.post('/api/admin/parser-versions', body)).statusCode).toBe(403);
    expect((await viewer.post('/api/admin/parser-versions', body)).statusCode).toBe(403);
    expect((await admin.post('/api/admin/parser-versions', { ...body, rules: { price: { pattern: '(' } } })).statusCode).toBe(400);
    const v2 = await admin.post('/api/admin/parser-versions', body);
    expect(v2.json()).toMatchObject({ version: 'v2', active: false });
    expect((await admin.post('/api/admin/parser-versions', body)).statusCode).toBe(409);
    expect((await admin.post(`/api/admin/parser-versions/${v2.json().id}/activate`)).statusCode).toBe(200);
    const list = (await viewer.get(`/api/admin/parser-versions?sourceId=${pageSource}`)).json().items;
    expect(list.map((p: { version: string; active: boolean }) => [p.version, p.active])).toEqual([
      ['v2', true],
      ['v1', false],
    ]);
    expect(await n(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'parser_version.%'`)).toBe(3);
  });

  it('offer edits are audited and recompute status as an admin transition; privacy views are Admin-only', async () => {
    const p = await editor.patch('/api/admin/offers/acme-1029', { officialEndAt: '2026-10-01', computedStatus: 'active' });
    expect(p.statusCode).toBe(200);
    expect(p.json()).toMatchObject({ status: 'expired', statusReason: 'official_end_passed' });
    expect((await viewer.patch('/api/admin/offers/acme-1029', { confidence: 'low' })).statusCode).toBe(403);
    const tr = (await pool.query(`SELECT * FROM offer_status_transitions WHERE offer_id = 'acme-1029' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(tr).toMatchObject({ from_status: 'unknown', to_status: 'expired', actor: 'admin' });
    expect(await n(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'offer.update' AND entity_id = 'acme-1029'`)).toBe(1);
    expect((await editor.get('/api/admin/privacy/deletions')).statusCode).toBe(403);
    const del = await admin.get('/api/admin/privacy/deletions');
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ items: [], counts: {} });
    expect((await admin.get('/api/admin/privacy/audit')).statusCode).toBe(200);
    // Provider families on companies.
    const c = await editor.patch(`/api/admin/companies/${companyId}`, { providerFamily: 'insurance' });
    expect(c.json().providerFamily).toBe('insurance');
    expect((await editor.patch(`/api/admin/companies/${companyId}`, { providerFamily: 'made_up' })).statusCode).toBe(400);
    expect((await viewer.get('/api/admin/companies?providerFamily=insurance')).json().total).toBe(1);
  });
});

describe('cross-calculation match endpoint', () => {
  let pool: Pool;
  let app: FastifyInstance;
  const clock = new TestClock(NOW);

  beforeAll(async () => {
    pool = await freshDb();
    await seedAll(pool, {
      registries: [resolve(SEED_DIR, 'registry.json'), resolve(SEED_DIR, 'registry-payments.json'), resolve(SEED_DIR, 'registry-families.json')],
      offers: resolve(SEED_DIR, 'offers.json'),
    });
    app = await makeApp(pool, { clock });
  });
  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  const match = (qs: string) => app.inject({ method: 'GET', url: `/api/public/offers/match?${qs}` });

  it('returns possible benefits with eligibility, expiry, assumptions, confidence and sources', async () => {
    const r = await match('provider=airtel&serviceType=prepaid&planCode=699&price=699');
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const body = r.json();
    expect(body.query).toEqual({ provider: 'airtel', serviceType: 'prepaid', planCode: '699', price: 699 });
    expect(body.disclaimer).toMatch(/estimate/i);
    const m = body.matches.find((x: { offerId: string }) => x.offerId === 'airtel-699-prime');
    expect(m).toBeTruthy();
    expect(m.matchedOn).toEqual(['provider', 'plan_code', 'price']);
    expect(m.eligibility.overall).toBe('missing');
    expect(m.eligibility.checks.map((c: { state: string }) => c.state)).toEqual(['confirmed', 'missing', 'provider_only']);
    expect(m.expiry).toMatchObject({ officialEndAt: null, note: expect.stringMatching(/no end date/) });
    expect(['high', 'medium', 'low']).toContain(m.confidence);
    expect(m.assumptions.length).toBeGreaterThan(1);
    expect(m.doubleCountNote).toMatch(/card statement/);
    expect(m.sources[0]).toMatchObject({ url: 'https://www.amazon.in/b?ie=UTF8&node=16700000031' });
    expect(m.estimate).toMatchObject({ amountInr: null });
    expect(m.status).toBe('active_verify');
    expect(JSON.stringify(body)).not.toMatch(/guarantee/i);
  });

  it('excludes expired offers and offers whose eligibility the user does not meet', async () => {
    const post = (await match('provider=airtel&serviceType=postpaid')).json();
    expect(post.excluded).toContainEqual({ offerId: 'airtel-699-prime', reason: 'eligibility_not_met' });
    const amazon = (await match('provider=Amazon')).json();
    expect(amazon.excluded).toContainEqual({ offerId: 'amazon-pay-cashback-apr-may-2026', reason: 'expired' });
    expect(amazon.matches.map((x: { offerId: string }) => x.offerId)).toContain('amazon-prime-plans');
    for (const q of ['provider=jio', 'provider=google&planCode=x', 'provider=gpay']) expect(JSON.stringify((await match(q)).json())).not.toMatch(/guarantee/i);
    expect((await match('serviceType=prepaid')).statusCode).toBe(400);
    expect((await match('provider=airtel&price=-1')).statusCode).toBe(400);
  });

  it('seeds provider families and unverified candidate sources without inventing offers', async () => {
    const fam = (await pool.query(`SELECT slug, provider_family FROM companies WHERE slug IN ('reliance-jio','hdfc-bank','tata-play','lic-india') ORDER BY slug`)).rows;
    expect(fam).toEqual([
      { slug: 'hdfc-bank', provider_family: 'banks_cards' },
      { slug: 'lic-india', provider_family: 'insurance' },
      { slug: 'reliance-jio', provider_family: 'jio' },
      { slug: 'tata-play', provider_family: 'broadband_dth' },
    ]);
    const cand = (await pool.query(`SELECT status, candidate, last_success_at FROM sources WHERE url = 'https://www.hdfcbank.com'`)).rows[0];
    expect(cand).toMatchObject({ status: 'inaccessible', candidate: true, last_success_at: null });
    expect(Number((await pool.query('SELECT count(*) AS n FROM offers')).rows[0].n)).toBe(22);
    const o = (await pool.query(`SELECT sku, provider_family, freshness_window_hours FROM offers WHERE id = 'airtel-699-prime'`)).rows[0];
    expect(o).toEqual({ sku: '699', provider_family: 'airtel', freshness_window_hours: 336 });
  });
});
