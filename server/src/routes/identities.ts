import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consumerAudit, currentAccount, requireAccount } from '../consumer/context.js';
import { one, withTransaction } from '../db.js';
import { disconnectIdentity } from '../gmail/service.js';
import { AppError, notFound, parse } from '../http/errors.js';
import {
  countIdentities,
  deleteIdentityData,
  getOwnedIdentity,
  identityView,
  listIdentities,
  MAX_IDENTITIES,
  type IdentityRow,
} from '../identities/service.js';
import { normaliseKeys } from '../util.js';

const email = z.string().trim().toLowerCase().email().max(254);
const label = z.string().trim().max(80);
const senderFilter = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-z0-9._%+-]+@)?[a-z0-9.-]+\.[a-z]{2,}$/, 'Use a domain (netflix.com) or an address');

/**
 * Email identities of the signed-in Due account. Records are linked only to the authenticated account;
 * identities are never merged by sender address. Gmail identities are created through OAuth only.
 */
export async function identitiesRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;

  app.get('/api/account/identities', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    return { items: (await listIdentities(pool, a.id)).map(identityView), max: MAX_IDENTITIES };
  });

  app.post('/api/account/identities', { preHandler: requireAccount, config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const a = currentAccount(req);
    const body = parse(
      z
        .object({
          kind: z.enum(['work', 'family', 'forwarding']),
          label: label.default(''),
          email,
          consentVersion: z.string().trim().min(1).max(64).optional(),
        })
        .strict(),
      normaliseKeys(req.body),
    );
    const now = clock();
    const row = await withTransaction(pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(724190020, hashtext($1))', [a.id]);
      if ((await countIdentities(c, a.id)) >= MAX_IDENTITIES) {
        throw new AppError(409, 'identity_limit', `Up to ${MAX_IDENTITIES} email identities per account`);
      }
      const r = await one<IdentityRow>(
        c,
        `INSERT INTO email_identities (account_id, kind, label, email, status, consent_version, consented_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$7) ON CONFLICT (account_id, kind, email) DO NOTHING RETURNING *`,
        [a.id, body.kind, body.label, body.email, body.consentVersion ?? null, body.consentVersion ? now : null, now],
      );
      if (!r) throw new AppError(409, 'identity_exists', 'This email is already added as that kind of identity');
      await consumerAudit(c, a.id, 'identity.create', 'email_identity', r.id, null, { kind: r.kind }, now);
      return r;
    });
    return reply.code(201).send({ identity: identityView(row) });
  });

  app.patch('/api/account/identities/:id', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const { id } = req.params as { id: string };
    const body = parse(
      z
        .object({
          label: label.optional(),
          status: z.enum(['active', 'paused']).optional(),
          attachmentsEnabled: z.boolean().optional(),
          senderFilters: z.array(senderFilter).max(20).optional(),
        })
        .strict(),
      normaliseKeys(req.body),
    );
    const now = clock();
    const row = await withTransaction(pool, async (c) => {
      const cur = await getOwnedIdentity(c, a.id, id, true);
      if (!cur) throw notFound('Identity not found');
      if (body.status && (cur.status === 'disconnected' || cur.status === 'error')) {
        throw new AppError(409, 'reconnect_required', 'Reconnect this identity before changing its status', { status: cur.status, reason: cur.status_reason });
      }
      if (cur.kind !== 'gmail' && (body.attachmentsEnabled !== undefined || body.senderFilters !== undefined)) {
        throw new AppError(400, 'not_gmail', 'Attachment and sender settings apply to Gmail identities only');
      }
      const r = (await one<IdentityRow>(
        c,
        `UPDATE email_identities SET label = COALESCE($3, label), status = COALESCE($4, status),
           attachments_enabled = COALESCE($5, attachments_enabled), sender_filters = COALESCE($6, sender_filters),
           status_reason = CASE WHEN $4::text IS NULL THEN status_reason ELSE NULL END, updated_at = $7
          WHERE id = $1 AND account_id = $2 RETURNING *`,
        [id, a.id, body.label ?? null, body.status ?? null, body.attachmentsEnabled ?? null, body.senderFilters ? [...new Set(body.senderFilters)] : null, now],
      ))!;
      await consumerAudit(c, a.id, 'identity.update', 'email_identity', id, null, { fields: Object.keys(body) }, now);
      return r;
    });
    return { identity: identityView(row) };
  });

  app.delete('/api/account/identities/:id', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const { id } = req.params as { id: string };
    const q = parse(z.object({ deleteData: z.enum(['true', 'false']).default('false') }), req.query);
    const deleteData = q.deleteData === 'true';
    const now = clock();
    const cur = await getOwnedIdentity(pool, a.id, id);
    if (!cur) throw notFound('Identity not found');
    if (cur.kind === 'gmail') {
      const r = await disconnectIdentity(app.deps, a.id, id, { deleteImported: deleteData, removeIdentity: true });
      await consumerAudit(pool, a.id, 'identity.delete', 'email_identity', id, { kind: cur.kind }, { deleteData, revoked: r.revoked }, now);
      return { ok: true, revoked: r.revoked, deleted: r.deleted };
    }
    const deleted = await withTransaction(pool, async (c) => {
      const d = await deleteIdentityData(c, a.id, id, deleteData);
      await c.query('DELETE FROM email_identities WHERE id = $1 AND account_id = $2', [id, a.id]);
      await consumerAudit(c, a.id, 'identity.delete', 'email_identity', id, { kind: cur.kind }, { deleteData }, now);
      return d;
    });
    return { ok: true, revoked: true, deleted };
  });
}
