import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many } from '../../db.js';
import { requireRole } from '../../http/context.js';
import { parse } from '../../http/errors.js';
import { camelAll, normaliseKeys } from '../../util.js';
import { paging } from './helpers.js';

/**
 * Privacy and deletion requests (Admin and above). Shows request progress and privacy-relevant consumer
 * audit metadata only: no status tokens, no before/after payloads, no emails or content.
 */
export async function privacyRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;
  const admin = { preHandler: requireRole('admin') };

  app.get('/privacy/deletions', admin, async (req) => {
    const q = parse(paging.extend({ status: z.enum(['queued', 'running', 'completed', 'failed']).optional() }), normaliseKeys(req.query));
    const rows = await many(
      pool,
      `SELECT d.id, d.account_id, d.status, d.steps, d.job_id, d.requested_at, d.started_at, d.completed_at, d.error_code,
              j.status AS job_status, j.attempts AS job_attempts, j.max_attempts AS job_max_attempts, j.last_error_code AS job_last_error_code
         FROM deletion_requests d LEFT JOIN jobs_queue j ON j.id = d.job_id
        WHERE ($1::text IS NULL OR d.status = $1)
        ORDER BY d.requested_at DESC LIMIT $2 OFFSET $3`,
      [q.status ?? null, q.limit, q.offset],
    );
    const counts = await many<{ status: string; n: number }>(pool, 'SELECT status, count(*)::int AS n FROM deletion_requests GROUP BY status');
    return { items: camelAll(rows), counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  });

  app.get('/privacy/audit', admin, async (req) => {
    const q = parse(paging.extend({ accountId: z.string().uuid().optional() }), normaliseKeys(req.query));
    const rows = await many(
      pool,
      `SELECT id, account_id, action, entity, entity_id, at FROM consumer_audit
        WHERE ($1::uuid IS NULL OR account_id = $1)
          AND (action ~* '(delet|consent|export|erase|withdraw|purge|retention|disconnect|unsubscrib)')
        ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [q.accountId ?? null, q.limit, q.offset],
    );
    return { items: camelAll(rows) };
  });
}
