import { buildApp } from './app.js';
import { createMailer } from './alerts.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { Scheduler } from './jobs/scheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const mailer = await createMailer(config.smtpUrl, config.smtpFrom);
  const app = await buildApp({ pool, config, mailer });
  if (config.adminSetupToken) {
    const n = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0]?.n ?? 0;
    if (n > 0) app.log.warn('ADMIN_SETUP_TOKEN is set but users exist: setup is disabled. Remove the variable.');
  }
  const scheduler = config.runScheduler ? new Scheduler(app.deps.monitor, config.schedulerTickMs) : null;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    try {
      await scheduler?.stop();
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
