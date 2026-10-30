/**
 * Obligation-level schedule: rule occurrences + per-occurrence overrides + append-only history.
 */
import { addDays } from './dates';
import { reconcileObligation } from './provenance';
import { occurrencesBetween, ruleAnchor, type RecurrenceRule } from './recurrence';
import { countsTowardForecast } from './status';
import type {
  AppData,
  Commitment,
  ISODate,
  OccurrenceEvent,
  OccurrenceOverride,
  ValueConfidence,
  Provenance,
} from './types';

export type OccurrenceStatus =
  'upcoming' | 'due_today' | 'overdue' | 'paid' | 'snoozed' | 'reviewed';

export interface ObligationOccurrence {
  obligationId: string;
  /** Original generated date: the occurrence's identity (used by overrides and history). */
  occurrenceDate: ISODate;
  /** Effective date after any override. */
  date: ISODate;
  amountPaise: number | null;
  amountConfidence: ValueConfidence;
  dateConfidence: ValueConfidence;
  amountSource: Provenance;
  dateSource: Provenance;
  override: OccurrenceOverride | null;
  status: OccurrenceStatus;
  snoozedUntil: ISODate | null;
  /** Latest live history event per kind for this occurrence. */
  paidEvent: OccurrenceEvent | null;
  reviewedEvent: OccurrenceEvent | null;
}

/** Obligations that are not soft-deleted (v2 fields reconciled). */
export function activeObligations(data: Pick<AppData, 'commitments'>): Commitment[] {
  return data.commitments.filter((c) => !c.deletedAt).map(reconcileObligation);
}

/** Active obligations whose status still counts toward forecasts (not confirmed cancelled/paused). */
export function forecastObligations(data: Pick<AppData, 'commitments'>): Commitment[] {
  return activeObligations(data).filter((c) => countsTowardForecast(c.status));
}

export function findObligation(data: Pick<AppData, 'commitments'>, id: string): Commitment | null {
  const c = data.commitments.find((x) => x.id === id);
  return c ? reconcileObligation(c) : null;
}

/** History events that have not been revoked. */
export function liveHistory(ob: Pick<Commitment, 'history'>): OccurrenceEvent[] {
  const revoked = new Set(ob.history.filter((e) => e.kind === 'revoked').map((e) => e.revokes));
  return ob.history.filter((e) => e.kind !== 'revoked' && !revoked.has(e.id));
}

/** Latest override per original occurrence date (later `at` wins). */
export function overrideFor(ob: Pick<Commitment, 'overrides'>, occurrenceDate: ISODate) {
  let best: OccurrenceOverride | null = null;
  for (const o of ob.overrides)
    if (o.occurrenceDate === occurrenceDate && (!best || o.at >= best.at)) best = o;
  return best;
}

function statusFor(
  date: ISODate,
  events: OccurrenceEvent[],
  today: ISODate,
  userMarkedOverdue: boolean,
): {
  status: OccurrenceStatus;
  snoozedUntil: ISODate | null;
  paid: OccurrenceEvent | null;
  reviewed: OccurrenceEvent | null;
} {
  const latest = (k: OccurrenceEvent['kind']) =>
    events
      .filter((e) => e.kind === k)
      .sort((a, b) => a.at.localeCompare(b.at))
      .pop() ?? null;
  const paid = latest('paid');
  const reviewed = latest('reviewed');
  const snooze = latest('snoozed');
  const snoozedUntil = snooze?.until && snooze.until > today ? snooze.until : null;
  let status: OccurrenceStatus;
  if (paid) status = 'paid';
  else if (snoozedUntil) status = 'snoozed';
  else if (date < today && userMarkedOverdue) status = 'overdue';
  else if (reviewed) status = 'reviewed';
  else if (date < today) status = 'overdue';
  else if (date === today) status = 'due_today';
  else status = 'upcoming';
  return { status, snoozedUntil, paid, reviewed };
}

/** Rule occurrences in a window around [start, end], with overrides applied, sorted by effective date. */
export function obligationOccurrences(
  input: Commitment,
  start: ISODate,
  end: ISODate,
  today: ISODate = start,
): ObligationOccurrence[] {
  const ob = reconcileObligation(input);
  // Overrides can move a date by any amount; widen the generation window to catch them.
  const shifts = ob.overrides
    .filter((o) => o.newDate)
    .map((o) => Math.abs(Date.parse(o.newDate!) - Date.parse(o.occurrenceDate)) / 86_400_000);
  const pad = Math.ceil(Math.max(0, ...shifts));
  const raw = occurrencesBetween(ob.rule, addDays(start, -pad), addDays(end, pad));
  const history = liveHistory(ob);
  const out: ObligationOccurrence[] = [];
  for (const r of raw) {
    const ov = overrideFor(ob, r.date);
    const date = ov?.newDate ?? r.date;
    if (date < start || date > end) continue;
    const baseAmount = r.amountPaise !== undefined ? r.amountPaise : ob.amount.value;
    const amountPaise =
      ov && ov.newAmountPaise !== undefined ? ov.newAmountPaise : (baseAmount ?? null);
    const s = statusFor(
      date,
      history.filter((e) => e.occurrenceDate === r.date),
      today,
      ob.status === 'overdue_user_entered',
    );
    out.push({
      obligationId: ob.id,
      occurrenceDate: r.date,
      date,
      amountPaise,
      amountConfidence:
        ov && ov.newAmountPaise !== undefined ? ov.confidence : ob.amount.confidence,
      amountSource: ov && ov.newAmountPaise !== undefined ? ov.source : ob.amount.source,
      // Generated dates inherit the anchor's confidence; an override carries its own.
      dateConfidence: ov?.newDate ? ov.confidence : ob.date.confidence,
      dateSource: ov?.newDate ? ov.source : ob.date.source,
      override: ov,
      status: s.status,
      snoozedUntil: s.snoozedUntil,
      paidEvent: s.paid,
      reviewedEvent: s.reviewed,
    });
  }
  return out.sort(
    (a, b) => a.date.localeCompare(b.date) || a.occurrenceDate.localeCompare(b.occurrenceDate),
  );
}

/** How far ahead selectors look for a "next" occurrence. */
export const NEXT_HORIZON_DAYS = 800;

/**
 * The occurrence that matters now:
 * - the first not-yet-paid occurrence dated today or later, else
 * - for one-time/irregular items (or items you marked overdue), the latest unpaid past occurrence
 *   (status 'overdue'). Past occurrences of recurring auto-renewals are not called overdue.
 * Returns null when nothing is pending (e.g. a paid one-time item, or irregular with no date).
 */
export function effectiveNext(input: Commitment, today: ISODate): ObligationOccurrence | null {
  const ob = reconcileObligation(input);
  const anchor = ruleAnchor(ob.rule);
  if (!anchor) return null;
  const from = anchor < today ? anchor : today;
  const all = obligationOccurrences(ob, from, addDays(today, NEXT_HORIZON_DAYS), today);
  const userOverdue = ob.status === 'overdue_user_entered';
  if (userOverdue) {
    const past = all.filter((o) => o.date < today && o.status !== 'paid').pop();
    if (past) return past;
  }
  const future = all.find((o) => o.date >= today && o.status !== 'paid');
  if (future) return future;
  if (isSingle(ob.rule)) {
    const past = all.filter((o) => o.date < today && o.status !== 'paid').pop();
    if (past) return past;
  }
  return null;
}

function isSingle(rule: RecurrenceRule): boolean {
  return rule.kind === 'one_time' || rule.kind === 'irregular';
}

/** Most recent occurrence on or before today (any status), for "last paid" style displays. */
export function lastOccurrence(input: Commitment, today: ISODate): ObligationOccurrence | null {
  const ob = reconcileObligation(input);
  const anchor = ruleAnchor(ob.rule);
  if (!anchor || anchor > today) return null;
  return obligationOccurrences(ob, anchor, today, today).pop() ?? null;
}
