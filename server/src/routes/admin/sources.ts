import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { many, one, withTransaction } from '../../db.js';
import { actorOf, requireRole } from '../../http/context.js';
import { conflict, notFound, parse } from '../../http/errors.js';
import { checkSource } from '../../monitor/engine.js';
import { getSettings } from '../../settings.js';
import { camel, camelAll, normaliseKeys } from '../../util.js';
import { buildSet, count, httpUrl, numericIdParam, paging, uuidParam } from './helpers.js';

const CATEGORIES = ['official_site', 'product_page', 'pricing', 'terms', 'press', 'news', 'rss', 'help', 'api', 'document', 'social', 'secondary'] as const;
const STATUSES = ['active', 'failing', 'blocked_robots', 'inaccessible', 'disabled'] as const;

const sourceFields = {
  url: httpUrl,
  label: z.string().trim().min(1).max(300),
  sourceCategory: z.enum(CATEGORIES),
  isOfficial: z.boolean(),
  extractionMethod: z.enum(['html_text', 'rss', 'json', 'sitemap']),
  cssSelector: z.string().trim().max(500).nullable(),
  priority: z.enum(['critical', 'regular', 'secondary']),
  frequencyMinutes: z.number().int().min(15).max(525600),
  enabled: z.boolean(),
};

const sourceCreate = z
  .object({
    companyId: z.string().uuid(),
    url: sourceFields.url,
    label: sourceFields.label,
    sourceCategory: sourceFields.sourceCategory,
    isOfficial: sourceFields.isOfficial.default(false),
    extractionMethod: sourceFields.extractionMethod.default('html_text'),
    cssSelector: sourceFields.cssSelector.optional(),
    priority: sourceFields.priority.default('regular'),
    frequencyMinutes: sourceFields.frequencyMinutes.optional(),
    enabled: sourceFields.enabled.default(true),
  })
  .strict();

const sourcePatch = z.object(sourceFields).partial().strict();

/** Line-level diff: lines present in `next` but not `base` (added) and vice versa (removed), multiset-aware. */
export function lineDiff(base: string, next: string): { added: string[]; removed: string[] } {
  const a = base ? base.split('\n') : [];
  const b = next ? next.split('\n') : [];
  const countA = new Map<string, number>();
  for (const l of a) countA.set(l, (countA.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of b) {
    const n = countA.get(l) ?? 0;
    if (n > 0) countA.set(l, n - 1);
    else added.push(l);
  }
  const countB = new Map<string, number>();
  for (const l of b) countB.set(l, (countB.get(l) ?? 0) + 1);
  const removed: string[] = [];
  for (const l of a) {
    const n = countB.get(l) ?? 0;
    if (n > 0) countB.set(l, n - 1);
    else removed.push(l);
  }
  return { added, removed };
}

const SNAPSHOT_LIST_COLS = 'id, source_id, fetched_at, http_status, content_hash, content_type, title, etag, last_modified, bytes, duration_ms';

export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const editor = { preHandler: requireRole('editor') };

  app.get('/sources', async (req) => {
    const q = parse(
      paging.extend({
        companyId: z.string().uuid().optional(),
        status: z.enum(STATUSES).optional(),
        q: z.string().trim().max(200).optional(),
      }),
      normaliseKeys(req.query),
    );
    const where = `($1::uuid IS NULL OR s.company_id = $1) AND ($2::text IS NULL OR s.status = $2)
       AND ($3::text IS NULL OR s.url ILIKE '%' || $3 || '%' OR s.label ILIKE '%' || $3 || '%')`;
    const params = [q.companyId ?? null, q.status ?? null, q.q || null];
    const total = await count(pool, `SELECT count(*) AS n FROM sources s WHERE ${where}`, params);
    const rows = await many(
      pool,
      `SELECT s.*, c.name AS company_name, c.slug AS company_slug FROM sources s JOIN companies c ON c.id = s.company_id
        WHERE ${where} ORDER BY c.name, s.priority, s.label LIMIT $4 OFFSET $5`,
      [...params, q.limit, q.offset],
    );
    return { items: camelAll(rows), total };
  });

  app.post('/sources', editor, async (req, reply) => {
    const body = parse(sourceCreate, normaliseKeys(req.body));
    const settings = await getSettings(pool);
    const freq = body.frequencyMinutes ?? settings.frequency_defaults[body.priority];
    const now = clock();
    const row = await withTransaction(pool, async (c) => {
      const company = await one(c, 'SELECT id FROM companies WHERE id = $1', [body.companyId]);
      if (!company) throw notFound('Company not found');
      const dup = await one(c, 'SELECT id FROM sources WHERE company_id = $1 AND url = $2', [body.companyId, body.url]);
      if (dup) throw conflict('This company already has a source with that URL');
      const r = await one<Record<string, unknown>>(
        c,
        `INSERT INTO sources (company_id, url, label, source_category, is_official, extraction_method, css_selector,
                              priority, frequency_minutes, enabled, status, next_check_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12) RETURNING *`,
        [body.companyId, body.url, body.label, body.sourceCategory, body.isOfficial, body.extractionMethod,
          body.cssSelector ?? null, body.priority, freq, body.enabled, body.enabled ? 'active' : 'disabled', now],
      );
      await writeAudit(c, actorOf(req), 'source.create', 'source', r!.id as string, null, r);
      return r!;
    });
    return reply.code(201).send(camel(row));
  });

  app.get('/sources/:id', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const row = await one(
      pool,
      'SELECT s.*, c.name AS company_name FROM sources s JOIN companies c ON c.id = s.company_id WHERE s.id = $1',
      [id],
    );
    if (!row) throw notFound('Source not found');
    return camel(row);
  });

  app.patch('/sources/:id', editor, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(sourcePatch, normaliseKeys(req.body));
    const now = clock();
    const row = await withTransaction(pool, async (c) => {
      const before = await one<Record<string, unknown>>(c, 'SELECT * FROM sources WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Source not found');
      if (body.url && body.url !== before.url) {
        const dup = await one(c, 'SELECT id FROM sources WHERE company_id = $1 AND url = $2 AND id <> $3', [before.company_id, body.url, id]);
        if (dup) throw conflict('This company already has a source with that URL');
      }
      const extra: Record<string, unknown> = { updatedAt: now };
      if (body.enabled === false) extra.status = 'disabled';
      if (body.enabled === true && before.enabled === false) {
        Object.assign(extra, { status: 'active', nextCheckAt: now, consecutiveFailures: 0, lastError: null });
      }
      if (body.url && body.url !== before.url) Object.assign(extra, { nextCheckAt: now, httpEtag: null, httpLastModified: null });
      const set = buildSet(body, 2, extra);
      const after = await one(c, `UPDATE sources SET ${set.sql} WHERE id = $1 RETURNING *`, [id, ...set.values]);
      await writeAudit(c, actorOf(req), 'source.update', 'source', id, before, after);
      return after!;
    });
    return camel(row);
  });

  app.post('/sources/:id/validate', editor, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const result = await checkSource(app.deps.monitor, id, { mode: 'validate' });
    await writeAudit(pool, actorOf(req), 'source.validate', 'source', id, null, {
      outcome: result.outcome,
      httpStatus: result.httpStatus,
      stored: result.stored,
      error: result.error,
    });
    return result;
  });

  app.post('/sources/:id/run', editor, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const before = await one(pool, 'SELECT status, consecutive_failures, next_check_at FROM sources WHERE id = $1', [id]);
    if (!before) throw notFound('Source not found');
    const result = await checkSource(app.deps.monitor, id, { mode: 'run' });
    await writeAudit(pool, actorOf(req), 'source.run', 'source', id, before, {
      outcome: result.outcome,
      status: result.sourceStatus,
      httpStatus: result.httpStatus,
      snapshotId: result.snapshotId,
      error: result.error,
    });
    return result;
  });

  app.get('/sources/:id/runs', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const q = parse(paging, req.query);
    const total = await count(pool, 'SELECT count(*) AS n FROM fetch_runs WHERE source_id = $1', [id]);
    const rows = await many(pool, 'SELECT * FROM fetch_runs WHERE source_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3', [id, q.limit, q.offset]);
    return { items: camelAll(rows), total };
  });

  app.get('/sources/:id/snapshots', async (req) => {
    const { id } = parse(uuidParam, req.params);
    const q = parse(paging, req.query);
    const total = await count(pool, 'SELECT count(*) AS n FROM snapshots WHERE source_id = $1', [id]);
    const rows = await many(
      pool,
      `SELECT ${SNAPSHOT_LIST_COLS} FROM snapshots WHERE source_id = $1 ORDER BY id DESC LIMIT $2 OFFSET $3`,
      [id, q.limit, q.offset],
    );
    return { items: camelAll(rows), total };
  });

  const getSnapshot = async (req: { params: unknown }) => {
    const { id } = parse(numericIdParam, req.params);
    const row = await one(pool, 'SELECT * FROM snapshots WHERE id = $1', [id]);
    if (!row) throw notFound('Snapshot not found');
    return camel(row);
  };
  app.get('/snapshots/:id', getSnapshot);
  app.get('/sources/snapshots/:id', getSnapshot);

  const diff = async (req: { params: unknown; query: unknown }) => {
    const { id } = parse(numericIdParam, req.params);
    const { against } = parse(z.object({ against: z.coerce.number().int().positive() }), req.query);
    const rows = await many<{ id: number; source_id: string; text_content: string | null }>(
      pool,
      'SELECT id, source_id, text_content FROM snapshots WHERE id = ANY($1)',
      [[id, against]],
    );
    const cur = rows.find((r) => r.id === id);
    const base = rows.find((r) => r.id === against);
    if (!cur || !base) throw notFound('Snapshot not found');
    return { id, against, ...lineDiff(base.text_content ?? '', cur.text_content ?? '') };
  };
  app.get('/snapshots/:id/diff', diff);
  app.get('/sources/snapshots/:id/diff', diff);
}
