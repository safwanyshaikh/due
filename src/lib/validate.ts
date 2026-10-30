import { isValidISO } from './dates';
import { looksSensitive } from './sensitive';
import type { Commitment } from './types';

export function validateCommitment(c: Commitment): string[] {
  const errors: string[] = [];
  if (!c.provider.trim())
    errors.push('Please enter who this is with (provider or lender nickname).');
  if (!isValidISO(c.nextDue)) errors.push('Please enter a valid next due date.');
  if (c.amountPaise !== null && (!Number.isInteger(c.amountPaise) || c.amountPaise < 0)) {
    errors.push('Amount must be zero or more.');
  }
  if (c.frequency === 'custom_months' && !(c.intervalMonths && c.intervalMonths >= 1)) {
    errors.push('Custom schedules need a number of months (1 or more).');
  }
  if (
    c.remainingOccurrences != null &&
    (!Number.isInteger(c.remainingOccurrences) || c.remainingOccurrences < 0)
  ) {
    errors.push('Remaining instalments must be a whole number, zero or more.');
  }
  for (const o of c.reminder.offsets) {
    if (!Number.isInteger(o) || o < 0 || o > 60)
      errors.push('Reminder days must be whole numbers from 0 to 60.');
  }
  const url = c.subscription?.helpUrl;
  if (url && !/^https?:\/\//i.test(url))
    errors.push('Provider help link must start with http:// or https://.');
  const rate = c.loan?.interestRatePct;
  if (rate != null && (rate < 0 || rate > 100))
    errors.push('Interest rate must be between 0 and 100.');
  const s = c.statement;
  if (s?.periodStart && s.periodEnd && s.periodStart > s.periodEnd) {
    errors.push('Statement period end must be on or after its start.');
  }
  for (const d of [
    c.subscription?.trialEnd,
    c.subscription?.cancellationBy,
    c.subscription?.seasonStart,
    c.subscription?.seasonEnd,
    s?.periodStart,
    s?.periodEnd,
    c.lastConfirmed,
  ]) {
    if (d && !isValidISO(d)) errors.push('One of the dates is not valid.');
  }
  const texts = [
    c.provider,
    c.nickname,
    c.accountNickname,
    c.ownerLabel,
    c.notes,
    c.loan?.lenderNickname,
    c.loan?.loanType,
    s?.cardNickname,
  ];
  for (const t of texts) {
    const problem = looksSensitive(t ?? '');
    if (problem) {
      errors.push(problem);
      break;
    }
  }
  return errors;
}
