/**
 * Minimal Google OAuth 2.0 and Gmail API client (fetch, no SDK). Due only ever issues:
 *   POST {tokenUrl}   (authorization-code exchange, refresh)
 *   POST {revokeUrl}  (disconnect)
 *   GET  users/me/messages              (list ids)
 *   GET  users/me/messages/{id}         (read one message)
 *   GET  users/me/messages/{id}/attachments/{aid}  (only when the user enabled attachments)
 * It never calls send, modify, trash, delete, insert, import, batchModify or label endpoints.
 * Tokens never appear in thrown errors or logs.
 */
import { createHash } from 'node:crypto';
import type { GmailEndpoints } from '../config.js';
import { randomToken } from '../util.js';

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const USERINFO_EMAIL_SCOPE = 'https://www.googleapis.com/auth/userinfo.email';
/** Exactly what Due requests: read-only Gmail plus OpenID email to know which Google account was linked. */
export const REQUESTED_SCOPES = ['openid', 'email', GMAIL_READONLY_SCOPE] as const;
/** The same set as Google reports it back (it expands "email" to the userinfo.email URL). */
export const REQUIRED_GRANTED = ['openid', USERINFO_EMAIL_SCOPE, GMAIL_READONLY_SCOPE].sort();

const TIMEOUT_MS = 15_000;

/** Google-side failure; `code` is safe to store and show (no secrets). */
export class GoogleError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GoogleError';
  }
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  // 32 random bytes -> 43 base64url characters (RFC 7636 allows 43-128).
  const verifier = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  endpoints: GmailEndpoints,
  p: { clientId: string; redirectUri: string; state: string; codeChallenge: string; loginHint?: string },
): string {
  const u = new URL(endpoints.authUrl);
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', REQUESTED_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'false');
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  if (p.loginHint) u.searchParams.set('login_hint', p.loginHint);
  return u.toString();
}

async function call(url: string, init: RequestInit): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new GoogleError('google_unreachable', 0, 'Could not reach Google');
  }
  const text = await res.text();
  let json: Record<string, unknown> | null;
  try {
    const v: unknown = text ? JSON.parse(text) : null;
    json = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function form(body: Record<string, string>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  };
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
  /** Granted scopes as reported by Google (null when the response omits `scope`). */
  scopes: string[] | null;
  idToken: string | null;
}

function tokenResponse(json: Record<string, unknown> | null): TokenResponse {
  const accessToken = typeof json?.access_token === 'string' ? json.access_token : '';
  if (!accessToken) throw new GoogleError('token_invalid_response', 502, 'Google returned no access token');
  const expiresIn = typeof json?.expires_in === 'number' && json.expires_in > 0 ? json.expires_in : 3600;
  return {
    accessToken,
    refreshToken: typeof json?.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
    expiresIn,
    scopes: typeof json?.scope === 'string' ? json.scope.split(/\s+/).filter(Boolean) : null,
    idToken: typeof json?.id_token === 'string' ? json.id_token : null,
  };
}

function tokenError(status: number, json: Record<string, unknown> | null): GoogleError {
  const err = typeof json?.error === 'string' ? json.error : 'token_error';
  // invalid_grant: code reused/expired, or the refresh token was revoked by the user.
  const code = err === 'invalid_grant' ? 'invalid_grant' : status >= 500 ? 'google_unavailable' : `token_${err.replace(/[^a-z_]/gi, '').slice(0, 40)}`;
  return new GoogleError(code, status, `Google token endpoint refused the request (${err})`);
}

export async function exchangeCode(
  endpoints: GmailEndpoints,
  p: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string },
): Promise<TokenResponse> {
  const r = await call(
    endpoints.tokenUrl,
    form({
      grant_type: 'authorization_code',
      code: p.code,
      client_id: p.clientId,
      client_secret: p.clientSecret,
      redirect_uri: p.redirectUri,
      code_verifier: p.codeVerifier,
    }),
  );
  if (r.status !== 200) throw tokenError(r.status, r.json);
  return tokenResponse(r.json);
}

export async function refreshAccessToken(
  endpoints: GmailEndpoints,
  p: { clientId: string; clientSecret: string; refreshToken: string },
): Promise<TokenResponse> {
  const r = await call(
    endpoints.tokenUrl,
    form({ grant_type: 'refresh_token', refresh_token: p.refreshToken, client_id: p.clientId, client_secret: p.clientSecret }),
  );
  if (r.status !== 200) throw tokenError(r.status, r.json);
  return tokenResponse(r.json);
}

/** Revokes the grant (revoking either token revokes both). Returns true when Google confirms, or the token was already invalid. */
export async function revokeToken(endpoints: GmailEndpoints, token: string): Promise<boolean> {
  try {
    const r = await call(endpoints.revokeUrl, form({ token }));
    // 400 invalid_token means it is already revoked/expired: nothing left to revoke.
    return r.status === 200 || (r.status === 400 && r.json?.error === 'invalid_token');
  } catch {
    return false;
  }
}

export interface IdTokenClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
}

/**
 * Reads the ID token received directly from Google's token endpoint over TLS (OpenID Connect Core 3.1.3.7:
 * signature validation may be skipped for tokens obtained this way). Audience, issuer and expiry are checked.
 */
export function readIdToken(idToken: string, clientId: string, now: Date): IdTokenClaims | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const audOk = c.aud === clientId || (Array.isArray(c.aud) && c.aud.includes(clientId));
  const issOk = c.iss === 'https://accounts.google.com' || c.iss === 'accounts.google.com';
  const expOk = typeof c.exp === 'number' && c.exp * 1000 > now.getTime() - 60_000;
  if (!audOk || !issOk || !expOk || typeof c.sub !== 'string' || typeof c.email !== 'string') return null;
  return { sub: c.sub, email: c.email.trim().toLowerCase(), emailVerified: c.email_verified === true || c.email_verified === 'true' };
}

/** Normalises granted scopes ("email" == userinfo.email, "profile" ignored) for comparison. */
export function normaliseScopes(scopes: string[]): string[] {
  const out = new Set<string>();
  for (const s of scopes) {
    if (s === 'email') out.add(USERINFO_EMAIL_SCOPE);
    else if (s === 'profile' || s === 'https://www.googleapis.com/auth/userinfo.profile') continue;
    else out.add(s);
  }
  return [...out].sort();
}

/** True when the granted scopes are exactly what Due requested (no missing Gmail read access, nothing broader). */
export function scopesMatch(granted: string[]): boolean {
  const g = normaliseScopes(granted);
  return g.length === REQUIRED_GRANTED.length && g.every((s, i) => s === REQUIRED_GRANTED[i]);
}

// ---- Gmail API (read-only GETs) ---------------------------------------------------------------

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailPart;
}

async function gmailGet(base: string, path: string, accessToken: string, query: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const u = new URL(`${base.replace(/\/$/, '')}/${path}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const r = await call(u.toString(), { method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
  if (r.status === 200 && r.json) return r.json;
  if (r.status === 401) throw new GoogleError('unauthorized', 401, 'Gmail rejected the access token');
  if (r.status === 403) {
    const reason = JSON.stringify(r.json ?? {}).includes('insufficientPermissions') || JSON.stringify(r.json ?? {}).includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT');
    throw new GoogleError(reason ? 'scope_mismatch' : 'gmail_forbidden', 403, 'Gmail refused the request');
  }
  if (r.status === 404) throw new GoogleError('not_found', 404, 'Gmail message not found');
  if (r.status === 429) throw new GoogleError('gmail_rate_limited', 429, 'Gmail rate limit');
  throw new GoogleError(r.status >= 500 ? 'gmail_unavailable' : 'gmail_error', r.status, `Gmail API error (HTTP ${r.status})`);
}

/** users.messages.list: one page of message ids. */
export async function listMessages(
  base: string,
  accessToken: string,
  q: string,
  pageToken?: string,
  maxResults = 100,
): Promise<{ ids: string[]; nextPageToken: string | null }> {
  const query: Record<string, string> = { q, maxResults: String(maxResults) };
  if (pageToken) query.pageToken = pageToken;
  const j = await gmailGet(base, 'users/me/messages', accessToken, query);
  const ids = Array.isArray(j.messages)
    ? (j.messages as { id?: unknown }[]).map((m) => (typeof m.id === 'string' ? m.id : '')).filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id))
    : [];
  return { ids, nextPageToken: typeof j.nextPageToken === 'string' ? j.nextPageToken : null };
}

/** users.messages.get format=full (body text is read from parts; attachments are separate requests). */
export async function getMessage(base: string, accessToken: string, id: string): Promise<GmailMessage> {
  const j = await gmailGet(base, `users/me/messages/${encodeURIComponent(id)}`, accessToken, { format: 'full' });
  return j as unknown as GmailMessage;
}

export async function getAttachment(base: string, accessToken: string, messageId: string, attachmentId: string): Promise<string | null> {
  const j = await gmailGet(base, `users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, accessToken);
  return typeof j.data === 'string' ? j.data : null;
}
