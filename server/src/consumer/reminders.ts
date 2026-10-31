import { z } from 'zod';
import type { Queryable } from '../db.js';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** One reminder from the client's resolved reminder plan (lead time already applied to remindAt). */
export const ReminderItem = z
  .object({
    obligationRef: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
    remindAt: z.string().datetime({ offset: true }),
    channel: z.enum(['email', 'push']),
    timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown IANA time zone').default('Asia/Kolkata'),
    quietHours: z.object({ start: hhmm, end: hhmm }).strict().nullable().default(null),
  })
  .strict();
export type ReminderItem = z.infer<typeof ReminderItem>;
export const ReminderPlan = z.array(ReminderItem).max(1000);

/** Minutes since local midnight in `tz`. */
export function localMinutes(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return (h % 24) * 60 + m;
}

/** True when `at` falls inside [start, end) local time in `tz`; windows may wrap midnight (22:00–07:00). */
export function inQuietHours(at: Date, tz: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const m = localMinutes(at, tz);
  const s = toMin(start);
  const e = toMin(end);
  return s < e ? m >= s && m < e : m >= s || m < e;
}

/**
 * Replaces an account's pending (undelivered) reminder schedule with the client's plan.
 * Closed reminders (sent or with a final outcome) are kept, and a re-sent identical item is not delivered twice.
 * Items whose time passed more than 24h ago are ignored.
 */
export async function replaceSchedule(q: Queryable, accountId: string, items: ReminderItem[], now: Date): Promise<number> {
  await q.query('DELETE FROM reminder_schedule WHERE account_id = $1 AND closed_at IS NULL', [accountId]);
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  let stored = 0;
  for (const it of items) {
    const at = new Date(it.remindAt);
    if (at.getTime() < cutoff) continue;
    const r = await q.query(
      `INSERT INTO reminder_schedule (account_id, obligation_ref, title, due_date, remind_at, channel, timezone, quiet_start, quiet_end, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (account_id, obligation_ref, remind_at, channel) DO NOTHING`,
      [accountId, it.obligationRef, it.title, it.dueDate, at, it.channel, it.timezone, it.quietHours?.start ?? null, it.quietHours?.end ?? null, now],
    );
    stored += r.rowCount ?? 0;
  }
  return stored;
}

// Delivery runs on the durable queue: see consumer/notifications.ts (enqueueDueReminders, deliverReminder).
