import { addMinutes } from '../clock.js';
import { many, one } from '../db.js';
import { checkSource, type MonitorContext, type Outcome } from '../monitor/engine.js';
import { getSettings } from '../settings.js';

export const JOB_IDS = ['monitor_sources', 'retry_failed', 'retention_cleanup'] as const;
export type JobId = (typeof JOB_IDS)[number];

const JOB_LOCK_NS = 724_190_002;

export interface JobRunRow {
  id: number;
  job_id: JobId;
  triggered_by: 'schedule' | 'manual';
  started_at: Date;
  finished_at: Date | null;
  status: 'running' | 'success' | 'failed';
  stats: Record<string, unknown>;
  error: string | null;
}

interface JobRow {
  id: JobId;
  enabled: boolean;
  interval_minutes: number;
  config: Record<string, unknown>;
}

/** Sources that are due now. Weekends are deliberately not skipped. */
export async function selectDueSources(
  ctx: MonitorContext,
  kind: 'fresh' | 'retry',
  limit: number,
): Promise<string[]> {
  const rows = await many<{ id: string }>(
    ctx.pool,
    `SELECT s.id FROM sources s JOIN companies c ON c.id = s.company_id
      WHERE s.enabled AND c.monitoring_enabled AND c.status = 'active' AND s.next_check_at <= $1
        AND ${kind === 'fresh' ? 's.consecutive_failures = 0' : 's.consecutive_failures > 0'}
      ORDER BY (s.priority = 'critical') DESC, s.next_check_at ASC
      LIMIT $2`,
    [ctx.clock(), limit],
  );
  return rows.map((r) => r.id);
}

async function monitorBatch(
  ctx: MonitorContext,
  jobRunId: number,
  kind: 'fresh' | 'retry',
  config: Record<string, unknown>,
): Promise<Record<string, number>> {
  const batch = Math.min(Math.max(Number(config.batch_size ?? 50) || 50, 1), 500);
  const concurrency = Math.min(Math.max(Number(config.concurrency ?? 4) || 4, 1), 16);
  const ids = await selectDueSources(ctx, kind, batch);
  const stats: Record<string, number> = { due: ids.length };
  const bump = (o: Outcome) => (stats[o] = (stats[o] ?? 0) + 1);
  let i = 0;
  const worker = async () => {
    while (i < ids.length && !ctx.stopping?.()) {
      const id = ids[i++]!;
      try {
        const r = await checkSource(ctx, id, { mode: 'run', jobRunId });
        bump(r.outcome);
      } catch (err) {
        stats.internal_errors = (stats.internal_errors ?? 0) + 1;
        ctx.log.error({ err, sourceId: id }, 'source check crashed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
  if (i < ids.length) stats.deferred_by_shutdown = ids.length - i;
  return stats;
}

async function retentionCleanup(ctx: MonitorContext): Promise<Record<string, number>> {
  const s = await getSettings(ctx.pool);
  const now = ctx.clock();
  const snapCutoff = addMinutes(now, -s.retention.snapshots_days * 1440);
  const loginCutoff = addMinutes(now, -s.retention.login_events_days * 1440);
  // Never delete the latest snapshot of a source: it is the baseline for change detection.
  const snaps = await ctx.pool.query(
    `DELETE FROM snapshots sn WHERE sn.fetched_at < $1
       AND sn.id <> (SELECT max(x.id) FROM snapshots x WHERE x.source_id = sn.source_id)`,
    [snapCutoff],
  );
  const runs = await ctx.pool.query('DELETE FROM fetch_runs WHERE started_at < $1', [snapCutoff]);
  const logins = await ctx.pool.query('DELETE FROM login_events WHERE at < $1', [loginCutoff]);
  const sessions = await ctx.pool.query(
    `DELETE FROM sessions WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $1)`,
    [addMinutes(now, -7 * 1440)],
  );
  const resets = await ctx.pool.query(
    'DELETE FROM password_resets WHERE expires_at < $1 OR (used_at IS NOT NULL AND used_at < $1)',
    [addMinutes(now, -30 * 1440)],
  );
  return {
    snapshots_deleted: snaps.rowCount ?? 0,
    fetch_runs_deleted: runs.rowCount ?? 0,
    login_events_deleted: logins.rowCount ?? 0,
    sessions_deleted: sessions.rowCount ?? 0,
    password_resets_deleted: resets.rowCount ?? 0,
  };
}

async function execute(ctx: MonitorContext, job: JobRow, jobRunId: number): Promise<Record<string, unknown>> {
  switch (job.id) {
    case 'monitor_sources':
      return monitorBatch(ctx, jobRunId, 'fresh', job.config);
    case 'retry_failed':
      return monitorBatch(ctx, jobRunId, 'retry', job.config);
    case 'retention_cleanup':
      return retentionCleanup(ctx);
  }
}

export interface StartedJob {
  run: JobRunRow;
  done: Promise<JobRunRow>;
}

/**
 * Starts a job under a Postgres advisory lock (one runner across all instances).
 * Scheduled and manual runs share this path. Returns null if the job is already running.
 */
export async function startJob(
  ctx: MonitorContext,
  jobId: JobId,
  triggeredBy: 'schedule' | 'manual',
  userId: string | null = null,
): Promise<StartedJob | null> {
  const job = await one<JobRow>(ctx.pool, 'SELECT id, enabled, interval_minutes, config FROM jobs WHERE id = $1', [jobId]);
  if (!job) throw new Error(`Unknown job ${jobId}`);
  const client = await ctx.pool.connect();
  let locked = false;
  try {
    locked = (
      await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok', [JOB_LOCK_NS, jobId])
    ).rows[0]!.ok;
    if (!locked) {
      client.release();
      return null;
    }
    // We hold the lock, so any 'running' row for this job was left by a process that stopped mid-run.
    await client.query(
      `UPDATE job_runs SET status = 'failed', finished_at = $2, error = 'Interrupted: the process stopped before the run finished'
        WHERE job_id = $1 AND status = 'running'`,
      [jobId, ctx.clock()],
    );
    const run = (
      await client.query<JobRunRow>(
        `INSERT INTO job_runs (job_id, triggered_by, triggered_by_user, started_at, status)
         VALUES ($1,$2,$3,$4,'running') RETURNING *`,
        [jobId, triggeredBy, userId, ctx.clock()],
      )
    ).rows[0]!;
    const done = (async () => {
      let status: 'success' | 'failed' = 'success';
      let stats: Record<string, unknown> = {};
      let error: string | null = null;
      try {
        stats = await execute(ctx, job, run.id);
      } catch (err) {
        status = 'failed';
        error = (err as Error).message;
        ctx.log.error({ err, jobId }, 'job failed');
      }
      try {
        const finished = ctx.clock();
        const row = (
          await client.query<JobRunRow>(
            `UPDATE job_runs SET finished_at = $2, status = $3, stats = $4, error = $5 WHERE id = $1 RETURNING *`,
            [run.id, finished, status, JSON.stringify(stats), error],
          )
        ).rows[0]!;
        await client.query('UPDATE jobs SET last_run_at = $2, next_run_at = $3 WHERE id = $1', [
          jobId,
          finished,
          addMinutes(finished, job.interval_minutes),
        ]);
        return row;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [JOB_LOCK_NS, jobId]).catch(() => undefined);
        client.release();
      }
    })();
    return { run, done };
  } catch (err) {
    if (locked) {
      await client.query('SELECT pg_advisory_unlock($1, hashtext($2))', [JOB_LOCK_NS, jobId]).catch(() => undefined);
    }
    client.release();
    throw err;
  }
}
