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
  | 'trial_end' // a free trial is about to convert to paid
  | 'fee_leak'; // card interest, late fees, forex markup, annual fee from a statement

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
  category:
    | 'mobility'
    | 'food'
    | 'telecom'
    | 'ott'
    | 'music'
    | 'cloud'
    | 'shopping'
    | 'card'
    | 'loan'
    | 'utility'
    | 'other';
  country: string; // ISO-2, "IN"
  cityPack: string | null; // e.g. "in-mmr"
  /** 3 Rules: typed by valueKind. Unknown numbers are null, never guessed. */
  rules: ModuleRules;
  /** 4 Value: which formula family the engine uses. */
  valueKind: ValueKind;
  /** 5 Proof: what later evidence proves the saving happened. */
  proof: {
    signal:
      'amount_drop' | 'charge_stopped' | 'new_plan_charge' | 'fewer_charges' | 'user_confirmed';
    description: string;
  };
  /** 6 Nudge: when to tell the user. */
  nudge: {
    trigger: 'before_renewal' | 'before_expiry' | 'usage_drop' | 'on_detect';
    leadDays: number;
  };
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

export type TransportMode =
  'cab' | 'auto' | 'bike_taxi' | 'local_train' | 'metro' | 'bus' | 'shuttle' | 'own_vehicle';

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
  /** Additive: 'urgent' moves (e.g. an overdue loan in SMA) rank first regardless of saving. */
  /** 'info' moves carry no money claim and rank last. */
  severity?: 'urgent' | 'info';
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
  /* Additive (engine): what the move was about, kept so later evidence can be checked. */
  moduleId?: string | null;
  obligationIds?: string[];
  /** The obligation whose spend the move would cut (overlap: the duplicate; others: the first id). */
  targetObligationId?: string | null;
  /** Snapshot of the target obligation when the move was found (or last refreshed before 'done'). */
  baseline?: LedgerBaseline | null;
}

/** Additive (engine): the target obligation as it was, used by proveSavings. */
export interface LedgerBaseline {
  obligationId: string;
  monthlyPaise: number | null;
  status: string;
  interestRatePct: number | null;
  at: string;
}

export interface SavingsState {
  profile: SavingsProfile;
  ledger: LedgerEntry[];
  /** Additive: card statement summaries the user saved from a statement import (no card numbers). */
  statements?: CardStatementSummary[];
  /** Additive: loan statement / welcome-letter summaries the user saved (no account numbers). */
  loans?: LoanStatementSummary[];
  /** Additive: bank-account statement summaries (failed auto-debits, morning balances, price steps). */
  banks?: BankStatementSummary[];
  /** Additive: telecom bills. */
  telecom?: TelecomBillSummary[];
  /** Additive: UPI app statements. */
  upi?: UpiStatementSummary[];
}

/** Additive: a merchant whose monthly charge stepped up and stayed there. */
export interface PriceStep {
  key: string;
  label: string;
  fromInr: number;
  toInr: number;
  /** YYYY-MM of the first month at the new price. */
  since: string;
}

/** Additive: what Due keeps from a bank statement (no account numbers, no payee names). */
export interface BankStatementSummary {
  bank: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  /** Auto-debits (mandates) returned for insufficient balance, and the bank's charges, per month. */
  failedAutoDebits: { month: string; count: number; chargesInr: number }[];
  /** Balance at 09:00 on each day of the statement. */
  morningBalances: { date: string; balanceInr: number }[];
  priceSteps: PriceStep[];
  /** Additive: automatic recoveries to an overdue loan/overdraft account in SMA ("SMA REC"). */
  smaSweeps?: { date: string; amountInr: number }[];
  /** Additive: recurring candidates found in this statement (for statement-only overlap moves). */
  recurring?: RecurringCandidate[];
}

/** Additive: a telecom bill (Jio Postpaid / JioFiber / AirFiber), read on the device. Rupees. */
export interface TelecomBillSummary {
  provider: string;
  service: 'postpaid' | 'fiber';
  planName: string | null;
  baseRentalInr: number | null;
  addOns: { label: string; amountInr: number }[];
  usageChargesInr: number | null;
  taxesInr: number | null;
  totalPayableInr: number | null;
  dueDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  dataUsedGb: number | null;
  planDataGb: number | null;
  /** What the plan says it includes, as printed (e.g. "13 paid OTT apps (list not printed)"). */
  includes: string[];
  ottAppCount: number | null;
}

/** Additive: UPI-app (Google Pay) statement totals that matter to Savings. */
export interface UpiStatementSummary {
  app: string;
  periodFrom: string | null;
  periodTo: string | null;
  /** UPI payments charged to credit cards, per card. */
  creditCardSpend: { paidBy: string; last4: string | null; totalInr: number; months: number }[];
}

/** Additive: a loan "Statement of Account" or welcome letter, read on the device. Rupees. */
export interface LoanStatementSummary {
  source: 'statement' | 'welcome_letter';
  lender: string | null;
  product: string | null;
  rateType: 'floating' | 'fixed' | null;
  annualRatePct: number | null;
  emiInr: number | null;
  /** Day of month the EMI is debited (1–31). */
  emiDueDay: number | null;
  loanAmountInr: number | null;
  loanTenureMonths: number | null;
  balanceTenureMonths: number | null;
  futurePrincipalInr: number | null;
  overdueInstalmentInr: number | null;
  /** Late payment charges still owed (closing balance). */
  latePaymentChargesInr: number | null;
  /** Rows "Bounced MON/YYYY" (each presentation that bounced). */
  bounceCount: number;
  /** YYYY-MM of every bounced row (repeats when an EMI bounced twice). */
  bounceRows: string[];
  /** Distinct months with a bounce, sorted. */
  bounceMonths: string[];
  bounceChargesInr: number;
  /** Each "Bounce Charges" debit, for windowed totals. */
  bounceCharges: { date: string; amountInr: number }[];
  processingFeeInr: number | null;
  disbursementDate: string | null;
  instalmentEndDate: string | null;
  /** Date the statement was generated. */
  statementDate: string | null;
  /** Set when the user added this loan's EMI as an obligation. */
  obligationId?: string | null;
  /* Additive: overdraft-style loans (SBI Gold Loan OD). */
  productKind?: 'gold_loan_od';
  limitInr?: number | null;
  outstandingInr?: number | null;
  monthlyInterest?: { month: string; amountInr: number }[];
  penalChargesInr?: number | null;
  /** "Irregularity Recovery" / "SMA REC" credits. */
  irregularities?: { date: string; amountInr: number; label: string }[];
  irregularityCount?: number;
}

/**
 * Additive: the account summary printed on a credit-card statement, read on the device.
 * Only masked digits of the card are kept. Rupees. null = not printed / not read.
 */
export interface CardStatementSummary {
  issuer: string | null;
  /** Visible digits of the masked card number only (e.g. "00" from "XXXX XXXX XXXX XX00"). */
  last4: string | null;
  statementDate: string | null;
  dueDate: string | null;
  creditLimit: number | null;
  availableCredit: number | null;
  totalDue: number | null;
  minimumDue: number | null;
  previousBalance: number | null;
  payments: number | null;
  purchases: number | null;
  feesTaxesInterest: number | null;
  /** Finance charges this statement, including the GST printed with them. */
  financeChargeInr: number | null;
  lateFeeInr: number | null;
  forexMarkupInr: number | null;
  /** Annual fee charged this statement (incl. GST); reversals are in annualFeeReversedInr. */
  annualFeeInr: number | null;
  annualFeeReversedInr?: number | null;
  /** Spend-based waiver text, only when the statement prints exactly one. */
  annualFeeWaiver?: string | null;
  /** Monthly interest rate printed on the statement, e.g. 3.75. */
  monthlyRatePct: number | null;
  /** Foreign-currency purchases this statement (rupees), for the forex-markup move. */
  foreignSpendInr?: number | null;
  /** Set when the user added this card's bill as an obligation. */
  obligationId?: string | null;
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
  /* Additive (engine): metadata read from the same line. */
  /** Foreign amount and ISO currency when the line shows one ("26.67 USD"). amountInr stays the INR charge. */
  foreignAmount?: number;
  foreignCurrency?: string;
  /** Tax printed with a fee line ("(EXCL TAX 2384.03)"): the GST on that fee, charged separately. */
  taxInr?: number;
  /** What the line is. Only 'purchase' lines can become subscriptions. */
  lineKind?:
    | 'purchase'
    | 'fee'
    | 'interest'
    | 'tax'
    | 'payment'
    | 'reversal'
    | 'credit'
    | 'wallet_topup'
    | 'loan_repayment'
    | 'p2p';
  /** Additive: the account or card that paid (UPI apps print it), e.g. "State Bank of India 0000 | RuPay credit card". */
  paidBy?: string;
  /** Additive: a transfer between the statement holder's own accounts (not spending or income). */
  selfTransfer?: boolean;
  /** YYYY-MM of the statement's closing date, when the text printed its period. */
  statementPeriod?: string;
  /** Running balance printed on the row (bank statements). */
  balanceInr?: number;
  /** Time of the transaction, HH:MM:SS, when printed. */
  time?: string;
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
  /** Additive: subscription, or repeated usage top-ups (e.g. cloud credits), or unclear. */
  kind?: 'subscription' | 'usage_topup' | 'unknown' | 'regular_transfer' | 'bill';
  /** Additive: the foreign currency when the charges were billed in one. */
  foreignCurrency?: string;
  /** Additive: postpaid-style merchants, distinct amounts paid a month ≈ connections. */
  connections?: number;
  /** Additive: the same merchant was paid from both bank and card lines passed together. */
  severalPaymentMethods?: boolean;
}

export const COMMUNITY_THRESHOLD = 20;
