import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { addMinutes } from '../../clock.js';
import { many, one, withTransaction } from '../../db.js';
import { actorOf, currentUser, requireRole } from '../../http/context.js';
import { AppError, notFound, parse } from '../../http/errors.js';
import { JOB_IDS, startJob } from '../../jobs/runner.js';
import { getSettings, SETTING_KEYS, SETTING_SCHEMAS, type SettingKey } from '../../settings.js';
import { camel, camelAll, normaliseKeys } from '../../util.js';
import { count, numericIdParam, paging } from './helpers.js';

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;
  app.get('/audit', { preHandler: requireRole('admin') }, async (req) => {
    const q = parse(
      paging.extend({
        entityType: z.string().max(60).optional(),
        entityId: z.string().max(100).optional(),
        actor: z.string().uuid().optional(),
        action: z.string().max(80).optional(),
      }),
      normaliseKeys(req.query),
    );
    const where = `($1::text IS NULL OR a.entity_type = $1) AND ($2::uuid IS NULL OR a.actor_user_id = $2)
      AND ($3::text IS NULL OR a.entity_id = $3) AND ($4::text IS NULL OR a.action = $4)`;
    const params = [q.entityType ?? null, q.actor ?? null, q.entityId ?? null, q.action ?? null];
    const total = await count(pool, `SELECT count(*) AS n FROM audit_log a WHERE ${where}`, params);
    const rows = await many(
      pool,
      `SELECT a.*, u.email AS actor_email FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE ${where} ORDER BY a.id DESC LIMIT $5 OFFSET $6`,
      [...params, q.limit, q.offset],
    );
    return { items: camelAll(rows), total };
  });
}

const jobParam = z.object({ id: z.enum(JOB_IDS) });

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;

  app.get('/jobs', async () => {
    const rows = await many(pool, 'SELECT * FROM jobs ORDER BY id');
    return { items: camelAll(rows), total: rows.length };
  });

  app.patch('/jobs/:id', { preHandler: requireRole('admin') }, async (req) => {
    const { id } = parse(jobParam, req.params);
    const body = parse(
      z
        .object({
          enabled: z.boolean().optional(),
          intervalMinutes: z.number().int().min(1).max(525600).optional(),
          config: z
            .object({ batch_size: z.number().int().min(1).max(500).optional(), concurrency: z.number().int().min(1).max(16).optional() })
            .strict()
            .optional(),
        })
        .strict(),
      normaliseKeys(req.body),
    );
    const row = await withTransaction(pool, async (c) => {
      const before = await one<Record<string, unknown>>(c, 'SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Job not found');
      const interval = body.intervalMinutes ?? (before.interval_minutes as number);
      const base = (before.last_run_at as Date | null) ?? clock();
      const after = await one(
        c,
        `UPDATE jobs SET enabled = COALESCE($2, enabled), interval_minutes = $3, next_run_at = $4,
                config = config || COALESCE($5::jsonb, '{}'::jsonb) WHERE id = $1 RETURNING *`,
        [id, body.enabled ?? null, interval, addMinutes(base, interval), body.config ? JSON.stringify(body.config) : null],
      );
      await writeAudit(c, actorOf(req), 'job.update', 'job', id, before, after);
      return after!;
    });
    return camel(row);
  });

  app.post('/jobs/:id/run', { preHandler: requireRole('editor') }, async (req, reply) => {
    const { id } = parse(jobParam, req.params);
    const started = await startJob(app.deps.monitor, id, 'manual', currentUser(req).id);
    if (!started) throw new AppError(409, 'job_running', 'This job is already running');
    started.done.catch((err) => req.log.error({ err }, 'manual job failed'));
    await writeAudit(pool, actorOf(req), 'job.run', 'job', id, null, { jobRunId: started.run.id });
    return reply.code(202).send(camel(started.run));
  });

  const jobRuns = async (req: { query: unknown }) => {
    const q = parse(paging.extend({ jobId: z.enum(JOB_IDS).optional() }), normaliseKeys(req.query));
    const total = await count(pool, 'SELECT count(*) AS n FROM job_runs WHERE ($1::text IS NULL OR job_id = $1)', [q.jobId ?? null]);
    const rows = await many(
      pool,
      'SELECT * FROM job_runs WHERE ($1::text IS NULL OR job_id = $1) ORDER BY id DESC LIMIT $2 OFFSET $3',
      [q.jobId ?? null, q.limit, q.offset],
    );
    return { items: camelAll(rows), total };
  };
  app.get('/job-runs', jobRuns);
  app.get('/jobs/runs', jobRuns);
  app.get('/jobs/job-runs', jobRuns);
}

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  app.get('/alerts', async (req) => {
    const q = parse(paging.extend({ unread: z.enum(['0', '1', 'true', 'false']).optional() }), req.query);
    const unread = q.unread === '1' || q.unread === 'true';
    const total = await count(pool, 'SELECT count(*) AS n FROM alerts WHERE (NOT $1 OR read_at IS NULL)', [unread]);
    const unreadCount = await count(pool, 'SELECT count(*) AS n FROM alerts WHERE read_at IS NULL');
    const rows = await many(pool, 'SELECT * FROM alerts WHERE (NOT $1 OR read_at IS NULL) ORDER BY id DESC LIMIT $2 OFFSET $3', [
      unread,
      q.limit,
      q.offset,
    ]);
    return { items: camelAll(rows), total, unreadCount };
  });

  app.post('/alerts/:id/read', async (req) => {
    const { id } = parse(numericIdParam, req.params);
    const row = await withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM alerts WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Alert not found');
      const after = await one(c, 'UPDATE alerts SET read_at = COALESCE(read_at, $2) WHERE id = $1 RETURNING *', [id, clock()]);
      await writeAudit(c, actorOf(req), 'alert.read', 'alert', id, { readAt: before.read_at }, { readAt: after!.read_at });
      return after!;
    });
    return camel(row);
  });
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  // smtp_configured is read-only: it reflects whether SMTP_URL is set in the environment.
  app.get('/settings', async () => ({ ...(await getSettings(pool)), smtp_configured: Boolean(process.env.SMTP_URL?.trim()) }));

  app.patch('/settings', { preHandler: requireRole('admin') }, async (req) => {
    const { key, value } = parse(z.object({ key: z.enum(SETTING_KEYS as [SettingKey, ...SettingKey[]]), value: z.unknown() }).strict(), req.body);
    const valid = parse(SETTING_SCHEMAS[key] as z.ZodType, value);
    await withTransaction(pool, async (c) => {
      const before = (await getSettings(c))[key];
      await c.query(
        `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [key, JSON.stringify(valid), currentUser(req).id, clock()],
      );
      await writeAudit(c, actorOf(req), 'settings.update', 'setting', key, before, valid);
    });
    return getSettings(pool);
  });
}
