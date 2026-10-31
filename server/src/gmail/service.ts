import type { Clock } from '../clock.js';
import type { AppConfig, GmailConfig } from '../config.js';
import type { Pool, Queryable } from '../db.js';
import { one, withTransaction } from '../db.js';
import { AppError } from '../http/errors.js';
import { countIdentities, deleteIdentityData, getOwnedIdentity, MAX_IDENTITIES, type IdentityRow } from '../identities/service.js';
import { enqueue } from '../queue/index.js';
import { hmacSha256, randomToken } from '../util.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  GoogleError,
  normaliseScopes,
  pkcePair,
  readIdToken,
  refreshAccessToken,
  REQUESTED_SCOPES,
  revokeToken,
  scopesMatch,
  type TokenResponse,
} from './google.js';
import { currentKid, seal, TokenKeyMissingError, unseal, type TokenKeyRing } from './keys.js';

/** Version of the Gmail consent copy the user must have seen; bump when the copy or scopes change. */
export const GMAIL_CONSENT_VERSION = 'gmail-consent-2026-10-v1';
export const GMAIL_CONSENT_TEXT =
  'Due searches only for relevant billing, renewal, subscription, loan, card, recharge, invoice, and trial messages. ' +
  'Due cannot send, delete, reply, pay, cancel, or change anything in your Gmail.';
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
/** Manual scans allowed per identity per rolling 24 hours. */
export const MAX_MANUAL_SCANS_PER_DAY = 4;
/** A scan lock older than this is considered stale (crashed worker). */
export const SCAN_LOCK_STALE_MS = 30 * 60 * 1000;
/** Plan feature that unlocks Gmail scanning (Plus). */
export const GMAIL_FEATURE = 'email_import' as const;

export interface GmailLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface GmailDeps {
  pool: Pool;
  config: AppConfig;
  clock: Clock;
  log?: GmailLogger;
}

export type ReadyGmail = GmailConfig & { oauth: NonNullable<GmailConfig['oauth']> };

export const gmailNotConfigured = (missing: string[]) =>
  new AppError(503, 'gmail_not_configured', 'Gmail connection is not available on this server yet.', { missing });

export function requireGmailConfigured(config: AppConfig): ReadyGmail {
  const g = config.gmail;
  if (g.mode === 'not_configured' || !g.oauth) throw gmailNotConfigured(g.missing);
  return g as ReadyGmail;
}

const BLOCKERS: Record<string, string> = {
  not_configured: 'Gmail OAuth credentials are not configured on this server.',
  test_mode: 'Google OAuth app is in Testing: only Google accounts added as test users can connect.',
  verification_pending: 'Google OAuth verification (restricted Gmail scope and security assessment) is pending; new connections may be limited.',
  live: '',
};

export function gmailStatus(config: AppConfig) {
  const g = config.gmail;
  return {
    mode: g.mode,
    scopes: [...REQUESTED_SCOPES],
    consentVersion: GMAIL_CONSENT_VERSION,
    consentText: GMAIL_CONSENT_TEXT,
    blocker: BLOCKERS[g.mode] || null,
    missing: g.mode === 'not_configured' ? g.missing : [],
  };
}

export function hashState(secret: string, state: string): string {
  return hmacSha256(secret, `gmail-oauth-state:${state}`);
}

/** Starts the authorization-code + PKCE flow. The state value is returned to the browser only inside the URL. */
export async function startConnect(deps: GmailDeps, accountId: string, consentVersion: string): Promise<{ authorizeUrl: string; expiresAt: Date }> {
  const g = requireGmailConfigured(deps.config);
  if (consentVersion !== GMAIL_CONSENT_VERSION) {
    throw new AppError(400, 'consent_version_mismatch', 'Please review the current Gmail permission text before connecting', { current: GMAIL_CONSENT_VERSION });
  }
  const now = deps.clock();
  const state = randomToken(32);
  const { verifier, challenge } = pkcePair();
  const stateHash = hashState(deps.config.sessionSecret, state);
  const sealed = seal(g.oauth.tokenKeys, verifier, `pkce:${stateHash}`);
  const expiresAt = new Date(now.getTime() + OAUTH_STATE_TTL_MS);
  await withTransaction(deps.pool, async (c) => {
    // Housekeeping: drop expired/used states, and cap outstanding attempts per account.
    await c.query('DELETE FROM oauth_states WHERE expires_at <= $1 OR (used_at IS NOT NULL AND used_at < $1)', [now]);
    await c.query(
      `DELETE FROM oauth_states WHERE account_id = $1 AND state_hash IN (
         SELECT state_hash FROM oauth_states WHERE account_id = $1 ORDER BY created_at DESC OFFSET 4)`,
      [accountId],
    );
    await c.query(
      `INSERT INTO oauth_states (state_hash, account_id, code_verifier_enc, verifier_kid, redirect_uri, consent_version, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [stateHash, accountId, sealed.value, sealed.kid, g.oauth.redirectUri, consentVersion, now, expiresAt],
    );
  });
  const authorizeUrl = buildAuthorizeUrl(g.endpoints, { clientId: g.oauth.clientId, redirectUri: g.oauth.redirectUri, state, codeChallenge: challenge });
  return { authorizeUrl, expiresAt };
}

export async function recordGmailConsent(q: Queryable, accountId: string, granted: boolean, version: string, now: Date): Promise<void> {
  // consent v2 (migration 006): policy_version, source and scope; the 006 triggers set granted_at / revoked_at.
  await q.query(
    `INSERT INTO consent_records (account_id, purpose, granted, text_version, policy_version, source, scope, at)
     VALUES ($1,'gmail',$2,$3,$3,'oauth',$4,$5)`,
    [accountId, granted, version, JSON.stringify({ scopes: [...REQUESTED_SCOPES] }), now],
  );
}

function sealTokens(ring: TokenKeyRing, identityId: string, access: string, refresh: string) {
  const a = seal(ring, access, `access:${identityId}`);
  const r = seal(ring, refresh, `refresh:${identityId}`);
  return { kid: a.kid, access: a.value, refresh: r.value };
}

export type CallbackResult = { ok: true; identityId: string } | { ok: false; reason: string };

/**
 * Completes the OAuth callback. Every failure is reported as a short reason code (never token material).
 * The state must exist, be unused, unexpired, belong to the signed-in account and carry the configured redirect URI.
 */
export async function completeCallback(
  deps: GmailDeps,
  accountId: string | null,
  query: { state?: string; code?: string; error?: string },
): Promise<CallbackResult> {
  const config = deps.config;
  if (config.gmail.mode === 'not_configured' || !config.gmail.oauth) return { ok: false, reason: 'not_configured' };
  const g = config.gmail as ReadyGmail;
  const now = deps.clock();
  if (!query.state || query.state.length > 200) return { ok: false, reason: 'invalid_state' };
  const stateHash = hashState(config.sessionSecret, query.state);
  // Single use: the state is consumed atomically before anything else, so a replay always fails.
  const row = await one<{ account_id: string; code_verifier_enc: string; verifier_kid: string; redirect_uri: string; consent_version: string; expires_at: Date }>(
    deps.pool,
    'UPDATE oauth_states SET used_at = $2 WHERE state_hash = $1 AND used_at IS NULL RETURNING account_id, code_verifier_enc, verifier_kid, redirect_uri, consent_version, expires_at',
    [stateHash, now],
  );
  if (!row) {
    const used = await one(deps.pool, 'SELECT 1 FROM oauth_states WHERE state_hash = $1', [stateHash]);
    return { ok: false, reason: used ? 'state_replayed' : 'invalid_state' };
  }
  if (row.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'state_expired' };
  if (!accountId || row.account_id !== accountId) return { ok: false, reason: 'account_mismatch' };
  if (row.redirect_uri !== g.oauth.redirectUri) return { ok: false, reason: 'redirect_mismatch' };
  if (query.error) return { ok: false, reason: query.error === 'access_denied' ? 'access_denied' : 'google_error' };
  if (!query.code || query.code.length > 2048) return { ok: false, reason: 'missing_code' };

  let verifier: string;
  try {
    verifier = unseal(g.oauth.tokenKeys, row.verifier_kid, row.code_verifier_enc, `pkce:${stateHash}`);
  } catch {
    return { ok: false, reason: 'invalid_state' };
  }
  let tokens: TokenResponse;
  try {
    tokens = await exchangeCode(g.endpoints, {
      clientId: g.oauth.clientId,
      clientSecret: g.oauth.clientSecret,
      redirectUri: row.redirect_uri,
      code: query.code,
      codeVerifier: verifier,
    });
  } catch (err) {
    deps.log?.warn({ code: err instanceof GoogleError ? err.code : 'unknown' }, 'gmail token exchange failed');
    return { ok: false, reason: 'token_exchange_failed' };
  }
  const discard = async () => {
    await revokeToken(g.endpoints, tokens.refreshToken ?? tokens.accessToken);
  };
  const claims = tokens.idToken ? readIdToken(tokens.idToken, g.oauth.clientId, now) : null;
  if (!claims || !claims.emailVerified) {
    await discard();
    return { ok: false, reason: tokens.idToken ? 'identity_unverified' : 'scope_mismatch' };
  }
  const granted = normaliseScopes(tokens.scopes ?? []);
  const scopeOk = tokens.scopes !== null && scopesMatch(granted);
  if (scopeOk && !tokens.refreshToken) {
    await discard();
    return { ok: false, reason: 'no_refresh_token' };
  }

  const result = await withTransaction(deps.pool, async (c) => {
    const existing = await one<IdentityRow>(c, `SELECT * FROM email_identities WHERE account_id = $1 AND kind = 'gmail' AND email = $2 FOR UPDATE`, [
      accountId,
      claims.email,
    ]);
    if (!existing && (await countIdentities(c, accountId)) >= MAX_IDENTITIES) return { ok: false as const, reason: 'identity_limit' };
    const status = scopeOk ? 'active' : 'error';
    const reason = scopeOk ? null : 'scope_mismatch';
    const ident = (await one<IdentityRow>(
      c,
      `INSERT INTO email_identities (account_id, kind, label, email, status, status_reason, consent_version, consented_at, revoked_at, created_at, updated_at)
       VALUES ($1,'gmail','Gmail',$2,$3,$4,$5,$6,NULL,$6,$6)
       ON CONFLICT (account_id, kind, email) DO UPDATE SET status = EXCLUDED.status, status_reason = EXCLUDED.status_reason,
         consent_version = EXCLUDED.consent_version, consented_at = EXCLUDED.consented_at, revoked_at = NULL, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [accountId, claims.email, status, reason, row.consent_version, now],
    ))!;
    if (scopeOk) {
      const s = sealTokens(g.oauth.tokenKeys, ident.id, tokens.accessToken, tokens.refreshToken!);
      await c.query(
        `INSERT INTO gmail_connections (identity_id, google_sub, scopes, token_kid, access_token_enc, refresh_token_enc, expires_at, created_at, updated_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,NULL)
         ON CONFLICT (identity_id) DO UPDATE SET google_sub = EXCLUDED.google_sub, scopes = EXCLUDED.scopes, token_kid = EXCLUDED.token_kid,
           access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc, expires_at = EXCLUDED.expires_at,
           updated_at = EXCLUDED.updated_at, revoked_at = NULL`,
        [ident.id, claims.sub, granted, s.kid, s.access, s.refresh, new Date(now.getTime() + tokens.expiresIn * 1000), now],
      );
      await recordGmailConsent(c, accountId, true, row.consent_version, now);
    } else {
      // Scope differs from what the user agreed to: keep no token, require a fresh connect.
      await c.query(
        `INSERT INTO gmail_connections (identity_id, google_sub, scopes, token_kid, access_token_enc, refresh_token_enc, expires_at, created_at, updated_at, revoked_at)
         VALUES ($1,$2,$3,NULL,NULL,NULL,NULL,$4,$4,$4)
         ON CONFLICT (identity_id) DO UPDATE SET google_sub = EXCLUDED.google_sub, scopes = EXCLUDED.scopes, token_kid = NULL,
           access_token_enc = NULL, refresh_token_enc = NULL, expires_at = NULL, updated_at = EXCLUDED.updated_at, revoked_at = EXCLUDED.revoked_at`,
        [ident.id, claims.sub, granted, now],
      );
    }
    return { ok: true as const, identityId: ident.id };
  });
  if (!result.ok) {
    await discard();
    return result;
  }
  if (!scopeOk) {
    await discard();
    return { ok: false, reason: 'scope_mismatch' };
  }
  try {
    await enqueueScan(deps, accountId, result.identityId, 'initial');
  } catch (err) {
    deps.log?.warn({ code: err instanceof AppError ? err.code : 'enqueue_failed' }, 'gmail initial scan not queued');
  }
  return result;
}

export class GmailStop extends Error {
  constructor(readonly code: string) {
    super(`Gmail scan stopped: ${code}`);
    this.name = 'GmailStop';
  }
}

interface ConnectionRow {
  identity_id: string;
  google_sub: string;
  scopes: string[];
  token_kid: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

/** Wipes token material and marks the identity as needing a reconnect. */
async function failConnection(deps: GmailDeps, identityId: string, code: string): Promise<void> {
  const now = deps.clock();
  await withTransaction(deps.pool, async (c) => {
    await c.query(
      `UPDATE gmail_connections SET access_token_enc = NULL, refresh_token_enc = NULL, token_kid = NULL, expires_at = NULL, revoked_at = $2, updated_at = $2
        WHERE identity_id = $1`,
      [identityId, now],
    );
    await c.query(`UPDATE email_identities SET status = 'error', status_reason = $2, updated_at = $3 WHERE id = $1`, [identityId, code, now]);
  });
}

/**
 * Returns a usable access token for the identity, refreshing (and re-encrypting both tokens under the
 * current key) when it is near expiry, when `force` is set, or when it is stored under an older kid.
 */
export async function accessTokenFor(deps: GmailDeps, identityId: string, force = false): Promise<string> {
  const g = requireGmailConfigured(deps.config);
  const ring = g.oauth.tokenKeys;
  const now = deps.clock();
  const conn = await one<ConnectionRow>(deps.pool, 'SELECT * FROM gmail_connections WHERE identity_id = $1 AND revoked_at IS NULL', [identityId]);
  if (!conn || !conn.refresh_token_enc || !conn.token_kid) throw new GmailStop('disconnected');
  let refresh: string;
  let access: string | null = null;
  try {
    refresh = unseal(ring, conn.token_kid, conn.refresh_token_enc, `refresh:${identityId}`);
    if (conn.access_token_enc) access = unseal(ring, conn.token_kid, conn.access_token_enc, `access:${identityId}`);
  } catch (err) {
    const code = err instanceof TokenKeyMissingError ? 'token_key_missing' : 'token_decrypt_failed';
    await deps.pool.query(`UPDATE email_identities SET status = 'error', status_reason = $2, updated_at = $3 WHERE id = $1`, [identityId, code, now]);
    throw new GmailStop(code);
  }
  const fresh = conn.expires_at && conn.expires_at.getTime() > now.getTime() + 60_000;
  if (access && fresh && !force) {
    if (conn.token_kid !== currentKid(ring)) {
      // Key rotation: re-encrypt under the current key without contacting Google.
      const s = sealTokens(ring, identityId, access, refresh);
      await deps.pool.query(
        'UPDATE gmail_connections SET token_kid = $2, access_token_enc = $3, refresh_token_enc = $4, updated_at = $5 WHERE identity_id = $1 AND revoked_at IS NULL',
        [identityId, s.kid, s.access, s.refresh, now],
      );
    }
    return access;
  }
  let t: TokenResponse;
  try {
    t = await refreshAccessToken(g.endpoints, { clientId: g.oauth.clientId, clientSecret: g.oauth.clientSecret, refreshToken: refresh });
  } catch (err) {
    if (err instanceof GoogleError && err.code === 'invalid_grant') {
      await failConnection(deps, identityId, 'token_revoked');
      throw new GmailStop('token_revoked');
    }
    throw err;
  }
  if (t.scopes !== null && !scopesMatch(t.scopes)) {
    await failConnection(deps, identityId, 'scope_mismatch');
    await revokeToken(g.endpoints, refresh);
    throw new GmailStop('scope_mismatch');
  }
  const s = sealTokens(ring, identityId, t.accessToken, t.refreshToken ?? refresh);
  await deps.pool.query(
    `UPDATE gmail_connections SET token_kid = $2, access_token_enc = $3, refresh_token_enc = $4, expires_at = $5, updated_at = $6
      WHERE identity_id = $1 AND revoked_at IS NULL`,
    [identityId, s.kid, s.access, s.refresh, new Date(now.getTime() + t.expiresIn * 1000), now],
  );
  return t.accessToken;
}

/** Marks a 403 insufficient-scope response from Gmail. */
export async function markScopeMismatch(deps: GmailDeps, identityId: string): Promise<void> {
  await failConnection(deps, identityId, 'scope_mismatch');
}

/**
 * Stops reads immediately (status + connection revoked inside one transaction), then revokes the grant at
 * Google. Optionally deletes the identity's imported review candidates and seen-ids.
 */
export async function disconnectIdentity(
  deps: GmailDeps,
  accountId: string,
  identityId: string,
  opts: { deleteImported: boolean; removeIdentity?: boolean },
): Promise<{ revoked: boolean; deleted: { events: number; seen: number } }> {
  const now = deps.clock();
  const ring = deps.config.gmail.oauth?.tokenKeys ?? null;
  const out = await withTransaction(deps.pool, async (c) => {
    const ident = await getOwnedIdentity(c, accountId, identityId, true);
    if (!ident) throw new AppError(404, 'not_found', 'Identity not found');
    const conn = await one<ConnectionRow>(c, 'SELECT * FROM gmail_connections WHERE identity_id = $1 FOR UPDATE', [identityId]);
    let token: string | null = null;
    if (conn && conn.revoked_at === null && conn.token_kid && ring) {
      try {
        token = conn.refresh_token_enc
          ? unseal(ring, conn.token_kid, conn.refresh_token_enc, `refresh:${identityId}`)
          : conn.access_token_enc
            ? unseal(ring, conn.token_kid, conn.access_token_enc, `access:${identityId}`)
            : null;
      } catch {
        token = null;
      }
    }
    const hadToken = Boolean(conn && conn.revoked_at === null && (conn.refresh_token_enc || conn.access_token_enc));
    if (conn) {
      await c.query(
        `UPDATE gmail_connections SET access_token_enc = NULL, refresh_token_enc = NULL, token_kid = NULL, expires_at = NULL,
           revoked_at = COALESCE(revoked_at, $2), updated_at = $2 WHERE identity_id = $1`,
        [identityId, now],
      );
    }
    await c.query(
      `UPDATE email_identities SET status = 'disconnected', status_reason = 'user_disconnected', revoked_at = $2, scan_running_since = NULL, updated_at = $2 WHERE id = $1`,
      [identityId, now],
    );
    await c.query(`UPDATE gmail_scan_runs SET status = 'cancelled', finished_at = $2, error_code = 'disconnected' WHERE identity_id = $1 AND status IN ('queued','running')`, [
      identityId,
      now,
    ]);
    if (ident.kind === 'gmail' && ident.consent_version) await recordGmailConsent(c, accountId, false, ident.consent_version, now);
    const deleted = await deleteIdentityData(c, accountId, identityId, opts.deleteImported);
    if (opts.removeIdentity) await c.query('DELETE FROM email_identities WHERE id = $1 AND account_id = $2', [identityId, accountId]);
    return { token, hadToken, deleted };
  });
  let revoked = !out.hadToken;
  if (out.token) revoked = await revokeToken(deps.config.gmail.endpoints, out.token);
  return { revoked, deleted: out.deleted };
}

/** Revokes every Gmail grant of an account (for account deletion). Best effort; local tokens are always wiped. */
export async function revokeAllForAccount(deps: GmailDeps, accountId: string): Promise<{ identities: number; revoked: number }> {
  const rows = await deps.pool.query<{ id: string }>(`SELECT id FROM email_identities WHERE account_id = $1 AND kind = 'gmail'`, [accountId]);
  let revoked = 0;
  for (const r of rows.rows) {
    const res = await disconnectIdentity(deps, accountId, r.id, { deleteImported: false });
    if (res.revoked) revoked++;
  }
  return { identities: rows.rows.length, revoked };
}

export type ScanTrigger = 'initial' | 'manual' | 'scheduled';

/** Creates a visible scan run and enqueues the durable `gmail.scan` job for it. */
export async function enqueueScan(deps: GmailDeps, accountId: string, identityId: string, trigger: ScanTrigger): Promise<{ runId: string; jobId: string }> {
  const now = deps.clock();
  const run = await withTransaction(deps.pool, async (c) => {
    const ident = await getOwnedIdentity(c, accountId, identityId, true);
    if (!ident || ident.kind !== 'gmail') throw new AppError(404, 'not_found', 'Gmail identity not found');
    if (ident.status !== 'active') {
      throw new AppError(409, 'identity_not_active', 'Reconnect this Gmail account before scanning', { status: ident.status, reason: ident.status_reason });
    }
    const busy = await one(
      c,
      `SELECT 1 FROM gmail_scan_runs WHERE identity_id = $1 AND status IN ('queued','running') AND requested_at > $2 LIMIT 1`,
      [identityId, new Date(now.getTime() - 60 * 60 * 1000)],
    );
    const locked = ident.scan_running_since && ident.scan_running_since.getTime() > now.getTime() - SCAN_LOCK_STALE_MS;
    if (busy || locked) throw new AppError(409, 'scan_in_progress', 'A scan of this Gmail account is already queued or running');
    if (trigger === 'manual') {
      const n = await one<{ n: number }>(
        c,
        `SELECT count(*)::int AS n FROM gmail_scan_runs WHERE identity_id = $1 AND trigger = 'manual' AND requested_at > $2`,
        [identityId, new Date(now.getTime() - 24 * 60 * 60 * 1000)],
      );
      if ((n?.n ?? 0) >= MAX_MANUAL_SCANS_PER_DAY) {
        throw new AppError(429, 'scan_limit', `Up to ${MAX_MANUAL_SCANS_PER_DAY} manual scans a day per Gmail account`);
      }
    }
    return (await one<{ id: string }>(
      c,
      `INSERT INTO gmail_scan_runs (identity_id, trigger, status, requested_at) VALUES ($1,$2,'queued',$3) RETURNING id`,
      [identityId, trigger, now],
    ))!;
  });
  try {
    const job = await enqueue(deps.pool, {
      type: 'gmail.scan',
      payload: { identityId, runId: run.id },
      accountId,
      idempotencyKey: `gmail.scan:${run.id}`,
      maxAttempts: 3,
      now,
    });
    await deps.pool.query('UPDATE gmail_scan_runs SET job_id = $2 WHERE id = $1', [run.id, String(job.id)]);
    return { runId: run.id, jobId: String(job.id) };
  } catch (err) {
    await deps.pool.query(`UPDATE gmail_scan_runs SET status = 'failed', finished_at = $2, error_code = 'enqueue_failed' WHERE id = $1`, [run.id, now]);
    throw err instanceof AppError ? err : new AppError(503, 'queue_unavailable', 'Could not queue the scan; try again shortly');
  }
}
