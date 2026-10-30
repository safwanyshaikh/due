import type { CommitmentType, Status } from './types';

export const STATUS_LABELS: Record<Status, string> = {
  active: 'Active',
  trial: 'Trial',
  review_needed: 'Review when ready',
  pause_planned: 'Pause planned (not done yet)',
  pause_confirmed_by_user: 'Pause confirmed by you',
  cancel_pending: 'Cancel requested (not confirmed)',
  cancelled_confirmed_by_user: 'Cancelled, confirmed by you',
  seasonal_plan: 'Seasonal plan',
  overdue_user_entered: 'Marked overdue by you',
  unknown: 'Status unknown',
};

export const STATUS_NOTE =
  'Statuses are what you tell us. They are not verified with the provider, and we never change anything with a provider.';

export function statusLabel(s: Status): string {
  return STATUS_LABELS[s];
}

/** Confirmed-cancelled and confirmed-paused items drop out of forecasts; "planned" and "requested" do not. */
export function countsTowardForecast(s: Status): boolean {
  return s !== 'cancelled_confirmed_by_user' && s !== 'pause_confirmed_by_user';
}

export const TYPE_LABELS: Record<CommitmentType, string> = {
  subscription: 'Subscriptions',
  emi: 'EMIs',
  other_loan: 'Other Loans',
  credit_card: 'Credit Cards',
  school_fee: 'School Fees',
  bill: 'Bills',
  other: 'Other',
};

export const TYPE_SINGULAR: Record<CommitmentType, string> = {
  subscription: 'Subscription',
  emi: 'EMI',
  other_loan: 'Loan',
  credit_card: 'Credit-card bill',
  school_fee: 'School fee',
  bill: 'Bill',
  other: 'Commitment',
};

export const TYPES: CommitmentType[] = [
  'subscription',
  'emi',
  'other_loan',
  'credit_card',
  'school_fee',
  'bill',
  'other',
];
