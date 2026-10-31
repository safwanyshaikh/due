import pino from 'pino';
import { createMailer } from './alerts.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { Scheduler } from './jobs/scheduler.js';
import { MonitorRuntime } from './monitor/runtime.js';
import { configureErrorReporter } from './observability/errorReporter.js';
import { LOG_REDACT_PATHS } from './observability/redact.js';
import { registerPlatformHandlers } from './queue/handlers.js';
import { drainQueue, QueueWorker, registeredTypes, type WorkerDeps } from './queue/index.js';

/**
 * Background worker (Render service `due-worker`): processes the durable queue and, unless RUN_SCHEDULER=false,
 * runs the scheduler that enqueues periodic work. `--once` drains due jobs and exits (ops / smoke tests).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.isProduction ? 'info' : 'debug', base: { service: 'due-worker' }, redact: LOG_REDACT_PATHS });
  configureErrorReporter(config.sentryDsn, config.env);
  const pool = createPool(config.databaseUrl, 5);
  const mailer = await createMailer(config.smtpUrl, config.smtpFrom);
  registerPlatformHandlers();
  // Other agents' handlers register themselves when their modules load (see registerExtraHandlers).
  await registerExtraHandlers(log);
  const deps: WorkerDeps = { pool, config, clock: () => new Date(), mailer, log };

  if (process.argv.includes('--once')) {
    const r = await drainQueue(deps);
    log.info({ ...r, types: registeredTypes() }, 'queue drained');
    await pool.end();
    return;
  }

  // The worker runs the scheduler by default; set RUN_SCHEDULER=false to run queue processing only.
  const runScheduler = process.env.RUN_SCHEDULER?.trim() ? config.runScheduler : true;
  const scheduler = runScheduler
    ? new Scheduler({ pool, clock: () => new Date(), mailer, runtime: new MonitorRuntime(config.monitor), log }, config.schedulerTickMs)
    : null;
  const worker = new QueueWorker(deps, { concurrency: Number(process.env.QUEUE_CONCURRENCY ?? 2) || 2 });

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'worker shutting down');
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    await scheduler?.stop();
    await worker.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  await worker.start();
  scheduler?.start();
}

/** Loads optional handler modules owned by other areas (Gmail scans, offer refreshes) when present. */
async function registerExtraHandlers(log: pino.Logger): Promise<void> {
  // Convention: an area's module exports register…Jobs() / register…Handlers() (e.g. registerGmailJobs).
  for (const mod of ['./gmail/index.js', './monitor/handlers.js', './monitor/jobs.js']) {
    try {
      const m = (await import(mod)) as Record<string, unknown>;
      for (const [name, fn] of Object.entries(m)) {
        if (typeof fn === 'function' && /^register\w*(Jobs|Handlers)$/.test(name)) (fn as () => void)();
      }
    } catch (err) {
      if ((err as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND') log.error({ err, mod }, 'handler module failed to load');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
