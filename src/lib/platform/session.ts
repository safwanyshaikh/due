import { getPlatform } from './index';

/**
 * Native session bearer token. The web build never has one (it relies on the HttpOnly cookie), so every
 * function here is a no-op there and `authInit()` returns the same cookie settings the client always used.
 */
let cached: string | null | undefined;

export async function getSessionToken(): Promise<string | null> {
  const p = getPlatform();
  if (!p.isNative) return null;
  if (cached === undefined) cached = await p.tokens.get();
  return cached;
}

export async function setSessionToken(token: string): Promise<void> {
  const p = getPlatform();
  if (!p.isNative) return;
  cached = token;
  await p.tokens.set(token);
}

export async function clearSessionToken(): Promise<void> {
  const p = getPlatform();
  cached = null;
  if (p.isNative) await p.tokens.clear();
}

/** Test hook: forget the in-memory copy. */
export function resetSessionTokenCache(): void {
  cached = undefined;
}

export interface AuthInit {
  headers: Record<string, string>;
  credentials: RequestCredentials;
  /** True when this build uses the bearer-token session (native). */
  bearer: boolean;
}

/**
 * Request settings for the account API. Web: cookies (`credentials: 'include'`). Native: no cookies at all
 * (`credentials: 'omit'`), `Authorization: Bearer` when signed in.
 */
export async function authInit(): Promise<AuthInit> {
  if (!getPlatform().isNative) return { headers: {}, credentials: 'include', bearer: false };
  const token = await getSessionToken();
  return {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    credentials: 'omit',
    bearer: true,
  };
}
