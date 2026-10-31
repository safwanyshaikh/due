import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many } from '../../db.js';
import { actorOf, requireRole } from '../../http/context.js';
import { parse } from '../../http/errors.js';
import { decideReview } from '../../monitor/offers.js';
import { camel, camelAll, normaliseKeys } from '../../util.js';
import { paging } from './helpers.js';

const decisionBody = z.object({ note: z.string().trim().max(2000).nullable().optional() }).strict();

/** Change review queue: engine-detected price/eligibility/expiry/status changes wait here for an Editor. */
export async function reviewRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const editor = { preHandler: requireRole('editor') };

  app.get('/review', async (req) => {
    const q = parse(
      paging.extend({
        status: z.enum(['pending', 'approved', 'rejected']).default('pending'),
        offerId: z.string().max(100).optional(),
        changeKind: z.enum(['price', 'eligibility', 'expiry', 'status', 'new_offer']).optional(),
      }),
      normaliseKeys(req.query),
    );
    const where = `r.status = $1 AND ($2::text IS NULL OR r.offer_id = $2) AND ($3::text IS NULL OR r.change_kind = $3)`;
    const params = [q.status, q.offerId ?? null, q.changeKind ?? null];
    const total = Number((await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM offer_review_queue r WHERE ${where}`, params)).rows[0]!.n);
    const rows = await many(
      pool,
      `SELECT r.*, o.name AS offer_name, o.provider, s.url AS source_url, s.label AS source_label,
              ob.observed_at, ob.parser_version, ob.content_hash, u.email AS decided_by_email
         FROM offer_review_queue r
         LEFT JOIN offers o ON o.id = r.offer_id
         LEFT JOIN sources s ON s.id = r.source_id
         LEFT JOIN offer_observations ob ON ob.id = r.observation_id
         LEFT JOIN users u ON u.id = r.decided_by
        WHERE ${where}
        ORDER BY r.created_at DESC, r.id DESC LIMIT $4 OFFSET $5`,
      [...params, q.limit, q.offset],
    );
    const counts = await many<{ status: string; n: number }>(pool, 'SELECT status, count(*)::int AS n FROM offer_review_queue GROUP BY status');
    return { items: camelAll(rows), total, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  });

  for (const [path, decision] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const) {
    app.post(`/review/:id/${path}`, editor, async (req) => {
      const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
      const b = parse(decisionBody, req.body ?? {});
      const r = await decideReview(pool, id, decision, b.note ?? null, actorOf(req), clock());
      return { review: camel(r.review), offerId: r.offer?.id ?? null, offerStatus: r.offer?.computed_status ?? null };
    });
  }
}
