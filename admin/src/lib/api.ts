/**
 * Due admin API client. Talks only to the same-origin Due server (see
 * docs/production/CONTRACT.md). Responses are deep-converted to camelCase
 * keys unless `raw` is requested (used for settings, whose JSON values are
 * edited and written back verbatim).
 */

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type UnauthorizedHandler = () => void;

function defaultUnauthorized() {
  const base = import.meta.env.BASE_URL || '/admin/';
  const path = window.location.pathname;
  const publicPages = ['login', 'setup', 'reset-password'];
  if (publicPages.some((p) => path.startsWith(base + p))) return;
  window.location.assign(base + 'login');
}

let onUnauthorized: UnauthorizedHandler = defaultUnauthorized;

export function setUnauthorizedHandler(fn: UnauthorizedHandler | null) {
  onUnauthorized = fn ?? defaultUnauthorized;
}

export const API_BASE = '/api';

const FRIENDLY: Record<number, string> = {
  400: 'The request was not accepted. Please check the form and try again.',
  401: 'Your session has ended. Please sign in again.',
  403: 'Your role does not allow this action.',
  404: 'That item could not be found.',
  409: 'This conflicts with an existing item.',
  429: 'Too many attempts. Please wait a few minutes and try again.',
};

export function friendlyMessage(status: number): string {
  if (FRIENDLY[status]) return FRIENDLY[status];
  if (status >= 500) return 'The server had a problem. Please try again shortly.';
  return 'Something went wrong. Please try again.';
}

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function camelize<T = unknown>(value: unknown): T {
  if (Array.isArray(value)) return value.map((v) => camelize(v)) as T;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[toCamel(k)] = camelize(v);
    }
    return out as T;
  }
  return value as T;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  raw?: boolean;
  /** Do not trigger the global 401 redirect (used by /auth/me and login). */
  skipAuthRedirect?: boolean;
  signal?: AbortSignal;
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Requested-With'] = 'due-admin';
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Could not reach the server. Check your connection and try again.');
  }

  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const errObj = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    const code = errObj?.code ?? `http_${res.status}`;
    let message = errObj?.message || friendlyMessage(res.status);
    if (Array.isArray(errObj?.details) && errObj.details.length > 0) {
      const parts = (errObj.details as { path?: string; message?: string }[])
        .slice(0, 3)
        .map((d) => (d.path ? `${d.path}: ${d.message ?? 'invalid'}` : (d.message ?? '')))
        .filter(Boolean);
      if (parts.length) message = `${message} (${parts.join('; ')})`;
    }
    if (res.status === 401 && !opts.skipAuthRedirect) onUnauthorized();
    throw new ApiError(res.status, code, message);
  }
  return (opts.raw ? data : camelize(data)) as T;
}

export const api = {
  get: <T = unknown>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'GET' }),
  post: <T = unknown>(path: string, body?: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'POST', body: body ?? {} }),
  patch: <T = unknown>(path: string, body: unknown, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'PATCH', body }),
  del: <T = unknown>(path: string, opts: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    request<T>(path, { ...opts, method: 'DELETE' }),
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Please try again.';
}

/** Lists may come back bare or wrapped ({items}, {companies}, ...). */
export function asList<T>(data: unknown, ...keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const k of [...keys, 'items', 'data', 'rows', 'results']) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
  }
  return [];
}

/** Single objects may come back bare or wrapped ({company: {...}}). */
export function asObject<T>(data: unknown, key: string): T {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const obj = data as Record<string, unknown>;
    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      return { ...(obj as object), ...(obj[key] as object) } as T;
    }
  }
  return data as T;
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
