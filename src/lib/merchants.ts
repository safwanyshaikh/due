/**
 * Merchant alias normalisation. Only well-known brand spellings (no prices, no plan data).
 * Used for duplicate suggestions and import matching. Never merges anything by itself.
 */

export interface MerchantAlias {
  key: string;
  displayName: string;
  aliases: string[];
}

export const MERCHANT_ALIASES: MerchantAlias[] = [
  { key: 'netflix', displayName: 'Netflix', aliases: ['netflix', 'netflix com', 'netflix india'] },
  {
    key: 'amazon_prime',
    displayName: 'Amazon Prime',
    aliases: ['amazon prime', 'prime video', 'amazon prime video', 'primevideo', 'amzn prime'],
  },
  {
    key: 'jiohotstar',
    displayName: 'JioHotstar',
    aliases: ['jiohotstar', 'jio hotstar', 'hotstar', 'disney hotstar', 'disney+ hotstar'],
  },
  { key: 'jio', displayName: 'Jio', aliases: ['jio', 'reliance jio', 'jio fiber', 'jiofiber'] },
  {
    key: 'airtel',
    displayName: 'Airtel',
    aliases: ['airtel', 'bharti airtel', 'airtel xstream', 'airtel postpaid'],
  },
  { key: 'vi', displayName: 'Vi', aliases: ['vi', 'vodafone idea', 'vodafone', 'idea cellular'] },
  { key: 'bsnl', displayName: 'BSNL', aliases: ['bsnl', 'bharat sanchar nigam'] },
  { key: 'spotify', displayName: 'Spotify', aliases: ['spotify', 'spotify india', 'spotify ab'] },
  {
    key: 'youtube_premium',
    displayName: 'YouTube Premium',
    aliases: ['youtube premium', 'youtube music', 'yt premium', 'google youtube'],
  },
  { key: 'google_one', displayName: 'Google One', aliases: ['google one', 'google storage'] },
  { key: 'apple', displayName: 'Apple', aliases: ['apple', 'apple com bill', 'itunes', 'icloud'] },
  {
    key: 'microsoft_365',
    displayName: 'Microsoft 365',
    aliases: ['microsoft 365', 'office 365', 'msft', 'microsoft'],
  },
  {
    key: 'adobe',
    displayName: 'Adobe',
    aliases: ['adobe', 'adobe systems', 'adobe creative cloud'],
  },
  { key: 'sonyliv', displayName: 'Sony LIV', aliases: ['sonyliv', 'sony liv'] },
  { key: 'zee5', displayName: 'ZEE5', aliases: ['zee5', 'zee 5'] },
  { key: 'swiggy_one', displayName: 'Swiggy One', aliases: ['swiggy one', 'swiggy'] },
  { key: 'zomato', displayName: 'Zomato', aliases: ['zomato', 'zomato gold'] },
  { key: 'tata_play', displayName: 'Tata Play', aliases: ['tata play', 'tata sky', 'tataplay'] },
  { key: 'act_fibernet', displayName: 'ACT Fibernet', aliases: ['act fibernet', 'act broadband'] },
  { key: 'linkedin', displayName: 'LinkedIn', aliases: ['linkedin', 'linkedin premium'] },
];

const NOISE = new Set([
  'com',
  'in',
  'co',
  'www',
  'pvt',
  'private',
  'ltd',
  'limited',
  'llp',
  'inc',
  'subscription',
  'payment',
  'autopay',
  'renewal',
  'bill',
]);

/** Lower-case, strip punctuation/legal suffixes/domains: "NETFLIX.COM" → "netflix". */
export function normaliseMerchant(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/https?:\/\//g, ' ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .split(' ')
    .filter((t) => t && !NOISE.has(t))
    .join(' ')
    .replace(/\+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Indexed {
  tokens: string[];
  alias: MerchantAlias;
}

const INDEX: Indexed[] = MERCHANT_ALIASES.flatMap(
  (alias) => alias.aliases.map((a) => ({ tokens: normaliseMerchant(a).split(' '), alias })),
  // Longer aliases first so "jio hotstar" wins over "jio".
).sort((a, b) => b.tokens.length - a.tokens.length);

function containsRun(hay: string[], needle: string[]): boolean {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * Canonical merchant for a name or bank descriptor, or null when unknown.
 * Matches whole tokens only ("JioHotstar" is not "Jio").
 */
export function canonicalMerchant(raw: string | null | undefined): MerchantAlias | null {
  if (!raw) return null;
  const tokens = normaliseMerchant(raw).split(' ').filter(Boolean);
  if (!tokens.length) return null;
  for (const e of INDEX) if (containsRun(tokens, e.tokens)) return e.alias;
  return null;
}

/** Key used to compare two merchants: canonical key, else the normalised name. */
export function merchantKey(raw: string | null | undefined): string {
  if (!raw) return '';
  return canonicalMerchant(raw)?.key ?? normaliseMerchant(raw);
}

/** Find the first known merchant mentioned anywhere in free text. */
export function findMerchantInText(text: string): { alias: MerchantAlias; index: number } | null {
  const lower = text.toLowerCase();
  let best: { alias: MerchantAlias; index: number; len: number } | null = null;
  for (const e of INDEX) {
    for (const a of e.alias.aliases) {
      const re = new RegExp(
        `(^|[^a-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`,
      );
      const m = re.exec(lower);
      if (!m) continue;
      const index = m.index + m[1].length;
      if (!best || index < best.index || (index === best.index && a.length > best.len))
        best = { alias: e.alias, index, len: a.length };
    }
  }
  return best ? { alias: best.alias, index: best.index } : null;
}
