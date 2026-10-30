import { addDays } from './dates';
import { occurrences } from './schedule';
import { countsTowardForecast } from './status';
import type { Commitment, ISODate, Season, Settings } from './types';

export type ReminderType =
  | 'renewal'
  | 'due_date'
  | 'trial_end'
  | 'cancellation_by'
  | 'season_consider'
  | 'season_review'
  | 'season_restart';

export interface ReminderItem {
  /** Idempotency key: same inputs always yield the same key. */
  key: string;
  targetKey: string;
  ownerId: string;
  type: ReminderType;
  label: string;
  targetDate: ISODate;
  remindOn: ISODate;
  offset: number;
}

export const DEFAULT_OFFSETS = [7, 3, 1];

export function normalizeOffsets(offsets: number[]): number[] {
  return [...new Set(offsets.filter((o) => Number.isInteger(o) && o >= 0 && o <= 60))].sort(
    (a, b) => b - a,
  );
}

function expand(
  ownerId: string,
  type: ReminderType,
  label: string,
  targetDate: ISODate,
  offsets: number[],
): ReminderItem[] {
  const targetKey = `${ownerId}:${type}:${targetDate}`;
  return normalizeOffsets(offsets).map((offset) => ({
    key: `${targetKey}:${offset}`,
    targetKey,
    ownerId,
    type,
    label,
    targetDate,
    remindOn: addDays(targetDate, -offset),
    offset,
  }));
}

export function remindersForCommitment(c: Commitment): ReminderItem[] {
  if (!c.reminder.enabled || !countsTowardForecast(c.status)) return [];
  const name = c.nickname || c.provider;
  const o = c.reminder.offsets;
  const out: ReminderItem[] = [];
  out.push(
    ...expand(
      c.id,
      c.type === 'subscription' ? 'renewal' : 'due_date',
      c.type === 'subscription' ? `${name} renews` : `${name} is due`,
      c.nextDue,
      o,
    ),
  );
  const sub = c.subscription;
  if (sub?.trialEnd) out.push(...expand(c.id, 'trial_end', `${name} trial ends`, sub.trialEnd, o));
  if (sub?.cancellationBy) {
    out.push(
      ...expand(c.id, 'cancellation_by', `${name}: cancellation-by date`, sub.cancellationBy, o),
    );
  }
  return out;
}

export function remindersForSeason(season: Season, commitments: Commitment[]): ReminderItem[] {
  const out: ReminderItem[] = [];
  out.push(
    ...expand(
      season.id,
      'season_consider',
      `Consider subscribing: ${season.name} starts`,
      season.start,
      [season.considerLeadDays],
    ),
  );
  for (const id of season.linkedCommitmentIds) {
    const c = commitments.find((x) => x.id === id);
    if (!c) continue;
    const renewal = firstRenewalOnOrAfter(c, season.end);
    if (renewal) {
      out.push(
        ...expand(
          `${season.id}:${c.id}`,
          'season_review',
          `Review ${c.nickname || c.provider} before it renews`,
          renewal,
          [season.reviewLeadDays],
        ),
      );
    }
  }
  if (season.restartDate) {
    out.push(
      ...expand(
        season.id,
        'season_restart',
        `Restart planned: ${season.name}`,
        season.restartDate,
        [1],
      ),
    );
  }
  return out;
}

function firstRenewalOnOrAfter(c: Commitment, date: ISODate): ISODate | null {
  const o = occurrences(c, { start: date, end: addDays(date, 800) });
  return o.length ? o[0].date : null;
}

export function allReminders(commitments: Commitment[], seasons: Season[]): ReminderItem[] {
  const seen = new Set<string>();
  const out: ReminderItem[] = [];
  for (const r of [
    ...commitments.flatMap(remindersForCommitment),
    ...seasons.flatMap((s) => remindersForSeason(s, commitments)),
  ]) {
    if (seen.has(r.key)) continue;
    seen.add(r.key);
    out.push(r);
  }
  return out;
}

/**
 * Reminders to surface today: one per target date (the most imminent offset that has started),
 * only while the target date has not passed. Prevents duplicate 7/3/1-day reminders.
 */
export function activeReminders(items: ReminderItem[], today: ISODate): ReminderItem[] {
  const best = new Map<string, ReminderItem>();
  for (const r of items) {
    if (r.remindOn > today || r.targetDate < today) continue;
    const cur = best.get(r.targetKey);
    if (!cur || r.offset < cur.offset) best.set(r.targetKey, r);
  }
  return [...best.values()].sort((a, b) => a.targetDate.localeCompare(b.targetDate));
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function isQuietTime(hhmm: string, quiet: Settings['quietHours']): boolean {
  const t = toMinutes(hhmm);
  const s = toMinutes(quiet.start);
  const e = toMinutes(quiet.end);
  if (s === e) return false;
  return s < e ? t >= s && t < e : t >= s || t < e;
}

/** Preferred send time (09:00 by default), pushed to the end of quiet hours if it falls inside them. */
export function reminderLocalTime(settings: Settings, preferred = '09:00'): string {
  return isQuietTime(preferred, settings.quietHours) ? settings.quietHours.end : preferred;
}

export const CHANNEL_AVAILABILITY: Record<
  Settings['channel'],
  { available: boolean; note: string }
> = {
  in_app: { available: true, note: 'Shown inside the app when you open it.' },
  calendar_ics: {
    available: true,
    note: 'Export a calendar file (.ics) and import it in your calendar app.',
  },
  email: {
    available: false,
    note: 'Unavailable: email delivery is not configured or tested in this beta.',
  },
  whatsapp: {
    available: false,
    note: 'Unavailable: WhatsApp delivery is not configured or tested in this beta.',
  },
};
