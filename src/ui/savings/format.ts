import type {
  Assumption,
  MoveConfidence,
  RecurringCandidate,
  SourceRef,
  TransportMode,
} from '../../lib/savings/types';
import { formatDate } from '../../lib/dates';

/** Whole rupees, Indian grouping: ₹1,299. */
export function rupees(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

export function perMonth(n: number): string {
  return `${rupees(n)}/month`;
}

export function rangeText([lo, hi]: [number, number]): string {
  if (Math.round(lo) === Math.round(hi)) return rupees(lo);
  return `${rupees(lo)}–${rupees(hi)}`;
}

/** "8 rides a month", "₹250 average fare", "18% interest". */
export function assumptionValue(a: Pick<Assumption, 'value' | 'unit' | 'label'>): string {
  const label = a.label.charAt(0).toLowerCase() + a.label.slice(1);
  if (a.unit === '₹') return `${rupees(a.value)} ${label}`;
  if (a.unit === '%') return `${a.value}% ${label}`;
  return `${a.value.toLocaleString('en-IN')} ${label}`;
}

export function assumptionLead(a: Assumption): string {
  if (a.source === 'your_data') return 'From your data:';
  if (a.source === 'you_entered') return 'You set';
  return 'We assumed';
}

export const CONFIDENCE_LABEL: Record<MoveConfidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export const CONFIDENCE_TONE: Record<MoveConfidence, 'calm' | 'plain' | 'warm'> = {
  high: 'calm',
  medium: 'plain',
  low: 'warm',
};

export const EFFORT_LABEL = { tap: 'A few taps', habit: 'Habit change', paperwork: 'Paperwork' };

export const SOURCE_KIND_LABEL: Record<SourceRef['kind'], string> = {
  official: 'Official page',
  press: 'News report',
  aggregator: 'Comparison site',
  regulator: 'Regulator',
  user_shared: 'Shared by a user',
};

export function lastChecked(s: SourceRef): string {
  if (!s.lastVerifiedAt) return 'Not checked yet';
  const d = s.lastVerifiedAt.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? `Last checked ${formatDate(d)}` : 'Not checked yet';
}

export const MODE_LABEL: Record<TransportMode, string> = {
  cab: 'Cab',
  auto: 'Auto',
  bike_taxi: 'Bike taxi',
  local_train: 'Local train',
  metro: 'Metro',
  bus: 'Bus',
  shuttle: 'Office shuttle',
  own_vehicle: 'Own vehicle',
};
export const MODES = Object.keys(MODE_LABEL) as TransportMode[];

export const RAIL_TEXT: Record<RecurringCandidate['rail'], string> = {
  upi_autopay: 'UPI AutoPay',
  bank_mandate: 'Bank mandate',
  credit_card: 'Credit card',
  debit_card: 'Debit card',
  unknown: 'Payment method unknown',
};

export const CADENCE_TEXT: Record<RecurringCandidate['cadence'], string> = {
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  yearly: 'Yearly',
};
