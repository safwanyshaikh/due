import { obligationOccurrences } from './obligations';
import { reconcileObligation } from './provenance';
import { cadenceMonths } from './recurrence';
import type { Commitment, ISODate, Period } from './types';

export interface Occurrence {
  date: ISODate;
  amountPaise: number | null;
}

/**
 * Months between occurrences, or null for one-time / irregular / invalid intervals.
 * With a full record, uses the v2 rule (weekly rules give a fractional value).
 */
export function stepMonths(
  c: Pick<Commitment, 'frequency' | 'intervalMonths'> & Partial<Commitment>,
): number | null {
  if (c.rule && c.amount && c.date && c.overrides && c.history && c.id)
    return cadenceMonths(reconcileObligation(c as Commitment).rule);
  return legacyStepMonths(c);
}

function legacyStepMonths(c: Pick<Commitment, 'frequency' | 'intervalMonths'>): number | null {
  switch (c.frequency) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'half_yearly':
      return 6;
    case 'annual':
      return 12;
    case 'custom_months':
      return c.intervalMonths && c.intervalMonths >= 1 ? Math.floor(c.intervalMonths) : null;
    default:
      return null;
  }
}

/**
 * Scheduled occurrences inside a period (v2 rule engine, with per-occurrence overrides applied).
 * Ignores status; callers decide what counts.
 */
export function occurrences(c: Commitment, period: Period): Occurrence[] {
  return obligationOccurrences(c, period.start, period.end).map((o) => ({
    date: o.date,
    amountPaise: o.amountPaise,
  }));
}

/** Planning-only monthly equivalent in (possibly fractional) paise. null = not recurring or no amount. */
export function monthlyEquivalentPaise(c: Commitment): number | null {
  const ob = reconcileObligation(c);
  const step = stepMonths(ob);
  const amount = ob.rule.kind === 'trial_to_paid' ? ob.rule.paidAmountPaise : ob.amount.value;
  if (step === null || amount === null) return null;
  return amount / step;
}

export function runRateFormula(c: Commitment): string {
  const step = stepMonths(c);
  if (step === null) return 'One-time: not part of the monthly run-rate';
  if (step === 1) return 'Monthly amount';
  if (!Number.isInteger(step)) return 'Amount × occurrences per year ÷ 12 (planning estimate)';
  return `Amount ÷ ${step} (planning estimate)`;
}

/** Rough "EMI × remaining instalments". Excludes rate changes, fees and lender adjustments. */
export function roughRemainingLoanPaise(c: Commitment): number | null {
  if (c.amountPaise === null || c.remainingOccurrences == null) return null;
  return c.amountPaise * c.remainingOccurrences;
}
