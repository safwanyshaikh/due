import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { many, one, withTransaction } from '../../db.js';
import { actorOf, requireRole } from '../../http/context.js';
import { conflict, notFound, parse } from '../../http/errors.js';
import { enqueue } from '../../queue/index.js';
import { camel, camelAll } from '../../util.js';
import { paging } from './helpers.js';

const STALE_DAYS = 30;
const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const domain = z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/);
const watchFields = {
  displayName: z.string().trim().min(1).max(120),
  senderDomains: z.array(domain).max(20),
  category: z.string().trim().min(1).max(40),
  country: z.string().trim().length(2).toUpperCase(),
  signupUrl: z.string().trim().url().max(500).nullable(),
  researchAddress: z.string().trim().toLowerCase().email().max(200).nullable(),
  status: z.enum(['subscribed', 'pending', 'unsubscribed']),
  appOnly: z.boolean(),
  notes: z.string().trim().max(1000).nullable(),
};
const watchCreate = z
  .object({ slug, ...watchFields, senderDomains: watchFields.senderDomains.default([]), category: watchFields.category.default('other'), country: watchFields.country.default('IN'),
    signupUrl: watchFields.signupUrl.default(null), researchAddress: watchFields.researchAddress.default(null), status: watchFields.status.default('pending'), appOnly: watchFields.appOnly.default(false), notes: watchFields.notes.default(null) })
  .strict();
const watchPatch = z.object(watchFields).partial().strict();

/** Offer inbox admin: provider watchlist, parsed newsletter mail, unmatched senders. Review/approve reuses /api/admin/review. */
export async function offerInboxAdminRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const editor = { preHandler: requireRole('editor') };
  const COLS: Record<string, string> = { displayName: 'display_name', senderDomains: 'sender_domains', category: 'category', country: 'country', signupUrl: 'signup_url', researchAddress: 'research_address', status: 'status', appOnly: 'app_only', notes: 'notes' };

  app.get('/offer-inbox/watch', async (req) => {
    const q = parse(z.object({ stale: z.enum(['true', 'false']).optional(), status: z.enum(['subscribed', 'pending', 'unsubscribed']).optional() }), req.query);
    const cutoff = new Date(clock().getTime() - STALE_DAYS * 86_400_000);
    const rows = await many(
      pool,
      `SELECT w.*, (SELECT count(*)::int FROM offer_inbox_messages m WHERE m.provider_slug = w.slug) AS message_count,
              (w.status = 'subscribed' AND (w.last_email_at IS NULL OR w.last_email_at < $1)) AS stale
         FROM provider_watch w
        WHERE ($2::text IS NULL OR w.status = $2)
          AND ($3::boolean IS NOT TRUE OR (w.status = 'subscribed' AND (w.last_email_at IS NULL OR w.last_email_at < $1)))
        ORDER BY w.display_name`,
      [cutoff, q.status ?? null, q.stale === 'true' ? true : null],
    );
    return { items: camelAll(rows), total: rows.length, staleDays: STALE_DAYS };
  });

  app.post('/offer-inbox/watch', editor, async (req, reply) => {
    const b = parse(watchCreate, req.body);
    const row = await withTransaction(pool, async (c) => {
      if (await one(c, 'SELECT slug FROM provider_watch WHERE slug = $1', [b.slug])) throw conflict('Provider already exists');
      const r = await one(
        c,
        `INSERT INTO provider_watch (slug, display_name, sender_domains, category, country, signup_url, research_address, status, app_only, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING *`,
        [b.slug, b.displayName, [...new Set(b.senderDomains)], b.category, b.country, b.signupUrl, b.researchAddress, b.status, b.appOnly, b.notes, clock()],
      );
      await writeAudit(c, actorOf(req), 'offer_inbox.watch.create', 'provider_watch', b.slug, null, r);
      return r!;
    });
    return reply.code(201).send(camel(row));
  });

  app.patch('/offer-inbox/watch/:slug', editor, async (req) => {
    const { slug: s } = parse(z.object({ slug }), req.params);
    const b = parse(watchPatch, req.body);
    return withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM provider_watch WHERE slug = $1 FOR UPDATE', [s]);
      if (!before) throw notFound('Provider not found');
      const entries = Object.entries(b).filter(([, v]) => v !== undefined);
      const sets = entries.map(([k], i) => `${COLS[k]} = $${i + 2}`);
      const vals = entries.map(([k, v]) => (k === 'senderDomains' ? [...new Set(v as string[])] : v));
      const r = await one(c, `UPDATE provider_watch SET ${[...sets, `updated_at = $${vals.length + 2}`].join(', ')} WHERE slug = $1 RETURNING *`, [s, ...vals, clock()]);
      await writeAudit(c, actorOf(req), 'offer_inbox.watch.update', 'provider_watch', s, before, r);
      return camel(r!);
    });
  });

  app.post('/offer-inbox/watch/:slug/mark-subscribed', editor, async (req) => {
    const { slug: s } = parse(z.object({ slug }), req.params);
    const b = parse(z.object({ researchAddress: watchFields.researchAddress.optional() }).strict(), req.body ?? {});
    return withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM provider_watch WHERE slug = $1 FOR UPDATE', [s]);
      if (!before) throw notFound('Provider not found');
      const r = await one(c, `UPDATE provider_watch SET status = 'subscribed', research_address = COALESCE($2, research_address), updated_at = $3 WHERE slug = $1 RETURNING *`, [s, b.researchAddress ?? null, clock()]);
      await writeAudit(c, actorOf(req), 'offer_inbox.watch.subscribe', 'provider_watch', s, before, r);
      return camel(r!);
    });
  });

  app.delete('/offer-inbox/watch/:slug', editor, async (req, reply) => {
    const { slug: s } = parse(z.object({ slug }), req.params);
    await withTransaction(pool, async (c) => {
      const before = await one(c, 'DELETE FROM provider_watch WHERE slug = $1 RETURNING *', [s]);
      if (!before) throw notFound('Provider not found');
      await writeAudit(c, actorOf(req), 'offer_inbox.watch.delete', 'provider_watch', s, before, null);
    });
    return reply.code(204).send();
  });

  app.get('/offer-inbox/messages', async (req) => {
    const q = parse(paging.extend({ provider: slug.optional(), status: z.enum(['received', 'parsed', 'quarantined', 'failed']).optional() }), req.query);
    const where = `($1::text IS NULL OR m.provider_slug = $1) AND ($2::text IS NULL OR m.status = $2)`;
    const total = (await one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM offer_inbox_messages m WHERE ${where}`, [q.provider ?? null, q.status ?? null]))!.n;
    const rows = await many(
      pool,
      `SELECT m.id, m.received_at, m.from_domain, m.subject, m.status, m.reason, m.personalised, m.landing_urls, m.candidates, m.reviews_queued,
              m.provider_slug, w.display_name AS provider_name, m.auth->>'dkim' AS dkim
         FROM offer_inbox_messages m LEFT JOIN provider_watch w ON w.slug = m.provider_slug
        WHERE ${where} ORDER BY m.received_at DESC LIMIT $3 OFFSET $4`,
      [q.provider ?? null, q.status ?? null, q.limit, q.offset],
    );
    return { items: camelAll(rows), total };
  });

  // DKIM-verified mail from a domain no provider owns yet: attach the domain to a provider in one click.
  app.get('/offer-inbox/unmatched', async () => {
    const rows = await many(
      pool,
      `SELECT from_domain AS domain, count(*)::int AS messages, max(received_at) AS last_received_at, max(subject) AS sample_subject
         FROM offer_inbox_messages WHERE status = 'quarantined' AND reason = 'unmatched_sender' AND from_domain IS NOT NULL
        GROUP BY from_domain ORDER BY max(received_at) DESC LIMIT 100`,
    );
    return { items: camelAll(rows), total: rows.length };
  });

  app.post('/offer-inbox/unmatched/attach', editor, async (req) => {
    const b = parse(z.object({ domain, providerSlug: slug }).strict(), req.body);
    const now = clock();
    return withTransaction(pool, async (c) => {
      const before = await one<{ sender_domains: string[] }>(c, 'SELECT * FROM provider_watch WHERE slug = $1 FOR UPDATE', [b.providerSlug]);
      if (!before) throw notFound('Provider not found');
      const owner = await one<{ slug: string }>(c, 'SELECT slug FROM provider_watch WHERE $1 = ANY(sender_domains) AND slug <> $2', [b.domain, b.providerSlug]);
      if (owner) throw conflict(`That domain already belongs to ${owner.slug}`);
      const after = await one(c, `UPDATE provider_watch SET sender_domains = (SELECT array_agg(DISTINCT d) FROM unnest(sender_domains || $2::text) d), updated_at = $3 WHERE slug = $1 RETURNING *`, [b.providerSlug, b.domain, now]);
      await writeAudit(c, actorOf(req), 'offer_inbox.sender.attach', 'provider_watch', b.providerSlug, before, after);
      // Re-run the stored mail from this domain now that it has an owner.
      const ids = await many<{ id: string }>(c, `UPDATE offer_inbox_messages SET status = 'received', reason = NULL WHERE status = 'quarantined' AND reason = 'unmatched_sender' AND from_domain = $1 AND raw_sealed IS NOT NULL RETURNING id`, [b.domain]);
      for (const { id } of ids) await enqueue(c, { type: 'offers.inbox_parse', payload: { inboxMessageId: id }, idempotencyKey: `offers.inbox_parse:${id}:attach:${now.getTime()}`, now });
      return { provider: camel(after!), requeued: ids.length };
    });
  });
}
