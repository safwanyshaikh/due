import type { Commitment } from './types';

/**
 * Only optional subscriptions can be offered a "review" prompt.
 * EMIs, loans, card bills, school fees and bills are never presented as things to cancel.
 */
export function canOfferReview(c: Pick<Commitment, 'type' | 'importance'>): boolean {
  return c.type === 'subscription' && c.importance === 'optional';
}

export const REVIEW_ACTIONS = [
  'Review this item',
  'Set a reminder',
  'Open provider help',
  'Mark decision for later',
] as const;

export function overCapMessage(
  valuePaise: string,
  capPaise: string,
  hasEstimates: boolean,
): string {
  return (
    `Your listed payments this month are ${valuePaise}, above the ${capPaise} limit you chose. ` +
    (hasEstimates ? 'Some entries may be estimates. ' : '') +
    'Review the details when you’re ready.'
  );
}

export const ESSENTIAL_NOTE =
  'This total includes EMIs, card bills, school fees or other essential items that are already committed. ' +
  'We only show the amounts and dates. If you need clarification about any of them, please contact the official provider.';

export const COOLING_OFF_NOTE =
  'A 24-hour reminder only helps you revisit a choice. It does not change any due date, and waiting is not guaranteed to be safe.';
