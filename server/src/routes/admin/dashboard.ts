import type { FastifyInstance } from 'fastify';
import { addMinutes } from '../../clock.js';
import { many } from '../../db.js';
import { camelAll } from '../../util.js';
import { count } from './helpers.js';

export async function dashboardStats(app: FastifyInstance) {
  const { pool, clock } = app.deps;
  const since = addMinutes(clock(), -7 * 1440);
  const [companies, vendors, activeSources, monitoredSources, newRecords7d, updatedRecords7d, failedFetches7d, pendingVerification] =
    await Promise.all([
      count(pool, `SELECT count(*) AS n FROM companies WHERE kind = 'company' AND status = 'active'`),
      count(pool, `SELECT count(*) AS n FROM companies WHERE kind = 'vendor' AND status = 'active'`),
      count(pool, `SELECT count(*) AS n FROM sources WHERE enabled AND status = 'active'`),
      count(
        pool,
        `SELECT count(*) AS n FROM sources s JOIN companies c ON c.id = s.company_id
          WHERE s.enabled AND c.monitoring_enabled AND c.status = 'active'`,
      ),
      count(pool, `SELECT count(*) AS n FROM records WHERE first_seen_at >= $1`, [since]),
      count(
        pool,
        `SELECT count(DISTINCT record_id) AS n FROM record_versions
          WHERE change_type IN ('modified','manual_correction') AND captured_at >= $1`,
        [since],
      ),
      count(pool, `SELECT count(*) AS n FROM fetch_runs WHERE outcome = 'error' AND started_at >= $1`, [since]),
      count(pool, `SELECT count(*) AS n FROM records WHERE verification_status = 'pending'`),
    ]);
  const latestRuns = camelAll(await many(pool, 'SELECT * FROM job_runs ORDER BY id DESC LIMIT 10'));
  const jobs = camelAll(await many(pool, 'SELECT * FROM jobs ORDER BY id'));
  return {
    companies,
    vendors,
    activeSources,
    monitoredSources,
    newRecords7d,
    updatedRecords7d,
    failedFetches7d,
    pendingVerification,
    latestRuns,
    automation: { jobs, schedulerEnabledOnThisInstance: app.deps.config.runScheduler },
  };
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/dashboard', async () => dashboardStats(app));
}
