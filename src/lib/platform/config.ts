/**
 * Build-time API origin. One setting for every client wrapper:
 * - web (served by the Due server): leave unset, requests are same-origin (relative paths);
 * - native: set VITE_API_ORIGIN=https://due.karigarai.com when building for Capacitor.
 * `VITE_API_BASE` is the older name and is still honoured when VITE_API_ORIGIN is not set.
 */
export function normaliseOrigin(raw: string | undefined | null): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

export function apiOrigin(): string {
  let origin: string | undefined;
  let legacy: string | undefined;
  try {
    origin = import.meta.env?.VITE_API_ORIGIN as string | undefined;
    legacy = import.meta.env?.VITE_API_BASE as string | undefined;
  } catch {
    origin = undefined;
    legacy = undefined;
  }
  return normaliseOrigin(origin) || normaliseOrigin(legacy);
}
