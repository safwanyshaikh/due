/**
 * Plans and entitlements: the single config module for prices and feature gates.
 *
 * Prices are product HYPOTHESES to validate experimentally, not competitor facts. UI must read
 * them from here (never hard-code). The server is the source of truth for entitlements; this is
 * a client-side mirror used for display and to avoid offering what the plan does not include.
 */
import { addMonthsClamped, formatDate } from './dates';
import { formatINR } from './money';
import { isAdvancedRule, type RecurrenceRule } from './recurrence';
import type { ISODate } from './types';

export type PlanId = 'free' | 'plus' | 'household';
export type BillingCadence = 'monthly' | 'yearly';

export interface PlanPrice {
  cadence: BillingCadence;
  amountPaise: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  tagline: string;
  prices: PlanPrice[];
  /** Household plan: how many members can share. */
  maxMembers: number;
  /** True while the prices are unvalidated hypotheses. */
  priceIsHypothesis: boolean;
  /**
   * Whether the plan is sold. Household is not sold until sharing works end to end; the server's
   * `plans.active` flag is authoritative, this mirrors it for the offline (indicative) price list.
   */
  onSale: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    name: 'Free',
    tagline:
      'Manual due items, next 7/30 days, basic reminders, CSV export. Your data stays on this device.',
    prices: [],
    maxMembers: 1,
    priceIsHypothesis: false,
    onSale: true,
  },
  plus: {
    id: 'plus',
    name: 'Plus',
    tagline:
      'Receipt and statement import, calendar sync, advanced schedules and more reminder channels.',
    prices: [
      { cadence: 'monthly', amountPaise: 14_900 },
      { cadence: 'yearly', amountPaise: 129_900 },
    ],
    maxMembers: 1,
    priceIsHypothesis: true,
    onSale: true,
  },
  household: {
    id: 'household',
    name: 'Household',
    tagline: 'Everything in Plus, shared with your household.',
    prices: [
      { cadence: 'monthly', amountPaise: 24_900 },
      { cadence: 'yearly', amountPaise: 219_900 },
    ],
    maxMembers: 6,
    priceIsHypothesis: true,
    onSale: false,
  },
};

export type Feature =
  | 'manual_obligations'
  | 'next_7_30_view'
  | 'basic_reminders'
  | 'csv_export'
  | 'local_data'
  | 'email_receipt_extraction'
  | 'statement_import'
  | 'calendar_sync'
  | 'household_sharing'
  | 'advanced_recurrence'
  | 'reconciliation_history'
  | 'multi_channel_delivery'
  | 'cancellation_guidance'
  | 'verified_action_evidence';

export const FEATURES: Record<Feature, { label: string; plans: PlanId[] }> = {
  manual_obligations: { label: 'Manual due items', plans: ['free', 'plus', 'household'] },
  next_7_30_view: { label: 'Next 7 and 30 days', plans: ['free', 'plus', 'household'] },
  basic_reminders: { label: 'Basic in-app reminders', plans: ['free', 'plus', 'household'] },
  csv_export: { label: 'CSV export', plans: ['free', 'plus', 'household'] },
  local_data: { label: 'Data stored on your device', plans: ['free', 'plus', 'household'] },
  email_receipt_extraction: { label: 'Receipt and email extraction', plans: ['plus', 'household'] },
  statement_import: { label: 'Bank/statement imports', plans: ['plus', 'household'] },
  calendar_sync: { label: 'Calendar sync', plans: ['plus', 'household'] },
  household_sharing: { label: 'Household sharing', plans: ['household'] },
  advanced_recurrence: {
    label: 'Advanced schedules (weekday, trial to paid, custom months)',
    plans: ['plus', 'household'],
  },
  reconciliation_history: {
    label: 'Confidence and reconciliation history',
    plans: ['plus', 'household'],
  },
  multi_channel_delivery: { label: 'Email and push reminders', plans: ['plus', 'household'] },
  cancellation_guidance: { label: 'Cancellation guidance', plans: ['plus', 'household'] },
  verified_action_evidence: { label: 'Verified action evidence', plans: ['plus', 'household'] },
};

export const FREE_FEATURES = (Object.keys(FEATURES) as Feature[]).filter((f) =>
  FEATURES[f].plans.includes('free'),
);
export const PREMIUM_FEATURES = (Object.keys(FEATURES) as Feature[]).filter(
  (f) => !FEATURES[f].plans.includes('free'),
);

export interface Entitlement {
  plan: PlanId;
  status: 'active' | 'trialing' | 'grace' | 'expired' | 'none';
  /** ISO timestamp; after this the plan is treated as Free unless the server renews it. */
  validUntil?: string | null;
  /** 'server' = verified by the backend; 'local_default' = no account / offline default. */
  source: 'server' | 'local_default';
}

export const FREE_ENTITLEMENT: Entitlement = {
  plan: 'free',
  status: 'none',
  source: 'local_default',
};

/** Plan actually in force (expired/unknown → free). */
export function effectivePlan(
  ent: Entitlement | null | undefined,
  now: string = new Date().toISOString(),
): PlanId {
  if (!ent) return 'free';
  if (ent.status === 'expired' || ent.status === 'none') return 'free';
  if (ent.validUntil && ent.validUntil < now) return 'free';
  return ent.plan;
}

/** Whether an entitlement includes a feature. */
export function can(ent: Entitlement | null | undefined, feature: Feature, now?: string): boolean {
  return FEATURES[feature].plans.includes(effectivePlan(ent, now));
}

/** Rule kinds weekday / trial_to_paid / custom_months need `advanced_recurrence`. */
export function canUseRule(
  ent: Entitlement | null | undefined,
  rule: RecurrenceRule,
  now?: string,
): boolean {
  return !isAdvancedRule(rule) || can(ent, 'advanced_recurrence', now);
}

export function priceFor(plan: PlanId, cadence: BillingCadence): PlanPrice | null {
  return PLANS[plan].prices.find((p) => p.cadence === cadence) ?? null;
}

/**
 * What must be shown before purchase: exact price, cadence, renewal date, auto-renew. Purchase
 * channel, cancellation path and refund terms come from the server/store configuration.
 */
export function priceDisclosure(plan: PlanId, cadence: BillingCadence, start: ISODate) {
  const p = priceFor(plan, cadence);
  if (!p) return null;
  const renewal = addMonthsClamped(start, cadence === 'monthly' ? 1 : 12);
  return {
    plan: PLANS[plan].name,
    amountPaise: p.amountPaise,
    priceText: `${formatINR(p.amountPaise)} per ${cadence === 'monthly' ? 'month' : 'year'}`,
    cadence,
    renewalDate: renewal,
    renewalText: `Renews on ${formatDate(renewal)} unless you cancel before then.`,
    autoRenews: true,
    priceIsHypothesis: PLANS[plan].priceIsHypothesis,
  };
}
