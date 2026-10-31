import { z } from 'zod';
import { catalogOffers, type CatalogSource } from '../catalog.js';
import type { Queryable } from '../db.js';

/**
 * Cross-calculation (LAUNCH_SPEC "Cross-calculation"): given a plan the user added, list benefits that the
 * plan may include, with eligibility, expiry, assumptions, confidence and sources. Estimates are never
 * presented as certain; every match is something the user must confirm with the provider.
 */

export const MatchQuery = z.object({
  provider: z.string().trim().min(1).max(60),
  serviceType: z.string().trim().max(40).optional(),
  planCode: z.string().trim().max(60).optional(),
  price: z.coerce.number().min(0).max(10_000_000).optional(),
});
export type MatchQuery = z.infer<typeof MatchQuery>;

/** Provider names users type, mapped to catalog provider ids and provider families. */
const PROVIDER_ALIASES: Record<string, { providers: string[]; family: string | null }> = {
  jio: { providers: ['jio'], family: 'jio' },
  'reliance jio': { providers: ['jio'], family: 'jio' },
  airtel: { providers: ['airtel'], family: 'airtel' },
  'bharti airtel': { providers: ['airtel'], family: 'airtel' },
  vi: { providers: ['vi'], family: 'vi' },
  vodafone: { providers: ['vi'], family: 'vi' },
  'vodafone idea': { providers: ['vi'], family: 'vi' },
  amazon: { providers: ['amazon'], family: 'amazon_prime_ott' },
  'amazon prime': { providers: ['amazon'], family: 'amazon_prime_ott' },
  prime: { providers: ['amazon'], family: 'amazon_prime_ott' },
  google: { providers: ['google'], family: 'google_one_gemini' },
  'google one': { providers: ['google'], family: 'google_one_gemini' },
  gemini: { providers: ['google'], family: 'google_one_gemini' },
  apple: { providers: ['apple'], family: 'apple' },
  'google pay': { providers: ['ecosystem'], family: 'upi_payments' },
  gpay: { providers: ['ecosystem'], family: 'upi_payments' },
  upi: { providers: ['ecosystem'], family: 'upi_payments' },
  paytm: { providers: ['ecosystem'], family: 'upi_payments' },
  rupay: { providers: ['ecosystem'], family: 'banks_cards' },
};

function resolveProvider(input: string): { providers: string[]; family: string | null } {
  const k = input.trim().toLowerCase().replace(/\s+/g, ' ');
  return PROVIDER_ALIASES[k] ?? { providers: [k], family: null };
}

type CheckState = 'confirmed' | 'missing' | 'provider_only' | 'not_met';

interface EligibilityRule {
  kind?: string;
  description?: string;
  verification?: string;
  field?: string;
  expected?: unknown;
}

export interface MatchItem {
  offerId: string;
  provider: string;
  productFamily: string;
  name: string;
  benefitType: string;
  possibleBenefit: unknown;
  matchedOn: string[];
  status: string;
  statusReason: string;
  eligibility: { overall: 'confirmed' | 'missing' | 'provider_only'; checks: { kind: string; description: string; state: CheckState }[] };
  expiry: { officialStartAt: string | null; officialEndAt: string | null; note: string };
  estimate: { amountInr: number | null; basis: string };
  confidence: 'high' | 'medium' | 'low';
  assumptions: string[];
  notes: string[];
  doubleCountNote: string | null;
  sources: CatalogSource[];
  lastSuccessfulCheckAt: unknown;
  freshness: unknown;
}

const DISCLAIMER =
  'Possible benefits only. Each one is an estimate from public provider pages and must be confirmed with the provider; it is not a promise of savings.';
const DOUBLE_COUNT_NOTE =
  'If this subscription is billed through your card, UPI or another bill, count it once: do not add it again when you review your card statement.';
const CONF_RANK = { low: 0, medium: 1, high: 2 } as const;

function userValue(q: MatchQuery, field: string | undefined): unknown {
  if (field === 'serviceType') return q.serviceType?.toLowerCase();
  return undefined;
}

function evaluateEligibility(rules: EligibilityRule[], q: MatchQuery): MatchItem['eligibility'] {
  const checks = rules.map((r) => {
    let state: CheckState;
    if (r.verification === 'provider_only') state = 'provider_only';
    else {
      const v = userValue(q, r.field);
      if (v === undefined) state = 'missing';
      else state = String(v) === String(r.expected).toLowerCase() ? 'confirmed' : 'not_met';
    }
    return { kind: r.kind ?? 'other', description: r.description ?? '', state };
  });
  const overall = checks.some((c) => c.state === 'missing') ? 'missing' : checks.some((c) => c.state === 'provider_only') ? 'provider_only' : 'confirmed';
  return { overall, checks };
}

function estimateOf(bv: unknown): MatchItem['estimate'] {
  const v = (bv as Record<string, unknown> | null)?.valueInr;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    return { amountInr: v, basis: 'Value stated by the provider; an estimate of what the benefit may be worth to you, not money you will receive.' };
  }
  return { amountInr: null, basis: 'No rupee value is estimated: the provider does not publish a comparable stand-alone price for this benefit.' };
}

/** Matches catalog offers against the user's plan. Expired and ineligible offers are listed in `excluded`. */
export async function matchOffers(q: Queryable, query: MatchQuery, now: Date) {
  const who = resolveProvider(query.provider);
  const all = await catalogOffers(q, now);
  const matches: MatchItem[] = [];
  const excluded: { offerId: string; reason: string }[] = [];
  for (const o of all) {
    const provider = String(o.provider);
    const family = (o.providerFamily as string | null) ?? null;
    const billingOwner = typeof o.billingOwner === 'string' ? o.billingOwner.toLowerCase() : '';
    const byProvider = who.providers.includes(provider) || (who.family !== null && family === who.family);
    const byOwner = !byProvider && billingOwner.includes(query.provider.trim().toLowerCase());
    if (!byProvider && !byOwner) continue;
    const id = String(o.id);
    const status = String(o.status);
    if (status === 'expired') {
      excluded.push({ offerId: id, reason: 'expired' });
      continue;
    }
    const rules = (Array.isArray(o.eligibility) ? o.eligibility : []) as EligibilityRule[];
    const eligibility = evaluateEligibility(rules, query);
    if (eligibility.checks.some((c) => c.state === 'not_met')) {
      excluded.push({ offerId: id, reason: 'eligibility_not_met' });
      continue;
    }
    const matchedOn = [byProvider ? 'provider' : 'billing_owner'];
    const sku = (o.sku as string | null) ?? (typeof o.skuOrPlanCode === 'string' ? o.skuOrPlanCode : null);
    if (query.planCode && sku) {
      if (sku.toLowerCase() !== query.planCode.toLowerCase()) {
        excluded.push({ offerId: id, reason: 'different_plan' });
        continue;
      }
      matchedOn.push('plan_code');
    }
    const price = o.priceInr === null || o.priceInr === undefined ? null : Number(o.priceInr);
    if (query.price !== undefined && price !== null) {
      if (Math.abs(price - query.price) < 0.5) matchedOn.push('price');
      else if (sku && matchedOn.includes('plan_code')) {
        // Same plan code at a different price: the plan may have been repriced; keep it but say so below.
      } else if (o.benefitType === 'bundle') {
        excluded.push({ offerId: id, reason: 'different_price' });
        continue;
      }
    }

    const assumptions = [
      'Based on public provider pages; personalised, app-only and checkout offers are confirmed only by the provider.',
      price !== null
        ? `Provider list price ₹${price}${o.billingPeriod && o.billingPeriod !== 'none' ? ` (${o.billingPeriod})` : ''} as last observed; taxes and circle pricing may differ.`
        : 'No list price is recorded for this benefit.',
    ];
    if (o.geography) assumptions.push(`Geography: ${String(o.geography)}.`);
    if (query.price !== undefined && price !== null && !matchedOn.includes('price')) {
      assumptions.push(`Your price (₹${query.price}) differs from the last observed price (₹${price}); the plan may have changed.`);
    }
    if (o.benefitType === 'trial') assumptions.push('Trials can convert to a paid subscription unless cancelled before the trial ends.');
    if (o.benefitType === 'one_time_reward') assumptions.push('One-time rewards may need a minimum spend and can be claimed once.');
    if (status !== 'active') assumptions.push(`Status is ${status.replace('_', ' ')} (${String(o.statusReason).replace(/_/g, ' ')}); check before relying on it.`);

    let confidence = (String(o.effectiveConfidence) in CONF_RANK ? o.effectiveConfidence : 'low') as 'high' | 'medium' | 'low';
    const strong = matchedOn.includes('plan_code') || matchedOn.includes('price');
    if (!strong && confidence === 'high') confidence = 'medium';
    if (eligibility.overall === 'missing' && CONF_RANK[confidence] > CONF_RANK.medium) confidence = 'medium';
    if (byOwner) confidence = 'low';

    const family2 = family ?? '';
    const includedSubscription = o.benefitType === 'bundle' || o.benefitType === 'recurring_entitlement' || Boolean(billingOwner);
    const doubleCountNote =
      includedSubscription || family2 === 'banks_cards' || family2 === 'upi_payments' || provider === 'ecosystem' ? DOUBLE_COUNT_NOTE : null;

    const end = (o.officialEndAt as string | null) ?? null;
    matches.push({
      offerId: id,
      provider,
      productFamily: String(o.productFamily),
      name: String(o.name),
      benefitType: String(o.benefitType),
      possibleBenefit: o.benefitValue,
      matchedOn,
      status,
      statusReason: String(o.statusReason),
      eligibility,
      expiry: {
        officialStartAt: (o.officialStartAt as string | null) ?? null,
        officialEndAt: end,
        note: end ? `The provider lists an end date of ${end}.` : 'The provider lists no end date; it can change without notice.',
      },
      estimate: estimateOf(o.benefitValue),
      confidence,
      assumptions,
      notes: Array.isArray(o.notes) ? (o.notes as string[]) : [],
      doubleCountNote,
      sources: o.sources,
      lastSuccessfulCheckAt: o.lastSuccessfulCheckAt ?? null,
      freshness: o.freshness,
    });
  }
  matches.sort((a, b) => b.matchedOn.length - a.matchedOn.length || CONF_RANK[b.confidence] - CONF_RANK[a.confidence] || a.offerId.localeCompare(b.offerId));
  return {
    generatedAt: now.toISOString(),
    query: { provider: query.provider, serviceType: query.serviceType ?? null, planCode: query.planCode ?? null, price: query.price ?? null },
    disclaimer: DISCLAIMER,
    matches,
    excluded,
  };
}
