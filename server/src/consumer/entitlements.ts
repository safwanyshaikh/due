import type { Queryable } from '../db.js';
import { many, one } from '../db.js';

export const PLAN_IDS = ['free', 'plus', 'household'] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const PAID_PLAN_IDS = ['plus', 'household'] as const;
export type PaidPlanId = (typeof PAID_PLAN_IDS)[number];
export type BillingPeriod = 'monthly' | 'yearly';

/** Every feature key a plan may grant. Free-tier keys are listed first. */
export const FEATURE_KEYS = [
  'manual_obligations',
  'upcoming_view',
  'basic_reminders',
  'csv_export',
  'local_data',
  'backup',
  'multi_device',
  'reminder_email',
  'email_import',
  'statement_import',
  'calendar_sync',
  'advanced_recurrence',
  'reconciliation_history',
  'multi_channel',
  'cancellation_guidance',
  'verified_evidence',
  'household_sharing',
] as const;
export type Feature = (typeof FEATURE_KEYS)[number];

export interface PlanRow {
  id: PlanId;
  name: string;
  price_inr_monthly: number | null;
  price_inr_yearly: number | null;
  active: boolean;
  features: string[];
  provider_plan_ids: { monthly?: string; yearly?: string };
  sort_order: number;
  updated_at: Date;
}

export interface Entitlement {
  plan: PlanId;
  status: 'active' | 'cancelled' | 'expired';
  billingPeriod: BillingPeriod | null;
  periodEnd: string | null;
  channel: 'razorpay' | 'manual' | null;
  features: Feature[];
  /** Set when features come from membership of someone else's household. */
  householdAccess: { householdId: string; role: 'owner' | 'member' } | null;
}

export async function listPlans(q: Queryable): Promise<PlanRow[]> {
  return many<PlanRow>(q, 'SELECT * FROM plans ORDER BY sort_order, id');
}

export async function getPlan(q: Queryable, id: string): Promise<PlanRow | null> {
  return one<PlanRow>(q, 'SELECT * FROM plans WHERE id = $1', [id]);
}

function featuresOf(plan: PlanRow | undefined): Feature[] {
  const allowed = new Set<string>(FEATURE_KEYS);
  return (plan?.features ?? []).filter((f): f is Feature => allowed.has(f));
}

/**
 * Computes an account's effective entitlement from the entitlements row and the plans table.
 * Paid access lasts while status is active, or cancelled with a period end still in the future.
 * Members of a household whose owner holds an effective 'household' plan get 'household_sharing'.
 */
export async function computeEntitlement(q: Queryable, accountId: string, now: Date): Promise<Entitlement> {
  const plans = await listPlans(q);
  const byId = new Map(plans.map((p) => [p.id, p]));
  const row = await one<{
    plan: PlanId;
    status: 'active' | 'cancelled' | 'expired';
    billing_period: BillingPeriod | null;
    current_period_end: Date | null;
    channel: 'razorpay' | 'manual' | null;
  }>(q, 'SELECT plan, status, billing_period, current_period_end, channel FROM entitlements WHERE account_id = $1', [accountId]);

  let plan: PlanId = 'free';
  let status: Entitlement['status'] = 'active';
  if (row && row.plan !== 'free') {
    const inPeriod = row.current_period_end === null || row.current_period_end.getTime() > now.getTime();
    const live = (row.status === 'active' || row.status === 'cancelled') && inPeriod;
    if (live) {
      plan = row.plan;
      status = row.status;
    } else {
      status = 'expired';
    }
  }
  const features = new Set<Feature>(featuresOf(byId.get(plan)));
  const membership = await one<{ household_id: string; role: 'owner' | 'member'; owner_account_id: string }>(
    q,
    `SELECT m.household_id, m.role, h.owner_account_id FROM household_members m JOIN households h ON h.id = m.household_id
      WHERE m.account_id = $1 AND m.status = 'active'`,
    [accountId],
  );
  let householdAccess: Entitlement['householdAccess'] = null;
  // Household sharing only works while the Household plan is offered (plans.active); until then nobody gets it.
  const sharingOffered = householdOffered(byId);
  if (!sharingOffered) features.delete('household_sharing');
  if (membership && sharingOffered) {
    const ownerHasHousehold =
      membership.owner_account_id === accountId
        ? features.has('household_sharing')
        : await ownerHouseholdActive(q, membership.owner_account_id, now, byId);
    if (ownerHasHousehold) {
      features.add('household_sharing');
      householdAccess = { householdId: membership.household_id, role: membership.role };
    }
  }
  return {
    plan,
    status,
    billingPeriod: plan === 'free' ? null : (row?.billing_period ?? null),
    periodEnd: plan === 'free' ? null : (row?.current_period_end?.toISOString() ?? null),
    channel: plan === 'free' ? null : (row?.channel ?? null),
    features: FEATURE_KEYS.filter((f) => features.has(f)),
    householdAccess,
  };
}

/** True while the 'household' plan is active (offered). Inactive means household sharing is switched off. */
export function householdOffered(byId: Map<string, PlanRow>): boolean {
  return byId.get('household')?.active === true;
}

async function ownerHouseholdActive(q: Queryable, ownerId: string, now: Date, byId: Map<string, PlanRow>): Promise<boolean> {
  const r = await one<{ plan: PlanId; status: string; current_period_end: Date | null }>(
    q,
    'SELECT plan, status, current_period_end FROM entitlements WHERE account_id = $1',
    [ownerId],
  );
  if (!r || r.plan === 'free') return false;
  const inPeriod = r.current_period_end === null || r.current_period_end.getTime() > now.getTime();
  if (!((r.status === 'active' || r.status === 'cancelled') && inPeriod)) return false;
  return featuresOf(byId.get(r.plan)).includes('household_sharing');
}

export function publicPlan(p: PlanRow) {
  return {
    id: p.id,
    name: p.name,
    priceInrMonthly: p.price_inr_monthly,
    priceInrYearly: p.price_inr_yearly,
    billingCadences: p.id === 'free' ? [] : (['monthly', 'yearly'] as BillingPeriod[]).filter((c) =>
      c === 'monthly' ? p.price_inr_monthly !== null : p.price_inr_yearly !== null,
    ),
    features: featuresOf(p),
    active: p.active,
  };
}
