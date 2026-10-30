import type { Queryable } from '../db.js';
import { hmacSha256, randomToken } from '../util.js';

export const ACCOUNT_COOKIE = 'due_acct';

export interface ConsumerAccount {
  id: string;
  email: string;
  displayName: string | null;
}

export interface AccountSessionPolicy {
  secret: string;
  idleMs: number;
  maxMs: number;
}

/** Consumer session ids are stored only as an HMAC of the cookie token (distinct prefix from admin sessions). */
export function hashAccountToken(secret: string, token: string): string {
  return hmacSha256(secret, `acct-session:${token}`);
}

export function hashMagicToken(secret: string, token: string): string {
  return hmacSha256(secret, `magic-link:${token}`);
}

export function hashInviteToken(secret: string, token: string): string {
  return hmacSha256(secret, `household-invite:${token}`);
}

/** Short human-readable device label from a User-Agent (best effort, never trusted for security). */
export function deviceLabelFromUa(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad|iOS/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown OS';
  return `${browser} on ${os}`;
}

export async function createAccountSession(
  q: Queryable,
  policy: AccountSessionPolicy,
  accountId: string,
  now: Date,
  meta: { ip: string | null; userAgent: string | null; deviceLabel: string | null },
): Promise<{ token: string; publicId: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Math.min(now.getTime() + policy.idleMs, now.getTime() + policy.maxMs));
  const r = await q.query<{ public_id: string }>(
    `INSERT INTO consumer_sessions (id_hash, account_id, device_label, user_agent, ip, created_at, last_seen_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7) RETURNING public_id`,
    [
      hashAccountToken(policy.secret, token),
      accountId,
      (meta.deviceLabel ?? deviceLabelFromUa(meta.userAgent)).slice(0, 80),
      meta.userAgent?.slice(0, 512) ?? null,
      meta.ip,
      now,
      expiresAt,
    ],
  );
  return { token, publicId: r.rows[0]!.public_id, expiresAt };
}

/** Resolves a consumer session: enforces revoke, idle (30d) and absolute (180d) expiry; slides the idle window. */
export async function resolveAccountSession(
  q: Queryable,
  policy: AccountSessionPolicy,
  token: string,
  now: Date,
): Promise<{ account: ConsumerAccount; idHash: string; publicId: string } | null> {
  const idHash = hashAccountToken(policy.secret, token);
  const r = await q.query<{
    public_id: string;
    account_id: string;
    created_at: Date;
    expires_at: Date;
    last_seen_at: Date;
    revoked_at: Date | null;
    email: string;
    display_name: string | null;
    status: string;
  }>(
    `SELECT s.public_id, s.account_id, s.created_at, s.expires_at, s.last_seen_at, s.revoked_at, a.email, a.display_name, a.status
       FROM consumer_sessions s JOIN consumer_accounts a ON a.id = s.account_id WHERE s.id_hash = $1`,
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
    await q.query('UPDATE consumer_sessions SET last_seen_at = $2, expires_at = $3 WHERE id_hash = $1', [idHash, now, expiresAt]);
  }
  return {
    account: { id: s.account_id, email: s.email, displayName: s.display_name },
    idHash,
    publicId: s.public_id,
  };
}
