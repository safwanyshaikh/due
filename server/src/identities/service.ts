import type { Queryable } from '../db.js';
import { many, one } from '../db.js';

export const IDENTITY_KINDS = ['gmail', 'work', 'family', 'forwarding'] as const;
export type IdentityKind = (typeof IDENTITY_KINDS)[number];
export type IdentityStatus = 'active' | 'paused' | 'disconnected' | 'error';
/** Maximum identities per Due account (all kinds). */
export const MAX_IDENTITIES = 10;

export interface IdentityRow {
  id: string;
  account_id: string;
  kind: IdentityKind;
  label: string;
  email: string;
  status: IdentityStatus;
  status_reason: string | null;
  consent_version: string | null;
  consented_at: Date | null;
  revoked_at: Date | null;
  attachments_enabled: boolean;
  sender_filters: string[];
  last_scan_at: Date | null;
  last_scan_status: 'ok' | 'error' | 'cancelled' | null;
  last_scan_error_code: string | null;
  scan_running_since: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** API view (contract: id, kind, label, email, status, consentVersion, lastScanAt, lastScanStatus, createdAt). */
export function identityView(r: IdentityRow & { scopes?: string[] | null }) {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    email: r.email,
    status: r.status,
    statusReason: r.status_reason,
    consentVersion: r.consent_version,
    consentedAt: r.consented_at,
    revokedAt: r.revoked_at,
    attachmentsEnabled: r.attachments_enabled,
    senderFilters: r.sender_filters,
    lastScanAt: r.last_scan_at,
    lastScanStatus: r.last_scan_status,
    lastScanErrorCode: r.last_scan_error_code,
    scanning: r.scan_running_since !== null,
    ...(r.kind === 'gmail' ? { scopes: r.scopes ?? [] } : {}),
    createdAt: r.created_at,
  };
}

/** Lists one account's identities. Every query is scoped by the authenticated account id. */
export async function listIdentities(q: Queryable, accountId: string) {
  return many<IdentityRow & { scopes: string[] | null }>(
    q,
    `SELECT i.*, c.scopes FROM email_identities i LEFT JOIN gmail_connections c ON c.identity_id = i.id
      WHERE i.account_id = $1 ORDER BY i.created_at, i.id`,
    [accountId],
  );
}

/** Loads an identity only if it belongs to `accountId` (another account's id reads as not found). */
export async function getOwnedIdentity(q: Queryable, accountId: string, id: string, lock = false): Promise<IdentityRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one<IdentityRow>(q, `SELECT * FROM email_identities WHERE id = $1 AND account_id = $2${lock ? ' FOR UPDATE' : ''}`, [id, accountId]);
}

export async function countIdentities(q: Queryable, accountId: string): Promise<number> {
  const r = await one<{ n: number }>(q, 'SELECT count(*)::int AS n FROM email_identities WHERE account_id = $1', [accountId]);
  return r?.n ?? 0;
}

/**
 * Removes data derived from one identity: its Gmail seen-ids and, when `deleteEvents`, the review
 * candidates it produced (offer matches cascade). Other identities' and other intake records are untouched.
 */
export async function deleteIdentityData(q: Queryable, accountId: string, identityId: string, deleteEvents: boolean): Promise<{ events: number; seen: number }> {
  const seen = await q.query('DELETE FROM gmail_messages_seen WHERE identity_id = $1', [identityId]);
  let events = 0;
  if (deleteEvents) {
    const r = await q.query('DELETE FROM user_events WHERE identity_id = $1 AND account_id = $2', [identityId, accountId]);
    events = r.rowCount ?? 0;
  }
  return { events, seen: seen.rowCount ?? 0 };
}
