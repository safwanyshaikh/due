/**
 * Recurrence engine v2. Pure functions over calendar dates (ISODate, user's timezone).
 *
 * Anchor-day drift prevention: the k-th occurrence is always computed from the rule's
 * anchor (`start` + k steps), never from the previous occurrence, so "31 Jan monthly"
 * yields 28/29 Feb and then 31 Mar again (not 28 Mar).
 */
import { addDays, daysInMonth, parseISO, toISO } from './dates';
import { formatINR } from './money';
import type { ISODate } from './types';

/** 0 = Sunday … 6 = Saturday (same as Date#getUTCDay). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;
/** 1st–4th, or -1 for "last". */
export type NthWeekday = 1 | 2 | 3 | 4 | -1;

interface Bounded {
  /** Stop after this many occurrences (counted from `start`). null/undefined = open-ended. */
  count?: number | null;
  /** No occurrences after this date (inclusive bound). */
  until?: ISODate | null;
}

export interface OneTimeRule {
  kind: 'one_time';
  start: ISODate;
}
export interface MonthlyRule extends Bounded {
  kind: 'monthly';
  start: ISODate;
  /** 1–31. Clamped to the last day in shorter months. */
  dayOfMonth: number;
}
export interface QuarterlyRule extends Bounded {
  kind: 'quarterly';
  start: ISODate;
  /** Defaults to the day of `start`. */
  dayOfMonth?: number;
}
export interface HalfYearlyRule extends Bounded {
  kind: 'half_yearly';
  start: ISODate;
  dayOfMonth?: number;
}
export interface AnnualRule extends Bounded {
  kind: 'annual';
  start: ISODate;
  /** 1–12 */
  month: number;
  /** 1–31; 29 Feb falls on 28 Feb in non-leap years. */
  day: number;
}
export interface EndOfMonthRule extends Bounded {
  kind: 'end_of_month';
  start: ISODate;
  /** Default 1. */
  intervalMonths?: number;
}
export interface WeekdayRule extends Bounded {
  kind: 'weekday';
  start: ISODate;
  weekday: Weekday;
  /** Nth weekday of the month (e.g. -1 = last). Exclusive with `everyWeeks`. */
  nth?: NthWeekday;
  /** With `nth`: every N months (default 1). */
  intervalMonths?: number;
  /** Every N weeks on `weekday`, starting on/after `start`. Exclusive with `nth`. */
  everyWeeks?: number;
}
export interface CustomMonthsRule extends Bounded {
  kind: 'custom_months';
  start: ISODate;
  intervalMonths: number;
  dayOfMonth?: number;
}
/** Rules a trial can convert into. */
export type PaidRule =
  | MonthlyRule
  | QuarterlyRule
  | HalfYearlyRule
  | AnnualRule
  | EndOfMonthRule
  | WeekdayRule
  | CustomMonthsRule;
export interface TrialToPaidRule {
  kind: 'trial_to_paid';
  /** Last day of the free/discounted trial; the first paid charge follows the paid rule on/after it. */
  trialEnd: ISODate;
  paid: PaidRule;
  /** Paid amount in paise once the trial converts. null = not known yet. */
  paidAmountPaise: number | null;
}
export interface IrregularRule {
  kind: 'irregular';
  /** User-supplied next date only. The engine never invents one. */
  nextDate: ISODate | null;
}

export type RecurrenceRule = OneTimeRule | PaidRule | TrialToPaidRule | IrregularRule;
export type RuleKind = RecurrenceRule['kind'];

export const RULE_KINDS: RuleKind[] = [
  'one_time',
  'monthly',
  'quarterly',
  'half_yearly',
  'annual',
  'end_of_month',
  'weekday',
  'custom_months',
  'trial_to_paid',
  'irregular',
];

export interface RuleOccurrence {
  date: ISODate;
  /** 0-based position in the rule's sequence (stable across queries). */
  seq: number;
  /** Set only when the rule itself dictates an amount (trial_to_paid paid phase). */
  amountPaise?: number | null;
  phase?: 'paid';
}

const MAX_STEPS = 20_000;

function clampDay(y: number, m: number, d: number): ISODate {
  return toISO(y, m, Math.min(Math.max(1, d), daysInMonth(y, m)));
}

function monthOffset(start: ISODate, k: number): { y: number; m: number } {
  const { y, m } = parseISO(start);
  const total = y * 12 + (m - 1) + k;
  return { y: Math.floor(total / 12), m: (total % 12) + 1 };
}

export function weekdayOf(date: ISODate): Weekday {
  const { y, m, d } = parseISO(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() as Weekday;
}

/** Nth weekday of a month, or null when that month has no such day (never happens for 1–4 / last). */
export function nthWeekdayOfMonth(
  y: number,
  m: number,
  weekday: Weekday,
  nth: NthWeekday,
): ISODate {
  if (nth === -1) {
    const last = toISO(y, m, daysInMonth(y, m));
    const back = (weekdayOf(last) - weekday + 7) % 7;
    return addDays(last, -back);
  }
  const first = toISO(y, m, 1);
  const fwd = (weekday - weekdayOf(first) + 7) % 7;
  return addDays(first, fwd + (nth - 1) * 7);
}

function stepMonthsOf(rule: RecurrenceRule): number | null {
  switch (rule.kind) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'half_yearly':
      return 6;
    case 'annual':
      return 12;
    case 'custom_months':
      return validInterval(rule.intervalMonths);
    case 'end_of_month':
      return validInterval(rule.intervalMonths ?? 1);
    case 'weekday':
      return rule.everyWeeks ? null : validInterval(rule.intervalMonths ?? 1);
    default:
      return null;
  }
}

function validInterval(n: number | undefined | null): number | null {
  return n != null && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/** Raw ascending date generator (ignores count/until). */
function* rawDates(rule: RecurrenceRule): Generator<ISODate> {
  switch (rule.kind) {
    case 'one_time':
      yield rule.start;
      return;
    case 'irregular':
      if (rule.nextDate) yield rule.nextDate;
      return;
    case 'trial_to_paid':
      for (const d of rawDates(rule.paid)) if (d >= rule.trialEnd) yield d;
      return;
    case 'annual': {
      const sy = parseISO(rule.start).y;
      for (let k = 0; k < MAX_STEPS; k++) {
        const d = clampDay(sy + k, rule.month, rule.day);
        if (d >= rule.start) yield d;
      }
      return;
    }
    case 'weekday': {
      if (rule.everyWeeks) {
        const weeks = validInterval(rule.everyWeeks);
        if (!weeks) return;
        const first = addDays(rule.start, (rule.weekday - weekdayOf(rule.start) + 7) % 7);
        for (let k = 0; k < MAX_STEPS; k++) yield addDays(first, k * 7 * weeks);
        return;
      }
      const step = stepMonthsOf(rule);
      if (!step || rule.nth === undefined) return;
      for (let k = 0; k < MAX_STEPS; k++) {
        const { y, m } = monthOffset(rule.start, k * step);
        const d = nthWeekdayOfMonth(y, m, rule.weekday, rule.nth);
        if (d >= rule.start) yield d;
      }
      return;
    }
    case 'end_of_month': {
      const step = stepMonthsOf(rule);
      if (!step) return;
      for (let k = 0; k < MAX_STEPS; k++) {
        const { y, m } = monthOffset(rule.start, k * step);
        const d = toISO(y, m, daysInMonth(y, m));
        if (d >= rule.start) yield d;
      }
      return;
    }
    case 'monthly':
    case 'quarterly':
    case 'half_yearly':
    case 'custom_months': {
      const step = stepMonthsOf(rule);
      if (!step) return;
      const day = rule.dayOfMonth ?? parseISO(rule.start).d;
      for (let k = 0; k < MAX_STEPS; k++) {
        const { y, m } = monthOffset(rule.start, k * step);
        const d = clampDay(y, m, day);
        if (d >= rule.start) yield d;
      }
      return;
    }
  }
}

function bounds(rule: RecurrenceRule): { count: number; until: ISODate | null } {
  if (rule.kind === 'trial_to_paid') return bounds(rule.paid);
  if (rule.kind === 'one_time' || rule.kind === 'irregular') return { count: 1, until: null };
  const count = rule.count == null ? Infinity : Math.max(0, Math.floor(rule.count));
  return { count, until: rule.until ?? null };
}

/** All occurrences in ascending order, honouring count/until. Stops at `stopAfter` (inclusive). */
function* sequence(rule: RecurrenceRule, stopAfter: ISODate): Generator<RuleOccurrence> {
  const { count, until } = bounds(rule);
  let seq = 0;
  for (const date of rawDates(rule)) {
    if (seq >= count) return;
    if (until && date > until) return;
    if (date > stopAfter) return;
    const occ: RuleOccurrence = { date, seq };
    if (rule.kind === 'trial_to_paid') {
      occ.amountPaise = rule.paidAmountPaise;
      occ.phase = 'paid';
    }
    yield occ;
    seq++;
  }
}

/** Occurrences with start <= date <= end (inclusive). Irregular rules return only the user's date. */
export function occurrencesBetween(
  rule: RecurrenceRule,
  start: ISODate,
  end: ISODate,
): RuleOccurrence[] {
  if (end < start) return [];
  const out: RuleOccurrence[] = [];
  for (const o of sequence(rule, end)) if (o.date >= start) out.push(o);
  return out;
}

/** The next `count` occurrences on/after `from` (inclusive). */
export function nextOccurrences(
  rule: RecurrenceRule,
  from: ISODate,
  count: number,
): RuleOccurrence[] {
  const out: RuleOccurrence[] = [];
  if (count <= 0) return out;
  for (const o of sequence(rule, '9999-12-31')) {
    if (o.date < from) continue;
    out.push(o);
    if (out.length >= count) break;
  }
  return out;
}

/** The latest occurrence strictly before `before`, if any. */
export function previousOccurrence(rule: RecurrenceRule, before: ISODate): RuleOccurrence | null {
  let last: RuleOccurrence | null = null;
  for (const o of sequence(rule, addDays(before, -1))) last = o;
  return last;
}

/** The date the rule is anchored on (first possible occurrence). null for irregular without a date. */
export function ruleAnchor(rule: RecurrenceRule): ISODate | null {
  switch (rule.kind) {
    case 'irregular':
      return rule.nextDate;
    case 'trial_to_paid':
      return rule.trialEnd;
    default:
      return rule.start;
  }
}

/** Approximate months between occurrences, for planning run-rates. null = not periodic. */
export function cadenceMonths(rule: RecurrenceRule): number | null {
  if (rule.kind === 'trial_to_paid') return cadenceMonths(rule.paid);
  if (rule.kind === 'weekday' && rule.everyWeeks) {
    const w = validInterval(rule.everyWeeks);
    return w ? (w * 7 * 12) / 365.25 : null;
  }
  return stepMonthsOf(rule);
}

/** Rule kinds that are premium "advanced recurrence" (see plans.ts). */
export function isAdvancedRule(rule: RecurrenceRule): boolean {
  return rule.kind === 'weekday' || rule.kind === 'trial_to_paid' || rule.kind === 'custom_months';
}

/** Validation messages (plain English). Empty = valid. */
export function validateRule(rule: RecurrenceRule): string[] {
  const errs: string[] = [];
  const day = (d: number | undefined, label = 'Day of month') => {
    if (d !== undefined && !(Number.isInteger(d) && d >= 1 && d <= 31))
      errs.push(`${label} must be 1–31.`);
  };
  switch (rule.kind) {
    case 'monthly':
      day(rule.dayOfMonth);
      break;
    case 'quarterly':
    case 'half_yearly':
      day(rule.dayOfMonth);
      break;
    case 'custom_months':
      day(rule.dayOfMonth);
      if (!validInterval(rule.intervalMonths)) errs.push('Choose a number of months (1 or more).');
      break;
    case 'annual':
      if (!(Number.isInteger(rule.month) && rule.month >= 1 && rule.month <= 12))
        errs.push('Month must be 1–12.');
      day(rule.day, 'Day');
      break;
    case 'weekday':
      if ((rule.nth === undefined) === (rule.everyWeeks === undefined))
        errs.push('Choose either a week of the month or a number of weeks.');
      if (rule.everyWeeks !== undefined && !validInterval(rule.everyWeeks))
        errs.push('Number of weeks must be 1 or more.');
      break;
    case 'trial_to_paid':
      errs.push(...validateRule(rule.paid));
      if (rule.paidAmountPaise !== null && !(rule.paidAmountPaise >= 0))
        errs.push('Paid amount must be zero or more.');
      break;
    default:
      break;
  }
  return errs;
}

/* ---------- Builders ---------- */

export const rules = {
  oneTime: (date: ISODate): OneTimeRule => ({ kind: 'one_time', start: date }),
  monthly: (start: ISODate, dayOfMonth = parseISO(start).d): MonthlyRule => ({
    kind: 'monthly',
    start,
    dayOfMonth,
  }),
  quarterly: (start: ISODate): QuarterlyRule => ({ kind: 'quarterly', start }),
  halfYearly: (start: ISODate): HalfYearlyRule => ({ kind: 'half_yearly', start }),
  annual: (start: ISODate): AnnualRule => {
    const { m, d } = parseISO(start);
    return { kind: 'annual', start, month: m, day: d };
  },
  endOfMonth: (start: ISODate, intervalMonths = 1): EndOfMonthRule => ({
    kind: 'end_of_month',
    start,
    intervalMonths,
  }),
  nthWeekday: (
    start: ISODate,
    nth: NthWeekday,
    weekday: Weekday,
    intervalMonths = 1,
  ): WeekdayRule => ({ kind: 'weekday', start, weekday, nth, intervalMonths }),
  everyWeeks: (
    start: ISODate,
    weeks: number,
    weekday: Weekday = weekdayOf(start),
  ): WeekdayRule => ({
    kind: 'weekday',
    start,
    weekday,
    everyWeeks: weeks,
  }),
  customMonths: (start: ISODate, intervalMonths: number): CustomMonthsRule => ({
    kind: 'custom_months',
    start,
    intervalMonths,
  }),
  /** Trial ends on `trialEnd`; paid charges then follow `paid` (defaults to monthly from trialEnd). */
  trialToPaid: (
    trialEnd: ISODate,
    paidAmountPaise: number | null,
    paid: PaidRule = rules.monthly(trialEnd),
  ): TrialToPaidRule => ({ kind: 'trial_to_paid', trialEnd, paid, paidAmountPaise }),
  irregular: (nextDate: ISODate | null = null): IrregularRule => ({ kind: 'irregular', nextDate }),
};

/* ---------- Plain-English descriptions ---------- */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NTH: Record<string, string> = {
  '1': 'First',
  '2': 'Second',
  '3': 'Third',
  '4': 'Fourth',
  '-1': 'Last',
};

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

function shortDate(d: ISODate, withYear = false): string {
  const p = parseISO(d);
  return `${p.d} ${MONTHS[p.m - 1]}${withYear ? ` ${p.y}` : ''}`;
}

function onDay(day: number): string {
  return `on the ${ordinal(day)}${day > 28 ? ' (last day in shorter months)' : ''}`;
}

function everyMonths(n: number): string {
  return n === 1 ? 'every month' : `every ${n} months`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function boundsText(rule: RecurrenceRule): string {
  if (rule.kind === 'one_time' || rule.kind === 'irregular' || rule.kind === 'trial_to_paid')
    return '';
  const parts: string[] = [];
  if (rule.count != null) parts.push(`${rule.count} time${rule.count === 1 ? '' : 's'} in total`);
  if (rule.until) parts.push(`until ${shortDate(rule.until, true)}`);
  return parts.length ? `, ${parts.join(', ')}` : '';
}

/** Lower-case cadence phrase, e.g. "every month on the 5th". */
function cadencePhrase(rule: PaidRule): string {
  switch (rule.kind) {
    case 'monthly':
      return `every month ${onDay(rule.dayOfMonth)}`;
    case 'quarterly':
      return `every 3 months ${onDay(rule.dayOfMonth ?? parseISO(rule.start).d)}`;
    case 'half_yearly':
      return `every 6 months ${onDay(rule.dayOfMonth ?? parseISO(rule.start).d)}`;
    case 'custom_months':
      return `${everyMonths(Math.max(1, Math.floor(rule.intervalMonths)))} ${onDay(rule.dayOfMonth ?? parseISO(rule.start).d)}`;
    case 'annual':
      return `every year on ${rule.day} ${MONTHS[rule.month - 1]}${rule.month === 2 && rule.day === 29 ? ' (28 Feb in non-leap years)' : ''}`;
    case 'end_of_month':
      return `on the last day of ${everyMonths(rule.intervalMonths ?? 1)}`;
    case 'weekday':
      if (rule.everyWeeks) {
        return rule.everyWeeks === 1
          ? `every ${WEEKDAYS[rule.weekday]}`
          : `every ${rule.everyWeeks} weeks on ${WEEKDAYS[rule.weekday]}`;
      }
      return `${(NTH[String(rule.nth)] ?? '').toLowerCase()} ${WEEKDAYS[rule.weekday]} of ${everyMonths(rule.intervalMonths ?? 1)}`;
  }
}

/** Short cadence for "then ₹X every month" (trial copy). */
function shortCadence(rule: PaidRule): string {
  switch (rule.kind) {
    case 'monthly':
      return 'every month';
    case 'quarterly':
      return 'every 3 months';
    case 'half_yearly':
      return 'every 6 months';
    case 'annual':
      return 'every year';
    case 'custom_months':
      return everyMonths(Math.max(1, Math.floor(rule.intervalMonths)));
    default:
      return cadencePhrase(rule);
  }
}

/**
 * Plain-English rule text.
 * - "Every month on the 31st (last day in shorter months)"
 * - "Last Friday of every month"
 * - "Trial ends 12 Nov, then ₹1,950 every month"
 */
export function describeRule(rule: RecurrenceRule): string {
  switch (rule.kind) {
    case 'one_time':
      return `Once, on ${shortDate(rule.start, true)}`;
    case 'irregular':
      return rule.nextDate
        ? `No fixed schedule. Next date set by you: ${shortDate(rule.nextDate, true)}`
        : 'No fixed schedule. Add the next date when you know it';
    case 'trial_to_paid': {
      const amt = rule.paidAmountPaise === null ? 'paid' : formatINR(rule.paidAmountPaise);
      return `Trial ends ${shortDate(rule.trialEnd)}, then ${amt} ${shortCadence(rule.paid)}`;
    }
    case 'weekday':
      if (!rule.everyWeeks)
        return `${NTH[String(rule.nth)] ?? ''} ${WEEKDAYS[rule.weekday]} of ${everyMonths(rule.intervalMonths ?? 1)}${boundsText(rule)}`;
      return cap(cadencePhrase(rule)) + boundsText(rule);
    case 'end_of_month':
      return `Last day of ${everyMonths(rule.intervalMonths ?? 1)}${boundsText(rule)}`;
    default:
      return cap(cadencePhrase(rule)) + boundsText(rule);
  }
}
