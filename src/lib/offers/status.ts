import type { OfferRecord, OfferStatus } from './types';

const AUTHORITATIVE = new Set([
  'plan_page',
  'terms',
  'faq',
  'help_page',
  'campaign_page',
  'product_page',
]);

/**
 * Deterministic status rules. Page visibility alone never makes something active,
 * and a press release alone is not a current offer.
 */
export function computeStatus(r: Omit<OfferRecord, 'computedStatus'>, today: string): OfferStatus {
  if (r.officialEndAt && r.officialEndAt < today) return 'expired';
  if (r.termsStatus === 'expired' || r.termsStatus === 'unavailable') {
    return r.pageStatus === 'visible' ? 'conflicting' : 'expired';
  }
  if (r.termsStatus === 'conflicting') return 'conflicting';
  const hasAuthoritative = r.sources.some((s) => AUTHORITATIVE.has(s.kind));
  if (!hasAuthoritative && !r.liveClaimPath) return 'unknown';
  if (r.termsStatus !== 'active') return 'unknown';
  if (r.pageStatus === 'unavailable') return 'unknown';
  const unresolved = r.eligibility.length > 0 || !r.officialEndAt || r.pageStatus !== 'visible';
  return unresolved ? 'active_verify' : 'active';
}

export const STATUS_TEXT: Record<OfferStatus, string> = {
  active: 'Active',
  active_verify: 'Active — verify',
  expired: 'Expired',
  conflicting: 'Conflicting sources',
  unknown: 'Unknown',
};

export const STATUS_ICON: Record<OfferStatus, string> = {
  active: '●',
  active_verify: '◐',
  expired: '○',
  conflicting: '△',
  unknown: '?',
};

/** Only these may appear in the default list of benefits to look at. */
export function isRecommendable(s: OfferStatus): boolean {
  return s === 'active' || s === 'active_verify';
}

const STALE_DAYS: Record<OfferRecord['cadence'], number> = {
  daily: 2,
  weekly: 8,
  monthly: 31,
  on_demand: 31,
};

export function daysBetween(a: string, b: string): number {
  return Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000,
  );
}

export function isStale(
  r: Pick<OfferRecord, 'lastConfirmedAt' | 'cadence'>,
  today: string,
): boolean {
  return daysBetween(r.lastConfirmedAt, today) > STALE_DAYS[r.cadence];
}

export function expiryLabel(r: Pick<OfferRecord, 'officialEndAt'>): string {
  return r.officialEndAt
    ? `Official end date: ${r.officialEndAt}`
    : 'Expiry not published — verify';
}
