import { describe, expect, it } from 'vitest';
import {
  can,
  canUseRule,
  effectivePlan,
  FEATURES,
  FREE_ENTITLEMENT,
  FREE_FEATURES,
  PLANS,
  PREMIUM_FEATURES,
  priceDisclosure,
  priceFor,
  type Entitlement,
} from '../plans';
import { rules } from '../recurrence';

const plus: Entitlement = {
  plan: 'plus',
  status: 'active',
  validUntil: '2027-01-01T00:00:00.000Z',
  source: 'server',
};
const household: Entitlement = { plan: 'household', status: 'active', source: 'server' };

describe('plans config', () => {
  it('prices are configurable hypotheses in paise', () => {
    expect(priceFor('plus', 'monthly')?.amountPaise).toBe(14900);
    expect(priceFor('plus', 'yearly')?.amountPaise).toBe(129900);
    expect(priceFor('household', 'monthly')?.amountPaise).toBe(24900);
    expect(priceFor('household', 'yearly')?.amountPaise).toBe(219900);
    expect(priceFor('free', 'monthly')).toBeNull();
    expect(PLANS.plus.priceIsHypothesis).toBe(true);
    expect(PLANS.free.priceIsHypothesis).toBe(false);
  });
  it('free core vs premium features', () => {
    expect(FREE_FEATURES.sort()).toEqual([
      'basic_reminders',
      'csv_export',
      'local_data',
      'manual_obligations',
      'next_7_30_view',
    ]);
    expect(PREMIUM_FEATURES).toHaveLength(9);
    expect(FEATURES.household_sharing.plans).toEqual(['household']);
  });
});

describe('can()', () => {
  it('free has the core only', () => {
    expect(can(FREE_ENTITLEMENT, 'manual_obligations')).toBe(true);
    expect(can(FREE_ENTITLEMENT, 'csv_export')).toBe(true);
    expect(can(null, 'email_receipt_extraction')).toBe(false);
    expect(can(FREE_ENTITLEMENT, 'advanced_recurrence')).toBe(false);
  });
  it('plus unlocks premium except household sharing; household unlocks all', () => {
    const now = '2026-10-30T00:00:00.000Z';
    expect(PREMIUM_FEATURES.filter((f) => !can(plus, f, now))).toEqual(['household_sharing']);
    expect(PREMIUM_FEATURES.every((f) => can(household, f, now))).toBe(true);
  });
  it('expired or lapsed entitlements fall back to free', () => {
    expect(effectivePlan(plus, '2027-02-01T00:00:00.000Z')).toBe('free');
    expect(
      can({ ...plus, status: 'expired' }, 'statement_import', '2026-10-30T00:00:00.000Z'),
    ).toBe(false);
    expect(effectivePlan({ ...plus, status: 'grace' }, '2026-10-30T00:00:00.000Z')).toBe('plus');
  });
  it('advanced recurrence rules are gated', () => {
    expect(canUseRule(FREE_ENTITLEMENT, rules.monthly('2026-11-05'))).toBe(true);
    expect(canUseRule(FREE_ENTITLEMENT, rules.endOfMonth('2026-11-05'))).toBe(true);
    expect(canUseRule(FREE_ENTITLEMENT, rules.nthWeekday('2026-11-05', -1, 5))).toBe(false);
    expect(canUseRule(FREE_ENTITLEMENT, rules.trialToPaid('2026-11-05', 100))).toBe(false);
    expect(canUseRule(plus, rules.customMonths('2026-11-05', 2), '2026-10-30T00:00:00.000Z')).toBe(
      true,
    );
  });
});

describe('price disclosure', () => {
  it('shows exact price, cadence and renewal date', () => {
    expect(priceDisclosure('plus', 'yearly', '2026-10-30')).toMatchObject({
      priceText: '₹1,299 per year',
      renewalDate: '2027-10-30',
      renewalText: 'Renews on 30 Oct 2027 unless you cancel before then.',
      autoRenews: true,
      priceIsHypothesis: true,
    });
    expect(priceDisclosure('household', 'monthly', '2027-01-31')?.renewalDate).toBe('2027-02-28');
    expect(priceDisclosure('free', 'monthly', '2026-10-30')).toBeNull();
  });
});
