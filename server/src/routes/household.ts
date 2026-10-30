import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { addMinutes } from '../clock.js';
import { consumerAudit, currentAccount, entitlementOf, premiumRequired, requireAccount, requireFeature } from '../consumer/context.js';
import { computeEntitlement, getPlan } from '../consumer/entitlements.js';
import { hashInviteToken } from '../consumer/sessions.js';
import { many, one, withTransaction, type Queryable } from '../db.js';
import { AppError, forbidden, notFound, parse } from '../http/errors.js';
import { camelAll, normaliseKeys, randomToken } from '../util.js';
import {
  emailUnavailable,
  jsonBytes,
  MAX_SYNC_BYTES,
  payloadTooLarge,
  publicBase,
  readVersionedDoc,
  SyncDocument,
  writeVersionedDoc,
} from './account.js';

export const HOUSEHOLD_MAX_MEMBERS = 6;
const INVITE_TTL_DAYS = 7;
const email = z.string().trim().toLowerCase().email().max(254);

interface Membership {
  household_id: string;
  role: 'owner' | 'member';
  name: string;
  owner_account_id: string;
  created_at: Date;
}

async function membershipOf(q: Queryable, accountId: string): Promise<Membership | null> {
  return one<Membership>(
    q,
    `SELECT m.household_id, m.role, h.name, h.owner_account_id, h.created_at FROM household_members m
       JOIN households h ON h.id = m.household_id WHERE m.account_id = $1 AND m.status = 'active'`,
    [accountId],
  );
}

async function requireMembership(req: FastifyRequest): Promise<Membership> {
  const m = await membershipOf(req.server.deps.pool, currentAccount(req).id);
  if (!m) throw new AppError(404, 'no_household', 'You are not in a household');
  return m;
}

async function members(q: Queryable, householdId: string) {
  return camelAll(
    await many(
      q,
      `SELECT m.account_id, a.email, a.display_name, m.role, m.status, m.created_at FROM household_members m
         JOIN consumer_accounts a ON a.id = m.account_id WHERE m.household_id = $1 ORDER BY m.role DESC, m.created_at`,
      [householdId],
    ),
  );
}

/**
 * Household sharing (premium). The owner needs the 'household' plan; members get access through the owner's
 * entitlement. Shared data lives in household_data with the same optimistic concurrency as personal sync.
 */
export async function householdRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock, config } = app.deps;
  const feature = requireFeature('household_sharing');
  /** Household sharing is not sold (plan inactive) until it works end to end; every sharing route checks it. */
  const offered = async () => {
    if (!(await getPlan(pool, 'household'))?.active) {
      throw new AppError(403, 'plan_unavailable', 'Household sharing is not available yet');
    }
  };
  const gate = [requireAccount, offered, feature];

  app.get('/api/account/household', { preHandler: gate }, async (req) => {
    const m = await membershipOf(pool, currentAccount(req).id);
    if (!m) return { household: null };
    const invites =
      m.role === 'owner'
        ? camelAll(
            await many(
              pool,
              `SELECT email, created_at, expires_at FROM household_invites WHERE household_id = $1 AND used_at IS NULL AND expires_at > $2 ORDER BY created_at`,
              [m.household_id, clock()],
            ),
          )
        : [];
    return {
      household: { id: m.household_id, name: m.name, ownerAccountId: m.owner_account_id, createdAt: m.created_at },
      role: m.role,
      members: await members(pool, m.household_id),
      pendingInvites: invites,
    };
  });

  app.post('/api/account/household', { preHandler: gate }, async (req, reply) => {
    const a = currentAccount(req);
    const body = parse(z.object({ name: z.string().trim().min(1).max(80) }).strict(), normaliseKeys(req.body));
    const now = clock();
    const h = await withTransaction(pool, async (c) => {
      if (await membershipOf(c, a.id)) throw new AppError(409, 'already_in_household', 'You are already in a household');
      const row = (await one<{ id: string; name: string; created_at: Date }>(
        c,
        'INSERT INTO households (owner_account_id, name, created_at) VALUES ($1,$2,$3) RETURNING id, name, created_at',
        [a.id, body.name, now],
      ))!;
      await c.query(`INSERT INTO household_members (household_id, account_id, role, status, created_at) VALUES ($1,$2,'owner','active',$3)`, [
        row.id,
        a.id,
        now,
      ]);
      await consumerAudit(c, a.id, 'household.created', 'household', row.id, null, { name: body.name }, now);
      return row;
    });
    return reply.code(201).send({ household: { id: h.id, name: h.name, ownerAccountId: a.id, createdAt: h.created_at }, role: 'owner' });
  });

  // Deleting is allowed even after the plan lapses, so an owner can always clean up.
  app.delete('/api/account/household', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const m = await requireMembership(req);
    if (m.role !== 'owner') throw forbidden('Only the household owner can delete the household');
    await withTransaction(pool, async (c) => {
      await c.query('DELETE FROM households WHERE id = $1', [m.household_id]);
      await consumerAudit(c, a.id, 'household.deleted', 'household', m.household_id, { name: m.name }, null, clock());
    });
    return { ok: true };
  });

  app.post('/api/account/household/invites', { preHandler: gate }, async (req, reply) => {
    const a = currentAccount(req);
    const m = await requireMembership(req);
    if (m.role !== 'owner') throw forbidden('Only the household owner can invite members');
    const body = parse(z.object({ email }).strict(), normaliseKeys(req.body));
    const mailer = app.deps.mailer;
    if (!mailer) throw emailUnavailable();
    const base = publicBase(app, req);
    if (body.email === a.email) throw new AppError(400, 'bad_request', 'You are already in this household');
    const now = clock();
    const active = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM household_members WHERE household_id = $1 AND status = 'active'`, [m.household_id])).rows[0]!.n;
    const pending = (
      await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM household_invites WHERE household_id = $1 AND used_at IS NULL AND expires_at > $2', [
        m.household_id,
        now,
      ])
    ).rows[0]!.n;
    if (active + pending >= HOUSEHOLD_MAX_MEMBERS) throw new AppError(409, 'household_full', `A household can have up to ${HOUSEHOLD_MAX_MEMBERS} members`);
    const token = randomToken(32);
    const tokenHash = hashInviteToken(config.sessionSecret, token);
    const expiresAt = addMinutes(now, INVITE_TTL_DAYS * 1440);
    await pool.query('INSERT INTO household_invites (token_hash, household_id, email, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)', [
      tokenHash,
      m.household_id,
      body.email,
      now,
      expiresAt,
    ]);
    const link = `${base}/?household_invite=${encodeURIComponent(token)}`;
    try {
      await mailer.send(
        [body.email],
        `You're invited to share "${m.name}" on Due`,
        `${a.displayName ?? a.email} invited you to a shared household on Due.\n\nOpen this link and sign in with this email address to accept (expires in ${INVITE_TTL_DAYS} days):\n\n${link}\n\nIf you were not expecting this, ignore this email.\n`,
      );
    } catch (err) {
      req.log.error({ err }, 'household invite email failed');
      await pool.query('DELETE FROM household_invites WHERE token_hash = $1', [tokenHash]);
      throw new AppError(502, 'email_send_failed', 'We could not send the invitation email. Please try again later.');
    }
    await consumerAudit(pool, a.id, 'household.invited', 'household', m.household_id, null, { email: body.email }, now);
    return reply.code(201).send({ email: body.email, expiresAt });
  });

  // The invitee may be on the Free plan: access comes from the owner's household entitlement.
  app.post('/api/account/household/accept', { preHandler: [requireAccount, offered] }, async (req) => {
    const a = currentAccount(req);
    const body = parse(z.object({ token: z.string().min(16).max(256) }).strict(), normaliseKeys(req.body));
    const now = clock();
    const hh = await withTransaction(pool, async (c) => {
      const inv = await one<{ household_id: string; email: string }>(
        c,
        'SELECT household_id, email FROM household_invites WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE',
        [hashInviteToken(config.sessionSecret, body.token), now],
      );
      if (!inv) throw new AppError(400, 'invalid_token', 'This invitation is invalid, expired or already used');
      if (inv.email !== a.email) throw new AppError(403, 'invite_email_mismatch', 'Sign in with the email address the invitation was sent to');
      if (await membershipOf(c, a.id)) throw new AppError(409, 'already_in_household', 'You are already in a household');
      const h = (await one<{ id: string; name: string; owner_account_id: string; created_at: Date }>(c, 'SELECT * FROM households WHERE id = $1', [inv.household_id]))!;
      const ownerEnt = await computeEntitlement(c, h.owner_account_id, now);
      if (!ownerEnt.features.includes('household_sharing')) throw premiumRequired('household_sharing');
      await c.query('UPDATE household_invites SET used_at = $2 WHERE token_hash = $1', [hashInviteToken(config.sessionSecret, body.token), now]);
      await c.query(
        `INSERT INTO household_members (household_id, account_id, role, invited_email, status, created_at) VALUES ($1,$2,'member',$3,'active',$4)`,
        [h.id, a.id, inv.email, now],
      );
      await consumerAudit(c, a.id, 'household.joined', 'household', h.id, null, { role: 'member' }, now);
      return h;
    });
    req.entitlement = null;
    return { household: { id: hh.id, name: hh.name, ownerAccountId: hh.owner_account_id, createdAt: hh.created_at }, role: 'member' };
  });

  app.get('/api/account/household/members', { preHandler: gate }, async (req) => {
    const m = await requireMembership(req);
    return { items: await members(pool, m.household_id) };
  });

  // Owners remove members; members may remove themselves (leave). Allowed without entitlement.
  app.delete('/api/account/household/members/:accountId', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const { accountId } = parse(z.object({ accountId: z.string().uuid() }), req.params);
    const m = await requireMembership(req);
    if (m.role !== 'owner' && accountId !== a.id) throw forbidden('Only the household owner can remove other members');
    if (accountId === m.owner_account_id) throw new AppError(400, 'bad_request', 'The owner cannot be removed; delete the household instead');
    const r = await pool.query(`DELETE FROM household_members WHERE household_id = $1 AND account_id = $2 AND role = 'member'`, [m.household_id, accountId]);
    if (!r.rowCount) throw notFound('Member not found');
    await consumerAudit(pool, a.id, accountId === a.id ? 'household.left' : 'household.member_removed', 'household', m.household_id, { accountId }, null, clock());
    return { ok: true };
  });

  app.get('/api/account/household/data', { preHandler: gate }, async (req) => {
    const m = await requireMembership(req);
    return readVersionedDoc(pool, 'household_data', 'household_id', m.household_id);
  });

  app.put('/api/account/household/data', { preHandler: gate, bodyLimit: MAX_SYNC_BYTES + 512 * 1024 }, async (req) => {
    const a = currentAccount(req);
    const m = await requireMembership(req);
    await entitlementOf(req);
    const body = parse(z.object({ baseVersion: z.number().int().min(0), data: SyncDocument }).strict(), normaliseKeys(req.body));
    const bytes = jsonBytes(body.data);
    if (bytes > MAX_SYNC_BYTES) throw payloadTooLarge();
    const now = clock();
    const w = await withTransaction(pool, async (c) => {
      const out = await writeVersionedDoc(c, 'household_data', 'household_id', m.household_id, body.baseVersion, body.data, now, { updatedBy: a.id });
      await consumerAudit(c, a.id, 'household_data.updated', 'household_data', m.household_id, { version: out.beforeVersion }, { version: out.version, bytes }, now);
      return out;
    });
    return { version: w.version, updatedAt: w.updatedAt };
  });
}
