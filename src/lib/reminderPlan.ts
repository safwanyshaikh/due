/**
 * Reminders v2: per-obligation lead times, quiet hours in the user's timezone, severity,
 * snooze, acknowledge, channel preference and honest delivery status.
 *
 * Delivery status is never 'sent' unless a delivery result recorded via `recordDeliveryResult`
 * says so. Channels that are not available (no server/provider configured) are 'unavailable'.
 */
import { commit, type MutationContext, type MutationResult } from './audit';
import { addDays, formatDate } from './dates';
import { formatINR } from './money';
import { forecastObligations, obligationOccurrences } from './obligations';
import { normalizeOffsets } from './reminders';
import { DEFAULT_TZ, shiftOutOfQuietHours, toZoned, zonedToUtc, type QuietHours } from './tz';
import type { AppData, Commitment, ISODate } from './types';

export type ReminderSeverity = 'info' | 'normal' | 'important';
export type DeliveryChannel = 'in_app' | 'email' | 'push';
export type DeliveryStatus = 'scheduled' | 'shown' | 'sent' | 'failed' | 'unavailable';
export type PlannedReminderKind = 'due' | 'trial_ending';

export interface DeliveryAttempt {
  channel: DeliveryChannel;
  result: 'sent' | 'failed' | 'shown';
  at: string;
  /** Provider message id or error text from the delivery service. */
  detail?: string;
}

/** Persisted per-reminder state (keyed by the reminder key). */
export interface ReminderState {
  key: string;
  acknowledgedAt?: string | null;
  snoozedUntil?: string | null;
  attempts: DeliveryAttempt[];
}

export interface PlannedReminder {
  /** Idempotent: obligationId:kind:occurrenceDate:leadDays */
  key: string;
  obligationId: string;
  occurrenceDate: ISODate;
  /** Effective due date of the occurrence. */
  dueDate: ISODate;
  kind: PlannedReminderKind;
  leadDays: number;
  title: string;
  body: string;
  severity: ReminderSeverity;
  channel: DeliveryChannel;
  /** UTC instant the reminder should surface. */
  scheduledFor: string;
  localDate: ISODate;
  localTime: string;
  timezone: string;
  shiftedForQuietHours: boolean;
  status: DeliveryStatus;
  acknowledged: boolean;
  snoozedUntil: string | null;
}

export interface PlanOptions {
  /** Days ahead to plan (default 60). */
  horizonDays?: number;
  /** Which channels can actually deliver right now. Default: only in_app. */
  available?: Partial<Record<DeliveryChannel, boolean>>;
  /** Include reminders whose time has already passed (default true; still pending until acknowledged). */
  includePast?: boolean;
}

export const DEFAULT_REMINDER_TIME = '09:00';
export const DEFAULT_QUIET_HOURS: QuietHours = { start: '22:00', end: '07:00' };

function severityOf(c: Commitment): ReminderSeverity {
  if (c.reminder.severity) return c.reminder.severity;
  return c.importance === 'essential'
    ? 'important'
    : c.importance === 'optional'
      ? 'info'
      : 'normal';
}

function stateOf(data: AppData, key: string): ReminderState | undefined {
  return (data.reminderStates ?? []).find((s) => s.key === key);
}

/** Status from recorded results only. */
export function deliveryStatus(
  state: ReminderState | undefined,
  channel: DeliveryChannel,
  available: boolean,
): DeliveryStatus {
  const last = state?.attempts.filter((a) => a.channel === channel).pop();
  if (last?.result === 'sent') return 'sent';
  if (last?.result === 'failed') return 'failed';
  if (last?.result === 'shown') return 'shown';
  return available ? 'scheduled' : 'unavailable';
}

/**
 * Full reminder plan for the next `horizonDays`. Paid occurrences and acknowledged reminders are
 * dropped; snoozed occurrences/reminders are re-timed to the snooze date.
 */
export function planReminders(
  data: AppData,
  now: Date | string,
  opts: PlanOptions = {},
): PlannedReminder[] {
  const nowDate = typeof now === 'string' ? new Date(now) : now;
  const tz = data.settings.timezone || DEFAULT_TZ;
  const quiet = data.settings.quietHours ?? DEFAULT_QUIET_HOURS;
  const today = toZoned(nowDate, tz).date;
  const horizon = opts.horizonDays ?? 60;
  const available: Partial<Record<DeliveryChannel, boolean>> = { in_app: true, ...opts.available };
  const out: PlannedReminder[] = [];
  for (const c of forecastObligations(data)) {
    if (!c.reminder.enabled) continue;
    const leads = normalizeOffsets(c.reminder.offsets);
    const maxLead = Math.max(0, ...leads);
    const name = c.nickname || c.provider;
    const channel = c.reminder.channel ?? data.settings.deliveryChannel ?? 'in_app';
    const time = c.reminder.time ?? DEFAULT_REMINDER_TIME;
    const occs = obligationOccurrences(c, today, addDays(today, horizon + maxLead), today);
    const targets: {
      kind: PlannedReminderKind;
      date: ISODate;
      occ: ISODate;
      snoozedUntil: ISODate | null;
      amount: number | null;
    }[] = [];
    for (const o of occs) {
      if (o.status === 'paid') continue;
      targets.push({
        kind: 'due',
        date: o.date,
        occ: o.occurrenceDate,
        snoozedUntil: o.snoozedUntil,
        amount: o.amountPaise,
      });
    }
    const trialEnd = c.rule.kind === 'trial_to_paid' ? c.rule.trialEnd : c.subscription?.trialEnd;
    if (trialEnd && trialEnd >= today && trialEnd <= addDays(today, horizon)) {
      // Trial reminders go out ahead of the first paid charge.
      const tl = [...new Set([...leads.filter((l) => l > 0), 3, 1])];
      for (const lead of tl) {
        const key = `${c.id}:trial_ending:${trialEnd}:${lead}`;
        pushReminder(key, 'trial_ending', trialEnd, trialEnd, lead, null, null);
      }
    }
    for (const t of targets) {
      for (const lead of leads) {
        const key = `${c.id}:due:${t.occ}:${lead}`;
        pushReminder(key, 'due', t.date, t.occ, lead, t.snoozedUntil, t.amount);
      }
    }

    function pushReminder(
      key: string,
      kind: PlannedReminderKind,
      dueDate: ISODate,
      occurrenceDate: ISODate,
      lead: number,
      occSnooze: ISODate | null,
      amount: number | null,
    ) {
      const state = stateOf(data, key);
      if (state?.acknowledgedAt) return;
      let localDate = addDays(dueDate, -lead);
      let localTime = time;
      const snoozeLocal = state?.snoozedUntil ? toZoned(state.snoozedUntil, tz) : null;
      if (occSnooze && occSnooze > localDate) {
        localDate = occSnooze;
      }
      if (
        snoozeLocal &&
        (snoozeLocal.date > localDate ||
          (snoozeLocal.date === localDate && snoozeLocal.time > localTime))
      ) {
        localDate = snoozeLocal.date;
        localTime = snoozeLocal.time;
      }
      if (localDate > dueDate) return; // snoozed past the date
      const shifted = shiftOutOfQuietHours(localDate, localTime, quiet);
      const at = zonedToUtc(shifted.date, shifted.time, tz);
      if (opts.includePast === false && at < nowDate) return;
      if (shifted.date < today && dueDate < today) return;
      const isAvail = !!available[channel];
      const amountText = amount === null ? '' : ` ${formatINR(amount)}`;
      out.push({
        key,
        obligationId: c.id,
        occurrenceDate,
        dueDate,
        kind,
        leadDays: lead,
        title:
          kind === 'trial_ending'
            ? `${name} trial ends ${formatDate(dueDate)}`
            : `${name}${amountText} due ${lead === 0 ? 'today' : formatDate(dueDate)}`,
        body:
          kind === 'trial_ending'
            ? 'Decide whether to keep it before the first paid charge.'
            : 'Review it when you are ready. Due does not make payments.',
        severity: kind === 'trial_ending' ? 'important' : severityOf(c),
        channel,
        scheduledFor: at.toISOString(),
        localDate: shifted.date,
        localTime: shifted.time,
        timezone: tz,
        shiftedForQuietHours: shifted.shifted,
        status: deliveryStatus(state, channel, isAvail),
        acknowledged: false,
        snoozedUntil: state?.snoozedUntil ?? occSnooze ?? null,
      });
    }
  }
  return out.sort(
    (a, b) => a.scheduledFor.localeCompare(b.scheduledFor) || a.key.localeCompare(b.key),
  );
}

/** Reminders to surface now: due by `now`, one per occurrence (the most imminent lead time). */
export function dueReminders(plan: PlannedReminder[], now: Date | string): PlannedReminder[] {
  const t = (typeof now === 'string' ? new Date(now) : now).toISOString();
  const best = new Map<string, PlannedReminder>();
  for (const r of plan) {
    if (r.scheduledFor > t) continue;
    const k = `${r.obligationId}:${r.kind}:${r.occurrenceDate}`;
    const cur = best.get(k);
    if (!cur || r.leadDays < cur.leadDays) best.set(k, r);
  }
  return [...best.values()].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

function putState(data: AppData, st: ReminderState): AppData {
  const list = data.reminderStates ?? [];
  const exists = list.some((s) => s.key === st.key);
  return {
    ...data,
    reminderStates: exists ? list.map((s) => (s.key === st.key ? st : s)) : [...list, st],
  };
}

function baseState(data: AppData, key: string): ReminderState {
  return stateOf(data, key) ?? { key, attempts: [] };
}

/** "Got it": stops this reminder. Undoable. */
export function acknowledgeReminder(
  data: AppData,
  key: string,
  ctx: MutationContext,
): MutationResult {
  const next = putState(data, { ...baseState(data, key), acknowledgedAt: ctx.now });
  return commit(
    data,
    next,
    { reminderStates: [key] },
    {
      action: 'reminder_acknowledged',
      entity: 'reminder',
      entityId: key,
      summary: 'Reminder acknowledged',
    },
    ctx,
  );
}

/** Re-surface this reminder at `until` (ISO instant). Undoable. */
export function snoozeReminder(
  data: AppData,
  key: string,
  until: string,
  ctx: MutationContext,
): MutationResult {
  const next = putState(data, { ...baseState(data, key), snoozedUntil: until });
  return commit(
    data,
    next,
    { reminderStates: [key] },
    {
      action: 'reminder_snoozed',
      entity: 'reminder',
      entityId: key,
      summary: `Reminder snoozed until ${until.slice(0, 16).replace('T', ' ')}`,
    },
    ctx,
  );
}

/** In-app display recorded (the only status the client can set by itself). */
export function markReminderShown(data: AppData, key: string, at: string): AppData {
  const st = baseState(data, key);
  if (st.attempts.some((a) => a.channel === 'in_app' && a.result === 'shown')) return data;
  return putState(data, {
    ...st,
    attempts: [...st.attempts, { channel: 'in_app', result: 'shown', at }],
  });
}

/** Records a delivery service's result. This is the only way a reminder becomes 'sent'. */
export function recordDeliveryResult(
  data: AppData,
  key: string,
  result: { channel: Exclude<DeliveryChannel, 'in_app'>; ok: boolean; at: string; detail?: string },
): AppData {
  const st = baseState(data, key);
  return putState(data, {
    ...st,
    attempts: [
      ...st.attempts,
      {
        channel: result.channel,
        result: result.ok ? 'sent' : 'failed',
        at: result.at,
        detail: result.detail,
      },
    ],
  });
}

/** Plain-English reminder state for an obligation ("Reminds 7, 3, 1 days before · in app"). */
export function reminderStateText(c: Commitment, data?: Pick<AppData, 'settings'>): string {
  if (!c.reminder.enabled) return 'Reminders off';
  const leads = normalizeOffsets(c.reminder.offsets);
  const ch = c.reminder.channel ?? data?.settings.deliveryChannel ?? 'in_app';
  const chText = ch === 'in_app' ? 'in app' : ch === 'email' ? 'by email' : 'by push';
  const before = leads.filter((l) => l > 0);
  const parts: string[] = [];
  if (before.length)
    parts.push(
      `${before.join(', ')} day${before.length === 1 && before[0] === 1 ? '' : 's'} before`,
    );
  if (leads.includes(0) || !leads.length) parts.push('on the day');
  const dayText = parts.join(' and ');
  return `Reminds ${dayText} · ${chText}`;
}
