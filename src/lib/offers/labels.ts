import type { BenefitType } from './types';

/** Display names for provider slugs. Unknown slugs fall back to the slug itself. */
export const PROVIDER_LABEL: Record<string, string> = {
  jio: 'Jio',
  airtel: 'Airtel',
  vi: 'Vi',
  amazon: 'Amazon Prime',
  google: 'Google AI',
  ecosystem: 'Cards & UPI',
  cards_upi: 'Cards & UPI',
  generic: 'Other recurring service',
};

export function providerLabel(slug: string): string {
  return PROVIDER_LABEL[slug] ?? slug;
}

export const BENEFIT_LABEL: Record<BenefitType, string> = {
  recurring_entitlement: 'Recurring entitlement',
  one_time_reward: 'One-time reward',
  trial: 'Trial',
  bundle: 'Bundle',
  capability: 'Capability',
  other: 'Benefit',
};
