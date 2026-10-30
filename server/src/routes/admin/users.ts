import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createAlert } from '../../alerts.js';
import { writeAudit } from '../../audit.js';
import { roleLevel, type Role } from '../../auth/roles.js';
import { revokeUserSessions } from '../../auth/sessions.js';
import { addMinutes } from '../../clock.js';
import { many, one, withTransaction, type PoolClient } from '../../db.js';
import { actorOf, currentUser, requireRole } from '../../http/context.js';
import { AppError, badRequest, conflict, forbidden, notFound, parse } from '../../http/errors.js';
import { camel, camelAll, randomToken, sha256 } from '../../util.js';
import { count, paging, uuidParam } from './helpers.js';

const USER_COLS = 'id, email, name, role, status, created_at, last_login_at, (password_hash IS NOT NULL) AS has_password';
const SETUP_LINK_HOURS = 72;
const RESET_LINK_HOURS = 24;

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: string;
}

function baseUrl(app: FastifyInstance, req: FastifyRequest): string {
  return app.deps.config.publicBaseUrl ?? `${req.protocol}://${req.host}`;
}

/** Only an owner may act on an owner or grant the owner role. */
function assertCanManage(actorRole: Role, target: { role: Role }, newRole?: Role): void {
  if (target.role === 'owner' && actorRole !== 'owner') throw forbidden('Only an owner can change an owner account');
  if (newRole && roleLevel(newRole) > roleLevel(actorRole)) throw forbidden('You cannot grant a role above your own');
}

async function issueLink(
  app: FastifyInstance,
  req: FastifyRequest,
  c: PoolClient,
  user: UserRow,
  kind: 'setup' | 'reset',
): Promise<{ link: string; expiresAt: Date; emailed: boolean }> {
  const now = app.deps.clock();
  const token = randomToken(32);
  const expiresAt = addMinutes(now, (kind === 'setup' ? SETUP_LINK_HOURS : RESET_LINK_HOURS) * 60);
  // Older unused links for this user stop working.
  await c.query('UPDATE password_resets SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [user.id, now]);
  await c.query(
    'INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at) VALUES ($1,$2,$3,$4,$5)',
    [sha256(token), user.id, currentUser(req).id, now, expiresAt],
  );
  const link = `${baseUrl(app, req)}/admin/reset-password?token=${encodeURIComponent(token)}${kind === 'setup' ? '&setup=1' : ''}`;
  let emailed = false;
  if (app.deps.mailer) {
    try {
      await app.deps.mailer.send(
        [user.email],
        kind === 'setup' ? 'Set up your Due admin account' : 'Reset your Due admin password',
        `Use this one-time link to set your password (expires ${expiresAt.toISOString()}):\n\n${link}\n\nIf you did not expect this, ignore this email.`,
      );
      emailed = true;
    } catch (err) {
      req.log.error({ err }, 'failed to email one-time link');
    }
  }
  await createAlert(
    c,
    {
      level: 'info',
      title: `${kind === 'setup' ? 'Setup' : 'Password reset'} link issued for ${user.email}`,
      body: `Issued by ${currentUser(req).email}; expires ${expiresAt.toISOString()}. ${emailed ? 'Emailed to the user.' : 'Not emailed (SMTP not configured): share the link with the user directly.'}`,
      entityType: 'user',
      entityId: user.id,
    },
    null,
  );
  return { link, expiresAt, emailed };
}

export async function userRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const admin = { preHandler: requireRole('admin') };

  app.get('/users', admin, async () => {
    const rows = await many(pool, `SELECT ${USER_COLS} FROM users ORDER BY created_at`);
    return { items: camelAll(rows), total: rows.length };
  });

  app.post('/users', admin, async (req, reply) => {
    const body = parse(
      z
        .object({
          email: z.string().trim().toLowerCase().email().max(254),
          name: z.string().trim().min(1).max(120),
          role: z.enum(['owner', 'admin', 'editor', 'viewer']),
        })
        .strict(),
      req.body,
    );
    const actor = currentUser(req);
    if (roleLevel(body.role) > roleLevel(actor.role)) throw forbidden('You cannot grant a role above your own');
    const out = await withTransaction(pool, async (c) => {
      const exists = await one(c, 'SELECT id FROM users WHERE email = $1', [body.email]);
      if (exists) throw conflict('A user with that email exists');
      const user = (await one<UserRow>(
        c,
        `INSERT INTO users (email, name, role, status, created_at) VALUES ($1,$2,$3,'active',$4) RETURNING ${USER_COLS}`,
        [body.email, body.name, body.role, clock()],
      ))!;
      const link = await issueLink(app, req, c, user, 'setup');
      await writeAudit(c, actorOf(req), 'user.create', 'user', user.id, null, user);
      return { user, link };
    });
    return reply.code(201).send({
      user: camel(out.user),
      setupLink: out.link.link,
      expiresAt: out.link.expiresAt,
      emailed: out.link.emailed,
    });
  });

  app.patch('/users/:id', admin, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const body = parse(
      z
        .object({
          role: z.enum(['owner', 'admin', 'editor', 'viewer']).optional(),
          status: z.enum(['active', 'disabled']).optional(),
          name: z.string().trim().min(1).max(120).optional(),
        })
        .strict(),
      req.body,
    );
    const actor = currentUser(req);
    if (id === actor.id && (body.role !== undefined || body.status !== undefined)) {
      throw badRequest('You cannot change your own role or status');
    }
    const row = await withTransaction(pool, async (c) => {
      const before = await one<UserRow>(c, `SELECT ${USER_COLS} FROM users WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('User not found');
      assertCanManage(actor.role, before, body.role);
      const losingOwner = before.role === 'owner' && ((body.role && body.role !== 'owner') || body.status === 'disabled');
      if (losingOwner) {
        const owners = await count(c, `SELECT count(*) AS n FROM users WHERE role = 'owner' AND status = 'active' AND id <> $1`, [id]);
        if (owners === 0) throw new AppError(409, 'last_owner', 'At least one active owner must remain');
      }
      const after = await one<UserRow>(
        c,
        `UPDATE users SET role = COALESCE($2, role), status = COALESCE($3, status), name = COALESCE($4, name)
          WHERE id = $1 RETURNING ${USER_COLS}`,
        [id, body.role ?? null, body.status ?? null, body.name ?? null],
      );
      if (body.status === 'disabled' || (body.role && body.role !== before.role)) {
        await revokeUserSessions(c, id, clock());
      }
      await writeAudit(c, actorOf(req), 'user.update', 'user', id, before, after);
      return after!;
    });
    return camel(row);
  });

  app.post('/users/:id/reset-link', admin, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const actor = currentUser(req);
    const out = await withTransaction(pool, async (c) => {
      const user = await one<UserRow>(c, `SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
      if (!user) throw notFound('User not found');
      assertCanManage(actor.role, user);
      if (user.status !== 'active') throw badRequest('User is disabled');
      const link = await issueLink(app, req, c, user, 'reset');
      await writeAudit(c, actorOf(req), 'user.reset_link', 'user', id, null, { expiresAt: link.expiresAt, emailed: link.emailed });
      return link;
    });
    return { resetLink: out.link, expiresAt: out.expiresAt, emailed: out.emailed };
  });

  app.post('/users/:id/revoke-sessions', admin, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const actor = currentUser(req);
    const revoked = await withTransaction(pool, async (c) => {
      const user = await one<UserRow>(c, `SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
      if (!user) throw notFound('User not found');
      assertCanManage(actor.role, user);
      const n = await revokeUserSessions(c, id, clock());
      await writeAudit(c, actorOf(req), 'user.revoke_sessions', 'user', id, null, { revoked: n });
      return n;
    });
    return { revoked };
  });

  const loginEvents = async (req: FastifyRequest) => {
    const q = parse(paging.extend({ userId: z.string().uuid().optional() }), req.query);
    const total = await count(pool, 'SELECT count(*) AS n FROM login_events WHERE ($1::uuid IS NULL OR user_id = $1)', [q.userId ?? null]);
    const rows = await many(
      pool,
      'SELECT * FROM login_events WHERE ($1::uuid IS NULL OR user_id = $1) ORDER BY id DESC LIMIT $2 OFFSET $3',
      [q.userId ?? null, q.limit, q.offset],
    );
    return { items: camelAll(rows), total };
  };
  app.get('/login-events', admin, loginEvents);
  app.get('/users/login-events', admin, loginEvents);

  const sessions = async (req: FastifyRequest) => {
    const q = parse(paging.extend({ userId: z.string().uuid().optional() }), req.query);
    const rows = await many(
      pool,
      `SELECT u.id AS user_id, u.email, u.name, s.created_at, s.last_seen_at, s.expires_at, s.ip, s.user_agent,
              (s.id_hash = $4) AS current
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.revoked_at IS NULL AND s.expires_at > $1 AND ($2::uuid IS NULL OR s.user_id = $2)
        ORDER BY s.last_seen_at DESC LIMIT $3`,
      [clock(), q.userId ?? null, q.limit, req.sessionIdHash],
    );
    return { items: camelAll(rows), total: rows.length };
  };
  app.get('/sessions', admin, sessions);
  app.get('/users/sessions', admin, sessions);
}
