import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { getDummyHash, hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from '../auth/password.js';
import type { Role } from '../auth/roles.js';
import { createSession, revokeSession, revokeUserSessions, SESSION_COOKIE } from '../auth/sessions.js';
import { addMinutes } from '../clock.js';
import { one, withTransaction } from '../db.js';
import { actorOf, currentUser } from '../http/context.js';
import { AppError, badRequest, forbidden, parse, unauthorized } from '../http/errors.js';
import { normaliseKeys, safeEqual, sha256 } from '../util.js';

const password = z.string().min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`).max(PASSWORD_MAX_LENGTH);
const email = z.string().trim().toLowerCase().email().max(254);

export const LOGIN_WINDOW_MINUTES = 15;
export const LOGIN_MAX_ATTEMPTS = 10;

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    secure: app.deps.config.isProduction,
    sameSite: 'strict',
    maxAge: Math.floor(app.deps.config.sessionMaxMs / 1000),
  });
}

function clearSessionCookie(app: FastifyInstance, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    path: '/',
    httpOnly: true,
    secure: app.deps.config.isProduction,
    sameSite: 'strict',
  });
}

function policy(app: FastifyInstance) {
  const c = app.deps.config;
  return { secret: c.sessionSecret, idleMs: c.sessionIdleMs, maxMs: c.sessionMaxMs };
}

function ua(req: FastifyRequest): string | null {
  const v = req.headers['user-agent'];
  return typeof v === 'string' ? v.slice(0, 512) : null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock, config } = app.deps;

  app.post('/api/auth/setup', async (req, reply) => {
    const body = parse(
      z.object({ setupToken: z.string().min(1).max(512), email, name: z.string().trim().min(1).max(120), password }),
      normaliseKeys(req.body),
    );
    if (!config.adminSetupToken) throw new AppError(403, 'setup_disabled', 'Setup is not enabled on this server');
    if (!safeEqual(body.setupToken, config.adminSetupToken)) throw new AppError(403, 'setup_rejected', 'Invalid setup token');
    const hash = await hashPassword(body.password);
    const now = clock();
    const user = await withTransaction(pool, async (c) => {
      // Serialise concurrent setup attempts, then require an empty users table.
      await c.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const count = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0]!.n;
      if (count > 0) throw new AppError(409, 'setup_complete', 'Setup has already been completed');
      const u = (
        await c.query<{ id: string; email: string; name: string; role: Role }>(
          `INSERT INTO users (email, name, password_hash, role, status, created_at, last_login_at)
           VALUES ($1,$2,$3,'owner','active',$4,$4) RETURNING id, email, name, role`,
          [body.email, body.name, hash, now],
        )
      ).rows[0]!;
      await writeAudit(c, { userId: u.id, ip: req.ip }, 'auth.setup', 'user', u.id, null, u);
      return u;
    });
    const s = await createSession(pool, policy(app), user.id, now, req.ip, ua(req));
    setSessionCookie(app, reply, s.token);
    return reply.code(201).send({ user });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) }), normaliseKeys(req.body));
    const now = clock();
    const since = addMinutes(now, -LOGIN_WINDOW_MINUTES);
    const recent = (
      await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM login_events
          WHERE email = $1 AND ip IS NOT DISTINCT FROM $2 AND at > $3 AND NOT success AND reason <> 'rate_limited'`,
        [body.email, req.ip, since],
      )
    ).rows[0]!.n;
    const logEvent = (userId: string | null, success: boolean, reason: string | null) =>
      pool.query(
        `INSERT INTO login_events (user_id, email, success, reason, ip, user_agent, at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [userId, body.email, success, reason, req.ip, ua(req), now],
      );
    if (recent >= LOGIN_MAX_ATTEMPTS) {
      await logEvent(null, false, 'rate_limited');
      reply.header('Retry-After', String(LOGIN_WINDOW_MINUTES * 60));
      throw new AppError(429, 'rate_limited', 'Too many login attempts. Try again later.');
    }
    const user = await one<{ id: string; email: string; name: string; role: Role; status: string; password_hash: string | null }>(
      pool,
      'SELECT id, email, name, role, status, password_hash FROM users WHERE email = $1',
      [body.email],
    );
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !user.password_hash || !ok) {
      await logEvent(user?.id ?? null, false, !user ? 'unknown_user' : !user.password_hash ? 'no_password_set' : 'bad_password');
      throw unauthorized('Invalid email or password');
    }
    if (user.status !== 'active') {
      await logEvent(user.id, false, 'disabled');
      throw unauthorized('Invalid email or password');
    }
    await logEvent(user.id, true, null);
    await pool.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [user.id, now]);
    const s = await createSession(pool, policy(app), user.id, now, req.ip, ua(req));
    setSessionCookie(app, reply, s.token);
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionIdHash) await revokeSession(pool, req.sessionIdHash, clock());
    clearSessionCookie(app, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const u = currentUser(req);
    return { id: u.id, email: u.email, name: u.name, role: u.role };
  });

  app.post('/api/auth/change-password', async (req) => {
    const u = currentUser(req);
    const body = parse(z.object({ current: z.string().min(1).max(PASSWORD_MAX_LENGTH), next: password }), req.body);
    const row = await one<{ password_hash: string | null }>(pool, 'SELECT password_hash FROM users WHERE id = $1', [u.id]);
    if (!row?.password_hash || !(await verifyPassword(body.current, row.password_hash))) {
      throw forbidden('Current password is incorrect');
    }
    if (body.current === body.next) throw badRequest('New password must differ from the current one');
    const hash = await hashPassword(body.next);
    await withTransaction(pool, async (c) => {
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, hash]);
      await revokeUserSessions(c, u.id, clock(), req.sessionIdHash);
      await writeAudit(c, actorOf(req), 'auth.change_password', 'user', u.id, null, { revokedOtherSessions: true });
    });
    return { ok: true };
  });

  app.post('/api/auth/reset', async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(16).max(256), password }), req.body);
    const now = clock();
    const hash = await hashPassword(body.password);
    const user = await withTransaction(pool, async (c) => {
      const r = await one<{ user_id: string }>(
        c,
        `SELECT user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE`,
        [sha256(body.token), now],
      );
      if (!r) throw new AppError(400, 'invalid_token', 'This link is invalid, expired or already used');
      const u = await one<{ id: string; email: string; name: string; role: Role; status: string }>(
        c,
        'SELECT id, email, name, role, status FROM users WHERE id = $1',
        [r.user_id],
      );
      if (!u || u.status !== 'active') throw new AppError(400, 'invalid_token', 'This account is disabled');
      await c.query('UPDATE password_resets SET used_at = $2 WHERE token_hash = $1', [sha256(body.token), now]);
      await c.query('UPDATE users SET password_hash = $2, last_login_at = $3 WHERE id = $1', [u.id, hash, now]);
      await revokeUserSessions(c, u.id, now);
      await writeAudit(c, { userId: u.id, ip: req.ip }, 'auth.reset_password', 'user', u.id, null, { via: 'one_time_link' });
      return u;
    });
    const s = await createSession(pool, policy(app), user.id, now, req.ip, ua(req));
    setSessionCookie(app, reply, s.token);
    return { user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });
}
