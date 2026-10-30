import pino from 'pino';
import { createMailer } from './alerts.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { Scheduler } from './jobs/scheduler.js';
import { MonitorRuntime } from './monitor/runtime.js';

/** Scheduler-only process (no HTTP server). */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.isProduction ? 'info' : 'debug', base: { service: 'due-worker' } });
  const pool = createPool(config.databaseUrl, 5);
  const mailer = await createMailer(config.smtpUrl, config.smtpFrom);
  const scheduler = new Scheduler(
    { pool, clock: () => new Date(), mailer, runtime: new MonitorRuntime(config.monitor), log },
    config.schedulerTickMs,
  );
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'worker shutting down');
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    await scheduler.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  scheduler.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
