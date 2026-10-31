/** Offer intelligence types and labels shared by the Offers, Review and Parser pages. */

export const PROVIDER_FAMILIES = [
  'jio',
  'airtel',
  'vi',
  'amazon_prime_ott',
  'google_one_gemini',
  'apple',
  'banks_cards',
  'upi_payments',
  'broadband_dth',
  'insurance',
  'utilities',
  'education_fees',
  'generic_subscriptions',
] as const;

const FAMILY_LABEL: Record<string, string> = {
  jio: 'Jio',
  airtel: 'Airtel',
  vi: 'Vi',
  amazon_prime_ott: 'Amazon Prime & OTT',
  google_one_gemini: 'Google One / Gemini',
  apple: 'Apple subscriptions',
  banks_cards: 'Banks & cards',
  upi_payments: 'UPI & payment apps',
  broadband_dth: 'Broadband & DTH',
  insurance: 'Insurance',
  utilities: 'Utilities',
  education_fees: 'Education fees',
  generic_subscriptions: 'Generic subscriptions',
};

export function familyLabel(f: string | null | undefined): string {
  if (!f) return '—';
  return FAMILY_LABEL[f] ?? f;
}

export const OFFER_STATUSES = ['active', 'active_verify', 'expired', 'conflicting', 'unknown'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  active_verify: 'Active — verify',
  expired: 'Expired',
  conflicting: 'Conflicting',
  unknown: 'Unknown',
};

export function offerStatusLabel(s: string | null | undefined): string {
  return s ? (STATUS_LABEL[s] ?? s) : '—';
}

export function offerStatusTone(s: string | null | undefined): 'neutral' | 'ok' | 'review' | 'error' | 'accent' {
  switch (s) {
    case 'active':
      return 'ok';
    case 'active_verify':
      return 'review';
    case 'expired':
    case 'conflicting':
      return 'error';
    default:
      return 'neutral';
  }
}

export interface Freshness {
  state: 'fresh' | 'stale' | 'expired_window' | 'never_checked';
  referenceAt: string | null;
  ageHours: number | null;
  windowHours: number;
}

export function freshnessText(f: Freshness | null | undefined): string {
  if (!f) return '—';
  switch (f.state) {
    case 'fresh':
      return `Fresh (${f.ageHours ?? 0} h of ${f.windowHours} h)`;
    case 'stale':
      return `Stale (${f.ageHours} h, window ${f.windowHours} h)`;
    case 'expired_window':
      return `Too old (${f.ageHours} h, over 2× ${f.windowHours} h)`;
    default:
      return 'Never checked';
  }
}

export interface OfferRow {
  id: string;
  provider: string;
  providerFamily: string | null;
  productFamily: string;
  name: string;
  benefitType: string;
  priceInr: number | null;
  billingPeriod: string | null;
  benefitValue: Record<string, unknown>;
  sourceUrls: string[];
  officialStartAt: string | null;
  officialEndAt: string | null;
  termsStatus: string;
  pageStatus: string;
  status: string;
  statusReason: string;
  confidence: string;
  effectiveConfidence: string;
  freshness: Freshness;
  freshnessWindowHours: number;
  sku: string | null;
  geography: string | null;
  supersededBy: string | null;
  notes: string[];
  verificationStatus: string;
  lastSuccessfulCheckAt: string | null;
  lastAttemptedCheckAt: string | null;
  lastCheckError?: string | null;
  lastConfirmedAt: string | null;
  pendingReviews?: number;
  observationCount?: number;
}

export interface Transition {
  id: number;
  fromStatus: string | null;
  toStatus: string;
  reason: string;
  actor: 'system' | 'admin';
  actorEmail: string | null;
  at: string;
}

export interface ReviewItem {
  id: number;
  offerId: string | null;
  offerName: string | null;
  provider: string | null;
  changeKind: string;
  proposed: Record<string, unknown>;
  current: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  sourceUrl: string | null;
  sourceLabel: string | null;
  parserVersion: string | null;
  observedAt: string | null;
  decidedByEmail: string | null;
  decidedAt: string | null;
  note: string | null;
}

export interface Observation {
  id: number;
  sourceId: string | null;
  sourceUrl: string | null;
  observedAt: string;
  parserVersion: string;
  fingerprint: string;
  fields: Record<string, unknown>;
  contentHash: string | null;
  httpStatus: number | null;
  origin: string;
  diff: { field: string; from: unknown; to: unknown }[];
  firstForSource: boolean;
}

export interface ParserVersion {
  id: number;
  sourceId: string | null;
  sourceUrl: string | null;
  sourceLabel: string | null;
  provider: string | null;
  version: string;
  rules: Record<string, unknown>;
  notes: string | null;
  active: boolean;
  createdAt: string;
  activatedAt: string | null;
  createdByEmail: string | null;
}

/** Short display of a field value in diffs and review items. */
export function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
