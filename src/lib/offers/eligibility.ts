import type { EligibilityRule, OfferRecord, UserServiceRecord } from './types';

export type CheckState = 'confirmed' | 'missing' | 'provider_only' | 'may_not_qualify';

export interface CheckItem {
  rule: EligibilityRule;
  state: CheckState;
}

export const CHECK_TEXT: Record<CheckState, string> = {
  confirmed: 'Confirmed by you',
  missing: 'Missing — add it if you know',
  provider_only: 'Only the provider can confirm',
  may_not_qualify: 'You may not qualify — verify',
};

export function evaluateEligibility(
  offer: OfferRecord,
  svc?: UserServiceRecord | null,
): CheckItem[] {
  return offer.eligibility.map((rule) => {
    if (rule.verification === 'provider_only' || !rule.field)
      return { rule, state: 'provider_only' };
    const v = svc ? svc[rule.field] : undefined;
    if (v === undefined || v === null || v === '') return { rule, state: 'missing' };
    if (rule.expected === undefined) return { rule, state: 'confirmed' };
    return { rule, state: v === rule.expected ? 'confirmed' : 'may_not_qualify' };
  });
}

/** A possible match is never a guaranteed one: at best it is "may qualify — verify". */
export function matchSummary(
  items: CheckItem[],
): 'may_qualify' | 'may_not_qualify' | 'needs_details' {
  if (items.some((i) => i.state === 'may_not_qualify')) return 'may_not_qualify';
  if (items.some((i) => i.state === 'missing')) return 'needs_details';
  return 'may_qualify';
}

/** User-entered fields relevant to a provider/service type. Never credentials. */
export function completeness(
  svc: UserServiceRecord,
  offers: OfferRecord[],
): { filled: number; total: number; missing: string[] } {
  const fields = new Map<string, string>();
  for (const o of offers)
    for (const r of o.eligibility)
      if (r.field && r.verification === 'user_input') fields.set(String(r.field), r.description);
  const missing: string[] = [];
  let filled = 0;
  for (const [f, desc] of fields) {
    const v = svc[f as keyof UserServiceRecord];
    if (v === undefined || v === null || v === '') missing.push(desc);
    else filled++;
  }
  return { filled, total: fields.size, missing };
}

export function offersForService(svc: UserServiceRecord, catalog: OfferRecord[]): OfferRecord[] {
  if (svc.provider === 'generic') return [];
  const prov = svc.provider === 'cards_upi' ? 'ecosystem' : svc.provider;
  return catalog.filter((o) => o.provider === prov);
}

/** Vi and similar: show the entitlement the user selected, not a hard-coded headline count. */
export function entitlementFor(
  offer: OfferRecord,
  svc?: UserServiceRecord | null,
): { value: string; caveat?: string } {
  if (offer.offerId === 'vi-movies-tv') {
    return {
      value:
        svc?.selectedOttCount != null
          ? `${svc.selectedOttCount} OTT apps (your selected pack)`
          : 'As shown for your pack in the Vi app',
      caveat: 'Vi’s pages show different OTT counts. Check the count for your exact pack.',
    };
  }
  return {
    value: Object.entries(offer.benefitValue)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
      .join(' · '),
  };
}

/** Who to go to for renewal or cancellation. Partner-billed plans go to the partner, not the brand. */
export function cancellationOwner(
  svc: Pick<UserServiceRecord, 'provider' | 'billedThrough' | 'partnerName'>,
): string {
  switch (svc.billedThrough) {
    case 'google_play':
      return 'Google Play subscriptions';
    case 'apple':
      return 'Apple subscriptions on your Apple device';
    case 'partner':
      return svc.partnerName
        ? `${svc.partnerName} (the partner that bills you)`
        : 'The partner that bills you';
    default:
      return svc.provider === 'google'
        ? 'Your Google account (Google One)'
        : svc.provider === 'amazon'
          ? 'Your Amazon account'
          : 'The official provider app or site';
  }
}
