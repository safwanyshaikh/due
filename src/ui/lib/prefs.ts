/** Small, failure-tolerant wrappers around localStorage for per-device UI preferences. */

const PREFIX = 'due:';

function store(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function readPref(key: string): string | null {
  try {
    return store()?.getItem(PREFIX + key) ?? null;
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string | null): void {
  try {
    const s = store();
    if (!s) return;
    if (value === null) s.removeItem(PREFIX + key);
    else s.setItem(PREFIX + key, value);
  } catch {
    /* storage blocked: preference lasts for this session only */
  }
}

export function readJsonPref<T>(key: string, fallback: T): T {
  const raw = readPref(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonPref(key: string, value: unknown): void {
  writePref(key, value === null ? null : JSON.stringify(value));
}

/** Random anonymous id for telemetry. Not linked to an account or any personal data. */
export function anonymousId(): string {
  const existing = readPref('anon-id');
  if (existing) return existing;
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  const id = 'anon_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  writePref('anon-id', id);
  return id;
}
