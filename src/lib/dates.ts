import type { ISODate, Period } from './types';

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function daysInMonth(y: number, m: number): number {
  return [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

export function toISO(y: number, m: number, d: number): ISODate {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function isValidISO(s: string): boolean {
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = +m[1];
  const mo = +m[2];
  const d = +m[3];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function parseISO(s: ISODate): { y: number; m: number; d: number } {
  if (!isValidISO(s)) throw new Error(`Invalid date: ${s}`);
  const m = ISO_RE.exec(s)!;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

export function addDays(s: ISODate, n: number): ISODate {
  const { y, m, d } = parseISO(s);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return toISO(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Add whole months to an anchor date, clamping to month-end (31 Jan + 1 month = 28/29 Feb). */
export function addMonthsClamped(s: ISODate, months: number): ISODate {
  const { y, m, d } = parseISO(s);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return toISO(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function daysBetween(a: ISODate, b: ISODate): number {
  const pa = parseISO(a);
  const pb = parseISO(b);
  return Math.round((Date.UTC(pb.y, pb.m - 1, pb.d) - Date.UTC(pa.y, pa.m - 1, pa.d)) / 86_400_000);
}

/** Today's calendar date in the given IANA timezone (default India Standard Time). */
export function todayInTz(tz = 'Asia/Kolkata', now: Date = new Date()): ISODate {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function monthPeriod(y: number, m: number): Period {
  return { start: toISO(y, m, 1), end: toISO(y, m, daysInMonth(y, m)) };
}

export function yearPeriod(y: number): Period {
  return { start: toISO(y, 1, 1), end: toISO(y, 12, 31) };
}

export function inPeriod(d: ISODate, p: Period): boolean {
  return d >= p.start && d <= p.end;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatDate(s: ISODate): string {
  const { y, m, d } = parseISO(s);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

export function monthName(y: number, m: number): string {
  return `${MONTHS[m - 1]} ${y}`;
}
