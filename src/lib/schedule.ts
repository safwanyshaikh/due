import { addMonthsClamped } from './dates';
import type { Commitment, ISODate, Period } from './types';

export interface Occurrence {
  date: ISODate;
  amountPaise: number | null;
}

/** Months between occurrences, or null for one-time / invalid custom intervals. */
export function stepMonths(c: Pick<Commitment, 'frequency' | 'intervalMonths'>): number | null {
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

/** Scheduled occurrences inside a period. Ignores status; callers decide what counts. */
export function occurrences(c: Commitment, period: Period): Occurrence[] {
  const max = c.remainingOccurrences ?? Infinity;
  if (max <= 0) return [];
  const step = stepMonths(c);
  const out: Occurrence[] = [];
  if (step === null) {
    if (c.nextDue >= period.start && c.nextDue <= period.end) {
      out.push({ date: c.nextDue, amountPaise: c.amountPaise });
    }
    return out;
  }
  for (let k = 0; k < 1200 && k < max; k++) {
    const date = addMonthsClamped(c.nextDue, k * step);
    if (date > period.end) break;
    if (date >= period.start) out.push({ date, amountPaise: c.amountPaise });
  }
  return out;
}

/** Planning-only monthly equivalent in (possibly fractional) paise. null = not recurring or no amount. */
export function monthlyEquivalentPaise(c: Commitment): number | null {
  const step = stepMonths(c);
  if (step === null || c.amountPaise === null) return null;
  return c.amountPaise / step;
}

export function runRateFormula(c: Commitment): string {
  const step = stepMonths(c);
  if (step === null) return 'One-time: not part of the monthly run-rate';
  if (step === 1) return 'Monthly amount';
  return `Amount ÷ ${step} (planning estimate)`;
}

/** Rough "EMI × remaining instalments". Excludes rate changes, fees and lender adjustments. */
export function roughRemainingLoanPaise(c: Commitment): number | null {
  if (c.amountPaise === null || c.remainingOccurrences == null) return null;
  return c.amountPaise * c.remainingOccurrences;
}
