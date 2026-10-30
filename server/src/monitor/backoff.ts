import type { Settings } from '../settings.js';

/**
 * Delay before the next attempt after `failures` consecutive failures:
 * min(base * 2^(failures-1), max). Once failures reach max_attempts the source is 'inaccessible'
 * and keeps being retried at the max interval.
 */
export function computeBackoff(
  failures: number,
  retry: Settings['retry'],
): { delayMinutes: number; status: 'failing' | 'inaccessible'; becameInaccessible: boolean } {
  const n = Math.max(1, failures);
  const inaccessible = n >= retry.max_attempts_before_inaccessible;
  const delay = inaccessible
    ? retry.max_minutes
    : Math.min(retry.base_minutes * 2 ** (n - 1), retry.max_minutes);
  return {
    delayMinutes: delay,
    status: inaccessible ? 'inaccessible' : 'failing',
    becameInaccessible: n === retry.max_attempts_before_inaccessible,
  };
}
