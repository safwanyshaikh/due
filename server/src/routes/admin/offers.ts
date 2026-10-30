import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { offerToApi } from '../../catalog.js';
import { many, one, withTransaction } from '../../db.js';
import { actorOf, requireRole } from '../../http/context.js';
import { conflict, notFound, parse } from '../../http/errors.js';
import { normaliseKeys } from '../../util.js';
import { buildSet, httpUrl } from './helpers.js';

const offerFields = {
  provider: z.string().trim().min(1).max(60),
  productFamily: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(300),
  benefitType: z.enum(['recurring_entitlement', 'one_time_reward', 'trial', 'bundle', 'capability']),
  priceInr: z.number().nonnegative().max(10_000_000).nullable(),
  billingPeriod: z.enum(['monthly', 'quarterly', 'annual', 'one_time', 'none']).nullable(),
  benefitValue: z.record(z.string(), z.unknown()),
  sourceUrls: z.array(httpUrl).min(1).max(20),
  officialEndAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  termsStatus: z.enum(['active', 'expired', 'unavailable', 'conflicting', 'unknown']),
  pageStatus: z.enum(['visible', 'unavailable', 'login_required', 'dynamic', 'unknown']),
  computedStatus: z.enum(['active', 'active_verify', 'expired', 'conflicting', 'unknown']),
  confidence: z.enum(['high', 'medium', 'low']),
  notes: z.array(z.string().max(1000)).max(20),
  details: z.record(z.string(), z.unknown()),
  verificationStatus: z.enum(['research_snapshot', 'pending', 'verified', 'rejected']),
  observedAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullable(),
  lastConfirmedAt: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullable(),
};

const offerCreate = z
  .object({
    id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,99}$/),
    ...offerFields,
    priceInr: offerFields.priceInr.optional(),
    billingPeriod: offerFields.billingPeriod.optional(),
    benefitValue: offerFields.benefitValue.default({}),
    officialEndAt: offerFields.officialEndAt.optional(),
    termsStatus: offerFields.termsStatus.default('unknown'),
    pageStatus: offerFields.pageStatus.default('unknown'),
    computedStatus: offerFields.computedStatus.default('unknown'),
    confidence: offerFields.confidence.default('low'),
    notes: offerFields.notes.default([]),
    details: offerFields.details.default({}),
    verificationStatus: offerFields.verificationStatus.default('pending'),
    observedAt: offerFields.observedAt.optional(),
    lastConfirmedAt: offerFields.lastConfirmedAt.optional(),
  })
  .strict();

const offerPatch = z.object(offerFields).partial().strict();

async function sourceIdsFor(c: { query: (s: string, p: unknown[]) => Promise<{ rows: { id: string }[] }> }, urls: string[]) {
  return (await c.query('SELECT id FROM sources WHERE url = ANY($1)', [urls])).rows.map((r) => r.id);
}

export async function offerRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const editor = { preHandler: requireRole('editor') };

  app.get('/offers', async () => {
    const rows = await many<Parameters<typeof offerToApi>[0] & { source_ids: string[] }>(pool, 'SELECT * FROM offers ORDER BY provider, id');
    return { items: rows.map((r) => ({ ...offerToApi(r), sourceIds: r.source_ids, sources: r.details?.sources ?? [] })), total: rows.length };
  });

  app.post('/offers', editor, async (req, reply) => {
    const b = parse(offerCreate, normaliseKeys(req.body));
    const row = await withTransaction(pool, async (c) => {
      if (await one(c, 'SELECT id FROM offers WHERE id = $1', [b.id])) throw conflict('Offer id already exists');
      const r = await one(
        c,
        `INSERT INTO offers (id, provider, product_family, name, benefit_type, price_inr, billing_period, benefit_value,
                             source_ids, source_urls, official_end_at, terms_status, page_status, computed_status, confidence,
                             notes, details, verification_status, observed_at, last_confirmed_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [b.id, b.provider, b.productFamily, b.name, b.benefitType, b.priceInr ?? null, b.billingPeriod ?? null,
          JSON.stringify(b.benefitValue), await sourceIdsFor(c, b.sourceUrls), b.sourceUrls, b.officialEndAt ?? null,
          b.termsStatus, b.pageStatus, b.computedStatus, b.confidence, b.notes, JSON.stringify(b.details),
          b.verificationStatus, b.observedAt ?? null, b.lastConfirmedAt ?? null, clock()],
      );
      await writeAudit(c, actorOf(req), 'offer.create', 'offer', b.id, null, r);
      return r!;
    });
    return reply.code(201).send(offerToApi(row as never));
  });

  app.patch('/offers/:id', editor, async (req) => {
    const { id } = parse(z.object({ id: z.string().min(1).max(100) }), req.params);
    const b = parse(offerPatch, normaliseKeys(req.body));
    const row = await withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM offers WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Offer not found');
      const extra: Record<string, unknown> = { updatedAt: clock() };
      if (b.sourceUrls) extra.sourceIds = await sourceIdsFor(c, b.sourceUrls);
      const set = buildSet(b, 2, extra);
      const after = await one(c, `UPDATE offers SET ${set.sql} WHERE id = $1 RETURNING *`, [id, ...set.values]);
      await writeAudit(c, actorOf(req), 'offer.update', 'offer', id, before, after);
      return after!;
    });
    return offerToApi(row as never);
  });
}
