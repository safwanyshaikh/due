import { formatINR } from '../../lib/money';
import { parseISO } from '../../lib/dates';
import type { ValueConfidence } from '../../lib/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const inr = (paise: number | null): string =>
  paise === null ? 'Amount not set' : formatINR(paise);

export function dayMonth(iso: string): { day: string; month: string } {
  const p = parseISO(iso);
  return { day: String(p.d), month: MONTHS[p.m - 1] };
}

export function weekdayDate(iso: string): string {
  const p = parseISO(iso);
  const wd = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  return `${DAYS[wd]}, ${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

export function localDateTime(isoInstant: string, tz = 'Asia/Kolkata'): string {
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: tz,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(isoInstant));
  } catch {
    return isoInstant;
  }
}

/** Calm, plain-language confidence copy for badges. */
export function confidenceCopy(field: 'Date' | 'Amount', c: ValueConfidence): string {
  switch (c) {
    case 'confirmed':
      return `${field} confirmed`;
    case 'estimated':
      return `${field} estimated`;
    case 'user_entered':
      return `${field} entered by you`;
    case 'imported':
      return `${field} imported`;
  }
}

export function confidenceTone(c: ValueConfidence): 'calm' | 'plain' | 'warm' {
  return c === 'confirmed' ? 'calm' : c === 'estimated' ? 'warm' : 'plain';
}

export function bandCopy(band: 'high' | 'medium' | 'low' | 'missing'): string {
  return band === 'high'
    ? 'High confidence'
    : band === 'medium'
      ? 'Check this'
      : band === 'low'
        ? 'Low confidence'
        : 'Not found';
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}
