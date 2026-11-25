import type { AppConfig } from '../config.js';
import type { BillingPeriod, PlanRow } from './entitlements.js';

export type ProviderName = 'razorpay' | 'cashfree';

/** True when the credentials of `provider` are present. */
export function providerConfigured(config: AppConfig, provider: ProviderName): boolean {
  return provider === 'razorpay' ? Boolean(config.razorpay) : Boolean(config.cashfree);
}

export const activeProvider = (config: AppConfig): ProviderName => config.billingProvider;

/** The provider's own plan id for a plan and cadence (razorpay ids are top-level, cashfree ids are nested). */
export function providerPlanId(plan: PlanRow, provider: ProviderName, period: BillingPeriod): string | undefined {
  const ids = plan.provider_plan_ids ?? {};
  return provider === 'cashfree' ? ids.cashfree?.[period] : ids[period];
}
