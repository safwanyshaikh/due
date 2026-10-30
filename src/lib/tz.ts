/** Timezone helpers (IANA zones via Intl; no dependencies). Default Asia/Kolkata. */
import { addDays, toISO } from './dates';
import type { ISODate } from './types';

export const DEFAULT_TZ = 'Asia/Kolkata';

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(instant: Date, tz = DEFAULT_TZ) {
  const parts = Object.fromEntries(
    fmt(tz)
      .formatToParts(instant)
      .map((p) => [p.type, p.value]),
  );
  return {
    y: +parts.year,
    m: +parts.month,
    d: +parts.day,
    hh: +parts.hour % 24,
    mm: +parts.minute,
    ss: +parts.second,
  };
}

/** Local date + HH:MM in a zone. */
export function toZoned(instant: Date | string, tz = DEFAULT_TZ): { date: ISODate; time: string } {
  const p = zonedParts(typeof instant === 'string' ? new Date(instant) : instant, tz);
  return {
    date: toISO(p.y, p.m, p.d),
    time: `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`,
  };
}

/** Offset (ms) of a zone at an instant: local wall time minus UTC. */
function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(new Date(ms), tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(ms / 1000) * 1000;
}

/**
 * UTC instant for a local wall-clock time in a zone. Times that do not exist (DST gap) move
 * forward by the gap; ambiguous times (DST overlap) use the earlier instant.
 */
export function zonedToUtc(date: ISODate, hhmm: string, tz = DEFAULT_TZ): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let guess = wall - offsetAt(wall, tz);
  const o2 = offsetAt(guess, tz);
  guess = wall - o2;
  const o3 = offsetAt(guess, tz);
  // In a DST gap the two offsets disagree; using the pre-transition offset moves the time forward.
  if (o3 !== o2) guess = wall - Math.min(o2, o3);
  return new Date(guess);
}

export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export interface QuietHours {
  start: string;
  end: string;
}

/** True when HH:MM falls in quiet hours (handles windows that cross midnight). */
export function inQuietHours(hhmm: string, quiet: QuietHours): boolean {
  const t = toMinutes(hhmm);
  const s = toMinutes(quiet.start);
  const e = toMinutes(quiet.end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/**
 * Moves a local date/time out of quiet hours to the end of the window, rolling to the next
 * day when the window crosses midnight (23:30 with 22:00–07:00 → 07:00 next day).
 */
export function shiftOutOfQuietHours(
  date: ISODate,
  hhmm: string,
  quiet: QuietHours,
): { date: ISODate; time: string; shifted: boolean } {
  if (!inQuietHours(hhmm, quiet)) return { date, time: hhmm, shifted: false };
  const crosses = toMinutes(quiet.start) > toMinutes(quiet.end);
  const afterStart = toMinutes(hhmm) >= toMinutes(quiet.start);
  return { date: crosses && afterStart ? addDays(date, 1) : date, time: quiet.end, shifted: true };
}
