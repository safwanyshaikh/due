import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { offerToApi } from '../../catalog.js';
import { many, one, withTransaction } from '../../db.js';
import { actorOf, requireRole } from '../../http/context.js';
import { badRequest, conflict, notFound, parse } from '../../http/errors.js';
import { enqueueOfferRefresh, recomputeAllStatuses, recomputeOfferStatus, type OfferRow } from '../../monitor/offers.js';
import { ParserRules } from '../../monitor/parser.js';
import { OFFER_STATUSES, PROVIDER_FAMILIES } from '../../monitor/status.js';
import { camel, camelAll, normaliseKeys } from '../../util.js';
import { buildSet, httpUrl, paging } from './helpers.js';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const offerFields = {
  provider: z.string().trim().min(1).max(60),
  productFamily: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  benefitType: z.enum(['recurring_entitlement', 'one_time_reward', 'trial', 'bundle', 'capability']),
  priceInr: z.number().nonnegative().max(10_000_000).nullable(),
  billingPeriod: z.enum(['monthly', 'quarterly', 'annual', 'one_time', 'none']).nullable(),
  benefitValue: z.record(z.string(), z.unknown()),
  sourceUrls: z.array(httpUrl).min(1).max(20),
  officialStartAt: dateOnly.nullable(),
  officialEndAt: dateOnly.nullable(),
  termsStatus: z.enum(['active', 'expired', 'unavailable', 'conflicting', 'unknown']),
  pageStatus: z.enum(['visible', 'unavailable', 'login_required', 'dynamic', 'unknown']),
  confidence: z.enum(['high', 'medium', 'low']),
  notes: z.array(z.string().max(1000)).max(20),
  details: z.record(z.string(), z.unknown()),
  verificationStatus: z.enum(['research_snapshot', 'pending', 'verified', 'rejected']),
  observedAt: z.string().datetime({ offset: true }).or(dateOnly).nullable(),
  lastConfirmedAt: z.string().datetime({ offset: true }).or(dateOnly).nullable(),
  sku: z.string().trim().max(60).nullable(),
  geography: z.string().trim().max(200).nullable(),
  supersededBy: z.string().trim().max(100).nullable(),
  freshnessWindowHours: z.number().int().min(1).max(8760),
  providerFamily: z.enum(PROVIDER_FAMILIES).nullable(),
};
/** Accepted for compatibility but ignored: status is always computed server-side (and audited as a transition). */
const legacyComputedStatus = z.enum(OFFER_STATUSES).optional();

const offerCreate = z
  .object({
    id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,99}$/),
    ...offerFields,
    priceInr: offerFields.priceInr.optional(),
    billingPeriod: offerFields.billingPeriod.optional(),
    benefitValue: offerFields.benefitValue.default({}),
    officialStartAt: offerFields.officialStartAt.optional(),
    officialEndAt: offerFields.officialEndAt.optional(),
    termsStatus: offerFields.termsStatus.default('unknown'),
    pageStatus: offerFields.pageStatus.default('unknown'),
    confidence: offerFields.confidence.default('low'),
    notes: offerFields.notes.default([]),
    details: offerFields.details.default({}),
    verificationStatus: offerFields.verificationStatus.default('pending'),
    observedAt: offerFields.observedAt.optional(),
    lastConfirmedAt: offerFields.lastConfirmedAt.optional(),
    sku: offerFields.sku.optional(),
    geography: offerFields.geography.optional(),
    supersededBy: offerFields.supersededBy.optional(),
    freshnessWindowHours: offerFields.freshnessWindowHours.default(168),
    providerFamily: offerFields.providerFamily.optional(),
    computedStatus: legacyComputedStatus,
  })
  .strict();

const offerPatch = z
  .object({ ...offerFields, computedStatus: legacyComputedStatus })
  .partial()
  .strict();

const idParam = z.object({ id: z.string().min(1).max(100) });

async function sourceIdsFor(c: { query: (s: string, p: unknown[]) => Promise<{ rows: { id: string }[] }> }, urls: string[]) {
  return (await c.query('SELECT id FROM sources WHERE url = ANY($1)', [urls])).rows.map((r) => r.id);
}

/** Field-level differences between consecutive observations of the same source. */
export function observationDiff(prev: Record<string, unknown> | null, next: Record<string, unknown>): { field: string; from: unknown; to: unknown }[] {
  const keys = new Set([...Object.keys(prev ?? {}), ...Object.keys(next)]);
  const out: { field: string; from: unknown; to: unknown }[] = [];
  for (const k of [...keys].sort()) {
    const a = prev ? (prev[k] ?? null) : null;
    const b = next[k] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: k, from: a, to: b });
  }
  return out;
}

export async function offerRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const editor = { preHandler: requireRole('editor') };
  const admin = { preHandler: requireRole('admin') };

  app.get('/offers', async (req) => {
    const q = parse(
      z.object({ status: z.enum(OFFER_STATUSES).optional(), provider: z.string().max(60).optional(), providerFamily: z.enum(PROVIDER_FAMILIES).optional() }),
      normaliseKeys(req.query),
    );
    const rows = await many<OfferRow>(
      pool,
      `SELECT o.*, (SELECT count(*)::int FROM offer_review_queue r WHERE r.offer_id = o.id AND r.status = 'pending') AS pending_reviews,
              (SELECT count(*)::int FROM offer_observations ob WHERE ob.offer_id = o.id) AS observation_count
         FROM offers o
        WHERE ($1::text IS NULL OR o.provider = $1) AND ($2::text IS NULL OR o.provider_family = $2)
        ORDER BY o.provider, o.id`,
      [q.provider ?? null, q.providerFamily ?? null],
    );
    const now = clock();
    const items = rows
      .map((r) => {
        const x = r as OfferRow & { pending_reviews: number; observation_count: number };
        return {
          ...offerToApi(r as never, now),
          sourceIds: r.source_ids,
          sources: (r.details as { sources?: unknown })?.sources ?? [],
          lastCheckError: r.last_check_error,
          statusChangedAt: r.status_changed_at,
          pendingReviews: x.pending_reviews,
          observationCount: x.observation_count,
        };
      })
      .filter((o) => !q.status || (o as Record<string, unknown>).status === q.status);
    return { items, total: items.length };
  });

  app.get('/offers/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const r = await one<OfferRow>(pool, 'SELECT * FROM offers WHERE id = $1', [id]);
    if (!r) throw notFound('Offer not found');
    const [transitions, pending, sources] = await Promise.all([
      many(pool, 'SELECT * FROM offer_status_transitions WHERE offer_id = $1 ORDER BY id DESC LIMIT 50', [id]),
      many(pool, `SELECT * FROM offer_review_queue WHERE offer_id = $1 AND status = 'pending' ORDER BY id DESC`, [id]),
      many(
        pool,
        `SELECT id, url, label, source_category, status, last_checked_at, last_success_at, last_error, frequency_minutes,
                request_timeout_ms, offer_next_refresh_at, candidate FROM sources WHERE id = ANY($1) ORDER BY label`,
        [r.source_ids],
      ),
    ]);
    return {
      ...offerToApi(r as never, clock()),
      sourceIds: r.source_ids,
      lastCheckError: r.last_check_error,
      statusChangedAt: r.status_changed_at,
      monitoredSources: camelAll(sources),
      transitions: camelAll(transitions),
      pendingReviews: camelAll(pending),
    };
  });

  app.post('/offers', editor, async (req, reply) => {
    const b = parse(offerCreate, normaliseKeys(req.body));
    const now = clock();
    const row = await withTransaction(pool, async (c) => {
      if (await one(c, 'SELECT id FROM offers WHERE id = $1', [b.id])) throw conflict('Offer id already exists');
      const r = await one(
        c,
        `INSERT INTO offers (id, provider, product_family, name, benefit_type, price_inr, billing_period, benefit_value,
                             source_ids, source_urls, official_end_at, terms_status, page_status, confidence,
                             notes, details, verification_status, observed_at, last_confirmed_at, updated_at,
                             official_start_at, sku, geography, superseded_by, freshness_window_hours, provider_family)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
        [b.id, b.provider, b.productFamily, b.name, b.benefitType, b.priceInr ?? null, b.billingPeriod ?? null,
          JSON.stringify(b.benefitValue), await sourceIdsFor(c, b.sourceUrls), b.sourceUrls, b.officialEndAt ?? null,
          b.termsStatus, b.pageStatus, b.confidence, b.notes, JSON.stringify(b.details),
          b.verificationStatus, b.observedAt ?? null, b.lastConfirmedAt ?? null, now,
          b.officialStartAt ?? null, b.sku ?? null, b.geography ?? null, b.supersededBy ?? null, b.freshnessWindowHours, b.providerFamily ?? null],
      );
      await writeAudit(c, actorOf(req), 'offer.create', 'offer', b.id, null, r);
      await recomputeOfferStatus(c, b.id, now, { kind: 'admin', userId: actorOf(req).userId });
      return (await one(c, 'SELECT * FROM offers WHERE id = $1', [b.id]))!;
    });
    return reply.code(201).send(offerToApi(row as never, now));
  });

  app.patch('/offers/:id', editor, async (req) => {
    const { id } = parse(idParam, req.params);
    const { computedStatus: _ignored, ...b } = parse(offerPatch, normaliseKeys(req.body));
    if (b.supersededBy === id) throw badRequest('An offer cannot supersede itself');
    const now = clock();
    const row = await withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM offers WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Offer not found');
      if (b.supersededBy && !(await one(c, 'SELECT id FROM offers WHERE id = $1', [b.supersededBy]))) throw badRequest('supersededBy must be an existing offer id');
      const extra: Record<string, unknown> = { updatedAt: now };
      if (b.sourceUrls) extra.sourceIds = await sourceIdsFor(c, b.sourceUrls);
      const set = buildSet(b, 2, extra);
      const after = await one(c, `UPDATE offers SET ${set.sql} WHERE id = $1 RETURNING *`, [id, ...set.values]);
      await writeAudit(c, actorOf(req), 'offer.update', 'offer', id, before, after);
      await recomputeOfferStatus(c, id, now, { kind: 'admin', userId: actorOf(req).userId });
      return (await one(c, 'SELECT * FROM offers WHERE id = $1', [id]))!;
    });
    return offerToApi(row as never, now);
  });

  app.get('/offers/:id/observations', async (req) => {
    const { id } = parse(idParam, req.params);
    const q = parse(paging, normaliseKeys(req.query));
    if (!(await one(pool, 'SELECT id FROM offers WHERE id = $1', [id]))) throw notFound('Offer not found');
    const rows = await many<{ id: number; source_id: string | null; fields: Record<string, unknown> } & Record<string, unknown>>(
      pool,
      `SELECT o.*, (SELECT p.fields FROM offer_observations p WHERE p.offer_id = o.offer_id AND p.source_id IS NOT DISTINCT FROM o.source_id
                                     AND p.id < o.id ORDER BY p.id DESC LIMIT 1) AS previous_fields
         FROM offer_observations o WHERE o.offer_id = $1 ORDER BY o.id DESC LIMIT $2 OFFSET $3`,
      [id, q.limit, q.offset],
    );
    const total = Number((await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM offer_observations WHERE offer_id = $1', [id])).rows[0]!.n);
    return {
      items: rows.map((r) => {
        const { previous_fields: prev, ...rest } = r as typeof r & { previous_fields: Record<string, unknown> | null };
        return { ...camel(rest), diff: observationDiff(prev, r.fields), firstForSource: prev === null };
      }),
      total,
    };
  });

  app.get('/offers/:id/transitions', async (req) => {
    const { id } = parse(idParam, req.params);
    const rows = await many(pool, 'SELECT * FROM offer_status_transitions WHERE offer_id = $1 ORDER BY id DESC LIMIT 200', [id]);
    return { items: camelAll(rows), total: rows.length };
  });

  app.post('/offers/:id/refresh', editor, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const r = await enqueueOfferRefresh(pool, id, clock());
    await writeAudit(pool, actorOf(req), 'offer.refresh', 'offer', id, null, r);
    return reply.code(202).send(r);
  });

  app.post('/offers/recompute-status', editor, async (req) => {
    const r = await recomputeAllStatuses(pool, clock());
    await writeAudit(pool, actorOf(req), 'offer.recompute_status', 'offer', null, null, r);
    return r;
  });

  // ---- Parser versions (Admin configures; everyone can read) ------------------------------------------

  app.get('/parser-versions', async (req) => {
    const q = parse(z.object({ sourceId: z.string().uuid().optional(), provider: z.string().max(60).optional() }), normaliseKeys(req.query));
    const rows = await many(
      pool,
      `SELECT p.*, s.url AS source_url, s.label AS source_label, u.email AS created_by_email
         FROM parser_versions p LEFT JOIN sources s ON s.id = p.source_id LEFT JOIN users u ON u.id = p.created_by
        WHERE ($1::uuid IS NULL OR p.source_id = $1) AND ($2::text IS NULL OR p.provider = $2)
        ORDER BY p.created_at DESC, p.id DESC LIMIT 500`,
      [q.sourceId ?? null, q.provider ?? null],
    );
    return { items: camelAll(rows), total: rows.length };
  });

  app.post('/parser-versions', admin, async (req, reply) => {
    const b = parse(
      z
        .object({
          sourceId: z.string().uuid().nullable().optional(),
          provider: z.string().trim().min(1).max(60).nullable().optional(),
          version: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/),
          rules: ParserRules,
          notes: z.string().max(2000).nullable().optional(),
          activate: z.boolean().default(false),
        })
        .strict()
        .refine((x) => Boolean(x.sourceId) !== Boolean(x.provider), 'Give either sourceId or provider'),
      normaliseKeys(req.body),
    );
    const now = clock();
    const row = await withTransaction(pool, async (c) => {
      if (b.sourceId && !(await one(c, 'SELECT id FROM sources WHERE id = $1', [b.sourceId]))) throw notFound('Source not found');
      const dup = await one(
        c,
        `SELECT id FROM parser_versions WHERE COALESCE(source_id::text, '') = COALESCE($1::text, '') AND COALESCE(provider, '') = COALESCE($2, '') AND version = $3`,
        [b.sourceId ?? null, b.provider ?? null, b.version],
      );
      if (dup) throw conflict('That version already exists for this scope; parser versions are immutable, create a new one');
      if (b.activate) {
        await c.query(`UPDATE parser_versions SET active = false WHERE active AND COALESCE(source_id::text, '') = COALESCE($1::text, '') AND COALESCE(provider, '') = COALESCE($2, '')`, [
          b.sourceId ?? null,
          b.provider ?? null,
        ]);
      }
      const r = await one(
        c,
        `INSERT INTO parser_versions (source_id, provider, version, rules, notes, created_by, created_at, active, activated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [b.sourceId ?? null, b.provider ?? null, b.version, JSON.stringify(b.rules), b.notes ?? null, actorOf(req).userId, now, b.activate, b.activate ? now : null],
      );
      await writeAudit(c, actorOf(req), 'parser_version.create', 'parser_version', r!.id as number, null, r);
      return r!;
    });
    return reply.code(201).send(camel(row));
  });

  app.post('/parser-versions/:id/activate', admin, async (req) => {
    const { id } = parse(z.object({ id: z.coerce.number().int().positive() }), req.params);
    const now = clock();
    const row = await withTransaction(pool, async (c) => {
      const p = await one<{ id: number; source_id: string | null; provider: string | null; active: boolean }>(c, 'SELECT * FROM parser_versions WHERE id = $1 FOR UPDATE', [id]);
      if (!p) throw notFound('Parser version not found');
      const prev = await one(
        c,
        `UPDATE parser_versions SET active = false WHERE active AND id <> $1 AND COALESCE(source_id::text, '') = COALESCE($2::text, '') AND COALESCE(provider, '') = COALESCE($3, '') RETURNING id, version`,
        [id, p.source_id, p.provider],
      );
      const after = await one(c, 'UPDATE parser_versions SET active = true, activated_at = $2 WHERE id = $1 RETURNING *', [id, now]);
      await writeAudit(c, actorOf(req), 'parser_version.activate', 'parser_version', id, { previousActive: prev ?? null }, after);
      return after!;
    });
    return camel(row);
  });
}
