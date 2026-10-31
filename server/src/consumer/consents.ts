import type { Queryable } from '../db.js';
import { one } from '../db.js';

/**
 * Consent state machine v2. consent_records is an append-only log: each row is a grant or a withdrawal of one
 * purpose with its policy version, scope and source. A withdrawal sets revoked_at on the open grant (DB trigger).
 * State per purpose: none -> granted -> revoked -> granted ...
 */
export const CONSENT_PURPOSES_V2 = [
  'account',
  'gmail',
  'forwarding',
  'documents',
  'reminders_email',
  'reminders_push',
  'analytics',
  'offer_personalisation',
  'household',
  'sync_backup',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES_V2)[number];

/** Names used before v2; accepted on input and mapped. */
export const LEGACY_PURPOSES: Record<string, ConsentPurpose> = {
  email_intake: 'forwarding',
  document_parsing: 'documents',
  telemetry: 'analytics',
};
export const ACCEPTED_PURPOSES = [...CONSENT_PURPOSES_V2, ...Object.keys(LEGACY_PURPOSES)] as [string, ...string[]];

export function canonicalPurpose(p: string): ConsentPurpose {
  return (LEGACY_PURPOSES[p] ?? p) as ConsentPurpose;
}

export type ConsentSource = 'app' | 'admin' | 'import' | 'system' | 'email_link' | 'oauth';

export type ConsentOwner = { accountId: string; tempSessionId?: null } | { accountId?: null; tempSessionId: string };

export interface ConsentInput {
  purpose: string;
  granted: boolean;
  policyVersion: string;
  scope?: Record<string, unknown>;
  source?: ConsentSource;
}

export async function recordConsentV2(q: Queryable, owner: ConsentOwner, input: ConsentInput, now: Date): Promise<void> {
  await q.query(
    `INSERT INTO consent_records (account_id, temp_session_id, purpose, granted, text_version, policy_version, scope, source, at)
     VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8)`,
    [
      owner.accountId ?? null,
      owner.tempSessionId ?? null,
      canonicalPurpose(input.purpose),
      input.granted,
      input.policyVersion,
      JSON.stringify(input.scope ?? {}),
      input.source ?? 'app',
      now,
    ],
  );
}

export type ConsentState = 'none' | 'granted' | 'revoked';

export async function consentState(q: Queryable, accountId: string, purpose: string): Promise<{ state: ConsentState; policyVersion: string | null; at: Date | null }> {
  const r = await one<{ granted: boolean; policy_version: string; at: Date }>(
    q,
    'SELECT granted, policy_version, at FROM consent_records WHERE account_id = $1 AND purpose = $2 ORDER BY at DESC, id DESC LIMIT 1',
    [accountId, canonicalPurpose(purpose)],
  );
  if (!r) return { state: 'none', policyVersion: null, at: null };
  return { state: r.granted ? 'granted' : 'revoked', policyVersion: r.policy_version, at: r.at };
}

/**
 * True when the account's most recent consent record for `purpose` is a withdrawal.
 * No record at all is not a withdrawal (use hasConsent where explicit opt-in is required).
 */
export async function consentWithdrawn(q: Queryable, accountId: string, purpose: string): Promise<boolean> {
  return (await consentState(q, accountId, purpose)).state === 'revoked';
}

/** True only with an explicit, unrevoked grant. */
export async function hasConsent(q: Queryable, accountId: string, purpose: string): Promise<boolean> {
  return (await consentState(q, accountId, purpose)).state === 'granted';
}
