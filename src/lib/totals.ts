import { addDays, daysBetween, parseISO, toISO } from './dates';
import { monthlyEquivalentPaise, occurrences, stepMonths } from './schedule';
import { countsTowardForecast } from './status';
import type { AppData, Commitment, CommitmentType, ISODate, Period } from './types';

/** component id -> parent statement id, only for user-confirmed links whose parent still exists. */
export function linkedParentMap(data: AppData): Map<string, string> {
  const ids = new Set(data.commitments.map((c) => c.id));
  const map = new Map<string, string>();
  for (const l of data.links) {
    if (l.confirmedByUser && ids.has(l.parentId) && ids.has(l.componentId)) {
      map.set(l.componentId, l.parentId);
    }
  }
  return map;
}

export interface CashItem {
  commitment: Commitment;
  date: ISODate;
  amountPaise: number | null;
}

export interface CashForecast {
  totalPaise: number;
  items: CashItem[];
  /** Occurrences with no amount entered. They are not counted as zero. */
  unknownAmountCount: number;
  estimateCount: number;
}

/**
 * Cash-outflow forecast: top-level obligations only. Anything the user confirmed is
 * included in a card statement is skipped here because the statement already contains it.
 */
export function cashForecast(data: AppData, period: Period): CashForecast {
  const linked = linkedParentMap(data);
  const items: CashItem[] = [];
  let totalPaise = 0;
  let unknownAmountCount = 0;
  let estimateCount = 0;
  for (const c of data.commitments) {
    if (!countsTowardForecast(c.status) || linked.has(c.id)) continue;
    for (const o of occurrences(c, period)) {
      items.push({ commitment: c, date: o.date, amountPaise: o.amountPaise });
      if (o.amountPaise === null) unknownAmountCount++;
      else {
        totalPaise += o.amountPaise;
        if (c.amountConfidence !== 'confirmed') estimateCount++;
      }
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { totalPaise, items, unknownAmountCount, estimateCount };
}

export interface RunRate {
  totalPaise: number;
  byType: Partial<Record<CommitmentType, number>>;
  /** Recurring items with no amount, or one-time items: not counted. */
  skippedCount: number;
}

/** Monthly run-rate (planning estimate). Items included in a card statement are not added twice. */
export function runRate(data: AppData): RunRate {
  const linked = linkedParentMap(data);
  const byType: Partial<Record<CommitmentType, number>> = {};
  let totalPaise = 0;
  let skippedCount = 0;
  for (const c of data.commitments) {
    if (!countsTowardForecast(c.status) || linked.has(c.id)) continue;
    const eq = monthlyEquivalentPaise(c);
    if (eq === null) {
      if (stepMonths(c) !== null) skippedCount++;
      continue;
    }
    byType[c.type] = (byType[c.type] ?? 0) + eq;
    totalPaise += eq;
  }
  return { totalPaise, byType, skippedCount };
}

export interface Breakdown {
  byType: Partial<Record<CommitmentType, number>>;
  totalPaise: number;
  warnings: string[];
}

/**
 * Category breakdown aligned with the cash forecast: each card statement is split into the
 * components the user linked to it plus an "other card spend" remainder, so
 * the breakdown total equals the cash total (unless components exceed the statement, which warns).
 */
export function cashBreakdown(data: AppData, period: Period): Breakdown {
  const linked = linkedParentMap(data);
  const byType: Breakdown['byType'] = {};
  const warnings: string[] = [];
  const add = (t: CommitmentType, v: number) => {
    byType[t] = (byType[t] ?? 0) + v;
  };
  for (const c of data.commitments) {
    if (!countsTowardForecast(c.status) || linked.has(c.id)) continue;
    const components = data.commitments.filter(
      (x) => linked.get(x.id) === c.id && countsTowardForecast(x.status),
    );
    for (const o of occurrences(c, period)) {
      if (o.amountPaise === null) continue;
      if (c.type !== 'credit_card' || components.length === 0) {
        add(c.type, o.amountPaise);
        continue;
      }
      const win = statementWindow(c, o.date);
      let componentSum = 0;
      for (const comp of components) {
        for (const co of occurrences(comp, win)) {
          if (co.amountPaise === null) continue;
          componentSum += co.amountPaise;
          add(comp.type, co.amountPaise);
        }
      }
      if (componentSum > o.amountPaise) {
        warnings.push(
          `Items linked to "${c.nickname || c.provider}" add up to more than the statement amount. Check the amounts or links.`,
        );
      }
      add('credit_card', Math.max(0, o.amountPaise - componentSum));
    }
  }
  const totalPaise = Object.values(byType).reduce((a, b) => a + (b ?? 0), 0);
  return { byType, totalPaise, warnings };
}

function statementWindow(c: Commitment, dueDate: ISODate): Period {
  const s = c.statement;
  if (c.frequency === 'one_time' && s?.periodStart && s.periodEnd && s.periodStart <= s.periodEnd) {
    return { start: s.periodStart, end: s.periodEnd };
  }
  const { y, m } = parseISO(dueDate);
  return { start: toISO(y, m, 1), end: dueDate };
}

/** Monthly run-rate of optional subscriptions, including ones paid via a card statement. */
export function discretionaryRunRatePaise(data: AppData): number {
  let total = 0;
  for (const c of data.commitments) {
    if (c.type !== 'subscription' || c.importance !== 'optional') continue;
    if (!countsTowardForecast(c.status)) continue;
    total += monthlyEquivalentPaise(c) ?? 0;
  }
  return total;
}

export function dueSoon(data: AppData, today: ISODate, days = 7): Commitment[] {
  const end = addDays(today, days);
  return data.commitments
    .filter((c) => countsTowardForecast(c.status) && c.nextDue >= today && c.nextDue <= end)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
}

export function markedOverdue(data: AppData): Commitment[] {
  return data.commitments.filter((c) => c.status === 'overdue_user_entered');
}

/** Dates in the past that the user may want to roll forward. Not a statement about payment. */
export function datePassed(c: Commitment, today: ISODate): boolean {
  return countsTowardForecast(c.status) && daysBetween(c.nextDue, today) > 0;
}
