/**
 * Due Savings engine: shared contract (client and server mirror these shapes).
 * Information only: Due never pays, switches, cancels, applies for loans or shares user data with providers.
 * Money is in whole rupees (INR) inside this module; obligations keep paise.
 */

export type ModuleStatus = 'research' | 'verified' | 'retired';
export type LegalRole = 'information' | 'sponsored_disclosed' | 'regulated_partner';
export type ValueKind =
  | 'membership_breakeven' // Uber One, Swiggy One, Zomato Gold vs the user's usage
  | 'period_switch' // monthly -> yearly plan at a lower effective price
  | 'overlap' // paying for something another plan already includes
  | 'commute_pass' // per-trip spend on a route vs a pass/shuttle
  | 'debt_rate' // revolving card debt vs balance-transfer EMI (information)
  | 'loan_switch' // floating-rate loan vs a lower published rate (information)
  | 'price_change' // the user's own price went up
  | 'trial_end'; // a free trial is about to convert to paid

export interface SourceRef {
  url: string;
  label: string;
  kind: 'official' | 'press' | 'aggregator' | 'regulator' | 'user_shared';
  lastVerifiedAt: string | null; // ISO; null = never checked against the page
}

/** The 8-field plug-in card. Anything new (offer, plan, product, loan rule) is one of these. */
export interface SavingsModule {
  id: string; // slug, e.g. "uber-one-in"
  version: number;
  status: ModuleStatus;
  /** 1 Detect: how Due recognises it in the user's data. */
  detect: { merchantAliases: string[]; senderDomains: string[]; keywords: string[] };
  /** 2 Identify. */
  provider: string; // display name, e.g. "Uber"
  product: string; // e.g. "Uber One"
  category: 'mobility' | 'food' | 'telecom' | 'ott' | 'music' | 'cloud' | 'shopping' | 'card' | 'loan' | 'utility' | 'other';
  country: string; // ISO-2, "IN"
  cityPack: string | null; // e.g. "in-mmr"
  /** 3 Rules: typed by valueKind. Unknown numbers are null, never guessed. */
  rules: ModuleRules;
  /** 4 Value: which formula family the engine uses. */
  valueKind: ValueKind;
  /** 5 Proof: what later evidence proves the saving happened. */
  proof: { signal: 'amount_drop' | 'charge_stopped' | 'new_plan_charge' | 'fewer_charges' | 'user_confirmed'; description: string };
  /** 6 Nudge: when to tell the user. */
  nudge: { trigger: 'before_renewal' | 'before_expiry' | 'usage_drop' | 'on_detect'; leadDays: number };
  /** 7 Legal role. Phase 1: always 'information'. */
  legalRole: LegalRole;
  /** 8 Sources. A module needs at least one source; 'verified' needs an official one with lastVerifiedAt. */
  sources: SourceRef[];
  /** Official page the user is sent to (Due never acts). */
  actionUrl: string | null;
  actionLabel: string | null;
  updatedAt: string;
}

export interface PlanPrice {
  label: string; // "Monthly", "Yearly ₹3,599"
  priceInr: number | null;
  periodDays: number; // 28, 30, 84, 90, 365...
}

export interface ModuleRules {
  prices?: PlanPrice[];
  /** Benefits bundled inside this plan, as other module ids or plain product keys (e.g. "jiohotstar"). */
  includes?: { key: string; label: string; months: number | null }[];
  /** Membership credit rules (e.g. Uber One). */
  creditPct?: number | null;
  creditCapPerUnitInr?: number | null;
  creditExpiryDays?: number | null;
  freeDeliveryMinOrderInr?: number | null;
  deliveryFeeSavedPerOrderInr?: number | null;
  /** Rates (debt_rate / loan_switch), % a year. */
  ratePctLow?: number | null;
  ratePctHigh?: number | null;
  processingFeePct?: number | null;
  /** Free-text conditions shown to the user verbatim. */
  conditions?: string[];
}

export type TransportMode = 'cab' | 'auto' | 'bike_taxi' | 'local_train' | 'metro' | 'bus' | 'shuttle' | 'own_vehicle';

export interface CityPass {
  id: string;
  operator: string; // "Cityflo", "Gala Bus", "BEST (Chalo)"
  mode: TransportMode;
  name: string;
  priceInr: number | null; // null = not yet confirmed
  periodDays: number | null;
  trips: number | null; // null = unlimited or unknown
  coverage: string[]; // locality names it serves
  status: ModuleStatus;
  sources: SourceRef[];
  actionUrl: string | null;
}

export interface CityPack {
  id: string; // "in-mmr"
  name: string; // "Mumbai, Navi Mumbai, Thane"
  country: string;
  localities: string[];
  passes: CityPass[];
  /** Typical per-trip costs by mode, used only as labelled assumptions. */
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

/* ---------- user side (lives in AppData.savings, on the device) ---------- */

export interface CommuteLeg {
  id: string;
  from: string;
  to: string;
  daysPerWeek: number;
  mode: TransportMode;
  costPerTripInr: number | null;
}

export interface SavingsProfile {
  cityPack: string | null;
  homeLocality: string | null;
  commute: CommuteLeg[];
  /** User edits to assumptions, keyed by Assumption.key (e.g. "uber-one-in:ridesPerMonth"). */
  overrides: Record<string, number>;
  /** Anonymous "I switched and saved" reports, opt-in. */
  communityOptIn: boolean;
  /** Provider labels already sent for research (so we don't resend). */
  researchSent: string[];
}

export type AssumptionSource = 'your_data' | 'you_entered' | 'typical';

export interface Assumption {
  key: string;
  label: string; // "Rides a month"
  value: number;
  unit: string; // "rides", "₹", "%"
  source: AssumptionSource;
  editable: boolean;
}

export type MoveConfidence = 'high' | 'medium' | 'low';
export type MoveStatus = 'new' | 'doing' | 'done' | 'dismissed';

export interface Move {
  id: string; // stable: `${kind}:${moduleId ?? ''}:${obligationIds.join('+')}`
  kind: ValueKind;
  moduleId: string | null;
  obligationIds: string[];
  title: string; // one line, e.g. "Pause Uber One before 12 Dec"
  why: string; // one line, e.g. "You took 4 rides; it needs 7 to pay back"
  monthlySavingInr: number; // point estimate, >= 0
  rangeInr: [number, number];
  confidence: MoveConfidence;
  assumptions: Assumption[];
  sources: SourceRef[];
  effort: 'tap' | 'habit' | 'paperwork';
  action: { url: string | null; label: string };
  /** True when any price came from a 'research' (unverified) module. */
  unverifiedPrice: boolean;
  legalNote: string | null;
  sponsored: false; // ads are off at launch
}

export interface LedgerEntry {
  moveId: string;
  kind: ValueKind;
  title: string;
  foundMonthlyInr: number;
  status: MoveStatus;
  /** Set only when later evidence proves it (an obligation change or a new import). */
  savedMonthlyInr: number | null;
  proofRef: string | null;
  foundAt: string;
  updatedAt: string;
}

export interface SavingsState {
  profile: SavingsProfile;
  ledger: LedgerEntry[];
}

/** A provider Due found in the user's data but has no module for yet. Sent anonymously for research. */
export interface ResearchNeed {
  providerLabel: string;
  category: SavingsModule['category'] | 'unknown';
  obligationIds: string[];
}

/* ---------- statements: recurring payment detection ---------- */

export interface StatementLine {
  date: string; // ISO
  narration: string;
  amountInr: number; // positive = debit
  source: 'bank' | 'card';
}

export interface RecurringCandidate {
  key: string; // merchant key
  label: string;
  rail: 'upi_autopay' | 'bank_mandate' | 'credit_card' | 'debit_card' | 'unknown';
  cadence: 'monthly' | 'quarterly' | 'yearly';
  averageInr: number;
  lastDate: string;
  nextExpected: string;
  occurrences: number;
  confidence: MoveConfidence;
  lineIndexes: number[];
}

export const COMMUNITY_THRESHOLD = 20;
