import type { Queryable } from './db.js';
import { computeStatus, effectiveConfidence } from './monitor/status.js';

const KIND_TO_CATEGORY: Record<string, string> = {
  plan_page: 'pricing',
  terms: 'terms',
  faq: 'help',
  landing_page: 'product_page',
  press_release: 'press',
  help_page: 'help',
  campaign_page: 'product_page',
  product_page: 'product_page',
};

interface OfferRow {
  id: string;
  provider: string;
  product_family: string;
  name: string;
  benefit_type: string;
  price_inr: number | null;
  billing_period: string | null;
  benefit_value: Record<string, unknown>;
  source_urls: string[];
  official_end_at: string | null;
  terms_status: string;
  page_status: string;
  computed_status: string;
  confidence: string;
  notes: string[];
  details: Record<string, unknown> & { sources?: { url: string; label: string; kind: string }[] };
  verification_status: string;
  observed_at: Date | null;
  last_confirmed_at: Date | null;
  updated_at: Date;
  // Migration 008 (offer intelligence).
  sku?: string | null;
  geography?: string | null;
  official_start_at?: string | null;
  superseded_by?: string | null;
  last_successful_check_at?: Date | null;
  last_attempted_check_at?: Date | null;
  last_check_error?: string | null;
  freshness_window_hours?: number;
  provider_family?: string | null;
  status_reason?: string | null;
  status_changed_at?: Date | null;
}

export interface CatalogSource {
  url: string;
  label: string;
  category: string | null;
  lastCheckedAt: Date | null;
  status: string;
}

/**
 * API shape of an offer. `status`/`computedStatus` are computed on read with the server-side rules (including
 * the stale-data policy), so a stored status can never stay confidently active past its freshness window.
 */
export function offerToApi(o: OfferRow, now: Date = new Date()): Record<string, unknown> {
  const { sources: _s, ...details } = o.details ?? {};
  const st = computeStatus(
    {
      ...o,
      official_end_at: o.official_end_at,
      last_successful_check_at: o.last_successful_check_at ?? null,
      freshness_window_hours: o.freshness_window_hours ?? 168,
    },
    now,
  );
  return {
    ...details,
    id: o.id,
    provider: o.provider,
    productFamily: o.product_family,
    name: o.name,
    benefitType: o.benefit_type,
    priceInr: o.price_inr,
    billingPeriod: o.billing_period,
    benefitValue: o.benefit_value,
    sourceUrls: o.source_urls,
    officialEndAt: o.official_end_at,
    termsStatus: o.terms_status,
    pageStatus: o.page_status,
    computedStatus: st.status,
    status: st.status,
    statusReason: st.reason,
    storedStatus: o.computed_status,
    confidence: o.confidence,
    effectiveConfidence: effectiveConfidence(o.confidence, st),
    freshness: st.freshness,
    sku: o.sku ?? null,
    geography: o.geography ?? null,
    officialStartAt: o.official_start_at ?? null,
    providerFamily: o.provider_family ?? null,
    supersededBy: o.superseded_by ?? null,
    lastSuccessfulCheckAt: o.last_successful_check_at ?? null,
    lastAttemptedCheckAt: o.last_attempted_check_at ?? null,
    freshnessWindowHours: o.freshness_window_hours ?? 168,
    notes: o.notes,
    verificationStatus: o.verification_status,
    observedAt: o.observed_at,
    lastConfirmedAt: o.last_confirmed_at,
    updatedAt: o.updated_at,
  };
}

/**
 * Public offer catalog. Each offer lists its sources with live monitoring state when the URL is a
 * monitored source; otherwise status is 'not_monitored' with lastCheckedAt null.
 */
export async function buildPublicCatalog(q: Queryable, now: Date) {
  return { generatedAt: now.toISOString(), offers: await catalogOffers(q, now) };
}

/** Live offers with their sources' monitoring state (shared by the catalog and the match endpoint). */
export async function catalogOffers(q: Queryable, now: Date): Promise<(Record<string, unknown> & { sources: CatalogSource[] })[]> {
  const offers = (
    await q.query<OfferRow>(`SELECT * FROM offers WHERE verification_status <> 'rejected' AND superseded_by IS NULL ORDER BY provider, id`)
  ).rows;
  const urls = [...new Set(offers.flatMap((o) => o.source_urls))];
  const monitored = new Map<string, { label: string; source_category: string; last_checked_at: Date | null; status: string }>();
  if (urls.length) {
    const rows = (
      await q.query<{ url: string; label: string; source_category: string; last_checked_at: Date | null; status: string }>(
        `SELECT DISTINCT ON (url) url, label, source_category, last_checked_at, status
           FROM sources WHERE url = ANY($1) ORDER BY url, last_checked_at DESC NULLS LAST`,
        [urls],
      )
    ).rows;
    for (const r of rows) monitored.set(r.url, r);
  }
  return offers.map((o) => {
      const labels = new Map((o.details?.sources ?? []).map((s) => [s.url, s]));
      const sources: CatalogSource[] = o.source_urls.map((url) => {
        const m = monitored.get(url);
        const ref = labels.get(url);
        return m
          ? { url, label: m.label, category: m.source_category, lastCheckedAt: m.last_checked_at, status: m.status }
          : {
              url,
              label: ref?.label ?? url,
              category: ref ? (KIND_TO_CATEGORY[ref.kind] ?? null) : null,
              lastCheckedAt: null,
              status: 'not_monitored',
            };
      });
      return { ...offerToApi(o, now), sources };
    });
}
