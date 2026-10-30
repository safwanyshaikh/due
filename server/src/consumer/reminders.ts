import { z } from 'zod';
import type { Mailer } from '../alerts.js';
import type { Clock } from '../clock.js';
import type { Pool, Queryable } from '../db.js';
import { many } from '../db.js';
import { consentWithdrawn } from './consents.js';
import { computeEntitlement } from './entitlements.js';

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
 * Already-delivered reminders are kept, and a re-sent identical item is not delivered twice.
 * Items whose time passed more than 24h ago are ignored.
 */
export async function replaceSchedule(q: Queryable, accountId: string, items: ReminderItem[], now: Date): Promise<number> {
  await q.query('DELETE FROM reminder_schedule WHERE account_id = $1 AND delivered_at IS NULL', [accountId]);
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

export interface ReminderJobContext {
  pool: Pool;
  clock: Clock;
  mailer: Mailer | null;
  log: { error(obj: unknown, msg?: string): void };
  stopping?: () => boolean;
}

const MAX_ATTEMPTS = 3;
const STALE_MS = 48 * 60 * 60 * 1000;

interface DueRow {
  id: number;
  account_id: string;
  obligation_ref: string;
  title: string;
  due_date: string;
  remind_at: Date;
  channel: 'email' | 'push';
  timezone: string;
  quiet_start: string | null;
  quiet_end: string | null;
  attempts: number;
  email: string;
  status: string;
}

/**
 * The 'consumer_reminders' job: delivers due reminders by email when the account is entitled and SMTP is
 * configured, re-checks quiet hours server-side (deferring, not dropping), and records every outcome honestly.
 */
export async function runConsumerReminders(ctx: ReminderJobContext, config: Record<string, unknown>): Promise<Record<string, number>> {
  const batch = Math.min(Math.max(Number(config.batch_size ?? 200) || 200, 1), 1000);
  const now = ctx.clock();
  const rows = await many<DueRow>(
    ctx.pool,
    `SELECT r.*, a.email, a.status FROM reminder_schedule r JOIN consumer_accounts a ON a.id = r.account_id
      WHERE r.delivered_at IS NULL AND r.remind_at <= $1 ORDER BY r.remind_at LIMIT $2`,
    [now, batch],
  );
  const stats: Record<string, number> = { due: rows.length, sent: 0, failed: 0, unavailable: 0, deferred_quiet_hours: 0 };
  const entitled = new Map<string, boolean>();
  const emailConsent = new Map<string, boolean>();

  const record = async (r: DueRow, status: 'sent' | 'failed' | 'unavailable', error: string | null, messageId: string | null, final: boolean) => {
    await ctx.pool.query(
      `INSERT INTO reminder_deliveries (account_id, obligation_ref, channel, scheduled_for, status, provider_message_id, error, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [r.account_id, r.obligation_ref, r.channel, r.remind_at, status, messageId, error, now],
    );
    await ctx.pool.query(
      'UPDATE reminder_schedule SET attempts = attempts + 1, delivered_at = CASE WHEN $2 THEN $3::timestamptz ELSE NULL END WHERE id = $1',
      [r.id, final, now],
    );
    stats[status] = (stats[status] ?? 0) + 1;
  };

  for (const r of rows) {
    if (ctx.stopping?.()) break;
    if (now.getTime() - r.remind_at.getTime() > STALE_MS) {
      await record(r, 'unavailable', 'stale: the reminder time passed more than 48 hours before delivery was possible', null, true);
      continue;
    }
    if (r.status !== 'active') {
      await record(r, 'unavailable', 'account_disabled', null, true);
      continue;
    }
    if (r.channel === 'push') {
      await record(r, 'unavailable', 'push_not_configured: push delivery is not available on this server', null, true);
      continue;
    }
    if (r.channel === 'email') {
      if (!emailConsent.has(r.account_id)) emailConsent.set(r.account_id, !(await consentWithdrawn(ctx.pool, r.account_id, 'reminders_email')));
      if (!emailConsent.get(r.account_id)) {
        await record(r, 'unavailable', 'consent_withdrawn', null, true);
        continue;
      }
    }
    if (!entitled.has(r.account_id)) {
      const ent = await computeEntitlement(ctx.pool, r.account_id, now);
      entitled.set(r.account_id, ent.features.includes('reminder_email'));
    }
    if (!entitled.get(r.account_id)) {
      await record(r, 'unavailable', 'premium_required: email reminders need a premium plan', null, true);
      continue;
    }
    if (!ctx.mailer) {
      await record(r, 'unavailable', 'email_unavailable: SMTP is not configured on this server', null, true);
      continue;
    }
    if (inQuietHours(now, r.timezone, r.quiet_start, r.quiet_end)) {
      stats.deferred_quiet_hours!++;
      continue;
    }
    try {
      const info = await ctx.mailer.send(
        [r.email],
        `Reminder: ${r.title} is due on ${r.due_date}`,
        `${r.title} is due on ${r.due_date}.\n\nYou asked Due to remind you about this. ` +
          `You can change, snooze or turn off this reminder in the Due app.\n`,
      );
      await record(r, 'sent', null, info?.messageId ?? null, true);
    } catch (err) {
      const final = r.attempts + 1 >= MAX_ATTEMPTS;
      ctx.log.error({ err, reminderId: r.id }, 'reminder email failed');
      await record(r, 'failed', (err as Error).message.slice(0, 500), null, final);
    }
  }
  return stats;
}
