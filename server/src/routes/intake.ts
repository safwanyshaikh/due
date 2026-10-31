import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ACCEPTED_PURPOSES, canonicalPurpose, LEGACY_PURPOSES, recordConsentV2 } from '../consumer/consents.js';
import { consumerAudit, currentAccount, entitlementOf, requireAccount, requireFeature } from '../consumer/context.js';
import { FREE_UPLOADS_PER_MONTH, guestUploadsUsed, takeAccountUpload, uploadLimitReached, uploadMonth } from '../consumer/uploads.js';
import { many, one, withTransaction, type Queryable } from '../db.js';
import { AppError, notFound, parse } from '../http/errors.js';
import { EXTRACTED_FIELD_KEYS, type ExtractedFields } from '../intake/parser.js';
import {
  claimTempSession,
  createAlias,
  createTempSession,
  eventView,
  ingest,
  INTAKE_COOKIE,
  liveAlias,
  matchOffers,
  MAX_EVENTS_PER_DAY,
  ownerWhere,
  TEMP_SESSION_TTL_MS,
  type AliasRow,
  type EventRow,
  type Owner,
} from '../intake/service.js';
import { camelAll, normaliseKeys } from '../util.js';

declare module 'fastify' {
  interface FastifyRequest {
    intakeSession: { id: string; expiresAt: Date } | null;
  }
}

/** Accepted on POST /api/account/consents: the v2 purposes plus legacy names (mapped). */
export const CONSENT_PURPOSES = ACCEPTED_PURPOSES;
const textVersion = z.string().trim().min(1).max(40);
const uuidParam = z.object({ id: z.string().uuid() });

/** Signed-in account wins; otherwise the temporary intake session. Never both. */
export function intakeOwner(req: FastifyRequest): Owner {
  if (req.account) return { kind: 'account', id: req.account.id };
  if (req.intakeSession) return { kind: 'temp', id: req.intakeSession.id };
  throw new AppError(401, 'unauthorized', 'Start a temporary intake session or sign in first');
}

/** Edits allowed on extracted fields (planning fields only). */
const FieldEdits = z
  .object({
    provider: z.string().trim().max(80).nullable(),
    service: z.string().trim().max(120).nullable(),
    commitmentType: z.string().trim().max(40).nullable(),
    amountInr: z.number().min(0).max(10_000_000).nullable(),
    billingCycle: z.enum(['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly']).nullable(),
    renewalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    trialEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    benefit: z.string().trim().max(200).nullable(),
    offerExpiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    referenceLabel: z.string().trim().max(80).nullable(),
  })
  .partial()
  .strict();

function aliasView(app: FastifyInstance, a: AliasRow | null) {
  const { inboundEmailDomain: domain, inboundWebhookSecret: secret } = app.deps.config;
  const live = Boolean(domain && secret);
  if (!a) return { alias: null, live };
  return {
    alias: a.alias,
    address: domain ? `${a.alias}@${domain}` : null,
    status: a.status,
    live,
    liveReason: live ? null : 'Email forwarding is not live on this server yet (inbound email is not configured).',
    createdAt: a.created_at,
  };
}

async function recordConsent(
  q: Queryable,
  owner: Owner,
  purpose: string,
  granted: boolean,
  version: string,
  now: Date,
  extra: { scope?: Record<string, unknown>; source?: 'app' | 'admin' | 'import' | 'system' | 'email_link' | 'oauth' } = {},
) {
  const who = owner.kind === 'account' ? { accountId: owner.id } : { tempSessionId: owner.id };
  await recordConsentV2(q, who, { purpose, granted, policyVersion: version, scope: extra.scope, source: extra.source }, now);
}

async function audit(q: Queryable, owner: Owner, action: string, entityId: string | null, before: unknown, after: unknown, now: Date) {
  // consumer_audit is account-scoped; temporary sessions are audited with a null account and the session id.
  await consumerAudit(q, owner.kind === 'account' ? owner.id : null, action, owner.kind === 'account' ? 'user_event' : 'temp_intake', entityId, before, after, now);
}

function setIntakeCookie(app: FastifyInstance, reply: FastifyReply, token: string): void {
  reply.setCookie(INTAKE_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: app.deps.config.isProduction,
    sameSite: 'lax',
    maxAge: Math.floor(TEMP_SESSION_TTL_MS / 1000),
  });
}

export async function intakeRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock, config } = app.deps;
  const key = () => config.dataEncryptionKey;

  async function ownedEvent(q: Queryable, owner: Owner, id: string, lock = false): Promise<EventRow> {
    const e = await one<EventRow>(q, `SELECT * FROM user_events WHERE id = $2 AND ${ownerWhere(owner, 1)}${lock ? ' FOR UPDATE' : ''}`, [owner.id, id]);
    // 404 (not 403) so other users' event ids are not confirmable.
    if (!e || e.review_status === 'deleted') throw notFound('Event not found');
    return e;
  }

  // ---- Temporary session + alias ---------------------------------------------------------------
  app.post('/api/intake/session', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    if (req.account) throw new AppError(409, 'signed_in', 'You are signed in; use your account forwarding address instead');
    const body = parse(z.object({ consentTextVersion: textVersion }).strict(), normaliseKeys(req.body));
    const now = clock();
    // Guest sessions keep manual entry, pasted text and documents only: forwarding needs a signed-in Plus account.
    const guestView = (expiresAt: Date) => ({
      sessionExpiresAt: expiresAt,
      alias: null,
      address: null,
      live: false,
      forwarding: 'sign_in_required' as const,
      allowedIntake: ['manual', 'shared_sms', 'document'],
    });
    if (req.intakeSession) return guestView(req.intakeSession.expiresAt);
    const s = await withTransaction(pool, async (c) => {
      const created = await createTempSession(c, config.sessionSecret, now);
      await recordConsent(c, { kind: 'temp', id: created.id }, 'documents', true, body.consentTextVersion, now, { scope: { guest: true } });
      return created;
    });
    setIntakeCookie(app, reply, s.token);
    return reply.code(201).send(guestView(s.expiresAt));
  });

  app.get('/api/intake/alias', async (req) => {
    const owner = intakeOwner(req);
    return aliasView(app, await liveAlias(pool, owner));
  });

  // Signed-in accounts create their alias explicitly, recording consent at the same time.
  // Forwarding is a Plus feature (server-side entitlement).
  app.post('/api/intake/alias', { preHandler: requireFeature('email_import') }, async (req, reply) => {
    const owner = intakeOwner(req);
    const body = parse(z.object({ consentTextVersion: textVersion }).strict(), normaliseKeys(req.body));
    const now = clock();
    const existing = await liveAlias(pool, owner);
    if (existing) return aliasView(app, existing);
    const a = await withTransaction(pool, async (c) => {
      await recordConsent(c, owner, 'forwarding', true, body.consentTextVersion, now);
      const row = await createAlias(c, owner, now);
      await audit(c, owner, 'intake.alias_created', row.id, null, { alias: row.alias }, now);
      return row;
    });
    return reply.code(201).send(aliasView(app, a));
  });

  app.post('/api/intake/alias/rotate', async (req) => {
    const owner = intakeOwner(req);
    const now = clock();
    const a = await withTransaction(pool, async (c) => {
      const cur = await liveAlias(c, owner);
      if (!cur) throw notFound('No forwarding address yet');
      await c.query(`UPDATE intake_aliases SET status = 'rotated', updated_at = $2 WHERE id = $1`, [cur.id, now]);
      const next = await createAlias(c, owner, now);
      if (cur.status === 'paused') await c.query(`UPDATE intake_aliases SET status = 'paused' WHERE id = $1`, [next.id]);
      await audit(c, owner, 'intake.alias_rotated', next.id, { alias: cur.alias }, { alias: next.alias }, now);
      return (await liveAlias(c, owner))!;
    });
    return aliasView(app, a);
  });

  for (const action of ['pause', 'resume'] as const) {
    app.post(`/api/intake/alias/${action}`, async (req) => {
      const owner = intakeOwner(req);
      const now = clock();
      const cur = await liveAlias(pool, owner);
      if (!cur) throw notFound('No forwarding address yet');
      const status = action === 'pause' ? 'paused' : 'active';
      await pool.query('UPDATE intake_aliases SET status = $2, updated_at = $3 WHERE id = $1', [cur.id, status, now]);
      await audit(pool, owner, `intake.alias_${action}d`, cur.id, { status: cur.status }, { status }, now);
      return aliasView(app, { ...cur, status });
    });
  }

  // ---- Events ----------------------------------------------------------------------------------
  app.get('/api/intake/events', async (req) => {
    const owner = intakeOwner(req);
    const q = parse(z.object({ status: z.enum(['needs_review', 'confirmed', 'ignored', 'unreadable']).optional() }), req.query);
    const rows = await many<EventRow>(
      pool,
      `SELECT * FROM user_events WHERE ${ownerWhere(owner, 1)} AND review_status <> 'deleted' AND ($2::text IS NULL OR review_status = $2)
        ORDER BY created_at DESC LIMIT 200`,
      [owner.id, q.status ?? null],
    );
    return { items: rows.map((r) => eventView(r, null)), rawStorage: key() ? 'encrypted' : 'disabled' };
  });

  // One shared SMS, pasted document text or manual fields (no broad SMS/inbox access).
  app.post('/api/intake/events', { bodyLimit: 512 * 1024 }, async (req, reply) => {
    const owner = intakeOwner(req);
    const body = parse(
      z
        .object({
          intakeType: z.enum(['shared_sms', 'document', 'manual']),
          text: z.string().max(100_000).optional(),
          subject: z.string().max(300).optional(),
          fields: FieldEdits.optional(),
        })
        .strict()
        .refine((b) => (b.text && b.text.trim()) || b.fields, 'Provide text or fields'),
      normaliseKeys(req.body),
    );
    const now = clock();
    // Same per-owner daily cap as forwarded email, so a temporary session cannot flood storage.
    const recent = (
      await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_events WHERE ${ownerWhere(owner, 1)} AND created_at > $2`, [
        owner.id,
        new Date(now.getTime() - 86_400_000),
      ])
    ).rows[0]!.n;
    if (recent >= MAX_EVENTS_PER_DAY) throw new AppError(429, 'quota_exceeded', 'Daily intake limit reached. Try again tomorrow.');
    const manual = body.fields ? (Object.fromEntries(Object.entries(body.fields).filter(([, v]) => v !== null && v !== undefined)) as ExtractedFields) : undefined;
    // Documents count against the monthly upload allowance (Free and guests: 5 a month, India time; Plus: unlimited),
    // the same allowance as POST /api/account/uploads/count. A duplicate submission is not counted.
    const isDocument = body.intakeType === 'document';
    const unlimited = isDocument && owner.kind === 'account' ? (await entitlementOf(req)).plan !== 'free' : false;
    const r = await withTransaction(pool, async (c) => {
      if (isDocument && owner.kind === 'temp' && (await guestUploadsUsed(c, owner.id, now)) >= FREE_UPLOADS_PER_MONTH) {
        throw uploadLimitReached(uploadMonth(now));
      }
      const out = await ingest(c, { owner, aliasId: null, intakeType: body.intakeType, text: body.text ?? '', subject: body.subject, manualFields: manual }, key(), now);
      if (isDocument && owner.kind === 'account' && !out.duplicate) {
        const count = await takeAccountUpload(c, owner.id, unlimited, now);
        // Throwing rolls back the inserted document as well.
        if (count === null) throw uploadLimitReached(uploadMonth(now));
      }
      return out;
    });
    return reply.code(r.duplicate ? 200 : 201).send({ duplicate: r.duplicate, event: eventView(r.event, null) });
  });

  app.get('/api/intake/events/:id', async (req) => {
    const owner = intakeOwner(req);
    const { id } = parse(uuidParam, req.params);
    const e = await ownedEvent(pool, owner, id);
    const matches = await many(
      pool,
      `SELECT m.offer_id, m.match_basis, m.eligibility_status, o.provider, o.name, o.computed_status, o.source_urls, o.last_confirmed_at, o.official_end_at
         FROM offer_matches m JOIN offers o ON o.id = m.offer_id WHERE m.user_event_id = $1`,
      [e.id],
    );
    return { event: eventView(e, key(), true), offerMatches: camelAll(matches) };
  });

  app.post('/api/intake/events/:id/confirm', async (req) => {
    const owner = intakeOwner(req);
    const { id } = parse(uuidParam, req.params);
    const now = clock();
    return withTransaction(pool, async (c) => {
      const e = await ownedEvent(c, owner, id, true);
      const after = (await one<EventRow>(c, `UPDATE user_events SET review_status = 'confirmed', updated_at = $2 WHERE id = $1 RETURNING *`, [e.id, now]))!;
      const matches = await matchOffers(c, owner, after, now);
      await audit(c, owner, 'intake.event_confirmed', e.id, { reviewStatus: e.review_status }, { reviewStatus: 'confirmed', offerMatches: matches.length }, now);
      return { event: eventView(after, null), offerMatches: matches };
    });
  });

  app.post('/api/intake/events/:id/ignore', async (req) => {
    const owner = intakeOwner(req);
    const { id } = parse(uuidParam, req.params);
    const now = clock();
    return withTransaction(pool, async (c) => {
      const e = await ownedEvent(c, owner, id, true);
      const after = (await one<EventRow>(c, `UPDATE user_events SET review_status = 'ignored', updated_at = $2 WHERE id = $1 RETURNING *`, [e.id, now]))!;
      await audit(c, owner, 'intake.event_ignored', e.id, { reviewStatus: e.review_status }, { reviewStatus: 'ignored' }, now);
      return { event: eventView(after, null) };
    });
  });

  app.patch('/api/intake/events/:id', async (req) => {
    const owner = intakeOwner(req);
    const { id } = parse(uuidParam, req.params);
    const body = parse(z.object({ fields: FieldEdits }).strict(), normaliseKeys(req.body));
    const now = clock();
    return withTransaction(pool, async (c) => {
      const e = await ownedEvent(c, owner, id, true);
      const fields: Record<string, unknown> = { ...e.extracted_fields };
      const confidence: Record<string, number> = { ...e.confidence };
      for (const [k, v] of Object.entries(body.fields)) {
        if (!(EXTRACTED_FIELD_KEYS as readonly string[]).includes(k)) continue;
        if (v === null) {
          delete fields[k];
          delete confidence[k];
        } else {
          fields[k] = v;
          confidence[k] = 1; // user-entered
        }
      }
      const status = e.review_status === 'unreadable' ? 'needs_review' : e.review_status;
      const after = (await one<EventRow>(
        c,
        'UPDATE user_events SET extracted_fields = $2, confidence = $3, review_status = $4, updated_at = $5 WHERE id = $1 RETURNING *',
        [e.id, JSON.stringify(fields), JSON.stringify(confidence), status, now],
      ))!;
      await audit(c, owner, 'intake.event_edited', e.id, { fields: e.extracted_fields }, { fields }, now);
      return { event: eventView(after, null) };
    });
  });

  app.delete('/api/intake/events/:id/raw', async (req) => {
    const owner = intakeOwner(req);
    const { id } = parse(uuidParam, req.params);
    const now = clock();
    const e = await ownedEvent(pool, owner, id);
    await pool.query('UPDATE user_events SET raw_text = NULL, raw_retention_until = NULL, updated_at = $2 WHERE id = $1', [e.id, now]);
    await audit(pool, owner, 'intake.raw_deleted', e.id, null, null, now);
    return { ok: true };
  });

  // Delete wipes content and keeps only an empty 'deleted' marker for the audit trail.
  app.delete('/api/intake/events/:id', async (req) => {
    const owner = intakeOwner(req);
    const { id } = parse(uuidParam, req.params);
    const now = clock();
    await withTransaction(pool, async (c) => {
      const e = await ownedEvent(c, owner, id, true);
      await c.query('DELETE FROM offer_matches WHERE user_event_id = $1', [e.id]);
      // A deliberately re-forwarded copy of a deleted message is accepted again.
      await c.query('UPDATE inbound_messages SET message_id_hash = NULL WHERE user_event_id = $1', [e.id]);
      await c.query(
        `UPDATE user_events SET review_status = 'deleted', raw_text = NULL, raw_retention_until = NULL, extracted_fields = '{}'::jsonb,
            confidence = '{}'::jsonb, source_domain = NULL, message_id_hash = NULL, updated_at = $2 WHERE id = $1`,
        [e.id, now],
      );
      await audit(c, owner, 'intake.event_deleted', e.id, null, null, now);
    });
    return { ok: true };
  });

  app.get('/api/intake/events/:id/export', async (req, reply) => {
    const owner = intakeOwner(req);
    const { id } = parse(uuidParam, req.params);
    const e = await ownedEvent(pool, owner, id);
    reply.header('Content-Disposition', `attachment; filename="due-intake-${e.id}.json"`);
    const v = eventView(e, null);
    return {
      format: 'due-intake-record/1',
      exportedAt: clock().toISOString(),
      record: {
        id: v.id,
        intakeType: v.intakeType,
        sourceDomain: v.sourceDomain,
        fields: v.extractedFields,
        confidence: v.confidence,
        reviewStatus: v.reviewStatus,
        parserVersion: v.parserVersion,
        createdAt: v.createdAt,
      },
    };
  });

  // ---- Claim + consents ------------------------------------------------------------------------
  app.post('/api/account/claim-intake', { preHandler: requireAccount }, async (req, reply) => {
    const a = currentAccount(req);
    if (!req.intakeSession) throw new AppError(400, 'no_intake_session', 'There is no temporary intake session on this device');
    const now = clock();
    const tempId = req.intakeSession.id;
    const r = await withTransaction(pool, async (c) => {
      const out = await claimTempSession(c, tempId, a.id, now);
      await consumerAudit(c, a.id, 'intake.claimed', 'temp_intake', tempId, null, out, now);
      return out;
    });
    reply.clearCookie(INTAKE_COOKIE, { path: '/', httpOnly: true, secure: config.isProduction, sameSite: 'lax' });
    return { ok: true, ...r, alias: aliasView(app, await liveAlias(pool, { kind: 'account', id: a.id })) };
  });

  app.post('/api/account/consents', async (req, reply) => {
    const owner = intakeOwner(req);
    const body = parse(
      z
        .object({
          purpose: z.enum(CONSENT_PURPOSES),
          granted: z.boolean(),
          textVersion: textVersion.optional(),
          policyVersion: textVersion.optional(),
          scope: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
        })
        .strict()
        .refine((b) => b.textVersion || b.policyVersion, 'policyVersion is required'),
      normaliseKeys(req.body),
    );
    const now = clock();
    const purpose = canonicalPurpose(body.purpose);
    await recordConsent(pool, owner, purpose, body.granted, (body.policyVersion ?? body.textVersion)!, now, { scope: body.scope });
    if (purpose === 'forwarding' && !body.granted) {
      // Withdrawing intake consent pauses forwarding immediately.
      await pool.query(`UPDATE intake_aliases SET status = 'paused', updated_at = $2 WHERE ${ownerWhere(owner, 1)} AND status = 'active'`, [owner.id, now]);
    }
    return reply.code(201).send({ ok: true, purpose, granted: body.granted, at: now });
  });

  app.get('/api/account/consents', async (req) => {
    const owner = intakeOwner(req);
    const rows = await many<{
      purpose: string;
      granted: boolean;
      text_version: string;
      policy_version: string;
      scope: Record<string, unknown>;
      source: string;
      granted_at: Date | null;
      revoked_at: Date | null;
      at: Date;
    }>(
      pool,
      `SELECT purpose, granted, text_version, policy_version, scope, source, granted_at, revoked_at, at FROM consent_records
        WHERE ${ownerWhere(owner, 1)} ORDER BY at DESC, id DESC`,
      [owner.id],
    );
    const current: Record<string, unknown> = {};
    for (const r of rows) {
      current[r.purpose] ??= {
        state: r.granted ? 'granted' : 'revoked',
        granted: r.granted,
        policyVersion: r.policy_version,
        textVersion: r.text_version,
        scope: r.scope,
        source: r.source,
        grantedAt: r.granted_at,
        revokedAt: r.revoked_at,
        at: r.at,
      };
    }
    // Legacy names mirror their v2 purpose for older clients.
    for (const [legacy, v2] of Object.entries(LEGACY_PURPOSES)) if (current[v2]) current[legacy] = current[v2];
    return { current, history: camelAll(rows) };
  });
}
