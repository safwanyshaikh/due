import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { many, one, withTransaction } from '../../db.js';
import { actorOf, currentUser, requireRole } from '../../http/context.js';
import { badRequest, notFound, parse } from '../../http/errors.js';
import { camel, camelAll, canonicalJson, normaliseKeys, sha256 } from '../../util.js';
import { count, paging, uuidParam } from './helpers.js';

export async function recordRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const editor = { preHandler: requireRole('editor') };

  app.get('/records', async (req) => {
    const q = parse(
      paging.extend({
        q: z.string().trim().max(200).optional(),
        status: z.enum(['pending', 'approved', 'rejected']).optional(),
        companyId: z.string().uuid().optional(),
        sourceId: z.string().uuid().optional(),
        type: z.enum(['page', 'rss_item', 'announcement', 'price_mention']).optional(),
      }),
      normaliseKeys(req.query),
    );
    const where = `($1::text IS NULL OR r.title ILIKE '%' || $1 || '%' OR r.summary ILIKE '%' || $1 || '%' OR r.url ILIKE '%' || $1 || '%')
      AND ($2::text IS NULL OR r.verification_status = $2) AND ($3::uuid IS NULL OR r.company_id = $3)
      AND ($4::text IS NULL OR r.record_type = $4) AND ($5::uuid IS NULL OR r.source_id = $5)`;
    const params = [q.q || null, q.status ?? null, q.companyId ?? null, q.type ?? null, q.sourceId ?? null];
    const total = await count(pool, `SELECT count(*) AS n FROM records r WHERE ${where}`, params);
    const rows = await many(
      pool,
      `SELECT r.*, c.name AS company_name, s.url AS source_url, s.label AS source_label, s.is_official AS source_is_official
         FROM records r JOIN companies c ON c.id = r.company_id LEFT JOIN sources s ON s.id = r.source_id
        WHERE ${where} ORDER BY r.last_seen_at DESC LIMIT $6 OFFSET $7`,
      [...params, q.limit, q.offset],
    );
    return { items: camelAll(rows), total };
  });

  app.get('/records/:id', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const row = await one(
      pool,
      `SELECT r.*, c.name AS company_name, s.url AS source_url, s.label AS source_label, s.source_category, s.is_official AS source_is_official,
              s.extraction_method
         FROM records r JOIN companies c ON c.id = r.company_id LEFT JOIN sources s ON s.id = r.source_id WHERE r.id = $1`,
      [id],
    );
    if (!row) throw notFound('Record not found');
    const versions = await many(pool, 'SELECT * FROM record_versions WHERE record_id = $1 ORDER BY version DESC', [id]);
    return { ...camel(row), versions: camelAll(versions) };
  });

  app.post('/records/:id/review', editor, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(2000).nullable().optional() }),
      req.body,
    );
    const user = currentUser(req);
    const row = await withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM records WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Record not found');
      const after = await one(
        c,
        `UPDATE records SET verification_status = $2, review_note = $3, reviewed_by = $4, reviewed_at = $5 WHERE id = $1 RETURNING *`,
        [id, body.decision, body.note ?? null, user.id, clock()],
      );
      await writeAudit(c, actorOf(req), 'record.review', 'record', id, before, after);
      return after!;
    });
    return camel(row);
  });

  app.patch('/records/:id', editor, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z
        .object({
          title: z.string().trim().min(1).max(1000).optional(),
          summary: z.string().max(5000).nullable().optional(),
          note: z.string().max(2000).nullable().optional(),
        })
        .strict(),
      req.body,
    );
    if (body.title === undefined && body.summary === undefined) throw badRequest('Provide title and/or summary');
    const user = currentUser(req);
    const now = clock();
    const row = await withTransaction(pool, async (c) => {
      const before = await one<Record<string, unknown>>(c, 'SELECT * FROM records WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Record not found');
      const title = body.title ?? (before.title as string | null);
      const summary = body.summary !== undefined ? body.summary : (before.summary as string | null);
      const version = (before.current_version as number) + 1;
      const data = { title, summary, url: before.url, note: body.note ?? null, correctedFromVersion: before.current_version };
      const after = await one(
        c,
        `UPDATE records SET title = $2, summary = $3, current_version = $4, review_note = COALESCE($5, review_note) WHERE id = $1 RETURNING *`,
        [id, title, summary, version, body.note ?? null],
      );
      // History is append-only: the correction is a new version; earlier versions are never overwritten.
      await c.query(
        `INSERT INTO record_versions (record_id, version, data, content_hash, snapshot_id, change_type, changed_by, captured_at)
         VALUES ($1,$2,$3,$4,NULL,'manual_correction',$5,$6)`,
        [id, version, JSON.stringify(data), sha256(canonicalJson(data)), user.id, now],
      );
      await writeAudit(c, actorOf(req), 'record.correct', 'record', id, before, after);
      return after!;
    });
    return camel(row);
  });
}
