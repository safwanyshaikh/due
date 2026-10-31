/**
 * Server-side offer status rules (docs/production/LAUNCH_SPEC.md, "Offer Intelligence engine" and
 * "Offer intelligence operations"). Pure functions: the same rules run on read (public catalog, match)
 * and in the periodic `offers_status` job that records transitions.
 */

export const OFFER_STATUSES = ['active', 'active_verify', 'expired', 'conflicting', 'unknown'] as const;
export type OfferStatus = (typeof OFFER_STATUSES)[number];

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
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export const PAGE_STATUSES = ['visible', 'unavailable', 'login_required', 'dynamic', 'unknown'] as const;
export const TERMS_STATUSES = ['active', 'expired', 'unavailable', 'conflicting', 'unknown'] as const;

/** Default freshness window by research cadence: twice the cadence, so one missed refresh is tolerated. */
export function freshnessHoursForCadence(cadence: unknown): number {
  switch (cadence) {
    case 'daily':
      return 48;
    case 'weekly':
      return 336;
    case 'monthly':
      return 1440;
    default:
      return 720;
  }
}

export interface StatusInput {
  official_end_at: string | Date | null;
  terms_status: string;
  page_status: string;
  verification_status: string;
  benefit_value: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
  last_successful_check_at: Date | string | null;
  last_confirmed_at: Date | string | null;
  observed_at: Date | string | null;
  freshness_window_hours: number;
}

export type FreshnessState = 'fresh' | 'stale' | 'expired_window' | 'never_checked';

export interface Freshness {
  state: FreshnessState;
  /** The time freshness is measured from: last successful engine check, else last research confirmation. */
  referenceAt: string | null;
  ageHours: number | null;
  windowHours: number;
}

export interface StatusResult {
  status: OfferStatus;
  reason: string;
  /** The status before the stale-data policy was applied. */
  baseStatus: OfferStatus;
  freshness: Freshness;
}



function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** YYYY-MM-DD for a date column (pg returns DATE as a local-midnight Date or a string). */
function dateOnly(v: string | Date | null): string | null {
  if (!v) return null;
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, '0');
  const d = String(v.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Today's date in India Standard Time (official offer end dates are Indian calendar dates). */
export function istDate(now: Date): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** True when the provider shows the benefit only to selected users or only inside its app or checkout. */
export function isPersonalisedOrAppOnly(benefit: Record<string, unknown> | null, details: Record<string, unknown> | null): boolean {
  const b = benefit ?? {};
  const d = details ?? {};
  return b.personalised === true || d.personalised === true || d.appOnly === true || b.appOnly === true;
}

function hasProviderOnlyEligibility(details: Record<string, unknown> | null): boolean {
  const el = (details ?? {}).eligibility;
  return Array.isArray(el) && el.some((e) => (e as { verification?: unknown })?.verification === 'provider_only');
}

export function freshnessOf(o: Pick<StatusInput, 'last_successful_check_at' | 'last_confirmed_at' | 'observed_at' | 'freshness_window_hours'>, now: Date): Freshness {
  const ref = toDate(o.last_successful_check_at) ?? toDate(o.last_confirmed_at) ?? toDate(o.observed_at);
  const windowHours = o.freshness_window_hours > 0 ? o.freshness_window_hours : 168;
  if (!ref) return { state: 'never_checked', referenceAt: null, ageHours: null, windowHours };
  const ageHours = Math.max(0, (now.getTime() - ref.getTime()) / 3_600_000);
  const state: FreshnessState = ageHours > 2 * windowHours ? 'expired_window' : ageHours > windowHours ? 'stale' : 'fresh';
  return { state, referenceAt: ref.toISOString(), ageHours: Math.round(ageHours * 10) / 10, windowHours };
}

/**
 * Status rules, in order:
 *  1. official end date passed → expired;
 *  2. terms expired/unavailable → conflicting when the landing page is still visible, otherwise expired;
 *  3. terms conflicting → conflicting;
 *  4. personalised or app-only → active_verify (provider-only until the user confirms);
 *  5. terms active + landing visible → active (active_verify until the engine has confirmed it, or when
 *     eligibility can only be checked by the provider); terms active with an app/login/dynamic page → active_verify;
 *     anything else (a visible landing page alone proves nothing) → unknown;
 *  6. stale policy: beyond the freshness window active → active_verify; beyond twice the window active or
 *     active_verify → unknown. Never-checked offers cannot be active.
 */
export function computeStatus(o: StatusInput, now: Date): StatusResult {
  const freshness = freshnessOf(o, now);
  const done = (status: OfferStatus, reason: string, baseStatus: OfferStatus = status): StatusResult => ({ status, reason, baseStatus, freshness });
  const end = dateOnly(o.official_end_at);
  if (end && end < istDate(now)) return done('expired', 'official_end_passed');
  if (o.terms_status === 'expired' || o.terms_status === 'unavailable') {
    return o.page_status === 'visible' ? done('conflicting', 'landing_visible_terms_unavailable') : done('expired', 'terms_unavailable');
  }
  if (o.terms_status === 'conflicting') return done('conflicting', 'terms_conflicting');

  let base: OfferStatus;
  let reason: string;
  if (isPersonalisedOrAppOnly(o.benefit_value, o.details)) {
    base = 'active_verify';
    reason = 'personalised_or_app_only';
  } else if (o.terms_status === 'active' && o.page_status === 'visible') {
    const engineConfirmed = toDate(o.last_successful_check_at) !== null || o.verification_status === 'verified';
    if (!engineConfirmed) {
      base = 'active_verify';
      reason = 'not_yet_confirmed_by_engine';
    } else if (hasProviderOnlyEligibility(o.details)) {
      base = 'active_verify';
      reason = 'provider_only_eligibility';
    } else {
      base = 'active';
      reason = 'terms_and_page_active';
    }
  } else if (o.terms_status === 'active' && (o.page_status === 'login_required' || o.page_status === 'dynamic')) {
    base = 'active_verify';
    reason = 'app_or_login_only_page';
  } else {
    base = 'unknown';
    reason = o.page_status === 'visible' ? 'landing_page_only' : 'insufficient_evidence';
  }

  if (base === 'active' || base === 'active_verify') {
    if (freshness.state === 'never_checked') return done('unknown', 'never_checked', base);
    if (freshness.state === 'expired_window') return done('unknown', 'stale_beyond_twice_freshness_window', base);
    if (freshness.state === 'stale' && base === 'active') return done('active_verify', 'stale_beyond_freshness_window', base);
  }
  return done(base, reason);
}

const CONF_RANK = { low: 0, medium: 1, high: 2 } as const;
type Confidence = keyof typeof CONF_RANK;

/** Stored confidence capped by what the computed status can support. */
export function effectiveConfidence(stored: string, r: StatusResult): Confidence {
  const s: Confidence = stored in CONF_RANK ? (stored as Confidence) : 'low';
  const cap: Confidence =
    r.status === 'unknown' || r.status === 'conflicting' ? 'low' : r.status === 'active_verify' || r.freshness.state !== 'fresh' ? 'medium' : 'high';
  return CONF_RANK[s] <= CONF_RANK[cap] ? s : cap;
}


