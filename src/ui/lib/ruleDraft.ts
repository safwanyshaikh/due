import { parseISO } from '../../lib/dates';
import {
  rules,
  weekdayOf,
  type NthWeekday,
  type PaidRule,
  type RecurrenceRule,
  type RuleKind,
  type Weekday,
} from '../../lib/recurrence';

/** Flat, form-friendly representation of every recurrence rule type. */
export interface RuleDraft {
  kind: RuleKind;
  /** Anchor / next date. */
  start: string;
  dayOfMonth: string;
  intervalMonths: string;
  weekMode: 'nth' | 'every';
  weekday: Weekday;
  nth: NthWeekday;
  everyWeeks: string;
  /** Optional: stop after N occurrences. */
  count: string;
  trialEnd: string;
  paidKind: 'monthly' | 'quarterly' | 'annual';
  paidAmount: string;
}

export const RULE_LABELS: Record<RuleKind, string> = {
  one_time: 'One time',
  monthly: 'Every month',
  quarterly: 'Every 3 months',
  half_yearly: 'Every 6 months',
  annual: 'Every year',
  end_of_month: 'Last day of the month',
  weekday: 'A weekday (e.g. last Friday)',
  custom_months: 'Every few months',
  trial_to_paid: 'Free trial, then paid',
  irregular: 'No fixed schedule',
};

export function defaultDraft(start: string): RuleDraft {
  return {
    kind: 'monthly',
    start,
    dayOfMonth: String(parseISO(start).d),
    intervalMonths: '2',
    weekMode: 'nth',
    weekday: weekdayOf(start),
    nth: 1,
    everyWeeks: '2',
    count: '',
    trialEnd: start,
    paidKind: 'monthly',
    paidAmount: '',
  };
}

const int = (s: string): number => (s.trim() === '' ? NaN : Number(s));

function bounded<T extends PaidRule>(r: T, d: RuleDraft): T {
  const n = int(d.count);
  return Number.isInteger(n) && n > 0 ? { ...r, count: n } : r;
}

/**
 * Builds a rule from the draft. `paidAmountPaise` is passed in because the form owns money parsing.
 * Returns null when a required date is missing.
 */
export function buildRule(
  d: RuleDraft,
  paidAmountPaise: number | null = null,
): RecurrenceRule | null {
  const hasStart = /^\d{4}-\d{2}-\d{2}$/.test(d.start);
  switch (d.kind) {
    case 'irregular':
      return rules.irregular(hasStart ? d.start : null);
    case 'trial_to_paid': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d.trialEnd)) return null;
      const paid: PaidRule =
        d.paidKind === 'annual'
          ? rules.annual(d.trialEnd)
          : d.paidKind === 'quarterly'
            ? rules.quarterly(d.trialEnd)
            : rules.monthly(d.trialEnd);
      return rules.trialToPaid(d.trialEnd, paidAmountPaise, paid);
    }
    default:
      break;
  }
  if (!hasStart) return null;
  switch (d.kind) {
    case 'one_time':
      return rules.oneTime(d.start);
    case 'monthly': {
      const day = int(d.dayOfMonth);
      return bounded(rules.monthly(d.start, Number.isFinite(day) ? day : parseISO(d.start).d), d);
    }
    case 'quarterly':
      return bounded(rules.quarterly(d.start), d);
    case 'half_yearly':
      return bounded(rules.halfYearly(d.start), d);
    case 'annual':
      return bounded(rules.annual(d.start), d);
    case 'end_of_month':
      return bounded(rules.endOfMonth(d.start, Math.max(1, int(d.intervalMonths) || 1)), d);
    case 'custom_months':
      return bounded(rules.customMonths(d.start, int(d.intervalMonths)), d);
    case 'weekday':
      return bounded(
        d.weekMode === 'every'
          ? rules.everyWeeks(d.start, int(d.everyWeeks), d.weekday)
          : rules.nthWeekday(d.start, d.nth, d.weekday),
        d,
      );
  }
  return null;
}

/** Fills a draft from an existing rule (for editing). */
export function draftFromRule(rule: RecurrenceRule, fallbackStart: string): RuleDraft {
  const base = defaultDraft(fallbackStart);
  switch (rule.kind) {
    case 'irregular':
      return { ...base, kind: 'irregular', start: rule.nextDate ?? '' };
    case 'trial_to_paid':
      return {
        ...base,
        kind: 'trial_to_paid',
        trialEnd: rule.trialEnd,
        paidKind:
          rule.paid.kind === 'annual'
            ? 'annual'
            : rule.paid.kind === 'quarterly'
              ? 'quarterly'
              : 'monthly',
        paidAmount: rule.paidAmountPaise === null ? '' : String(rule.paidAmountPaise / 100),
      };
    case 'one_time':
      return { ...base, kind: 'one_time', start: rule.start };
    default: {
      const d: RuleDraft = {
        ...base,
        kind: rule.kind,
        start: rule.start,
        count: rule.count ? String(rule.count) : '',
      };
      if (rule.kind === 'monthly') d.dayOfMonth = String(rule.dayOfMonth);
      if (rule.kind === 'custom_months') d.intervalMonths = String(rule.intervalMonths);
      if (rule.kind === 'end_of_month') d.intervalMonths = String(rule.intervalMonths ?? 1);
      if (rule.kind === 'weekday') {
        d.weekday = rule.weekday;
        if (rule.everyWeeks) {
          d.weekMode = 'every';
          d.everyWeeks = String(rule.everyWeeks);
        } else {
          d.weekMode = 'nth';
          d.nth = rule.nth ?? 1;
        }
      }
      return d;
    }
  }
}
