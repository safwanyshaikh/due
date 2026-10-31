import { createAlert, type Mailer } from '../alerts.js';
import type { Clock } from '../clock.js';
import { addMinutes } from '../clock.js';
import { withTransaction, type Pool, type PoolClient } from '../db.js';
import { notFound } from '../http/errors.js';
import { getSettings } from '../settings.js';
import { canonicalJson, sha256 } from '../util.js';
import { computeBackoff } from './backoff.js';
import { extractContent, MAX_TEXT_CHARS, type Extracted } from './extract.js';
import { decodeBody, FetchError } from './net.js';
import type { MonitorRuntime } from './runtime.js';

export interface MonitorLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface MonitorContext {
  pool: Pool;
  clock: Clock;
  mailer: Mailer | null;
  runtime: MonitorRuntime;
  log: MonitorLogger;
  /** Set during graceful shutdown: batch jobs stop picking up new sources. */
  stopping?: () => boolean;
}

export type Outcome = 'changed' | 'unchanged' | 'error' | 'skipped_robots' | 'skipped_disabled' | 'not_modified';

export interface CheckResult {
  sourceId: string;
  outcome: Outcome;
  stored: boolean;
  httpStatus: number | null;
  error: string | null;
  robotsAllowed: boolean | null;
  title: string | null;
  contentHash: string | null;
  snapshotId: number | null;
  recordsNew: number;
  recordsModified: number;
  bytes: number | null;
  durationMs: number | null;
  sourceStatus: string;
  nextCheckAt: Date | null;
  textSample: string | null;
}

interface SourceRow {
  id: string;
  company_id: string;
  company_name: string;
  url: string;
  label: string;
  source_category: string;
  extraction_method: 'html_text' | 'rss' | 'json' | 'sitemap';
  css_selector: string | null;
  priority: 'critical' | 'regular' | 'secondary';
  frequency_minutes: number;
  enabled: boolean;
  status: string;
  consecutive_failures: number;
  http_etag: string | null;
  http_last_modified: string | null;
  request_timeout_ms: number | null;
  monitoring_enabled: boolean;
  company_status: string;
}

interface ExtractedRecord {
  recordType: 'page' | 'rss_item';
  fingerprint: string;
  title: string | null;
  url: string | null;
  summary: string | null;
  publishedAt: string | null;
  data: Record<string, unknown>;
  contentHash: string;
}

export function pageFingerprint(sourceUrl: string): string {
  return sha256(sourceUrl);
}

export function rssFingerprint(link: string, title: string): string {
  return sha256(`${link}\n${title}`);
}

function toRecords(src: SourceRow, ex: Extracted, contentHash: string): ExtractedRecord[] {
  if (ex.items) {
    const byFp = new Map<string, ExtractedRecord>();
    for (const it of ex.items) {
      const fp = rssFingerprint(it.link, it.title);
      if (byFp.has(fp)) continue;
      const data = { title: it.title, link: it.link, pubDate: it.pubDate, summary: it.summary };
      byFp.set(fp, {
        recordType: 'rss_item',
        fingerprint: fp,
        title: it.title,
        url: it.link || null,
        summary: it.summary.slice(0, 1000) || null,
        publishedAt: it.pubDate,
        data,
        contentHash: sha256(canonicalJson(data)),
      });
    }
    return [...byFp.values()];
  }
  const excerpt = ex.text.slice(0, 2000);
  return [
    {
      recordType: 'page',
      fingerprint: pageFingerprint(src.url),
      title: ex.title ?? src.label,
      url: src.url,
      summary: ex.text.slice(0, 500) || null,
      publishedAt: null,
      data: { title: ex.title, url: src.url, contentHash, excerpt },
      contentHash,
    },
  ];
}

async function loadSource(pool: Pool, id: string): Promise<SourceRow> {
  const r = await pool.query<SourceRow>(
    `SELECT s.*, c.name AS company_name, c.monitoring_enabled, c.status AS company_status
       FROM sources s JOIN companies c ON c.id = s.company_id WHERE s.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw notFound('Source not found');
  return r.rows[0];
}

async function upsertRecords(
  c: PoolClient,
  src: SourceRow,
  records: ExtractedRecord[],
  snapshotId: number | null,
  now: Date,
): Promise<{ created: number; modified: number }> {
  let created = 0;
  let modified = 0;
  const sensitive = src.source_category === 'pricing' || src.source_category === 'terms';
  for (const rec of records) {
    const existing = (
      await c.query<{ id: string; current_version: number; content_hash: string | null }>(
        `SELECT r.id, r.current_version,
                (SELECT v.content_hash FROM record_versions v WHERE v.record_id = r.id ORDER BY v.version DESC LIMIT 1) AS content_hash
           FROM records r WHERE r.company_id = $1 AND r.fingerprint = $2 FOR UPDATE`,
        [src.company_id, rec.fingerprint],
      )
    ).rows[0];
    if (!existing) {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO records (company_id, source_id, record_type, fingerprint, title, url, summary, published_at,
                              first_seen_at, last_seen_at, current_version, verification_status, sensitive)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,1,'pending',$10)
         ON CONFLICT (company_id, fingerprint) DO NOTHING RETURNING id`,
        [src.company_id, src.id, rec.recordType, rec.fingerprint, rec.title, rec.url, rec.summary, rec.publishedAt, now, sensitive],
      );
      if (!ins.rows[0]) continue;
      await c.query(
        `INSERT INTO record_versions (record_id, version, data, content_hash, snapshot_id, change_type, captured_at)
         VALUES ($1, 1, $2, $3, $4, 'new', $5)`,
        [ins.rows[0].id, JSON.stringify(rec.data), rec.contentHash, snapshotId, now],
      );
      created++;
    } else if (existing.content_hash !== rec.contentHash) {
      const version = existing.current_version + 1;
      await c.query(
        `UPDATE records SET title = $2, url = $3, summary = $4, published_at = COALESCE($5, published_at),
                last_seen_at = $6, current_version = $7, verification_status = 'pending', source_id = $8
          WHERE id = $1`,
        [existing.id, rec.title, rec.url, rec.summary, rec.publishedAt, now, version, src.id],
      );
      await c.query(
        `INSERT INTO record_versions (record_id, version, data, content_hash, snapshot_id, change_type, captured_at)
         VALUES ($1, $2, $3, $4, $5, 'modified', $6)`,
        [existing.id, version, JSON.stringify(rec.data), rec.contentHash, snapshotId, now],
      );
      modified++;
    } else {
      await c.query('UPDATE records SET last_seen_at = $2 WHERE id = $1', [existing.id, now]);
    }
  }
  return { created, modified };
}

export interface CheckOptions {
  mode: 'run' | 'validate';
  jobRunId?: number | null;
}

/**
 * Checks one source: robots → (conditional) GET → extract → sha256 change detection →
 * snapshot/record versioning on change → scheduling/backoff. 'validate' returns the result and
 * stores only a genuine content change (no scheduling or failure-counter updates).
 */
export async function checkSource(ctx: MonitorContext, sourceId: string, opts: CheckOptions): Promise<CheckResult> {
  const src = await loadSource(ctx.pool, sourceId);
  const startedAt = ctx.clock();
  const settings = await getSettings(ctx.pool);
  const attempt = src.consecutive_failures + 1;
  const result: CheckResult = {
    sourceId,
    outcome: 'error',
    stored: false,
    httpStatus: null,
    error: null,
    robotsAllowed: null,
    title: null,
    contentHash: null,
    snapshotId: null,
    recordsNew: 0,
    recordsModified: 0,
    bytes: null,
    durationMs: null,
    sourceStatus: src.status,
    nextCheckAt: null,
    textSample: null,
  };

  const logFetchRun = async (c: PoolClient | Pool, outcome: Outcome) => {
    await c.query(
      `INSERT INTO fetch_runs (source_id, job_run_id, started_at, finished_at, outcome, http_status, error, attempt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [src.id, opts.jobRunId ?? null, startedAt, ctx.clock(), outcome, result.httpStatus, result.error, attempt],
    );
  };

  if (opts.mode === 'run' && (!src.enabled || !src.monitoring_enabled || src.company_status !== 'active')) {
    result.outcome = 'skipped_disabled';
    result.error = 'Source or company monitoring is disabled';
    await logFetchRun(ctx.pool, 'skipped_disabled');
    return result;
  }

  const prev = (
    await ctx.pool.query<{ id: number; content_hash: string }>(
      'SELECT id, content_hash FROM snapshots WHERE source_id = $1 ORDER BY id DESC LIMIT 1',
      [src.id],
    )
  ).rows[0];

  let extracted: Extracted | null = null;
  let contentType: string | null = null;
  let etag: string | null = null;
  let lastModified: string | null = null;
  try {
    const conditional =
      opts.mode === 'run' && prev ? { etag: src.http_etag, lastModified: src.http_last_modified } : {};
    const out = await ctx.runtime.fetch(src.url, conditional, { timeoutMs: src.request_timeout_ms });
    if (out.kind === 'robots') {
      result.robotsAllowed = false;
      result.outcome = 'skipped_robots';
      result.error = `Disallowed by ${out.robotsUrl}`;
    } else {
      result.robotsAllowed = true;
      const res = out.res;
      result.httpStatus = res.status;
      result.bytes = res.body.length;
      result.durationMs = res.durationMs;
      if (res.status === 304) {
        result.outcome = 'not_modified';
      } else if (res.status >= 200 && res.status < 300) {
        contentType = res.headers['content-type'] ?? null;
        etag = res.headers.etag ?? null;
        lastModified = res.headers['last-modified'] ?? null;
        const body = decodeBody(res.body, contentType ?? undefined);
        extracted = extractContent(src.extraction_method, body, res.url, src.css_selector);
        if (!extracted.text) throw new Error('No extractable text (page may need JavaScript or a login)');
        result.title = extracted.title;
        result.contentHash = sha256(extracted.text);
        result.textSample = extracted.text.slice(0, 1000);
        result.outcome = prev && prev.content_hash === result.contentHash ? 'unchanged' : 'changed';
      } else {
        throw new FetchError(`HTTP ${res.status}`, 'network');
      }
    }
  } catch (err) {
    result.outcome = 'error';
    result.error = (err as Error).message.slice(0, 1000);
  }

  const now = ctx.clock();

  if (opts.mode === 'validate') {
    if (result.outcome === 'changed' && extracted) {
      await withTransaction(ctx.pool, async (c) => {
        await storeChange(c, src, extracted!, result, { contentType, etag, lastModified }, now);
        await logFetchRun(c, 'changed');
        await c.query('UPDATE sources SET last_change_at = $2, updated_at = $2 WHERE id = $1', [src.id, now]);
      });
    }
    return result;
  }

  const wasStatus = src.status;
  await withTransaction(ctx.pool, async (c) => {
    if (result.outcome === 'skipped_robots') {
      const next = addMinutes(now, src.frequency_minutes);
      await c.query(
        `UPDATE sources SET status = 'blocked_robots', last_checked_at = $2, next_check_at = $3,
                consecutive_failures = 0, last_error = $4, updated_at = $2 WHERE id = $1`,
        [src.id, now, next, result.error],
      );
      result.sourceStatus = 'blocked_robots';
      result.nextCheckAt = next;
      await logFetchRun(c, 'skipped_robots');
      if (wasStatus !== 'blocked_robots') {
        await createAlert(
          c,
          {
            level: 'info',
            title: `Source blocked by robots.txt: ${src.label}`,
            body: `${src.url} (${src.company_name}) is disallowed for the monitor. It will not be fetched while robots.txt disallows it.`,
            entityType: 'source',
            entityId: src.id,
          },
          ctx.mailer,
          ctx.log,
        );
      }
      return;
    }

    if (result.outcome === 'error') {
      const failures = src.consecutive_failures + 1;
      const b = computeBackoff(failures, settings.retry);
      const next = addMinutes(now, b.delayMinutes);
      await c.query(
        `UPDATE sources SET status = $2, consecutive_failures = $3, last_error = $4, last_checked_at = $5,
                next_check_at = $6, updated_at = $5 WHERE id = $1`,
        [src.id, b.status, failures, result.error, now, next],
      );
      result.sourceStatus = b.status;
      result.nextCheckAt = next;
      await logFetchRun(c, 'error');
      if (b.becameInaccessible) {
        await createAlert(
          c,
          {
            level: 'important',
            title: `Source inaccessible: ${src.label}`,
            body: `${src.url} (${src.company_name}) failed ${failures} times in a row. Last error: ${result.error}. It will keep being retried every ${b.delayMinutes} minutes.`,
            entityType: 'source',
            entityId: src.id,
          },
          ctx.mailer,
          ctx.log,
        );
      }
      return;
    }

    // Success: not_modified, unchanged or changed.
    if (result.outcome === 'changed' && extracted) {
      await storeChange(c, src, extracted, result, { contentType, etag, lastModified }, now);
      if (prev && src.priority === 'critical') {
        await createAlert(
          c,
          {
            level: 'important',
            title: `Critical source changed: ${src.label}`,
            body: `${src.url} (${src.company_name}) changed. ${result.recordsNew} new and ${result.recordsModified} modified records await review.`,
            entityType: 'source',
            entityId: src.id,
          },
          ctx.mailer,
          ctx.log,
        );
      }
    } else if (result.outcome === 'unchanged' && extracted && result.contentHash) {
      const fps = toRecords(src, extracted, result.contentHash).map((r) => r.fingerprint);
      await c.query('UPDATE records SET last_seen_at = $3 WHERE company_id = $1 AND fingerprint = ANY($2)', [
        src.company_id,
        fps,
        now,
      ]);
    }
    const next = addMinutes(now, src.frequency_minutes);
    await c.query(
      `UPDATE sources SET status = 'active', consecutive_failures = 0, last_error = NULL, last_checked_at = $2, candidate = false,
              last_success_at = $2, next_check_at = $3,
              last_change_at = CASE WHEN $4 THEN $2 ELSE last_change_at END,
              http_etag = CASE WHEN $5::text IS NOT NULL OR $6::text IS NOT NULL THEN $5 ELSE http_etag END,
              http_last_modified = CASE WHEN $5::text IS NOT NULL OR $6::text IS NOT NULL THEN $6 ELSE http_last_modified END,
              updated_at = $2
        WHERE id = $1`,
      [src.id, now, next, result.outcome === 'changed', etag, lastModified],
    );
    result.sourceStatus = 'active';
    result.nextCheckAt = next;
    await logFetchRun(c, result.outcome);
    if (wasStatus === 'inaccessible' || wasStatus === 'failing') {
      await createAlert(
        c,
        {
          level: 'info',
          title: `Source recovered: ${src.label}`,
          body: `${src.url} (${src.company_name}) is reachable again.`,
          entityType: 'source',
          entityId: src.id,
        },
        ctx.mailer,
        ctx.log,
      );
    }
  });
  return result;
}

async function storeChange(
  c: PoolClient,
  src: SourceRow,
  ex: Extracted,
  result: CheckResult,
  meta: { contentType: string | null; etag: string | null; lastModified: string | null },
  now: Date,
): Promise<void> {
  const snap = await c.query<{ id: number }>(
    `INSERT INTO snapshots (source_id, fetched_at, http_status, content_hash, content_type, title, text_content,
                            etag, last_modified, bytes, duration_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [
      src.id,
      now,
      result.httpStatus,
      result.contentHash,
      meta.contentType,
      ex.title,
      ex.text.slice(0, MAX_TEXT_CHARS),
      meta.etag,
      meta.lastModified,
      result.bytes,
      result.durationMs,
    ],
  );
  result.snapshotId = snap.rows[0]!.id;
  result.stored = true;
  const counts = await upsertRecords(c, src, toRecords(src, ex, result.contentHash!), result.snapshotId, now);
  result.recordsNew = counts.created;
  result.recordsModified = counts.modified;
}
