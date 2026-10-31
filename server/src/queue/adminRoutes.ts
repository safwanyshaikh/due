import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { many } from '../db.js';
import { actorOf, requireRole } from '../http/context.js';
import { notFound, parse, AppError } from '../http/errors.js';
import { camel, camelAll, normaliseKeys } from '../util.js';
import { queueStats, retryJob } from './index.js';

const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead'] as const;

/** /api/admin/queue (registered under the /api/admin prefix, so viewer-or-above already applies). */
export async function queueAdminRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;

  app.get('/queue', async (req) => {
    const q = parse(
      z.object({
        status: z.enum(STATUSES).optional(),
        type: z.string().max(80).optional(),
        accountId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }),
      normaliseKeys(req.query),
    );
    const where = `($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR type = $2) AND ($3::uuid IS NULL OR account_id = $3)`;
    const params = [q.status ?? null, q.type ?? null, q.accountId ?? null];
    const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs_queue WHERE ${where}`, params)).rows[0]!.n;
    const rows = await many(
      pool,
      `SELECT id, type, account_id, payload, idempotency_key, status, attempts, max_attempts, run_at, started_at, finished_at,
              locked_by, last_error_code, last_error_message, correlation_id, created_at, updated_at
         FROM jobs_queue WHERE ${where} ORDER BY created_at DESC, id LIMIT $4 OFFSET $5`,
      [...params, q.limit, q.offset],
    );
    return { items: camelAll(rows), total };
  });

  app.get('/queue/stats', async () => {
    const s = await queueStats(pool, clock());
    return { ...s, byType: s.byType };
  });

  app.post('/queue/:id/retry', { preHandler: requireRole('editor') }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const before = (await pool.query('SELECT status, attempts FROM jobs_queue WHERE id = $1', [id])).rows[0];
    if (!before) throw notFound('Job not found');
    const row = await retryJob(pool, id, clock());
    if (!row) throw new AppError(409, 'not_retryable', 'Only failed or dead jobs can be retried');
    await writeAudit(pool, actorOf(req), 'queue.retry', 'job', id, before, { status: row.status, attempts: row.attempts });
    return camel(row);
  });
}
