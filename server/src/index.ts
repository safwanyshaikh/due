import { buildApp } from './app.js';
import { createMailer } from './alerts.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { Scheduler } from './jobs/scheduler.js';
import { QueueWorker } from './queue/index.js';
import { workerDepsOf } from './app.js';
import { resolve } from 'node:path';
import { SERVER_ROOT } from './paths.js';
import { seedProviderWatch } from './offerinbox/service.js';
import { seedSavings } from './savings/repo.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const mailer = await createMailer(config.smtpUrl, config.smtpFrom);
  const app = await buildApp({ pool, config, mailer });
  if (config.adminSetupToken) {
    const n = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0]?.n ?? 0;
    if (n > 0) app.log.warn('ADMIN_SETUP_TOKEN is set but users exist: setup is disabled. Remove the variable.');
  }
  // Idempotent: fills empty savings tables from the bundled seed file (no-op when the file is absent).
  try {
    const seeded = await seedSavings(pool, resolve(SERVER_ROOT, 'src/seed/savings-data.json'), new Date());
    if (seeded.file) app.log.info({ modules: seeded.modulesInserted, cityPacks: seeded.packsInserted }, 'savings seed checked');
    for (const w of seeded.skipped) app.log.warn(w);
  } catch (err) {
    app.log.error({ err }, 'savings seed failed');
  }
  try {
    const w = await seedProviderWatch(pool, resolve(SERVER_ROOT, 'src/seed/provider-watchlist.json'), new Date());
    if (w.inserted) app.log.info({ providers: w.inserted }, 'provider watchlist seeded');
    for (const m of w.skipped) app.log.warn(m);
  } catch (err) {
    app.log.error({ err }, 'provider watchlist seed failed');
  }
  const scheduler = config.runScheduler ? new Scheduler(app.deps.monitor, config.schedulerTickMs) : null;
  // Normally the separate due-worker service processes the queue; RUN_QUEUE_WORKER=true runs it here instead.
  const queueWorker = config.runQueueWorker ? new QueueWorker(workerDepsOf(app)) : null;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    try {
      await scheduler?.stop();
      await queueWorker?.stop();
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
  scheduler?.start();
  await queueWorker?.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
