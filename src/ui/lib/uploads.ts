/**
 * Document upload allowance: 5 documents a calendar month (India time) for guests and Free accounts,
 * unlimited on Plus. Guests are counted on this device; signed-in accounts are counted by the server
 * (POST /api/account/uploads/count, which refuses once the allowance is used).
 */
import { readJsonPref, writeJsonPref } from './prefs';

export const FREE_UPLOADS_PER_MONTH = 5;

/** YYYY-MM in Asia/Kolkata (months roll over at midnight IST, matching the server). */
export function uploadMonth(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 7);
}

interface GuestCounter {
  month: string;
  used: number;
}

export function guestUploadsUsed(now: Date = new Date()): number {
  const c = readJsonPref<GuestCounter | null>('guest-uploads', null);
  return c && c.month === uploadMonth(now) ? Math.max(0, c.used | 0) : 0;
}

export function guestUploadsRemaining(now: Date = new Date()): number {
  return Math.max(0, FREE_UPLOADS_PER_MONTH - guestUploadsUsed(now));
}

/** Counts one guest upload; returns false (and counts nothing) once this month's allowance is used. */
export function countGuestUpload(now: Date = new Date()): boolean {
  const used = guestUploadsUsed(now);
  if (used >= FREE_UPLOADS_PER_MONTH) return false;
  writeJsonPref('guest-uploads', { month: uploadMonth(now), used: used + 1 });
  return true;
}

export function remainingText(remaining: number | null): string {
  if (remaining === null) return 'Unlimited documents on Plus';
  return `${remaining} of ${FREE_UPLOADS_PER_MONTH} document uploads left this month`;
}
