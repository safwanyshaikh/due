import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { many, one, withTransaction } from '../../db.js';
import { actorOf, currentUser, requireRole } from '../../http/context.js';
import { conflict, notFound, parse } from '../../http/errors.js';
import { camel, camelAll, normaliseKeys, slugify } from '../../util.js';
import { buildSet, count, httpUrl, paging, uuidParam } from './helpers.js';

const companyBody = z.object({
  kind: z.enum(['company', 'vendor']).default('company'),
  name: z.string().trim().min(1).max(200),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and hyphens')
    .max(80)
    .optional(),
  officialWebsite: httpUrl.nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  country: z.string().trim().max(80).nullable().optional(),
  categoryId: z.string().uuid().nullable().optional(),
  monitoringEnabled: z.boolean().optional(),
});

const companyPatch = companyBody
  .omit({ kind: true })
  .partial()
  .extend({ kind: z.enum(['company', 'vendor']).optional(), status: z.enum(['active', 'archived']).optional() })
  .strict();

export async function getCompany(app: FastifyInstance, id: string) {
  const row = await one(app.deps.pool, 'SELECT * FROM companies WHERE id = $1', [id]);
  if (!row) throw notFound('Company not found');
  return row;
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

export async function companyRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const editor = { preHandler: requireRole('editor') };

  app.get('/companies', async (req) => {
    const q = parse(
      paging.extend({
        kind: z.enum(['company', 'vendor']).optional(),
        status: z.enum(['active', 'archived']).optional(),
        q: z.string().trim().max(200).optional(),
      }),
      req.query,
    );
    const where = ['($1::text IS NULL OR c.kind = $1)', '($2::text IS NULL OR c.status = $2)',
      `($3::text IS NULL OR c.name ILIKE '%' || $3 || '%' OR c.slug ILIKE '%' || $3 || '%' OR c.official_website ILIKE '%' || $3 || '%')`];
    const params = [q.kind ?? null, q.status ?? null, q.q || null];
    const total = await count(pool, `SELECT count(*) AS n FROM companies c WHERE ${where.join(' AND ')}`, params);
    const rows = await many(
      pool,
      `SELECT c.*, cat.name AS category_name,
              (SELECT count(*) FROM sources s WHERE s.company_id = c.id) AS source_count,
              (SELECT count(*) FROM sources s WHERE s.company_id = c.id AND s.status IN ('failing','inaccessible')) AS failing_source_count
         FROM companies c LEFT JOIN categories cat ON cat.id = c.category_id
        WHERE ${where.join(' AND ')}
        ORDER BY c.name LIMIT $4 OFFSET $5`,
      [...params, q.limit, q.offset],
    );
    return { items: camelAll(rows), total };
  });

  app.post('/companies', editor, async (req, reply) => {
    const body = parse(companyBody.strict(), normaliseKeys(req.body));
    const slug = body.slug ?? slugify(body.name);
    if (!slug) throw conflict('Could not derive a slug from the name; provide one');
    const now = clock();
    try {
      const row = await withTransaction(pool, async (c) => {
        const r = await one<Record<string, unknown>>(
          c,
          `INSERT INTO companies (kind, name, slug, official_website, description, country, category_id, monitoring_enabled, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *`,
          [body.kind, body.name, slug, body.officialWebsite ?? null, body.description ?? null, body.country ?? null,
            body.categoryId ?? null, body.monitoringEnabled ?? true, now],
        );
        await writeAudit(c, actorOf(req), 'company.create', 'company', r!.id as string, null, r);
        return r!;
      });
      return reply.code(201).send(camel(row));
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A company with slug "${slug}" already exists`);
      throw err;
    }
  });

  app.get('/companies/:id', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const company = await getCompany(app, id);
    const [sources, recentRecords, intel] = await Promise.all([
      many(pool, 'SELECT * FROM sources WHERE company_id = $1 ORDER BY priority, label', [id]),
      many(pool, 'SELECT * FROM records WHERE company_id = $1 ORDER BY last_seen_at DESC LIMIT 20', [id]),
      many(pool, 'SELECT id, kind, data, source_url, fetched_at, method, verification_status, created_at FROM vendor_intel WHERE company_id = $1 ORDER BY kind, created_at', [id]),
    ]);
    return { ...camel(company), sources: camelAll(sources), recentRecords: camelAll(recentRecords), intel: camelAll(intel) };
  });

  app.patch('/companies/:id', editor, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(companyPatch, normaliseKeys(req.body));
    try {
      const row = await withTransaction(pool, async (c) => {
        const before = await one(c, 'SELECT * FROM companies WHERE id = $1 FOR UPDATE', [id]);
        if (!before) throw notFound('Company not found');
        const set = buildSet(body, 2, { updatedAt: clock() });
        const after = await one(c, `UPDATE companies SET ${set.sql} WHERE id = $1 RETURNING *`, [id, ...set.values]);
        await writeAudit(c, actorOf(req), 'company.update', 'company', id, before, after);
        return after!;
      });
      return camel(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Slug already in use');
      throw err;
    }
  });

  app.post('/companies/:id/archive', editor, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const row = await withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM companies WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Company not found');
      const after = await one(c, `UPDATE companies SET status = 'archived', updated_at = $2 WHERE id = $1 RETURNING *`, [id, clock()]);
      await writeAudit(c, actorOf(req), 'company.archive', 'company', id, before, after);
      return after!;
    });
    return camel(row);
  });

  app.post('/companies/:id/verify', editor, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({ status: z.enum(['unverified', 'pending', 'verified', 'rejected']), note: z.string().max(2000).nullable().optional() }),
      req.body,
    );
    const user = currentUser(req);
    const row = await withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM companies WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Company not found');
      const now = clock();
      const after = await one(
        c,
        `UPDATE companies SET verification_status = $2, verification_note = $3, verified_by = $4, verified_at = $5, updated_at = $5
          WHERE id = $1 RETURNING *`,
        [id, body.status, body.note ?? null, user.id, now],
      );
      await writeAudit(c, actorOf(req), 'company.verify', 'company', id, before, after);
      return after!;
    });
    return camel(row);
  });
}
