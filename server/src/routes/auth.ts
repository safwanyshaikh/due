import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { getDummyHash, hashPassword, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, verifyPassword } from '../auth/password.js';
import type { Role } from '../auth/roles.js';
import { createSession, revokeSession, revokeUserSessions, SESSION_COOKIE } from '../auth/sessions.js';
import {
  decryptTotpSecret,
  encryptTotpSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normaliseRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from '../auth/totp.js';
import { addMinutes } from '../clock.js';
import { one, withTransaction, type Queryable } from '../db.js';
import { cookieName } from '../http/cookies.js';
import { actorOf, currentUser, requireFreshMfa } from '../http/context.js';
import { AppError, badRequest, forbidden, parse, unauthorized } from '../http/errors.js';
import { hmacSha256, normaliseKeys, randomToken, safeEqual, sha256 } from '../util.js';

const password = z.string().min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`).max(PASSWORD_MAX_LENGTH);
const email = z.string().trim().toLowerCase().email().max(254);
const code = z.string().trim().min(6).max(40);

export const LOGIN_WINDOW_MINUTES = 15;
/** Failed attempts per IP + email in 15 minutes. */
export const LOGIN_MAX_ATTEMPTS = 10;
/** Failed attempts (password or second step) per email from any IP in an hour (L10). */
export const LOGIN_MAX_PER_EMAIL_HOUR = 20;
/** Failed attempts per IP across all emails in 15 minutes (credential stuffing). */
export const LOGIN_MAX_PER_IP = 50;
export const MFA_CHALLENGE_MINUTES = 5;
export const MFA_CHALLENGE_ATTEMPTS = 5;
export const TOTP_ISSUER = 'Due Admin';

export function adminCookieName(app: FastifyInstance): string {
  return cookieName(SESSION_COOKIE, app.deps.config.isProduction);
}

export function setSessionCookie(app: FastifyInstance, reply: FastifyReply, token: string): void {
  reply.setCookie(adminCookieName(app), token, {
    path: '/',
    httpOnly: true,
    secure: app.deps.config.isProduction,
    sameSite: 'strict',
    maxAge: Math.floor(app.deps.config.sessionMaxMs / 1000),
  });
  // A cookie from before the __Host- prefix is dropped (it is no longer read).
  if (app.deps.config.isProduction) reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

function clearSessionCookie(app: FastifyInstance, reply: FastifyReply): void {
  reply.clearCookie(adminCookieName(app), {
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

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: string;
  password_hash: string | null;
  totp_secret_enc: string | null;
  totp_enrolled_at: Date | null;
  totp_last_step: string | null;
}

const USER_SELECT = 'SELECT id, email, name, role, status, password_hash, totp_secret_enc, totp_enrolled_at, totp_last_step FROM users';

function publicUser(u: { id: string; email: string; name: string; role: Role }) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

export type SecondStep =
  | { status: 'mfa_required'; challengeToken: string; expiresInSeconds: number }
  | {
      status: 'enrol_required';
      challengeToken: string;
      expiresInSeconds: number;
      enrolment: { secret: string; otpauthUrl: string; qrSvg: string; issuer: string; account: string };
    };

function challengeHash(secret: string, token: string): string {
  return hmacSha256(secret, `admin-mfa:${token}`);
}

/**
 * After a correct password: no session yet. Returns a short-lived challenge for the TOTP step, or an enrolment
 * (new secret + QR) when the user has not set up an authenticator app yet. 2-step verification is mandatory.
 */
async function startSecondStep(app: FastifyInstance, q: Queryable, user: UserRow, now: Date, forceEnrol = false): Promise<SecondStep> {
  const { config } = app.deps;
  const token = randomToken(32);
  const expiresAt = addMinutes(now, MFA_CHALLENGE_MINUTES);
  // Only one open challenge per user.
  await q.query('UPDATE admin_mfa_challenges SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL', [user.id, now]);
  if (user.totp_enrolled_at && !forceEnrol) {
    await q.query(
      `INSERT INTO admin_mfa_challenges (token_hash, user_id, purpose, created_at, expires_at) VALUES ($1,$2,'verify',$3,$4)`,
      [challengeHash(config.sessionSecret, token), user.id, now, expiresAt],
    );
    return { status: 'mfa_required', challengeToken: token, expiresInSeconds: MFA_CHALLENGE_MINUTES * 60 };
  }
  const secret = generateTotpSecret();
  await q.query(
    `INSERT INTO admin_mfa_challenges (token_hash, user_id, purpose, pending_secret_enc, created_at, expires_at)
     VALUES ($1,$2,'enrol',$3,$4,$5)`,
    [challengeHash(config.sessionSecret, token), user.id, encryptTotpSecret(config.sessionSecret, secret), now, expiresAt],
  );
  const url = otpauthUrl(TOTP_ISSUER, user.email, secret);
  const qrSvg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
  return {
    status: 'enrol_required',
    challengeToken: token,
    expiresInSeconds: MFA_CHALLENGE_MINUTES * 60,
    enrolment: { secret, otpauthUrl: url, qrSvg, issuer: TOTP_ISSUER, account: user.email },
  };
}

/** Checks a TOTP code or an unused recovery code for `user`; records the step / marks the code used. */
async function checkSecondFactor(
  app: FastifyInstance,
  q: Queryable,
  user: UserRow,
  input: string,
  now: Date,
): Promise<{ ok: false } | { ok: true; via: 'totp' | 'recovery_code'; secretReadable: boolean }> {
  const secret = decryptTotpSecret(app.deps.config.sessionSecret, user.totp_secret_enc);
  const digits = input.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    if (!secret) return { ok: false };
    const step = verifyTotp(secret, digits, now, user.totp_last_step === null ? null : Number(user.totp_last_step));
    if (step === null) return { ok: false };
    // Conditional update: two concurrent requests with the same code cannot both pass.
    const r = await q.query('UPDATE users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)', [user.id, step]);
    return r.rowCount ? { ok: true, via: 'totp', secretReadable: true } : { ok: false };
  }
  if (!normaliseRecoveryCode(input)) return { ok: false };
  const r = await q.query(
    `UPDATE admin_recovery_codes SET used_at = $3
      WHERE id = (SELECT id FROM admin_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL LIMIT 1)
      RETURNING id`,
    [user.id, hashRecoveryCode(input), now],
  );
  return r.rowCount ? { ok: true, via: 'recovery_code', secretReadable: secret !== null } : { ok: false };
}

async function replaceRecoveryCodes(q: Queryable, userId: string, now: Date): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await q.query('DELETE FROM admin_recovery_codes WHERE user_id = $1', [userId]);
  for (const c of codes) {
    await q.query('INSERT INTO admin_recovery_codes (user_id, code_hash, created_at) VALUES ($1,$2,$3)', [userId, hashRecoveryCode(c), now]);
  }
  return codes;
}

async function recoveryCodesLeft(q: Queryable, userId: string): Promise<number> {
  return (await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM admin_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]))!.n;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock, config } = app.deps;

  const logEvent = (q: Queryable, req: FastifyRequest, emailAddr: string, userId: string | null, success: boolean, reason: string | null, now: Date) =>
    q.query(`INSERT INTO login_events (user_id, email, success, reason, ip, user_agent, at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
      userId,
      emailAddr,
      success,
      reason,
      req.ip,
      ua(req),
      now,
    ]);

  /**
   * Failed-attempt limits, counted from login_events: per IP + email (15 min), per email from any IP (1 h) and
   * per IP across emails (15 min). Rotating IPs (or a spoofed X-Forwarded-For) does not reset the per-email cap.
   */
  async function assertNotThrottled(req: FastifyRequest, reply: FastifyReply, emailAddr: string, now: Date): Promise<void> {
    const r = (
      await pool.query<{ ip_email: number; email_hour: number; ip_any: number }>(
        `SELECT count(*) FILTER (WHERE email = $1 AND ip IS NOT DISTINCT FROM $2 AND at > $3)::int AS ip_email,
                count(*) FILTER (WHERE email = $1 AND at > $4)::int AS email_hour,
                count(*) FILTER (WHERE ip IS NOT DISTINCT FROM $2 AND at > $3)::int AS ip_any
           FROM login_events
          WHERE (email = $1 OR ip IS NOT DISTINCT FROM $2) AND at > $4 AND NOT success
            AND reason IS DISTINCT FROM 'rate_limited' AND reason NOT LIKE 'password_ok_%'`,
        [emailAddr, req.ip, addMinutes(now, -LOGIN_WINDOW_MINUTES), addMinutes(now, -60)],
      )
    ).rows[0]!;
    if (r.ip_email >= LOGIN_MAX_ATTEMPTS || r.email_hour >= LOGIN_MAX_PER_EMAIL_HOUR || r.ip_any >= LOGIN_MAX_PER_IP) {
      await logEvent(pool, req, emailAddr, null, false, 'rate_limited', now);
      reply.header('Retry-After', String((r.email_hour >= LOGIN_MAX_PER_EMAIL_HOUR ? 60 : LOGIN_WINDOW_MINUTES) * 60));
      throw new AppError(429, 'rate_limited', 'Too many sign-in attempts. Try again later.');
    }
  }

  app.post('/api/auth/setup', async (req, reply) => {
    const body = parse(
      z.object({ setupToken: z.string().min(1).max(512), email, name: z.string().trim().min(1).max(120), password }),
      normaliseKeys(req.body),
    );
    if (!config.adminSetupToken) throw new AppError(403, 'setup_disabled', 'Setup is not enabled on this server');
    if (!safeEqual(body.setupToken, config.adminSetupToken)) throw new AppError(403, 'setup_rejected', 'Invalid setup token');
    const hash = await hashPassword(body.password);
    const now = clock();
    const out = await withTransaction(pool, async (c) => {
      // Serialise concurrent setup attempts, then require an empty users table.
      await c.query('LOCK TABLE users IN EXCLUSIVE MODE');
      const count = (await c.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows[0]!.n;
      if (count > 0) throw new AppError(409, 'setup_complete', 'Setup has already been completed');
      const u = (
        await c.query<UserRow>(
          `INSERT INTO users (email, name, password_hash, role, status, created_at)
           VALUES ($1,$2,$3,'owner','active',$4) RETURNING id, email, name, role, status, password_hash, totp_secret_enc, totp_enrolled_at, totp_last_step`,
          [body.email, body.name, hash, now],
        )
      ).rows[0]!;
      await writeAudit(c, { userId: u.id, ip: req.ip }, 'auth.setup', 'user', u.id, null, publicUser(u));
      // No session until the owner has set up 2-step verification.
      return { user: u, step: await startSecondStep(app, c, u, now) };
    });
    return reply.code(201).send({ user: publicUser(out.user), ...out.step });
  });

  /** Step 1: email + password. Never opens a session: returns the second-step challenge. */
  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(z.object({ email, password: z.string().min(1).max(PASSWORD_MAX_LENGTH) }), normaliseKeys(req.body));
    const now = clock();
    await assertNotThrottled(req, reply, body.email, now);
    const user = await one<UserRow>(pool, `${USER_SELECT} WHERE email = $1`, [body.email]);
    const ok = await verifyPassword(body.password, user?.password_hash ?? (await getDummyHash()));
    if (!user || !user.password_hash || !ok) {
      await logEvent(pool, req, body.email, user?.id ?? null, false, !user ? 'unknown_user' : !user.password_hash ? 'no_password_set' : 'bad_password', now);
      throw unauthorized('Invalid email or password');
    }
    if (user.status !== 'active') {
      await logEvent(pool, req, body.email, user.id, false, 'disabled', now);
      throw unauthorized('Invalid email or password');
    }
    const step = await startSecondStep(app, pool, user, now);
    await logEvent(pool, req, body.email, user.id, false, step.status === 'mfa_required' ? 'password_ok_mfa_pending' : 'password_ok_enrol_pending', now);
    return step;
  });

  async function openChallenge(token: string, purpose: 'verify' | 'enrol', now: Date) {
    const ch = await one<{ user_id: string; purpose: string; pending_secret_enc: string | null; attempts: number }>(
      pool,
      `SELECT user_id, purpose, pending_secret_enc, attempts FROM admin_mfa_challenges
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2`,
      [challengeHash(config.sessionSecret, token), now],
    );
    if (!ch || ch.purpose !== purpose || ch.attempts >= MFA_CHALLENGE_ATTEMPTS) {
      throw new AppError(400, 'invalid_challenge', 'This sign-in step has expired. Enter your email and password again.');
    }
    const user = await one<UserRow>(pool, `${USER_SELECT} WHERE id = $1`, [ch.user_id]);
    if (!user || user.status !== 'active') throw new AppError(400, 'invalid_challenge', 'This sign-in step has expired. Enter your email and password again.');
    return { ch, user };
  }

  async function failChallenge(req: FastifyRequest, token: string, user: UserRow, now: Date, reason: string): Promise<never> {
    await pool.query(
      `UPDATE admin_mfa_challenges SET attempts = attempts + 1,
              used_at = CASE WHEN attempts + 1 >= $2 THEN $3 ELSE used_at END WHERE token_hash = $1`,
      [challengeHash(config.sessionSecret, token), MFA_CHALLENGE_ATTEMPTS, now],
    );
    await logEvent(pool, req, user.email, user.id, false, reason, now);
    throw unauthorized('That code did not work. Check the time on your phone and try again.');
  }

  /** Step 2: a code from the authenticator app (or a recovery code). Opens the session. */
  app.post('/api/auth/mfa', async (req, reply) => {
    const body = parse(z.object({ challengeToken: z.string().min(16).max(256), code }).strict(), normaliseKeys(req.body));
    const now = clock();
    const { user } = await openChallenge(body.challengeToken, 'verify', now);
    await assertNotThrottled(req, reply, user.email, now);
    const result = await withTransaction(pool, async (c) => {
      const check = await checkSecondFactor(app, c, user, body.code, now);
      if (!check.ok) return null;
      await c.query('UPDATE admin_mfa_challenges SET used_at = $2 WHERE token_hash = $1', [challengeHash(config.sessionSecret, body.challengeToken), now]);
      if (!check.secretReadable) {
        // The stored secret cannot be read any more (SESSION_SECRET rotated): a recovery code proves the
        // person, and they set up the authenticator app again before getting a session.
        await writeAudit(c, { userId: user.id, ip: req.ip }, 'auth.mfa_reenrol_required', 'user', user.id, null, { via: 'recovery_code' });
        return { reenrol: await startSecondStep(app, c, user, now, true) };
      }
      await logEvent(c, req, user.email, user.id, true, check.via === 'recovery_code' ? 'recovery_code' : null, now);
      await c.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [user.id, now]);
      if (check.via === 'recovery_code') await writeAudit(c, { userId: user.id, ip: req.ip }, 'auth.recovery_code_used', 'user', user.id, null, null);
      const s = await createSession(c, policy(app), user.id, now, req.ip, ua(req), now);
      return { session: s, via: check.via, left: await recoveryCodesLeft(c, user.id) };
    });
    if (!result) return failChallenge(req, body.challengeToken, user, now, 'bad_mfa');
    if ('reenrol' in result) return result.reenrol;
    setSessionCookie(app, reply, result.session.token);
    return { user: publicUser(user), via: result.via, recoveryCodesRemaining: result.left };
  });

  /** Step 2 for a user without an authenticator yet: confirm the first code, get recovery codes and a session. */
  app.post('/api/auth/mfa/enrol', async (req, reply) => {
    const body = parse(z.object({ challengeToken: z.string().min(16).max(256), code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') }).strict(), normaliseKeys(req.body));
    const now = clock();
    const { ch, user } = await openChallenge(body.challengeToken, 'enrol', now);
    await assertNotThrottled(req, reply, user.email, now);
    const secret = decryptTotpSecret(config.sessionSecret, ch.pending_secret_enc);
    const step = secret ? verifyTotp(secret, body.code, now, null) : null;
    if (!secret || step === null) return failChallenge(req, body.challengeToken, user, now, 'bad_mfa_enrol');
    const out = await withTransaction(pool, async (c) => {
      await c.query('UPDATE admin_mfa_challenges SET used_at = $2 WHERE token_hash = $1', [challengeHash(config.sessionSecret, body.challengeToken), now]);
      await c.query(
        'UPDATE users SET totp_secret_enc = $2, totp_enrolled_at = $3, totp_last_step = $4, last_login_at = $3 WHERE id = $1',
        [user.id, ch.pending_secret_enc, now, step],
      );
      const codes = await replaceRecoveryCodes(c, user.id, now);
      // Any session opened before this enrolment ends.
      await revokeUserSessions(c, user.id, now);
      await writeAudit(c, { userId: user.id, ip: req.ip }, 'auth.mfa_enrolled', 'user', user.id, null, { method: 'totp', recoveryCodes: codes.length });
      await logEvent(c, req, user.email, user.id, true, 'mfa_enrolled', now);
      const s = await createSession(c, policy(app), user.id, now, req.ip, ua(req), now);
      return { codes, session: s };
    });
    setSessionCookie(app, reply, out.session.token);
    return { user: publicUser(user), recoveryCodes: out.codes };
  });

  /** Re-authentication: a fresh code before owner/admin changes (valid for config.adminReauthMs). */
  app.post('/api/auth/reauth', async (req, reply) => {
    const u = currentUser(req);
    const body = parse(z.object({ code }).strict(), normaliseKeys(req.body));
    const now = clock();
    await assertNotThrottled(req, reply, u.email, now);
    const user = (await one<UserRow>(pool, `${USER_SELECT} WHERE id = $1`, [u.id]))!;
    const ok = await withTransaction(pool, async (c) => {
      const check = await checkSecondFactor(app, c, user, body.code, now);
      if (!check.ok) return false;
      await c.query('UPDATE sessions SET mfa_at = $2 WHERE id_hash = $1', [req.sessionIdHash, now]);
      if (check.via === 'recovery_code') await writeAudit(c, actorOf(req), 'auth.recovery_code_used', 'user', user.id, null, { for: 'reauth' });
      return true;
    });
    if (!ok) {
      await logEvent(pool, req, user.email, user.id, false, 'bad_reauth', now);
      throw unauthorized('That code did not work. Check the time on your phone and try again.');
    }
    return { ok: true, validForSeconds: Math.floor(config.adminReauthMs / 1000) };
  });

  /** New set of recovery codes (old ones stop working). Needs a fresh code. */
  app.post('/api/auth/recovery-codes', { preHandler: requireFreshMfa }, async (req) => {
    const u = currentUser(req);
    const now = clock();
    const codes = await withTransaction(pool, async (c) => {
      const out = await replaceRecoveryCodes(c, u.id, now);
      await writeAudit(c, actorOf(req), 'auth.recovery_codes_regenerated', 'user', u.id, null, { count: out.length });
      return out;
    });
    return { recoveryCodes: codes };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sessionIdHash) await revokeSession(pool, req.sessionIdHash, clock());
    clearSessionCookie(app, reply);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const u = currentUser(req);
    const now = clock().getTime();
    const fresh = req.sessionMfaAt ? req.sessionMfaAt.getTime() + config.adminReauthMs : 0;
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      mfaEnrolled: true,
      recoveryCodesRemaining: await recoveryCodesLeft(pool, u.id),
      reauthValidUntil: fresh > now ? new Date(fresh).toISOString() : null,
    };
  });

  app.post('/api/auth/change-password', { preHandler: requireFreshMfa }, async (req) => {
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

  /** One-time setup/reset link: sets the password, then continues with the second step (no session yet). */
  app.post('/api/auth/reset', async (req) => {
    const body = parse(z.object({ token: z.string().min(16).max(256), password }), req.body);
    const now = clock();
    const hash = await hashPassword(body.password);
    return withTransaction(pool, async (c) => {
      const r = await one<{ user_id: string }>(
        c,
        `SELECT user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 FOR UPDATE`,
        [sha256(body.token), now],
      );
      if (!r) throw new AppError(400, 'invalid_token', 'This link is invalid, expired or already used');
      const u = await one<UserRow>(c, `${USER_SELECT} WHERE id = $1`, [r.user_id]);
      if (!u || u.status !== 'active') throw new AppError(400, 'invalid_token', 'This account is disabled');
      await c.query('UPDATE password_resets SET used_at = $2 WHERE token_hash = $1', [sha256(body.token), now]);
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, hash]);
      await revokeUserSessions(c, u.id, now);
      await writeAudit(c, { userId: u.id, ip: req.ip }, 'auth.reset_password', 'user', u.id, null, { via: 'one_time_link' });
      return { user: publicUser(u), ...(await startSecondStep(app, c, u, now)) };
    });
  });
}
