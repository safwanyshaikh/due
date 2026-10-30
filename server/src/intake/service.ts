import { randomBytes } from 'node:crypto';
import type { Clock } from '../clock.js';
import { addMinutes } from '../clock.js';
import type { Pool, Queryable } from '../db.js';
import { many, one } from '../db.js';
import { AppError } from '../http/errors.js';
import { hmacSha256, randomToken, sha256 } from '../util.js';
import { decryptText, encryptText } from './crypto.js';
import { parseMessage, TemplateRules, type ExtractedFields, type ParserTemplate } from './parser.js';

export const INTAKE_COOKIE = 'due_intake';
export const TEMP_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RAW_RETENTION_DAYS = 7;
export const MAX_EVENTS_PER_DAY = 100;
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** New aliases are 'u' + 12 base32 chars (60 bits); legacy 5-char aliases issued before go-live still route. */
export const ALIAS_RE = /^u(?:[a-z2-7]{12}|[a-z2-7]{5})$/;
export const ALIAS_LENGTH = 12;

export type Owner = { kind: 'account'; id: string } | { kind: 'temp'; id: string };

/** SQL predicate restricting rows to one owner. A temp session never sees rows that moved to an account. */
export function ownerWhere(owner: Owner, param: number, alias = ''): string {
  const p = alias ? `${alias}.` : '';
  return owner.kind === 'account' ? `${p}account_id = $${param}` : `${p}temp_session_id = $${param} AND ${p}account_id IS NULL`;
}

export function ownerCols(owner: Owner): { account_id: string | null; temp_session_id: string | null } {
  return owner.kind === 'account' ? { account_id: owner.id, temp_session_id: null } : { account_id: null, temp_session_id: owner.id };
}

export function hashIntakeToken(secret: string, token: string): string {
  return hmacSha256(secret, `intake-session:${token}`);
}

export function generateAlias(): string {
  // One random byte per character, 5 bits kept: 12 x 5 = 60 bits of entropy.
  const bytes = randomBytes(ALIAS_LENGTH);
  let s = 'u';
  for (const b of bytes) s += B32[b & 31];
  return s;
}

export async function createTempSession(q: Queryable, secret: string, now: Date): Promise<{ id: string; token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(now.getTime() + TEMP_SESSION_TTL_MS);
  const r = await q.query<{ id: string }>(
    'INSERT INTO intake_temp_sessions (id_hash, created_at, last_seen_at, expires_at) VALUES ($1,$2,$2,$3) RETURNING id',
    [hashIntakeToken(secret, token), now, expiresAt],
  );
  return { id: r.rows[0]!.id, token, expiresAt };
}

export async function resolveTempSession(q: Queryable, secret: string, token: string, now: Date): Promise<{ id: string; expiresAt: Date } | null> {
  const r = await one<{ id: string; expires_at: Date; claimed_at: Date | null }>(
    q,
    'SELECT id, expires_at, claimed_at FROM intake_temp_sessions WHERE id_hash = $1',
    [hashIntakeToken(secret, token)],
  );
  if (!r || r.claimed_at || r.expires_at.getTime() <= now.getTime()) return null;
  return { id: r.id, expiresAt: r.expires_at };
}

export interface AliasRow {
  id: string;
  alias: string;
  status: 'active' | 'paused' | 'rotated';
  created_at: Date;
  updated_at: Date;
}

export async function liveAlias(q: Queryable, owner: Owner): Promise<AliasRow | null> {
  return one<AliasRow>(q, `SELECT id, alias, status, created_at, updated_at FROM intake_aliases WHERE ${ownerWhere(owner, 1)} AND status <> 'rotated'`, [owner.id]);
}

/** Creates a unique alias (retries on the rare collision). */
export async function createAlias(q: Queryable, owner: Owner, now: Date): Promise<AliasRow> {
  const cols = ownerCols(owner);
  for (let i = 0; i < 8; i++) {
    const r = await q.query<AliasRow>(
      `INSERT INTO intake_aliases (alias, account_id, temp_session_id, status, created_at, updated_at) VALUES ($1,$2,$3,'active',$4,$4)
       ON CONFLICT (alias) DO NOTHING RETURNING id, alias, status, created_at, updated_at`,
      [generateAlias(), cols.account_id, cols.temp_session_id, now],
    );
    if (r.rows[0]) return r.rows[0];
  }
  throw new Error('Could not allocate a unique alias');
}

export async function activeTemplates(q: Queryable): Promise<ParserTemplate[]> {
  const rows = await many<ParserTemplate>(q, 'SELECT id, sender_domain, message_class, version, rules FROM provider_parser_templates WHERE active');
  return rows.filter((r) => TemplateRules.safeParse(r.rules).success);
}

export interface IngestInput {
  owner: Owner;
  aliasId: string | null;
  intakeType: 'forwarded_email' | 'document' | 'shared_sms' | 'manual';
  text: string;
  subject?: string | null;
  envelopeSenderDomain?: string | null;
  messageId?: string | null;
  manualFields?: ExtractedFields;
}

export interface EventRow {
  id: string;
  account_id: string | null;
  temp_session_id: string | null;
  intake_type: string;
  message_fingerprint: string | null;
  source_domain: string | null;
  extracted_fields: Record<string, unknown>;
  confidence: Record<string, number>;
  review_status: string;
  raw_text: string | null;
  raw_retention_until: Date | null;
  parser_version: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * Stores one private intake candidate. Dedupes per owner by Message-ID and normalised fingerprint
 * (deleted events are ignored for dedupe). Raw text is kept only encrypted, and only when a key exists.
 */
export async function ingest(q: Queryable, input: IngestInput, key: Buffer | null, now: Date): Promise<{ duplicate: boolean; event: EventRow }> {
  const templates = await activeTemplates(q);
  const parsed = parseMessage({ text: input.text, subject: input.subject, envelopeSenderDomain: input.envelopeSenderDomain }, templates);
  const messageIdHash = input.messageId ? sha256(input.messageId.trim().replace(/^<|>$/g, '').toLowerCase()) : null;
  await q.query('SELECT pg_advisory_xact_lock(724190010, hashtext($1))', [`${input.owner.kind}:${input.owner.id}`]);
  const dup = await one<EventRow>(
    q,
    `SELECT * FROM user_events WHERE ${ownerWhere(input.owner, 1)} AND review_status <> 'deleted'
       AND (message_fingerprint = $2 OR ($3::text IS NOT NULL AND message_id_hash = $3)) LIMIT 1`,
    [input.owner.id, parsed.fingerprint, messageIdHash],
  );
  if (dup) return { duplicate: true, event: dup };
  const fields = { ...parsed.fields, ...(input.manualFields ?? {}) };
  const confidence = { ...parsed.confidence };
  for (const k of Object.keys(input.manualFields ?? {})) confidence[k] = 1;
  const hasText = parsed.redactedText.trim().length > 0;
  const status = !hasText && !input.manualFields ? 'unreadable' : parsed.unreadable && !input.manualFields ? 'unreadable' : 'needs_review';
  const raw = key && hasText ? encryptText(key, parsed.redactedText) : null;
  const cols = ownerCols(input.owner);
  const event = (await one<EventRow>(
    q,
    `INSERT INTO user_events (account_id, temp_session_id, alias_id, intake_type, message_fingerprint, message_id_hash, source_domain,
        extracted_fields, confidence, review_status, raw_text, raw_retention_until, parser_version, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING *`,
    [
      cols.account_id,
      cols.temp_session_id,
      input.aliasId,
      input.intakeType,
      parsed.fingerprint,
      messageIdHash,
      parsed.sourceDomain,
      JSON.stringify(fields),
      JSON.stringify(confidence),
      status,
      raw,
      raw ? addMinutes(now, RAW_RETENTION_DAYS * 1440) : null,
      parsed.parserVersion,
      now,
    ],
  ))!;
  return { duplicate: false, event };
}

export function eventView(e: EventRow, key: Buffer | null, includeRaw = false) {
  let rawText: string | null | undefined;
  if (includeRaw) {
    rawText = null;
    if (e.raw_text && key) {
      try {
        rawText = decryptText(key, e.raw_text);
      } catch {
        rawText = null;
      }
    }
  }
  return {
    id: e.id,
    intakeType: e.intake_type,
    messageFingerprint: e.message_fingerprint,
    sourceDomain: e.source_domain,
    extractedFields: e.extracted_fields,
    confidence: e.confidence,
    reviewStatus: e.review_status,
    rawAvailable: e.raw_text !== null,
    rawRetentionUntil: e.raw_retention_until,
    parserVersion: e.parser_version,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    ...(includeRaw ? { rawText } : {}),
  };
}

/**
 * Links a confirmed event to matching public offers (same provider, case-insensitive). The match row is private
 * to the owner; the public offer is reused as-is and never receives user content.
 */
export async function matchOffers(q: Queryable, owner: Owner, e: EventRow, now: Date) {
  const provider = typeof e.extracted_fields.provider === 'string' ? e.extracted_fields.provider.trim() : '';
  if (!provider) return [];
  const offers = await many<{ id: string; provider: string; name: string; computed_status: string; source_urls: string[]; price_inr: number | null; billing_period: string | null; last_confirmed_at: Date | null; official_end_at: string | null }>(
    q,
    `SELECT id, provider, name, computed_status, source_urls, price_inr, billing_period, last_confirmed_at, official_end_at FROM offers
      WHERE lower(provider) = lower($1) AND verification_status <> 'rejected' ORDER BY id LIMIT 20`,
    [provider],
  );
  const cols = ownerCols(owner);
  for (const o of offers) {
    const amount = typeof e.extracted_fields.amountInr === 'number' ? e.extracted_fields.amountInr : null;
    await q.query(
      `INSERT INTO offer_matches (account_id, temp_session_id, user_event_id, offer_id, match_basis, created_at) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_event_id, offer_id) DO NOTHING`,
      [cols.account_id, cols.temp_session_id, e.id, o.id, JSON.stringify({ provider: true, price: amount !== null && o.price_inr !== null && Number(o.price_inr) === amount }), now],
    );
  }
  return offers.map((o) => ({
    offerId: o.id,
    provider: o.provider,
    name: o.name,
    computedStatus: o.computed_status,
    sourceUrls: o.source_urls,
    lastConfirmedAt: o.last_confirmed_at,
    officialEndAt: o.official_end_at,
    eligibility: 'unconfirmed',
    label: 'Possible benefit to verify',
  }));
}

/** Moves a temporary session's events, consents, matches and alias to an account. */
export async function claimTempSession(q: Queryable, tempId: string, accountId: string, now: Date) {
  const sess = await one<{ id: string; expires_at: Date; claimed_at: Date | null }>(q, 'SELECT id, expires_at, claimed_at FROM intake_temp_sessions WHERE id = $1 FOR UPDATE', [tempId]);
  if (!sess || sess.claimed_at || sess.expires_at.getTime() <= now.getTime()) {
    throw new AppError(400, 'intake_session_invalid', 'This temporary intake session has expired or was already claimed');
  }
  // Events the account already holds (same fingerprint) are not duplicated.
  const dropped = await q.query(
    `UPDATE user_events t SET review_status = 'deleted', raw_text = NULL, raw_retention_until = NULL, extracted_fields = '{}'::jsonb, confidence = '{}'::jsonb, updated_at = $3
      WHERE t.temp_session_id = $1 AND t.account_id IS NULL AND EXISTS (
        SELECT 1 FROM user_events a WHERE a.account_id = $2 AND a.review_status <> 'deleted' AND a.message_fingerprint = t.message_fingerprint)`,
    [tempId, accountId, now],
  );
  const moved = await q.query('UPDATE user_events SET account_id = $2, temp_session_id = NULL, updated_at = $3 WHERE temp_session_id = $1 AND account_id IS NULL', [tempId, accountId, now]);
  await q.query('UPDATE consent_records SET account_id = $2, temp_session_id = NULL WHERE temp_session_id = $1', [tempId, accountId]);
  await q.query('UPDATE offer_matches SET account_id = $2, temp_session_id = NULL WHERE temp_session_id = $1', [tempId, accountId]);
  const hasAlias = await liveAlias(q, { kind: 'account', id: accountId });
  let aliasTransferred = false;
  if (hasAlias) {
    await q.query(`UPDATE intake_aliases SET status = 'rotated', updated_at = $2 WHERE temp_session_id = $1 AND account_id IS NULL`, [tempId, now]);
  } else {
    const r = await q.query(`UPDATE intake_aliases SET account_id = $2, temp_session_id = NULL, updated_at = $3 WHERE temp_session_id = $1 AND status <> 'rotated'`, [
      tempId,
      accountId,
      now,
    ]);
    aliasTransferred = (r.rowCount ?? 0) > 0;
    await q.query(`UPDATE intake_aliases SET status = 'rotated', updated_at = $2 WHERE temp_session_id = $1 AND account_id IS NULL`, [tempId, now]);
  }
  await q.query('UPDATE intake_temp_sessions SET claimed_by = $2, claimed_at = $3 WHERE id = $1', [tempId, accountId, now]);
  return { moved: moved.rowCount ?? 0, duplicatesDropped: dropped.rowCount ?? 0, aliasTransferred };
}

/** The 'intake_purge' job: deletes raw text past retention and expired, unclaimed temporary sessions. */
export async function runIntakePurge(ctx: { pool: Pool; clock: Clock }): Promise<Record<string, number>> {
  const now = ctx.clock();
  const raw = await ctx.pool.query(
    'UPDATE user_events SET raw_text = NULL, raw_retention_until = NULL WHERE raw_text IS NOT NULL AND raw_retention_until <= $1',
    [now],
  );
  // Retire aliases first (kept as tombstones), then ON DELETE CASCADE removes events, consents and offer matches.
  await ctx.pool.query(
    `UPDATE intake_aliases SET status = 'rotated', updated_at = $1 WHERE status <> 'rotated' AND account_id IS NULL
       AND temp_session_id IN (SELECT id FROM intake_temp_sessions WHERE claimed_at IS NULL AND expires_at <= $1)`,
    [now],
  );
  const temps = await ctx.pool.query('DELETE FROM intake_temp_sessions WHERE claimed_at IS NULL AND expires_at <= $1', [now]);
  const claimed = await ctx.pool.query('DELETE FROM intake_temp_sessions WHERE claimed_at IS NOT NULL AND claimed_at < $1', [addMinutes(now, -30 * 1440)]);
  return { raw_purged: raw.rowCount ?? 0, temp_sessions_expired: temps.rowCount ?? 0, claimed_sessions_cleaned: claimed.rowCount ?? 0 };
}
