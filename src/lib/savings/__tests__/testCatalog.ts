/** Test-only catalog. Prices are made up for tests and are NOT the real seed. */
import type { CityPack, SavingsCatalog, SavingsModule, SourceRef } from '../types';

export const SRC: SourceRef = {
  url: 'https://example.test/official',
  label: 'Official page (test)',
  kind: 'official',
  lastVerifiedAt: '2026-11-01T00:00:00.000Z',
};

export function mod(
  over: Partial<SavingsModule> & Pick<SavingsModule, 'id' | 'valueKind'>,
): SavingsModule {
  return {
    version: 1,
    status: 'verified',
    detect: { merchantAliases: [], senderDomains: [], keywords: [] },
    provider: 'Provider',
    product: 'Product',
    category: 'other',
    country: 'IN',
    cityPack: null,
    rules: {},
    proof: { signal: 'amount_drop', description: 'Amount drops' },
    nudge: { trigger: 'before_renewal', leadDays: 3 },
    legalRole: 'information',
    sources: [SRC],
    actionUrl: 'https://example.test/manage',
    actionLabel: 'Open the official page',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

export const UBER_ONE = mod({
  id: 'uber-one-in',
  valueKind: 'membership_breakeven',
  provider: 'Uber',
  product: 'Uber One',
  category: 'mobility',
  detect: { merchantAliases: ['uber one'], senderDomains: [], keywords: [] },
  rules: {
    prices: [
      { label: 'Monthly', priceInr: 149, periodDays: 30 },
      { label: 'Yearly', priceInr: 1499, periodDays: 365 },
    ],
    includes: [{ key: 'zomato-gold-in', label: 'Zomato Gold', months: null }],
    creditPct: 10,
    creditCapPerUnitInr: 50,
  },
});

export const ZOMATO_GOLD = mod({
  id: 'zomato-gold-in',
  status: 'research',
  valueKind: 'membership_breakeven',
  provider: 'Zomato',
  product: 'Zomato Gold',
  category: 'food',
  detect: { merchantAliases: ['zomato gold'], senderDomains: [], keywords: [] },
  rules: {
    prices: [{ label: '3 months', priceInr: null, periodDays: 90 }],
    deliveryFeeSavedPerOrderInr: 30,
    freeDeliveryMinOrderInr: 199,
  },
});

export const SWIGGY_ONE = mod({
  id: 'swiggy-one-in',
  valueKind: 'membership_breakeven',
  provider: 'Swiggy',
  product: 'Swiggy One',
  category: 'food',
  detect: { merchantAliases: ['swiggy one'], senderDomains: [], keywords: [] },
  rules: { deliveryFeeSavedPerOrderInr: 20, freeDeliveryMinOrderInr: 149 },
});

export const JIO = mod({
  id: 'jio-prepaid-in',
  valueKind: 'period_switch',
  provider: 'Jio',
  product: 'Jio prepaid',
  category: 'telecom',
  detect: { merchantAliases: ['jio', 'reliance jio'], senderDomains: [], keywords: [] },
  rules: {
    prices: [
      { label: '28 days', priceInr: 349, periodDays: 28 },
      { label: 'Yearly', priceInr: 3599, periodDays: 365 },
    ],
    includes: [{ key: 'jiohotstar', label: 'JioHotstar', months: 3 }],
  },
});

export const CARD_BT = mod({
  id: 'card-balance-transfer-in',
  valueKind: 'debt_rate',
  provider: 'Banks',
  product: 'Balance-transfer EMI',
  category: 'card',
  rules: { ratePctLow: 14, ratePctHigh: 22, processingFeePct: 1 },
});

export const HOME_LOAN = mod({
  id: 'home-loan-floating-in',
  valueKind: 'loan_switch',
  provider: 'Banks',
  product: 'Floating-rate home loan',
  category: 'loan',
  detect: { merchantAliases: [], senderDomains: [], keywords: ['home loan'] },
  rules: { ratePctLow: 8.1, ratePctHigh: 9.0 },
  sources: [
    SRC,
    {
      url: 'https://example.test/rbi',
      label: 'RBI prepayment charges (test)',
      kind: 'regulator',
      lastVerifiedAt: '2026-11-01T00:00:00.000Z',
    },
  ],
});

export const NULL_PRICE = mod({
  id: 'mystery-ott-in',
  status: 'research',
  valueKind: 'period_switch',
  product: 'Mystery OTT',
  category: 'ott',
  detect: { merchantAliases: ['mystery ott'], senderDomains: [], keywords: [] },
  rules: { prices: [{ label: 'Yearly', priceInr: null, periodDays: 365 }] },
});

export const MMR: CityPack = {
  id: 'in-mmr',
  name: 'Mumbai, Navi Mumbai, Thane',
  country: 'IN',
  localities: ['Navi Mumbai', 'Vashi', 'Thane', 'Andheri'],
  passes: [
    {
      id: 'cityflo-nm-thane',
      operator: 'Cityflo',
      mode: 'shuttle',
      name: 'Cityflo monthly pass',
      priceInr: 6000,
      periodDays: 30,
      trips: 44,
      coverage: ['Navi Mumbai', 'Vashi', 'Thane'],
      status: 'research',
      sources: [SRC],
      actionUrl: 'https://example.test/cityflo',
    },
    {
      id: 'bus-unknown',
      operator: 'Some Bus',
      mode: 'bus',
      name: 'Bus pass',
      priceInr: null,
      periodDays: 30,
      trips: null,
      coverage: ['Navi Mumbai', 'Thane'],
      status: 'research',
      sources: [SRC],
      actionUrl: null,
    },
  ],
  typicalFareInr: { cab: 400, auto: 150 },
  status: 'verified',
  updatedAt: '2026-11-01T00:00:00.000Z',
};

export const CATALOG: SavingsCatalog = {
  version: 'test-1',
  generatedAt: '2026-11-01T00:00:00.000Z',
  modules: [UBER_ONE, ZOMATO_GOLD, SWIGGY_ONE, JIO, CARD_BT, HOME_LOAN, NULL_PRICE],
  cityPacks: [MMR],
};

export function catalogWith(...modules: SavingsModule[]): SavingsCatalog {
  return { ...CATALOG, modules, cityPacks: [MMR] };
}
