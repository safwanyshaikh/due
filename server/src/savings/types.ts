/**
 * Server mirror of src/lib/savings/types.ts (the server cannot import from the client tree).
 * Keep shapes in sync with that file; additive changes only.
 */
export type ModuleStatus = 'research' | 'verified' | 'retired';
export type LegalRole = 'information' | 'sponsored_disclosed' | 'regulated_partner';
export type ValueKind =
  | 'membership_breakeven'
  | 'period_switch'
  | 'overlap'
  | 'commute_pass'
  | 'debt_rate'
  | 'loan_switch'
  | 'price_change'
  | 'trial_end';

export interface SourceRef {
  url: string;
  label: string;
  kind: 'official' | 'press' | 'aggregator' | 'regulator' | 'user_shared';
  lastVerifiedAt: string | null;
}

export interface PlanPrice {
  label: string;
  priceInr: number | null;
  periodDays: number;
}

export interface ModuleRules {
  prices?: PlanPrice[];
  includes?: { key: string; label: string; months: number | null }[];
  creditPct?: number | null;
  creditCapPerUnitInr?: number | null;
  creditExpiryDays?: number | null;
  freeDeliveryMinOrderInr?: number | null;
  deliveryFeeSavedPerOrderInr?: number | null;
  ratePctLow?: number | null;
  ratePctHigh?: number | null;
  processingFeePct?: number | null;
  conditions?: string[];
}

export type ModuleCategory = 'mobility' | 'food' | 'telecom' | 'ott' | 'music' | 'cloud' | 'shopping' | 'card' | 'loan' | 'utility' | 'other';

export interface SavingsModule {
  id: string;
  version: number;
  status: ModuleStatus;
  detect: { merchantAliases: string[]; senderDomains: string[]; keywords: string[] };
  provider: string;
  product: string;
  category: ModuleCategory;
  country: string;
  cityPack: string | null;
  rules: ModuleRules;
  valueKind: ValueKind;
  proof: { signal: 'amount_drop' | 'charge_stopped' | 'new_plan_charge' | 'fewer_charges' | 'user_confirmed'; description: string };
  nudge: { trigger: 'before_renewal' | 'before_expiry' | 'usage_drop' | 'on_detect'; leadDays: number };
  legalRole: LegalRole;
  sources: SourceRef[];
  actionUrl: string | null;
  actionLabel: string | null;
  updatedAt: string;
}

export type TransportMode = 'cab' | 'auto' | 'bike_taxi' | 'local_train' | 'metro' | 'bus' | 'shuttle' | 'own_vehicle';

export interface CityPass {
  id: string;
  operator: string;
  mode: TransportMode;
  name: string;
  priceInr: number | null;
  periodDays: number | null;
  trips: number | null;
  coverage: string[];
  status: ModuleStatus;
  sources: SourceRef[];
  actionUrl: string | null;
}

export interface CityPack {
  id: string;
  name: string;
  country: string;
  localities: string[];
  passes: CityPass[];
  typicalFareInr: Partial<Record<TransportMode, number>>;
  status: ModuleStatus;
  updatedAt: string;
}

export interface SavingsCatalog {
  version: string;
  generatedAt: string;
  modules: SavingsModule[];
  cityPacks: CityPack[];
}

export const COMMUNITY_THRESHOLD = 20;
/** A module may be marked verified only if an official source was checked within this many days. */
export const VERIFY_MAX_AGE_DAYS = 30;
