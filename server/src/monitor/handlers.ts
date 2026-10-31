import { PermanentJobError, registerHandler, type JobContext } from '../queue/index.js';
import { metrics } from '../observability/metrics.js';
import { MonitorRuntime } from './runtime.js';
import { recomputeAllStatuses, refreshOfferSource } from './offers.js';

/**
 * Queue handlers for the offer intelligence engine. One MonitorRuntime per process is shared by every
 * refresh, so robots.txt caching and the per-host request gap apply across jobs.
 */
let runtime: MonitorRuntime | null = null;

function runtimeFor(job: JobContext): MonitorRuntime {
  runtime ??= new MonitorRuntime(job.deps.config.monitor);
  return runtime;
}

/** Test hook: replace (or reset with null) the shared runtime. */
export function setOfferRuntime(r: MonitorRuntime | null): void {
  runtime = r;
}

/** `offers.refresh` { sourceId }. Network failures retry with backoff; robots/disabled dead-letter at once. */
export async function offersRefreshJob(job: JobContext): Promise<void> {
  const sourceId = String(job.payload.sourceId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(sourceId)) throw new PermanentJobError('bad_payload', 'sourceId is required');
  const { pool, clock, mailer } = job.deps;
  let r;
  try {
    r = await refreshOfferSource({ pool, clock, mailer, runtime: runtimeFor(job), log: job.log }, sourceId);
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) throw new PermanentJobError('source_not_found', 'The source no longer exists');
    throw err;
  }
  metrics.inc('offers.refresh', { outcome: r.ok ? 'ok' : r.permanent ? 'skipped' : 'failed' });
  job.log.info(
    { sourceId, ok: r.ok, fetchOutcome: r.fetchOutcome, offers: r.offers, observationsAdded: r.observationsAdded, reviewsQueued: r.reviewsQueued, transitions: r.transitions },
    'offer refresh finished',
  );
  if (!r.ok) {
    if (r.permanent) throw new PermanentJobError(r.fetchOutcome, r.error ?? r.fetchOutcome);
    throw Object.assign(new Error(r.error ?? 'refresh failed'), { code: 'fetch_failed' });
  }
}

/** `offers.recompute`: applies the stale-data policy and records each status transition. */
export async function offersRecomputeJob(job: JobContext): Promise<void> {
  const r = await recomputeAllStatuses(job.deps.pool, job.deps.clock());
  job.log.info(r, 'offer statuses recomputed');
}

let registered = false;

/** Registers the offer engine's job types (idempotent; called by buildApp and the worker). */
export function registerOfferHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler('offers.refresh', offersRefreshJob);
  registerHandler('offers.recompute', offersRecomputeJob);
}
