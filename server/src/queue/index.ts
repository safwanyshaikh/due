import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Mailer } from '../alerts.js';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import type { Pool, Queryable } from '../db.js';
import { many, one } from '../db.js';
import { currentCorrelationId, runWithCorrelation } from '../observability/context.js';
import { errorReporter } from '../observability/errorReporter.js';
import { metrics } from '../observability/metrics.js';
import { redactObject, redactText } from '../observability/redact.js';

/**
 * Durable Postgres job queue (contract: docs/production/LAUNCH_CONTRACT.md, "Durable queue").
 *
 * Statuses: queued -> running -> succeeded | failed (will retry at run_at) | dead (terminal).
 * Workers claim with FOR UPDATE SKIP LOCKED, retry with exponential backoff and dead-letter after max_attempts.
 * A job whose worker stops (no heartbeat for 2 minutes, or running for more than 30 minutes) is requeued.
 */

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';

export interface QueueLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** What a handler can reach besides its job: the same dependencies as the web process. */
export interface WorkerDeps {
  pool: Pool;
  config: AppConfig;
  clock: Clock;
  mailer: Mailer | null;
  log: QueueLogger;
  /** Network access for provider calls (Razorpay, Gmail); injectable in tests. */
  fetchImpl?: typeof fetch;
}

export interface JobContext {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  accountId: string | null;
  attempt: number;
  maxAttempts: number;
  correlationId: string;
  /** Redacts every object and string it is given; never pass raw mail, documents, tokens or secrets anyway. */
  log: QueueLogger;
  deps: WorkerDeps;
}

export type JobHandler = (job: JobContext) => Promise<void>;

export interface EnqueueInput {
  type: string;
  payload?: Record<string, unknown>;
  accountId?: string | null;
  idempotencyKey?: string | null;
  runAt?: Date | null;
  maxAttempts?: number;
  correlationId?: string | null;
  /** The caller's clock (defaults to the wall clock); run_at defaults to it. */
  now?: Date;
}

export interface QueueJobRow {
  id: string;
  type: string;
  account_id: string | null;
  payload: Record<string, unknown>;
  idempotency_key: string | null;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  locked_by: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  correlation_id: string;
  created_at: Date;
  updated_at: Date;
}

/** Thrown by a handler for errors that will never succeed on retry (the job goes straight to 'dead'). */
export class PermanentJobError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

/** Thrown by a handler to retry later without counting as an error (e.g. quiet hours). */
export class RetryLaterError extends Error {
  constructor(
    public readonly code: string,
    public readonly runAt: Date,
  ) {
    super(code);
    this.name = 'RetryLaterError';
  }
}

const TYPE_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
/** Payload keys that would mean raw content or secrets ended up in the queue. */
const FORBIDDEN_PAYLOAD_KEY = /^(text|body|html|raw|rawtext|raw_text|content|subject|token|access_token|refresh_token|id_token|password|secret|authorization|cookie)$/i;
const MAX_PAYLOAD_BYTES = 8 * 1024;

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
export const HEARTBEAT_FRESH_MS = 2 * 60_000;
export const RUNNING_TIMEOUT_MS = 30 * 60_000;

/** Delay before retry n (1-based): 30 s, 1 min, 2 min, 4 min ... capped at 1 hour. */
export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1), BACKOFF_MAX_MS);
}

function assertSafePayload(v: unknown, depth = 0): void {
  if (depth > 5 || !v || typeof v !== 'object') return;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (FORBIDDEN_PAYLOAD_KEY.test(k)) throw new Error(`Job payloads must not contain "${k}" (store content elsewhere and pass its id)`);
    assertSafePayload(val, depth + 1);
  }
}

// ---- Handler registry ------------------------------------------------------------------------------

const handlers = new Map<string, JobHandler>();

/** Registers (or replaces) the handler for a job type. Workers only claim types that have a handler. */
export function registerHandler(type: string, handler: JobHandler): void {
  if (!TYPE_RE.test(type)) throw new Error(`Invalid job type "${type}" (use area.action)`);
  handlers.set(type, handler);
}

export function registeredTypes(): string[] {
  return [...handlers.keys()].sort();
}

/** Test hook. */
export function unregisterHandler(type: string): void {
  handlers.delete(type);
}

// ---- Enqueue ---------------------------------------------------------------------------------------

/**
 * Adds a job. With an idempotency key, a second enqueue of the same key returns the existing job
 * (deduped: true) whatever its status, so callers put the logical unit of work in the key
 * (e.g. `reminder.deliver:<id>:<round>` or `billing.reconcile:2026-10-30`).
 */
export async function enqueue(db: Queryable, input: EnqueueInput): Promise<{ id: string; deduped: boolean }> {
  if (!TYPE_RE.test(input.type)) throw new Error(`Invalid job type "${input.type}"`);
  const payload = input.payload ?? {};
  assertSafePayload(payload);
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > MAX_PAYLOAD_BYTES) throw new Error('Job payload too large (store content elsewhere and pass its id)');
  const maxAttempts = input.maxAttempts ?? 5;
  const correlationId = input.correlationId ?? currentCorrelationId() ?? randomUUID();
  const key = input.idempotencyKey ?? null;
  const now = input.now ?? new Date();
  const r = await db.query<{ id: string }>(
    `INSERT INTO jobs_queue (type, account_id, payload, idempotency_key, max_attempts, run_at, correlation_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [input.type, input.accountId ?? null, json, key, maxAttempts, input.runAt ?? now, correlationId, now],
  );
  if (r.rows[0]) {
    metrics.inc('queue.enqueued', { type: input.type });
    return { id: r.rows[0].id, deduped: false };
  }
  const existing = await one<{ id: string }>(db, 'SELECT id FROM jobs_queue WHERE idempotency_key = $1', [key]);
  metrics.inc('queue.deduped', { type: input.type });
  return { id: existing!.id, deduped: true };
}

// ---- Claim / process -------------------------------------------------------------------------------

function jobLogger(base: QueueLogger, job: QueueJobRow): QueueLogger {
  const meta = { jobId: job.id, jobType: job.type, attempt: job.attempts, correlationId: job.correlation_id };
  const wrap = (fn: (o: unknown, m?: string) => void) => (obj: unknown, msg?: string) =>
    fn.call(base, { ...meta, ...(redactObject(typeof obj === 'object' && obj !== null ? obj : { detail: obj }) as object) }, msg ? redactText(msg) : msg);
  return { info: wrap(base.info), warn: wrap(base.warn), error: wrap(base.error) };
}

export function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(code)) return code;
  const name = (err as { name?: unknown })?.name;
  return typeof name === 'string' && name ? name.slice(0, 60) : 'error';
}

export async function beat(pool: Queryable, workerId: string, now: Date, processed = 0): Promise<void> {
  await pool.query(
    `INSERT INTO queue_heartbeats (worker_id, hostname, started_at, beat_at, jobs_processed) VALUES ($1,$2,$3,$3,$4)
     ON CONFLICT (worker_id) DO UPDATE SET beat_at = EXCLUDED.beat_at, jobs_processed = queue_heartbeats.jobs_processed + $4`,
    [workerId, hostname().slice(0, 100), now, processed],
  );
}

/**
 * Requeues jobs left 'running' by a worker that stopped: its heartbeat is older than 2 minutes, or the job has
 * run longer than 30 minutes. Jobs that already used all attempts are dead-lettered instead.
 */
export async function recoverStale(pool: Queryable, now: Date): Promise<{ requeued: number; dead: number }> {
  const rows = await many<{ status: JobStatus }>(
    pool,
    `UPDATE jobs_queue j SET
        status = CASE WHEN j.attempts >= j.max_attempts THEN 'dead' ELSE 'queued' END,
        run_at = $1, locked_by = NULL, updated_at = $1,
        finished_at = CASE WHEN j.attempts >= j.max_attempts THEN $1::timestamptz ELSE NULL END,
        last_error_code = 'worker_lost',
        last_error_message = 'The worker stopped before the job finished; it was requeued automatically'
      WHERE j.status = 'running'
        AND (j.started_at < $1::timestamptz - make_interval(secs => $2)
             OR NOT EXISTS (SELECT 1 FROM queue_heartbeats h WHERE h.worker_id = j.locked_by
                             AND h.beat_at > $1::timestamptz - make_interval(secs => $3)))
      RETURNING j.status`,
    [now, RUNNING_TIMEOUT_MS / 1000, HEARTBEAT_FRESH_MS / 1000],
  );
  const dead = rows.filter((r) => r.status === 'dead').length;
  if (rows.length) metrics.inc('queue.recovered_stale', undefined, rows.length);
  return { requeued: rows.length - dead, dead };
}

/** Claims up to `limit` due jobs of registered types for `workerId`. */
export async function claim(pool: Queryable, workerId: string, now: Date, limit = 1, types = registeredTypes()): Promise<QueueJobRow[]> {
  if (types.length === 0) return [];
  return many<QueueJobRow>(
    pool,
    `WITH c AS (
       SELECT id FROM jobs_queue
        WHERE status IN ('queued','failed') AND run_at <= $1 AND type = ANY($3::text[])
        ORDER BY run_at, created_at, id
        LIMIT $2 FOR UPDATE SKIP LOCKED)
     UPDATE jobs_queue j SET status = 'running', attempts = j.attempts + 1, started_at = $1, finished_at = NULL,
            locked_by = $4, updated_at = $1
       FROM c WHERE j.id = c.id RETURNING j.*`,
    [now, limit, types, workerId],
  );
}

/** Runs one claimed job and records its outcome. Returns the final status of this attempt. */
export async function processJob(deps: WorkerDeps, job: QueueJobRow): Promise<JobStatus> {
  const handler = handlers.get(job.type);
  const log = jobLogger(deps.log, job);
  const start = performance.now();
  const finish = async (status: JobStatus, runAt: Date | null, code: string | null, message: string | null) => {
    const now = deps.clock();
    // Only the claimer may finish the job (guards against a stale worker finishing a requeued job).
    await deps.pool.query(
      `UPDATE jobs_queue SET status = $2, run_at = COALESCE($3, run_at), finished_at = $4, last_error_code = $5,
              last_error_message = $6, locked_by = NULL, updated_at = $7
        WHERE id = $1 AND status = 'running' AND locked_by IS NOT DISTINCT FROM $8`,
      [job.id, status, runAt, status === 'succeeded' || status === 'dead' ? now : null, code, message, now, job.locked_by],
    );
    metrics.inc('queue.jobs', { type: job.type, status });
    metrics.timing('queue.job_ms', performance.now() - start, { type: job.type });
  };
  if (!handler) {
    await finish('dead', null, 'no_handler', `No handler is registered for ${job.type}`);
    return 'dead';
  }
  try {
    await runWithCorrelation(job.correlation_id, () =>
      handler({
        id: job.id,
        type: job.type,
        payload: job.payload ?? {},
        accountId: job.account_id,
        attempt: job.attempts,
        maxAttempts: job.max_attempts,
        correlationId: job.correlation_id,
        log,
        deps,
      }),
    );
    await finish('succeeded', null, null, null);
    return 'succeeded';
  } catch (err) {
    if (err instanceof RetryLaterError) {
      // Not an error: give the attempt back and run again later.
      await deps.pool.query('UPDATE jobs_queue SET attempts = GREATEST(attempts - 1, 0) WHERE id = $1', [job.id]);
      await finish('queued', err.runAt, err.code, null);
      return 'queued';
    }
    const code = errorCodeOf(err);
    const message = redactText((err as Error)?.message ?? String(err));
    const permanent = err instanceof PermanentJobError;
    if (permanent || job.attempts >= job.max_attempts) {
      log.error({ code, message }, 'job dead-lettered');
      void errorReporter().capture(err, { job_type: job.type, correlation_id: job.correlation_id, code });
      await finish('dead', null, code, message);
      return 'dead';
    }
    log.warn({ code, message }, 'job failed; will retry');
    await finish('failed', new Date(deps.clock().getTime() + backoffMs(job.attempts)), code, message);
    return 'failed';
  }
}

/**
 * Processes due jobs in this process until none are due (or `maxJobs` ran). Used by tests, by
 * `npm --prefix server run worker -- --once`, and inside the worker loop.
 */
export async function drainQueue(
  deps: WorkerDeps,
  opts: { maxJobs?: number; workerId?: string; types?: string[] } = {},
): Promise<{ processed: number; byStatus: Record<string, number> }> {
  const workerId = opts.workerId ?? `drain-${process.pid}`;
  const byStatus: Record<string, number> = {};
  let processed = 0;
  const max = opts.maxJobs ?? 1000;
  await beat(deps.pool, workerId, deps.clock());
  while (processed < max) {
    const [job] = await claim(deps.pool, workerId, deps.clock(), 1, opts.types ?? registeredTypes());
    if (!job) break;
    const s = await processJob(deps, job);
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    processed++;
  }
  if (processed) await beat(deps.pool, workerId, deps.clock(), processed);
  return { processed, byStatus };
}

/** Long-running worker: N concurrent claim loops, heartbeat every 30 s, stale recovery every minute. */
export class QueueWorker {
  readonly workerId = `${hostname().slice(0, 40)}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private stopped = true;
  private loops: Promise<void>[] = [];
  private timers: NodeJS.Timeout[] = [];
  private processedSinceBeat = 0;
  private wake: (() => void)[] = [];

  constructor(
    private readonly deps: WorkerDeps,
    private readonly opts: { concurrency?: number; pollMs?: number } = {},
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    await beat(this.deps.pool, this.workerId, this.deps.clock());
    await recoverStale(this.deps.pool, this.deps.clock()).catch((err) => this.deps.log.error({ err }, 'stale recovery failed'));
    this.timers.push(
      setInterval(() => {
        const n = this.processedSinceBeat;
        this.processedSinceBeat = 0;
        beat(this.deps.pool, this.workerId, this.deps.clock(), n).catch((err) => this.deps.log.error({ err }, 'queue heartbeat failed'));
      }, 30_000),
      setInterval(() => {
        recoverStale(this.deps.pool, this.deps.clock()).catch((err) => this.deps.log.error({ err }, 'stale recovery failed'));
      }, 60_000),
    );
    for (const t of this.timers) t.unref();
    const n = Math.min(Math.max(this.opts.concurrency ?? 2, 1), 16);
    for (let i = 0; i < n; i++) this.loops.push(this.loop());
    this.deps.log.info({ workerId: this.workerId, concurrency: n, types: registeredTypes() }, 'queue worker started');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake.push(done);
    });
  }

  private async loop(): Promise<void> {
    const pollMs = this.opts.pollMs ?? 1_000;
    while (!this.stopped) {
      try {
        const [job] = await claim(this.deps.pool, this.workerId, this.deps.clock(), 1);
        if (!job) {
          await this.sleep(pollMs);
          continue;
        }
        await processJob(this.deps, job);
        this.processedSinceBeat++;
      } catch (err) {
        this.deps.log.error({ err }, 'queue loop error');
        await this.sleep(pollMs * 5);
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const w of this.wake.splice(0)) w();
    await Promise.all(this.loops);
    this.loops = [];
    await this.deps.pool
      .query('DELETE FROM queue_heartbeats WHERE worker_id = $1', [this.workerId])
      .catch(() => undefined);
  }
}

// ---- Introspection (admin + health) ----------------------------------------------------------------

export interface QueueStats {
  counts: Record<JobStatus, number>;
  byType: { type: string; status: JobStatus; n: number }[];
  oldestDueSeconds: number | null;
  lastHeartbeatAt: Date | null;
  heartbeatFresh: boolean;
  workers: { workerId: string; hostname: string | null; startedAt: Date; beatAt: Date; jobsProcessed: number }[];
  deadLast24h: number;
}

export async function queueStats(pool: Queryable, now: Date): Promise<QueueStats> {
  const rows = await many<{ type: string; status: JobStatus; n: number }>(
    pool,
    `SELECT type, status, count(*)::int AS n FROM jobs_queue GROUP BY type, status ORDER BY type, status`,
  );
  const counts: Record<JobStatus, number> = { queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0 };
  for (const r of rows) counts[r.status] += r.n;
  const oldest = await one<{ run_at: Date | null }>(pool, `SELECT min(run_at) AS run_at FROM jobs_queue WHERE status IN ('queued','failed') AND run_at <= $1`, [now]);
  const workers = await many<{ worker_id: string; hostname: string | null; started_at: Date; beat_at: Date; jobs_processed: number }>(
    pool,
    'SELECT * FROM queue_heartbeats ORDER BY beat_at DESC LIMIT 20',
  );
  const dead = await one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM jobs_queue WHERE status = 'dead' AND finished_at > $1`, [new Date(now.getTime() - 86_400_000)]);
  const last = workers[0]?.beat_at ?? null;
  return {
    counts,
    byType: rows,
    oldestDueSeconds: oldest?.run_at ? Math.max(0, Math.round((now.getTime() - oldest.run_at.getTime()) / 1000)) : null,
    lastHeartbeatAt: last,
    heartbeatFresh: last !== null && now.getTime() - last.getTime() < HEARTBEAT_FRESH_MS,
    workers: workers.map((w) => ({ workerId: w.worker_id, hostname: w.hostname, startedAt: w.started_at, beatAt: w.beat_at, jobsProcessed: w.jobs_processed })),
    deadLast24h: dead?.n ?? 0,
  };
}

/** Puts a failed or dead job back in the queue now with a fresh attempt budget. */
export async function retryJob(pool: Queryable, id: string, now: Date): Promise<QueueJobRow | null> {
  return one<QueueJobRow>(
    pool,
    `UPDATE jobs_queue SET status = 'queued', attempts = 0, run_at = $2, finished_at = NULL, locked_by = NULL, updated_at = $2
      WHERE id = $1 AND status IN ('failed','dead') RETURNING *`,
    [id, now],
  );
}
