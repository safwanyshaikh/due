/**
 * Research needs: providers found in the user's data that no module describes yet.
 * Only a cleaned provider label and a category leave the device (no amounts, numbers or emails).
 */
import { canonicalMerchant } from '../merchants';
import type { Commitment } from '../types';
import type { ResearchNeed, SavingsModule, SavingsState } from './types';

export const MAX_LABEL = 60;

/**
 * A provider label safe to send: emails, URLs, handles and every digit removed, whitespace
 * collapsed, at most 60 characters. Empty string when nothing meaningful is left.
 */
export function researchLabel(raw: string): string {
  const t = raw
    .replace(/\S+@\S+/g, ' ') // emails and UPI handles
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/\bwww\.\S+/gi, ' ')
    .replace(/\.(com|in|net|org|co|io|app)\b/gi, ' ')
    .replace(/[0-9०-९]/g, ' ')
    .replace(/[^\p{L}\s&+'.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.'&+-]+|[\s.'&+-]+$/g, '')
    .trim()
    .slice(0, MAX_LABEL)
    .trim();
  return /\p{L}{2,}/u.test(t) ? t : '';
}

const RESEARCH_TYPES = new Set<Commitment['type']>([
  'subscription',
  'bill',
  'credit_card',
  'emi',
  'other_loan',
]);

export function researchCategory(ob: Commitment, label: string): ResearchNeed['category'] {
  if (ob.type === 'credit_card') return 'card';
  if (ob.type === 'emi' || ob.type === 'other_loan') return 'loan';
  const key = ob.canonicalProvider ?? canonicalMerchant(label)?.key ?? null;
  const byKey: Record<string, SavingsModule['category']> = {
    netflix: 'ott',
    amazon_prime: 'ott',
    jiohotstar: 'ott',
    sonyliv: 'ott',
    zee5: 'ott',
    jio: 'telecom',
    airtel: 'telecom',
    vi: 'telecom',
    bsnl: 'telecom',
    spotify: 'music',
    youtube_premium: 'music',
    google_one: 'cloud',
    apple: 'cloud',
    microsoft_365: 'cloud',
    adobe: 'other',
    swiggy_one: 'food',
    zomato: 'food',
    tata_play: 'ott',
    act_fibernet: 'telecom',
    linkedin: 'other',
  };
  if (key && byKey[key]) return byKey[key];
  if (ob.type === 'bill') return 'utility';
  return 'unknown';
}

/** Research needs for obligations without a module, grouped by cleaned label. */
export function researchNeeds(unmatched: Commitment[]): ResearchNeed[] {
  const byLabel = new Map<string, ResearchNeed>();
  for (const ob of unmatched) {
    if (!RESEARCH_TYPES.has(ob.type)) continue;
    const label = researchLabel(ob.provider || ob.nickname);
    if (!label) continue;
    const k = label.toLowerCase();
    const prev = byLabel.get(k);
    if (prev) prev.obligationIds.push(ob.id);
    else
      byLabel.set(k, {
        providerLabel: label,
        category: researchCategory(ob, label),
        obligationIds: [ob.id],
      });
  }
  return [...byLabel.values()].sort((a, b) => a.providerLabel.localeCompare(b.providerLabel));
}

/** Needs not yet sent for research (compared case-insensitively). */
export function unsentResearch(needs: ResearchNeed[], state: SavingsState): ResearchNeed[] {
  const sent = new Set(state.profile.researchSent.map((s) => s.toLowerCase()));
  return needs.filter((n) => !sent.has(n.providerLabel.toLowerCase()));
}
