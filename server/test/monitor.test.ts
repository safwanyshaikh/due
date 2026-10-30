import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { startJob } from '../src/jobs/runner.js';
import { Scheduler } from '../src/jobs/scheduler.js';
import { computeBackoff } from '../src/monitor/backoff.js';
import { checkSource, type MonitorContext } from '../src/monitor/engine.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';
import { FixtureServer, page } from './fixtures/httpServer.js';
import { freshDb, monitorCtx, testConfig, TestClock } from './helpers.js';

let pool: Pool;
let srv: FixtureServer;
let ctx: MonitorContext;
const clock = new TestClock(new Date('2026-10-28T09:00:00Z'));

async function company(slug = 'acme', overrides: Record<string, unknown> = {}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO companies (kind, name, slug, monitoring_enabled, status) VALUES ('vendor', $1, $1, $2, $3) RETURNING id`,
    [slug, overrides.monitoring_enabled ?? true, overrides.status ?? 'active'],
  );
  return r.rows[0].id;
}

async function source(companyId: string, path: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await pool.query(
    `INSERT INTO sources (company_id, url, label, source_category, extraction_method, priority, frequency_minutes, next_check_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      companyId,
      srv.url(path),
      `Label ${path}`,
      extra.category ?? 'product_page',
      extra.method ?? 'html_text',
      extra.priority ?? 'regular',
      extra.frequency ?? 1440,
      extra.nextCheckAt ?? clock.now,
    ],
  );
  return r.rows[0].id;
}

const count = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows[0].n as number;

beforeAll(async () => {
  srv = await new FixtureServer().start();
});
afterAll(async () => {
  await srv.stop();
  await pool?.end();
});
beforeEach(async () => {
  await pool?.end();
  pool = await freshDb();
  srv.routes.clear();
  srv.hits.clear();
  srv.requests = [];
  srv.robots('User-agent: *\nAllow: /\n');
  clock.set('2026-10-28T09:00:00Z');
  ctx = monitorCtx(pool, clock);
});

describe('robots.txt', () => {
  it('marks a disallowed source blocked_robots without fetching the page', async () => {
    srv.robots('User-agent: DueSourceMonitor\nDisallow: /private\n\nUser-agent: *\nAllow: /\n');
    srv.html('/private/plans', () => page('Secret', '<p>x</p>'));
    srv.html('/public', () => page('Public', '<p>ok</p>'));
    const c = await company();
    const blocked = await source(c, '/private/plans');
    const r = await checkSource(ctx, blocked, { mode: 'run' });
    expect(r.outcome).toBe('skipped_robots');
    expect(srv.hit('/private/plans')).toBe(0);
    const s = (await pool.query('SELECT status, last_error FROM sources WHERE id = $1', [blocked])).rows[0];
    expect(s.status).toBe('blocked_robots');
    expect(await count(`SELECT count(*)::int AS n FROM fetch_runs WHERE source_id = $1 AND outcome = 'skipped_robots'`, [blocked])).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM snapshots')).toBe(0);

    // robots.txt is cached per host: a second source on the host does not refetch it.
    const ok = await source(c, '/public');
    expect((await checkSource(ctx, ok, { mode: 'run' })).outcome).toBe('changed');
    expect(srv.hit('/robots.txt')).toBe(1);
    // User agent identifies the monitor.
    expect(srv.requests.find((x) => x.path === '/public')!.headers['user-agent']).toMatch(/^DueSourceMonitor\/1\.0 \(\+https:\/\/.+\/about-monitoring\)$/);
  });
});

describe('change detection', () => {
  it('stores a snapshot only on change, versions records and preserves history', async () => {
    let body = page('Plans', '<p>Plan A costs 100</p>');
    srv.html('/plans', () => body);
    const c = await company();
    const s = await source(c, '/plans', { priority: 'critical', category: 'pricing' });

    const first = await checkSource(ctx, s, { mode: 'run' });
    expect(first.outcome).toBe('changed');
    expect(first.recordsNew).toBe(1);
    const snap1 = (await pool.query('SELECT * FROM snapshots WHERE source_id = $1', [s])).rows[0];
    expect(snap1.title).toBe('Plans');
    expect(snap1.text_content).toContain('Plan A costs 100');
    expect(snap1.text_content).not.toContain('tracking');
    expect(snap1.text_content).not.toContain('Home | Plans');
    expect(snap1.content_hash).toMatch(/^[0-9a-f]{64}$/);
    // First capture of a critical source is a baseline, not an alert.
    expect(await count(`SELECT count(*)::int AS n FROM alerts WHERE level = 'important'`)).toBe(0);

    // Unchanged content (cosmetic whitespace only) → no new snapshot.
    body = page('Plans', '<p>Plan A   costs 100</p>\n\n');
    clock.advanceMinutes(1440);
    const second = await checkSource(ctx, s, { mode: 'run' });
    expect(second.outcome).toBe('unchanged');
    expect(await count('SELECT count(*)::int AS n FROM snapshots WHERE source_id = $1', [s])).toBe(1);

    // Changed content → new snapshot + new record version, old version kept.
    body = page('Plans', '<p>Plan A costs 120</p>');
    clock.advanceMinutes(1440);
    const third = await checkSource(ctx, s, { mode: 'run' });
    expect(third.outcome).toBe('changed');
    expect(third.recordsModified).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM snapshots WHERE source_id = $1', [s])).toBe(2);
    const rec = (await pool.query('SELECT * FROM records WHERE source_id = $1', [s])).rows;
    expect(rec).toHaveLength(1);
    expect(rec[0].current_version).toBe(2);
    expect(rec[0].sensitive).toBe(true);
    const versions = (await pool.query('SELECT * FROM record_versions WHERE record_id = $1 ORDER BY version', [rec[0].id])).rows;
    expect(versions.map((v) => v.change_type)).toEqual(['new', 'modified']);
    expect(versions[0].data.excerpt).toContain('costs 100');
    expect(versions[1].data.excerpt).toContain('costs 120');
    expect(versions[0].snapshot_id).toBe(snap1.id);
    expect(await count(`SELECT count(*)::int AS n FROM alerts WHERE level = 'important' AND title LIKE 'Critical source changed%'`)).toBe(1);

    const runs = (await pool.query('SELECT outcome FROM fetch_runs WHERE source_id = $1 ORDER BY id', [s])).rows.map((r) => r.outcome);
    expect(runs).toEqual(['changed', 'unchanged', 'changed']);
    const src = (await pool.query('SELECT status, consecutive_failures, next_check_at, last_change_at FROM sources WHERE id = $1', [s])).rows[0];
    expect(src.status).toBe('active');
    expect(src.next_check_at.toISOString()).toBe(new Date(clock.now.getTime() + 1440 * 60_000).toISOString());
  });

  it('applies the css selector', async () => {
    srv.html('/sel', () => page('T', '<div id="offer"><p>Only this</p></div><p>Not this</p>'));
    const c = await company();
    const r = await pool.query(
      `INSERT INTO sources (company_id, url, label, source_category, css_selector, frequency_minutes) VALUES ($1,$2,'s','product_page','#offer',1440) RETURNING id`,
      [c, srv.url('/sel')],
    );
    await checkSource(ctx, r.rows[0].id, { mode: 'run' });
    const snap = (await pool.query('SELECT text_content FROM snapshots')).rows[0];
    expect(snap.text_content).toBe('Only this');
  });

  it('uses conditional GET and records not_modified on 304', async () => {
    srv.routes.set('/etag', (req, res) => {
      if (req.headers['if-none-match'] === '"v1"') return res.writeHead(304).end();
      res.writeHead(200, { 'content-type': 'text/html', etag: '"v1"', 'last-modified': 'Tue, 27 Oct 2026 10:00:00 GMT' }).end(page('E', '<p>e</p>'));
    });
    const c = await company();
    const s = await source(c, '/etag');
    expect((await checkSource(ctx, s, { mode: 'run' })).outcome).toBe('changed');
    clock.advanceMinutes(2000);
    const r = await checkSource(ctx, s, { mode: 'run' });
    expect(r.outcome).toBe('not_modified');
    expect(r.httpStatus).toBe(304);
    const req = srv.requests.filter((x) => x.path === '/etag')[1]!;
    expect(req.headers['if-none-match']).toBe('"v1"');
    expect(req.headers['if-modified-since']).toBe('Tue, 27 Oct 2026 10:00:00 GMT');
    expect(await count('SELECT count(*)::int AS n FROM snapshots')).toBe(1);
  });

  it('extracts RSS items as records and deduplicates them across runs', async () => {
    const item = (n: number) =>
      `<item><title>News ${n}</title><link>https://vendor.example/news/${n}</link><pubDate>Mon, 2${n} Oct 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Body ${n}&lt;/p&gt;</description></item>`;
    let items = [item(1), item(2)];
    srv.routes.set('/feed.xml', (_q, res) =>
      res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(`<?xml version="1.0"?><rss version="2.0"><channel><title>Vendor news</title>${items.join('')}</channel></rss>`),
    );
    const c = await company();
    const s = await source(c, '/feed.xml', { method: 'rss', category: 'rss' });
    const r1 = await checkSource(ctx, s, { mode: 'run' });
    expect(r1.recordsNew).toBe(2);
    items = [item(3), item(1), item(2), item(2)];
    clock.advanceMinutes(1500);
    const r2 = await checkSource(ctx, s, { mode: 'run' });
    expect(r2.outcome).toBe('changed');
    expect(r2.recordsNew).toBe(1);
    expect(r2.recordsModified).toBe(0);
    clock.advanceMinutes(1500);
    expect((await checkSource(ctx, s, { mode: 'run' })).outcome).toBe('unchanged');
    const recs = (await pool.query(`SELECT title, url, summary, published_at, record_type FROM records ORDER BY title`)).rows;
    expect(recs.map((r) => r.title)).toEqual(['News 1', 'News 2', 'News 3']);
    expect(recs[0]).toMatchObject({ url: 'https://vendor.example/news/1', summary: 'Body 1', record_type: 'rss_item' });
    expect(recs[0].published_at.toISOString()).toBe('2026-10-21T10:00:00.000Z');
    expect(await count('SELECT count(*)::int AS n FROM record_versions')).toBe(3);
  });

  it('canonicalises JSON so key order does not count as a change', async () => {
    let body = '{"b":1,"a":{"y":2,"x":1}}';
    srv.routes.set('/api.json', (_q, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(body));
    const c = await company();
    const s = await source(c, '/api.json', { method: 'json', category: 'api' });
    expect((await checkSource(ctx, s, { mode: 'run' })).outcome).toBe('changed');
    body = '{"a":{"x":1,"y":2},"b":1}';
    clock.advanceMinutes(2000);
    expect((await checkSource(ctx, s, { mode: 'run' })).outcome).toBe('unchanged');
  });
});

describe('failures and backoff', () => {
  it('computes exponential backoff capped at the max', () => {
    const r = DEFAULT_SETTINGS.retry;
    expect([1, 2, 3, 4, 5, 6, 7].map((n) => computeBackoff(n, r).delayMinutes)).toEqual([30, 60, 120, 240, 480, 960, 1440]);
    expect(computeBackoff(7, r).status).toBe('failing');
    expect(computeBackoff(8, r)).toEqual({ delayMinutes: 1440, status: 'inaccessible', becameInaccessible: true });
    expect(computeBackoff(9, r)).toEqual({ delayMinutes: 1440, status: 'inaccessible', becameInaccessible: false });
  });

  it('backs off on HTTP 500, becomes inaccessible after max attempts with one important alert, and recovers', async () => {
    let fail = true;
    srv.routes.set('/flaky', (_q, res) => {
      if (fail) return res.writeHead(500, { 'content-type': 'text/plain' }).end('boom');
      res.writeHead(200, { 'content-type': 'text/html' }).end(page('Back', '<p>up</p>'));
    });
    const c = await company();
    const s = await source(c, '/flaky');
    const expected = [30, 60, 120, 240, 480, 960, 1440, 1440, 1440];
    for (let i = 0; i < expected.length; i++) {
      const r = await checkSource(ctx, s, { mode: 'run' });
      expect(r.outcome).toBe('error');
      expect(r.error).toBe('HTTP 500');
      const row = (await pool.query('SELECT * FROM sources WHERE id = $1', [s])).rows[0];
      expect(row.consecutive_failures).toBe(i + 1);
      expect((row.next_check_at.getTime() - clock.now.getTime()) / 60_000).toBe(expected[i]);
      expect(row.status).toBe(i + 1 >= 8 ? 'inaccessible' : 'failing');
      clock.set(row.next_check_at);
    }
    expect(await count(`SELECT count(*)::int AS n FROM alerts WHERE level = 'important' AND title LIKE 'Source inaccessible%'`)).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM fetch_runs WHERE outcome = 'error'`)).toBe(9);
    fail = false;
    const ok = await checkSource(ctx, s, { mode: 'run' });
    expect(ok.outcome).toBe('changed');
    const row = (await pool.query('SELECT status, consecutive_failures, last_error FROM sources WHERE id = $1', [s])).rows[0];
    expect(row).toEqual({ status: 'active', consecutive_failures: 0, last_error: null });
    expect(await count(`SELECT count(*)::int AS n FROM alerts WHERE title LIKE 'Source recovered%'`)).toBe(1);
  });

  it('treats timeouts and oversized responses as failures', async () => {
    srv.routes.set('/slow', (_q, res) => {
      setTimeout(() => {
        if (!res.destroyed) res.writeHead(200, { 'content-type': 'text/html' }).end('late');
      }, 4000);
    });
    srv.routes.set('/huge', (_q, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('x'.repeat(6 * 1024 * 1024));
    });
    const c = await company();
    const slow = await source(c, '/slow');
    const r = await checkSource(ctx, slow, { mode: 'run' });
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/Timed out/);
    const huge = await source(c, '/huge');
    const h = await checkSource(ctx, huge, { mode: 'run' });
    expect(h.outcome).toBe('error');
    expect(h.error).toMatch(/too large|exceeded/i);
  }, 15_000);

  it('refuses private addresses unless explicitly allowed', async () => {
    const strict = monitorCtx(pool, clock, { ...testConfig(), monitor: { ...testConfig().monitor, allowPrivateHosts: false } });
    srv.html('/p', () => page('P', '<p>p</p>'));
    const c = await company();
    const s = await source(c, '/p');
    const r = await checkSource(strict, s, { mode: 'run' });
    expect(r.outcome).toBe('error');
    expect(r.error).toMatch(/private address/);
    expect(srv.hit('/p')).toBe(0);
  });
});

describe('scheduler and jobs', () => {
  it('picks due sources on a Saturday and a Sunday (no weekday filter)', async () => {
    srv.html('/a', () => page('A', `<p>${clock.now.toISOString()}</p>`));
    const c = await company();
    const s = await source(c, '/a', { nextCheckAt: new Date('2026-10-31T08:00:00Z') });
    const notDue = await source(c, '/b', { nextCheckAt: new Date('2026-11-05T08:00:00Z') });
    const sched = new Scheduler(ctx, 60_000);

    clock.set('2026-10-31T09:00:00Z'); // Saturday
    expect(clock.now.getUTCDay()).toBe(6);
    const runs = await sched.tick();
    expect(runs.map((r) => r.job_id).sort()).toEqual(['monitor_sources', 'retention_cleanup', 'retry_failed']);
    expect(runs.every((r) => r.status === 'success' && r.triggered_by === 'schedule')).toBe(true);
    expect(runs.find((r) => r.job_id === 'monitor_sources')!.stats).toMatchObject({ due: 1, changed: 1 });
    expect(srv.hit('/a')).toBe(1);
    expect(srv.hit('/b')).toBe(0);
    // Nothing re-runs within the job interval.
    expect(await sched.tick()).toEqual([]);

    clock.set('2026-11-01T09:30:00Z'); // Sunday, the source is due again (frequency 1440)
    expect(clock.now.getUTCDay()).toBe(0);
    const sunday = await sched.tick();
    expect(sunday.find((r) => r.job_id === 'monitor_sources')!.stats).toMatchObject({ due: 1, changed: 1 });
    expect(srv.hit('/a')).toBe(2);
    expect(await count('SELECT count(*)::int AS n FROM fetch_runs WHERE source_id = $1 AND job_run_id IS NOT NULL', [s])).toBe(2);
    expect(await count('SELECT count(*)::int AS n FROM fetch_runs WHERE source_id = $1', [notDue])).toBe(0);
  });

  it('skips sources of archived or monitoring-disabled companies and disabled sources', async () => {
    srv.html('/x', () => page('X', '<p>x</p>'));
    const archived = await company('arch', { status: 'archived' });
    const off = await company('off', { monitoring_enabled: false });
    const on = await company('on');
    await source(archived, '/x');
    await source(off, '/x');
    const disabled = await source(on, '/x');
    await pool.query('UPDATE sources SET enabled = false WHERE id = $1', [disabled]);
    const started = await startJob(ctx, 'monitor_sources', 'manual');
    const run = await started!.done;
    expect(run.stats).toMatchObject({ due: 0 });
    expect(srv.hit('/x')).toBe(0);
  });

  it('retry_failed handles failing sources; advisory lock prevents concurrent runs', async () => {
    srv.routes.set('/err', (_q, res) => res.writeHead(503).end());
    const c = await company();
    const s = await source(c, '/err');
    await pool.query('UPDATE sources SET consecutive_failures = 2, status = $2 WHERE id = $1', [s, 'failing']);
    const fresh = await (await startJob(ctx, 'monitor_sources', 'manual'))!.done;
    expect(fresh.stats).toMatchObject({ due: 0 });
    const a = await startJob(ctx, 'retry_failed', 'manual');
    const b = await startJob(ctx, 'retry_failed', 'manual');
    expect(a).not.toBeNull();
    expect(b).toBeNull();
    const done = await a!.done;
    expect(done.status).toBe('success');
    expect(done.stats).toMatchObject({ due: 1, error: 1 });
    const row = (await pool.query('SELECT consecutive_failures FROM sources WHERE id = $1', [s])).rows[0];
    expect(row.consecutive_failures).toBe(3);
    const again = await startJob(ctx, 'retry_failed', 'manual');
    expect(again).not.toBeNull();
    await again!.done;
  });

  it('marks a run left "running" by a stopped process as failed, and stops batches on shutdown', async () => {
    await pool.query(`INSERT INTO job_runs (job_id, triggered_by, started_at, status) VALUES ('monitor_sources','schedule',now(),'running')`);
    srv.html('/s1', () => page('S1', '<p>1</p>'));
    srv.html('/s2', () => page('S2', '<p>2</p>'));
    const c = await company();
    await source(c, '/s1');
    await source(c, '/s2');
    let stop = false;
    const stoppingCtx = { ...ctx, stopping: () => stop };
    await pool.query(`UPDATE jobs SET config = '{"batch_size": 50, "concurrency": 1}' WHERE id = 'monitor_sources'`);
    const started = await startJob(stoppingCtx, 'monitor_sources', 'schedule');
    stop = true;
    const run = await started!.done;
    const stale = (await pool.query(`SELECT status, error FROM job_runs WHERE id <> $1`, [run.id])).rows[0];
    expect(stale.status).toBe('failed');
    expect(stale.error).toMatch(/Interrupted/);
    expect(run.status).toBe('success');
    expect(Number(run.stats.due)).toBe(2);
    expect(Number(run.stats.deferred_by_shutdown ?? 0) + Number(run.stats.changed ?? 0)).toBe(2);
  });

  it('retention_cleanup removes old data but keeps the latest snapshot per source', async () => {
    const c = await company();
    const s = await source(c, '/r');
    for (const [d, h] of [['2025-01-01', 'a'], ['2025-02-01', 'b']]) {
      await pool.query(`INSERT INTO snapshots (source_id, fetched_at, content_hash, text_content) VALUES ($1,$2,$3,'t')`, [s, d, h]);
    }
    await pool.query(`INSERT INTO login_events (email, success, at) VALUES ('x@example.com', false, '2025-01-01')`);
    const run = await (await startJob(ctx, 'retention_cleanup', 'manual'))!.done;
    expect(run.stats).toMatchObject({ snapshots_deleted: 1, login_events_deleted: 1 });
    const left = (await pool.query('SELECT content_hash FROM snapshots')).rows;
    expect(left).toEqual([{ content_hash: 'b' }]);
  });
});
