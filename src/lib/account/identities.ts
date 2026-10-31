/**
 * Typed client for the account's email identities (Gmail, work, family/shared, forwarding-only).
 * Every identity carries its own consent, status, last scan, disconnect and delete controls; the server links
 * identities only to the signed-in Due account and never merges them by sender address.
 *
 * Requests send `credentials: 'include'` and `X-Requested-With: due-app` (CSRF guard). Errors are
 * `AccountApiError` with the server's `{ error: { code, message, details } }` payload.
 */
import {
  AccountApiError,
  CSRF_HEADER,
  CSRF_VALUE,
  defaultApiBase,
  type AccountClientOptions,
  type FetchLike,
} from './client';

export type IdentityKind = 'gmail' | 'work' | 'family' | 'forwarding';
export type IdentityStatus = 'active' | 'paused' | 'disconnected' | 'error';

export interface EmailIdentity {
  id: string;
  kind: IdentityKind;
  label: string;
  email: string;
  status: IdentityStatus;
  /** Why the identity needs attention, e.g. 'scope_mismatch', 'token_revoked', 'user_disconnected'. */
  statusReason: string | null;
  consentVersion: string | null;
  consentedAt: string | null;
  revokedAt: string | null;
  attachmentsEnabled: boolean;
  senderFilters: string[];
  lastScanAt: string | null;
  lastScanStatus: 'ok' | 'error' | 'cancelled' | null;
  lastScanErrorCode: string | null;
  scanning: boolean;
  /** Granted Google scopes (Gmail identities only). */
  scopes?: string[];
  createdAt: string;
}

export interface IdentitiesResponse {
  items: EmailIdentity[];
  max: number;
}

export interface CreateIdentityInput {
  kind: Exclude<IdentityKind, 'gmail'>;
  label?: string;
  email: string;
  consentVersion?: string;
}

export interface UpdateIdentityInput {
  label?: string;
  status?: 'active' | 'paused';
  /** Gmail only: read small text attachments (off by default). */
  attachmentsEnabled?: boolean;
  /** Gmail only: extra sender/domain filters, e.g. ['netflix.com']. */
  senderFilters?: string[];
}

export interface DeleteIdentityResponse {
  ok: true;
  /** False when Google could not confirm revocation; the user can revoke at myaccount.google.com/permissions. */
  revoked: boolean;
  deleted: { events: number; seen: number };
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Requester = <T>(method: Method, path: string, body?: unknown) => Promise<T>;

/** Shared JSON requester for the account wrappers (same behaviour as the main account client). */
export function createRequester(opts: AccountClientOptions = {}): Requester {
  const base = (opts.base ?? defaultApiBase()).replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [CSRF_HEADER]: CSRF_VALUE,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string } | null)?.name === 'AbortError';
      throw new AccountApiError(
        0,
        aborted ? 'timeout' : 'network_error',
        aborted ? 'The request timed out' : 'Could not reach the server',
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const e = (
        json as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined
      )?.error;
      throw new AccountApiError(
        res.status,
        typeof e?.code === 'string' ? e.code : 'http_error',
        typeof e?.message === 'string' ? e.message : `Request failed (HTTP ${res.status})`,
        e?.details,
      );
    }
    if (json === undefined && text) {
      throw new AccountApiError(
        res.status,
        'invalid_response',
        'The server returned an unexpected response',
      );
    }
    return json as T;
  };
}

export function createIdentitiesClient(opts: AccountClientOptions = {}) {
  const request = createRequester(opts);
  const id = (s: string) => encodeURIComponent(s);
  return {
    list: () => request<IdentitiesResponse>('GET', '/api/account/identities'),
    /** Work, family/shared or forwarding-only identity. Gmail identities are created by connecting Gmail. */
    create: async (input: CreateIdentityInput) =>
      (await request<{ identity: EmailIdentity }>('POST', '/api/account/identities', input))
        .identity,
    update: async (identityId: string, input: UpdateIdentityInput) =>
      (
        await request<{ identity: EmailIdentity }>(
          'PATCH',
          `/api/account/identities/${id(identityId)}`,
          input,
        )
      ).identity,
    /** Removes the identity (revoking Gmail access first). `deleteData` also deletes the review items it produced. */
    remove: (identityId: string, deleteData = false) =>
      request<DeleteIdentityResponse>(
        'DELETE',
        `/api/account/identities/${id(identityId)}?deleteData=${deleteData ? 'true' : 'false'}`,
      ),
  };
}

export type IdentitiesClient = ReturnType<typeof createIdentitiesClient>;
