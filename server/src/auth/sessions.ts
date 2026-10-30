import type { Queryable } from '../db.js';
import { hmacSha256, randomToken } from '../util.js';
import type { Role } from './roles.js';

export const SESSION_COOKIE = 'due_session';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface SessionPolicy {
  secret: string;
  idleMs: number;
  maxMs: number;
}

/** Session ids are stored only as a keyed SHA-256 hash of the cookie token. */
export function hashSessionToken(secret: string, token: string): string {
  return hmacSha256(secret, `session:${token}`);
}

export async function createSession(
  q: Queryable,
  policy: SessionPolicy,
  userId: string,
  now: Date,
  ip: string | null,
  userAgent: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Math.min(now.getTime() + policy.idleMs, now.getTime() + policy.maxMs));
  await q.query(
    `INSERT INTO sessions (id_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$3,$5,$6)`,
    [hashSessionToken(policy.secret, token), userId, now, expiresAt, ip, userAgent?.slice(0, 512) ?? null],
  );
  return { token, expiresAt };
}

/**
 * Resolves a session token to an active user. Enforces revoke, idle (12h) and absolute (7d) expiry,
 * and slides the idle window (written at most once a minute).
 */
export async function resolveSession(
  q: Queryable,
  policy: SessionPolicy,
  token: string,
  now: Date,
): Promise<{ user: AuthUser; idHash: string } | null> {
  const idHash = hashSessionToken(policy.secret, token);
  const r = await q.query<{
    user_id: string;
    created_at: Date;
    expires_at: Date;
    last_seen_at: Date;
    revoked_at: Date | null;
    email: string;
    name: string;
    role: Role;
    status: string;
  }>(
    `SELECT s.user_id, s.created_at, s.expires_at, s.last_seen_at, s.revoked_at, u.email, u.name, u.role, u.status
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $1`,
    [idHash],
  );
  const s = r.rows[0];
  if (!s || s.revoked_at || s.status !== 'active') return null;
  const t = now.getTime();
  if (t >= s.expires_at.getTime()) return null;
  if (t - s.last_seen_at.getTime() >= policy.idleMs) return null;
  if (t - s.created_at.getTime() >= policy.maxMs) return null;
  if (t - s.last_seen_at.getTime() > 60_000) {
    const expiresAt = new Date(Math.min(t + policy.idleMs, s.created_at.getTime() + policy.maxMs));
    await q.query('UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE id_hash = $1', [
      idHash,
      now,
      expiresAt,
    ]);
  }
  return { user: { id: s.user_id, email: s.email, name: s.name, role: s.role }, idHash };
}

export async function revokeSession(q: Queryable, idHash: string, now: Date): Promise<void> {
  await q.query('UPDATE sessions SET revoked_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL', [idHash, now]);
}

export async function revokeUserSessions(
  q: Queryable,
  userId: string,
  now: Date,
  exceptIdHash: string | null = null,
): Promise<number> {
  const r = await q.query(
    `UPDATE sessions SET revoked_at = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::text IS NULL OR id_hash <> $3)`,
    [userId, now, exceptIdHash],
  );
  return r.rowCount ?? 0;
}
