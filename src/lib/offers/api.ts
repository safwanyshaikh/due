/**
 * Client for Due's monitoring service: GET `${VITE_API_BASE}/api/public/catalog`.
 * This is the only network call in the consumer app. It sends no user data: no cookies,
 * no query parameters, no request body.
 */
import { computeStatus } from './status';
import { isSafeHttpUrl, kindForCategory } from './sources';
import type {
  BenefitType,
  Cadence,
  Confidence,
  EligibilityKind,
  EligibilityRule,
  OfferRecord,
  OfferStatus,
  PageStatus,
  SourceRef,
  TermsStatus,
  UserServiceRecord,
  VerificationStatus,
} from './types';

export const CATALOG_PATH = '/api/public/catalog';
export const CATALOG_CACHE_KEY = 'due:catalog-cache:v1';
export const DEFAULT_TIMEOUT_MS = 10_000;

export function apiBase(): string {
  const raw = (import.meta.env.VITE_API_BASE as string | undefined) ?? '';
  return raw.trim().replace(/\/+$/, '');
}

export function catalogUrl(base: string = apiBase()): string {
  return `${base.replace(/\/+$/, '')}${CATALOG_PATH}`;
}

/** The last good response, kept so the app can say when data was last updated. */
export interface CatalogCache {
  generatedAt: string;
  fetchedAt: string;
  offers: unknown[];
}

export type CatalogErrorKind = 'timeout' | 'network' | 'http' | 'invalid';

export interface CatalogError {
  kind: CatalogErrorKind;
  message: string;
  status?: number;
}

export type CatalogFetchResult =
  { ok: true; data: CatalogCache } | { ok: false; error: CatalogError };

type FetchLike = (
  input: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
    credentials: 'omit';
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export async function fetchCatalog(
  opts: {
    base?: string;
    fetchImpl?: FetchLike;
    timeoutMs?: number;
    now?: () => string;
  } = {},
): Promise<CatalogFetchResult> {
  const doFetch: FetchLike | undefined =
    opts.fetchImpl ?? (typeof fetch === 'function' ? (fetch as unknown as FetchLike) : undefined);
  if (!doFetch) return { ok: false, error: { kind: 'network', message: 'No network available.' } };
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await doFetch(catalogUrl(opts.base ?? apiBase()), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: ctrl.signal,
      credentials: 'omit',
    });
    if (!res.ok)
      return {
        ok: false,
        error: { kind: 'http', status: res.status, message: `HTTP ${res.status}` },
      };
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        error: { kind: 'invalid', message: 'The response was not valid JSON.' },
      };
    }
    const parsed = parseCatalogPayload(body);
    if (!parsed)
      return {
        ok: false,
        error: { kind: 'invalid', message: 'The response was not a valid catalog.' },
      };
    return {
      ok: true,
      data: { ...parsed, fetchedAt: (opts.now ?? (() => new Date().toISOString()))() },
    };
  } catch (e) {
    if (timedOut)
      return { ok: false, error: { kind: 'timeout', message: 'The request timed out.' } };
    return {
      ok: false,
      error: { kind: 'network', message: (e as Error)?.message || 'Network error.' },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Validates the envelope only: {generatedAt: string, offers: array}. Offers are normalised later. */
export function parseCatalogPayload(
  body: unknown,
): { generatedAt: string; offers: unknown[] } | null {
  if (!isObj(body)) return null;
  const generatedAt = body.generatedAt;
  if (typeof generatedAt !== 'string' || Number.isNaN(Date.parse(generatedAt))) return null;
  if (!Array.isArray(body.offers)) return null;
  return { generatedAt, offers: body.offers };
}

// ---------- cache ----------

export function loadCatalogCache(
  storage: Pick<Storage, 'getItem'> | null = safeLocal(),
): CatalogCache | null {
  try {
    const raw = storage?.getItem(CATALOG_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!isObj(v) || typeof v.fetchedAt !== 'string') return null;
    const env = parseCatalogPayload(v);
    return env ? { ...env, fetchedAt: v.fetchedAt } : null;
  } catch {
    return null;
  }
}

export function saveCatalogCache(
  c: CatalogCache,
  storage: Pick<Storage, 'setItem'> | null = safeLocal(),
): boolean {
  try {
    storage?.setItem(CATALOG_CACHE_KEY, JSON.stringify(c));
    return !!storage;
  } catch {
    return false;
  }
}

function safeLocal(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

// ---------- normalisation (contract shape -> OfferRecord) ----------

const BENEFIT_TYPES: BenefitType[] = [
  'recurring_entitlement',
  'one_time_reward',
  'trial',
  'bundle',
  'capability',
];
const PAGE: PageStatus[] = ['visible', 'unavailable', 'login_required', 'dynamic', 'unknown'];
const TERMS: TermsStatus[] = ['active', 'expired', 'unavailable', 'conflicting', 'unknown'];
const STATUSES: OfferStatus[] = ['active', 'active_verify', 'expired', 'conflicting', 'unknown'];
const CONF: Confidence[] = ['high', 'medium', 'low'];
const CADENCE: Cadence[] = ['daily', 'weekly', 'monthly', 'on_demand'];
const VERIFY: VerificationStatus[] = ['research_snapshot', 'pending', 'verified', 'rejected'];
const PERIODS = ['monthly', 'quarterly', 'annual', 'one_time', 'none'] as const;
const ELIG_KINDS: EligibilityKind[] = [
  'service_type',
  'plan_threshold',
  'tenure',
  'number_type',
  'address_circle',
  'age',
  'account_status',
  'payment_rail',
  'partner_app',
  'min_transaction',
  'frequency_cap',
  'promo_code',
  'existing_subscription',
  'device_platform',
  'claim_channel',
  'claim_deadline',
  'renewal_rule',
  'exclusion',
];
const SERVICE_FIELDS: (keyof UserServiceRecord)[] = [
  'serviceType',
  'numberType',
  'existingSubscription',
  'device',
  'partnerAppStatus',
  'paymentRail',
  'claimCardVisible',
  'billedThrough',
  'circle',
  'tenureMonths',
];

const PROVIDER_ALIASES: [RegExp, string][] = [
  [/^(google pay|gpay|rupay|paytm|upi|cards?)\b/, 'ecosystem'],
  [/^jio\b/, 'jio'],
  [/^airtel\b/, 'airtel'],
  [/^(vi|vodafone idea|myvi)\b/, 'vi'],
  [/^amazon\b/, 'amazon'],
  [/^google\b/, 'google'],
];

export function providerSlug(raw: string): string {
  const t = raw.trim().toLowerCase();
  for (const [re, slug] of PROVIDER_ALIASES) if (re.test(t)) return slug;
  return t;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function pick(o: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function oneOf<T extends string>(v: unknown, list: readonly T[]): T | undefined {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;
}
function dateOnly(v: unknown): string | undefined {
  const s = str(v);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : undefined;
}
function timestamp(v: unknown): string | null {
  const s = str(v);
  return s && !Number.isNaN(Date.parse(s)) ? s : null;
}

function normaliseSources(o: Record<string, unknown>): SourceRef[] {
  const out: SourceRef[] = [];
  const list = pick(o, 'sources');
  if (Array.isArray(list)) {
    for (const s of list) {
      if (!isObj(s)) continue;
      const url = str(s.url);
      if (!url || !isSafeHttpUrl(url)) continue;
      const category = str(s.category);
      out.push({
        url,
        label: str(s.label) ?? url,
        category,
        kind: kindForCategory(category),
        lastCheckedAt: timestamp(pick(s, 'lastCheckedAt', 'last_checked_at')),
        status: str(s.status),
      });
    }
  }
  const urls = pick(o, 'source_urls', 'sourceUrls');
  if (Array.isArray(urls))
    for (const u of urls)
      if (typeof u === 'string' && isSafeHttpUrl(u) && !out.some((s) => s.url === u))
        out.push({ url: u, label: u, kind: 'landing_page' });
  return out;
}

function normaliseEligibility(v: unknown): EligibilityRule[] {
  if (!Array.isArray(v)) return [];
  const out: EligibilityRule[] = [];
  for (const r of v) {
    if (!isObj(r)) continue;
    const kind = oneOf(r.kind, ELIG_KINDS);
    const description = str(r.description);
    if (!kind || !description) continue;
    const field = oneOf(r.field, SERVICE_FIELDS as string[]) as keyof UserServiceRecord | undefined;
    const verification = r.verification === 'user_input' && field ? 'user_input' : 'provider_only';
    const expected =
      typeof r.expected === 'string' || typeof r.expected === 'boolean' ? r.expected : undefined;
    out.push({ kind, description, verification, field, expected });
  }
  return out;
}

/**
 * Maps one offer from the contract shape (snake_case DB columns plus `sources`) to the app's model.
 * Returns null for malformed or rejected records. Nothing is invented: absent values stay absent.
 */
export function normaliseOffer(raw: unknown, today: string): OfferRecord | null {
  if (!isObj(raw)) return null;
  const offerId = str(pick(raw, 'id', 'offerId'));
  const name = str(raw.name);
  const provider = str(raw.provider);
  if (!offerId || !name || !provider) return null;
  const verificationStatus =
    oneOf(pick(raw, 'verification_status', 'verificationStatus'), VERIFY) ?? 'pending';
  if (verificationStatus === 'rejected') return null;
  const sources = normaliseSources(raw);
  const price = pick(raw, 'price_inr', 'price');
  const bv = pick(raw, 'benefit_value', 'benefitValue');
  const notes = pick(raw, 'notes');
  const observedAt = timestamp(pick(raw, 'observed_at', 'observedAt'));
  const record: Omit<OfferRecord, 'computedStatus'> = {
    offerId,
    provider: providerSlug(provider),
    productFamily: str(pick(raw, 'product_family', 'productFamily')) ?? '',
    name,
    skuOrPlanCode: str(pick(raw, 'sku_or_plan_code', 'skuOrPlanCode')),
    benefitType: oneOf(pick(raw, 'benefit_type', 'benefitType'), BENEFIT_TYPES) ?? 'other',
    currency: 'INR',
    price: typeof price === 'number' && Number.isFinite(price) && price >= 0 ? price : undefined,
    billingPeriod: oneOf(pick(raw, 'billing_period', 'billingPeriod'), PERIODS),
    benefitValue: isObj(bv) ? bv : {},
    geography: str(raw.geography),
    sourceUrls: sources.map((s) => s.url),
    sources,
    observedAt,
    officialStartAt: dateOnly(pick(raw, 'official_start_at', 'officialStartAt')),
    officialEndAt: dateOnly(pick(raw, 'official_end_at', 'officialEndAt')),
    lastConfirmedAt: timestamp(pick(raw, 'last_confirmed_at', 'lastConfirmedAt')),
    pageStatus: oneOf(pick(raw, 'page_status', 'pageStatus'), PAGE) ?? 'unknown',
    termsStatus: oneOf(pick(raw, 'terms_status', 'termsStatus'), TERMS) ?? 'unknown',
    confidence: oneOf(raw.confidence, CONF) ?? 'low',
    notes: Array.isArray(notes) ? notes.filter((n): n is string => typeof n === 'string') : [],
    eligibility: normaliseEligibility(raw.eligibility),
    liveClaimPath:
      typeof pick(raw, 'live_claim_path', 'liveClaimPath') === 'boolean'
        ? (pick(raw, 'live_claim_path', 'liveClaimPath') as boolean)
        : undefined,
    billingOwner: str(pick(raw, 'billing_owner', 'billingOwner')),
    cadence: oneOf(raw.cadence, CADENCE) ?? 'monthly',
    verificationStatus,
  };
  const local = computeStatus(record, today);
  const server = oneOf(pick(raw, 'computed_status', 'computedStatus'), STATUSES);
  // A passed official end date always wins, even if the server's status is older than today.
  const computedStatus =
    local === 'expired' && record.officialEndAt ? 'expired' : (server ?? local);
  return { ...record, computedStatus };
}

export function normaliseOffers(list: unknown[], today: string): OfferRecord[] {
  const seen = new Set<string>();
  const out: OfferRecord[] = [];
  for (const raw of list) {
    const o = normaliseOffer(raw, today);
    if (o && !seen.has(o.offerId)) {
      seen.add(o.offerId);
      out.push(o);
    }
  }
  return out;
}

/** e.g. "30 Oct 2026, 3:05 pm IST". */
export function formatIST(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown time';
  return `${new Date(t).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })} IST`;
}

/** Calendar date in IST for an ISO date or timestamp, e.g. "30 Oct 2026". */
export function formatDateIST(iso: string | null | undefined): string {
  if (!iso) return 'not yet';
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'unknown';
  return new Date(t).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
