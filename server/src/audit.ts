import type { Queryable } from './db.js';

export interface AuditActor {
  userId: string | null;
  ip: string | null;
}

const SECRET_KEYS = new Set(['password_hash', 'passwordHash', 'id_hash', 'token_hash']);

function scrub(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v.map(scrub);
  if (typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !SECRET_KEYS.has(k))
        .map(([k, x]) => [k, scrub(x)]),
    );
  }
  return v;
}

/** Writes one audit_log row. Secrets (password/token hashes) are never stored. */
export async function writeAudit(
  q: Queryable,
  actor: AuditActor,
  action: string,
  entityType: string,
  entityId: string | number | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  await q.query(
    `INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, before, after, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      actor.userId,
      action,
      entityType,
      entityId === null ? null : String(entityId),
      before === null || before === undefined ? null : JSON.stringify(scrub(before)),
      after === null || after === undefined ? null : JSON.stringify(scrub(after)),
      actor.ip,
    ],
  );
}
