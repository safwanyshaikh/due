/**
 * Recurring payment detection over statement lines: groups by merchant, checks cadence and
 * amount stability, and names the payment rail (UPI AutoPay, bank mandate, card).
 */
import { addMonthsClamped, daysBetween } from '../dates';
import { canonicalMerchant, normaliseMerchant } from '../merchants';
import { lineKindOf } from './statement';
import type { MoveConfidence, RecurringCandidate, StatementLine } from './types';

/** Rail from the narration; card statements default to credit card. */
export function railFor(
  line: Pick<StatementLine, 'narration' | 'source'>,
): RecurringCandidate['rail'] {
  const n = line.narration.toUpperCase();
  if (/\bMAND\s+DR\b/.test(n)) return 'bank_mandate';
  if (
    /UPI[\s-_/]*AUTO\s*PAY|UPI[\s-_/]*MANDATE|\bAUTO\s*PAY\b|\bAUTOPAY\b|\bMANDATE\b|\/MAND\b|\/EXEC\b|\/MONT\b|\/YOUT\b|\/AMAZ\b/.test(
      n,
    )
  )
    return 'upi_autopay';
  if (
    /\bMAND\s+DR\b|\bNACH\b|\bACH[\s-]*D(R)?\b|\bACH\s+DEBIT\b|\bECS\b|\bSI[-/\s]|\bSTANDING\s+INSTRUCTION\b/.test(
      n,
    )
  )
    return 'bank_mandate';
  if (line.source === 'card') return 'credit_card';
  if (/\bPOS\b|\bDEBIT\s+CARD\b|\bVISA\s+POS\b|\bVPS\b|\bECOM\b/.test(n)) return 'debit_card';
  return 'unknown';
}

// Words that describe the rail or the bank's own bookkeeping, not the merchant.
const RAIL_NOISE = new Set([
  'upi',
  'autopay',
  'auto',
  'pay',
  'mandate',
  'nach',
  'ach',
  'ecs',
  'si',
  'tp',
  'd',
  'dr',
  'cr',
  'debit',
  'credit',
  'pos',
  'vps',
  'ecom',
  'card',
  'txn',
  'ref',
  'refno',
  'no',
  'ib',
  'billpay',
  'bil',
  'onl',
  'mmt',
  'imps',
  'neft',
  'rtgs',
  'to',
  'by',
  'from',
  'for',
  'the',
  'via',
  'purchase',
  'recurring',
  'standing',
  'instruction',
  'emi',
  'collect',
  'request',
  'paid',
  'ltd',
  'india',
  'xx',
  'xxxx',
  'mumbai',
  'bangalore',
  'bengaluru',
  'delhi',
  'gurgaon',
  'in',
  'ind',
  // bank codes printed inside UPI remarks
  'sbin',
  'hdfc',
  'utib',
  'icic',
  'yesb',
  'ubin',
  'barb',
  'ratn',
  'punb',
  'ibkl',
  'indb',
  'airp',
  'nspb',
  'ipos',
  'ppiw',
  'kkbk',
  'cnrb',
  'idib',
  'cbin',
  'ioba',
  'mahb',
  'fdrl',
  'kvbl',
  'yes',
]);

/**
 * Statement spellings of common Indian card/UPI merchants that the general alias list does not
 * cover. `squash` entries match inside the narration with spaces and punctuation removed (so
 * "FACEBOOKCOMADSMANAGER" and "Facebook India Onliervices" both match); `tokens` must appear as
 * whole words. `usage` merchants bill top-ups (ad spend, cloud credits) rather than a plan.
 */
export interface StatementAlias {
  key: string;
  label: string;
  squash?: string[];
  tokens?: string[][];
  usage?: boolean;
  /** Billed like a subscription (counts as recurring from two statement months). */
  subscription: boolean;
  /** Paying another bill (card bill, loan EMI): never a subscription. */
  billPayment?: 'card' | 'loan';
  category?:
    'mobility' | 'food' | 'telecom' | 'ott' | 'music' | 'cloud' | 'shopping' | 'utility' | 'other';
  /** Several numbers/accounts paid separately each month (postpaid connections). */
  multiConnection?: boolean;
  /** A bill to plan for (society maintenance), not a subscription to cancel. */
  bill?: boolean;
}

export const STATEMENT_ALIASES: StatementAlias[] = [
  // Bill payments first, so "SBI Card" or "L&T Finance" never reads as a merchant subscription.
  {
    key: 'sbi_card_bill',
    label: 'SBI Card bill payment',
    squash: ['sbicardp', 'sbicardpayment', 'sbicard'],
    subscription: false,
    billPayment: 'card',
  },
  {
    key: 'lnt_finance_emi',
    label: 'L&T Finance EMI',
    squash: ['landtfinance', 'lntfi', 'landtfi', 'ltfinance', 'financelimited'],
    tokens: [
      ['l', 'and', 't'],
      ['l', 'n', 't'],
    ],
    subscription: false,
    billPayment: 'loan',
  },
  {
    key: 'gpay_bills',
    label: 'Google Pay bill/FASTag',
    squash: ['gpayutility', 'gpaybptoll', 'gpaytoll', 'gpaybputil'],
    usage: true,
    subscription: true,
    category: 'utility',
  },
  {
    key: 'mobile_recharge',
    label: 'Mobile/DTH recharge',
    squash: ['gpayrecharge', 'euronet'],
    usage: true,
    subscription: false,
    category: 'telecom',
  },
  {
    key: 'openai',
    label: 'OpenAI (ChatGPT)',
    squash: ['openai', 'chatgpt'],
    subscription: true,
    category: 'cloud',
  },
  {
    key: 'linkedin',
    label: 'LinkedIn',
    squash: ['linkedin'],
    subscription: true,
    category: 'other',
  },
  {
    key: 'jiohotstar',
    label: 'JioHotstar',
    squash: ['jiohotstar', 'hotstaronl', 'hotstar'],
    subscription: true,
    category: 'ott',
  },
  { key: 'netflix', label: 'Netflix', squash: ['netflix'], subscription: true, category: 'ott' },
  {
    key: 'youtube_premium',
    label: 'YouTube Premium',
    squash: ['youtube'],
    tokens: [['yout']],
    subscription: true,
    category: 'ott',
  },
  {
    key: 'google_play',
    label: 'Google Play',
    squash: ['playstore', 'googleplay'],
    subscription: true,
    category: 'other',
  },
  {
    key: 'jiofiber',
    label: 'JioFiber',
    squash: ['jiofiber', 'jioairfiber'],
    subscription: true,
    category: 'telecom',
  },
  {
    key: 'airtel_postpaid',
    label: 'Airtel postpaid',
    squash: ['airtelpostpaid', 'airtelblack'],
    subscription: true,
    category: 'telecom',
    multiConnection: true,
  },
  {
    key: 'jio_postpaid',
    label: 'JIO Postpaid',
    squash: ['jiopost'],
    subscription: true,
    category: 'telecom',
    multiConnection: true,
  },
  {
    key: 'apple',
    label: 'Apple services',
    squash: ['appleme', 'appleservi', 'applecombill', 'itunes'],
    subscription: true,
    category: 'cloud',
  },
  {
    key: 'indian_railways',
    label: 'Indian Railways season pass',
    squash: ['iruts', 'indianrail', 'irctcuts'],
    subscription: true,
    category: 'mobility',
  },
  {
    key: 'mygate',
    label: 'MyGate (society maintenance)',
    squash: ['mygate'],
    subscription: true,
    category: 'utility',
    bill: true,
  },
  {
    key: 'lic',
    label: 'LIC',
    squash: ['lifeinsurancecorpo', 'licofindia'],
    subscription: false,
    category: 'other',
  },
  { key: 'blinkit', label: 'Blinkit', squash: ['blinkit'], subscription: false, category: 'food' },
  {
    key: 'anthropic',
    label: 'Anthropic (Claude)',
    squash: ['anthropic', 'claudeai', 'claudesub'],
    subscription: true,
  },
  { key: 'lovable', label: 'Lovable', squash: ['lovable'], subscription: true },
  {
    key: 'google_cloud',
    label: 'Google Cloud',
    squash: ['googlecloud', 'gcpbilling'],
    usage: true,
    subscription: true,
  },
  {
    key: 'google_workspace',
    label: 'Google Workspace',
    squash: ['googleworkspa', 'gsuite'],
    subscription: true,
  },
  {
    key: 'facebook_ads',
    label: 'Facebook / Meta ads',
    squash: ['facebook', 'metaads', 'metaplatforms'],
    usage: true,
    subscription: true,
  },
  {
    key: 'meta_verified',
    label: 'Meta Verified',
    squash: ['metaverified'],
    tokens: [['meta']],
    subscription: true,
  },
  {
    key: 'jio',
    label: 'Jio prepaid',
    squash: ['jioprepaid', 'jiorecharg', 'reliancejio'],
    subscription: true,
  },
  { key: 'airtel', label: 'Airtel', squash: ['airtel'], subscription: true },
  {
    key: 'urban_company',
    label: 'Urban Company',
    squash: ['urbancompany', 'urbanclap'],
    subscription: false,
  },
];

const COUNTRY = new Set(['in', 'us', 'de', 'ca', 'gb', 'uk', 'sg', 'ie', 'nl', 'au', 'fr', 'ae']);
const TRUNCATED = new Set([
  'pvt',
  'private',
  'limited',
  'limit',
  'lim',
  'ltd',
  'l',
  'p',
  'pv',
  'servi',
  'ser',
  'services',
]);

export function statementAlias(narration: string): StatementAlias | null {
  const squashed = narration.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const words = narration
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ');
  for (const a of STATEMENT_ALIASES) if (a.squash?.some((s) => squashed.includes(s))) return a;
  for (const a of STATEMENT_ALIASES)
    if (a.tokens?.some((t) => t.every((w) => words.includes(w)))) return a;
  return null;
}

/** Merchant key and label for a statement narration. */
export function statementMerchant(
  narration: string,
  amountInr?: number,
): { key: string; label: string } {
  const alias = statementAlias(narration);
  if (alias) return { key: alias.key, label: alias.label };
  // Amazon over UPI: Prime is ₹299 a month or ₹1,499 a year; other amounts are shopping.
  if (/amazon|amzn/i.test(narration) && !/prime/i.test(narration)) {
    const a = amountInr !== undefined ? Math.round(Math.abs(amountInr)) : null;
    if (a !== null && [299, 1499].some((p) => Math.abs(a - p) <= 1))
      return { key: 'amazon_prime', label: 'Amazon (possibly Prime)' };
    return { key: 'amazon', label: 'Amazon' };
  }
  const cleaned = narration
    // SBI rows: "WDL TFR UPI/DR/0000000/PAYEE/…  0000000 AT 00343 TESTBR".
    .replace(/^\s*(?:WDL|DEP)\s+TFR\s+/i, ' ')
    .replace(/^\s*UPI\/(?:DR|CR)\/\d+\//i, ' ')
    .replace(/\s+\d+\s+AT\s+\d{5}(?:\s+\S+)?\s*$/i, ' ')
    // Bank UPI rows: "UPIAR/000000 /DR/Google W/utib/…" → the payee after /DR/ or /CR/.
    .replace(/^\s*(?:UPIA[RB]|UPI)\/\d+\s*\/(?:DR|CR)\//i, ' ')
    .replace(/^\s*(?:NEFTO?-?:?|RTGS:|IMPSA[RB]\/?|MOBFT\/?|eTXN\/By:)/i, ' ')
    .replace(/\/[A-Z]{4}\//g, ' ') // bank codes between slashes
    .replace(/^\s*UPI[\s-/]+/i, ' ')
    .replace(/[a-z0-9._]+@[a-z0-9.]+/gi, ' ') // UPI handles / emails
    .replace(/\.(com|dev|io|in|ai|net|org|co|app)\b/gi, ' ') // domains: keep the name
    .replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, ' ') // IFSC codes
    .replace(/\b[A-Z]{2,6}\d{5,}\w*\b/gi, ' ') // mandate / reference ids like HDFC0000123456
    .replace(/\b\d+\b|\d{5,}/g, ' ');
  const canon = canonicalMerchant(cleaned);
  if (canon) return { key: canon.key, label: canon.displayName };
  let tokens = normaliseMerchant(cleaned)
    .split(' ')
    .filter((t) => t.length > 1 && !RAIL_NOISE.has(t) && !/^x+$/.test(t));
  // Trailing country codes and words cut off by the statement's column width.
  while (
    tokens.length > 1 &&
    (COUNTRY.has(tokens[tokens.length - 1]) || TRUNCATED.has(tokens[tokens.length - 1]))
  )
    tokens = tokens.slice(0, -1);
  tokens = tokens.filter((t, i) => i === 0 || !/pvt$/.test(t));
  // Handle fragments: a word that repeats an earlier one ("ikea ikeaindiapv"), or a short
  // vowel-less tag ("cfp", "tlt").
  tokens = tokens.filter(
    (t, i) =>
      i === 0 ||
      (!tokens.slice(0, i).some((p) => t.startsWith(p) || p.startsWith(t)) &&
        !(t.length <= 4 && !/[aeiouy]/.test(t))),
  );
  const words = tokens.slice(0, 3);
  if (!words.length) return { key: 'unknown', label: 'Unknown' };
  return {
    key: words.join(' '),
    label: words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
  };
}

const CADENCES: {
  cadence: RecurringCandidate['cadence'];
  min: number;
  max: number;
  months: number;
}[] = [
  { cadence: 'monthly', min: 26, max: 35, months: 1 },
  { cadence: 'quarterly', min: 84, max: 97, months: 3 },
  { cadence: 'yearly', min: 350, max: 380, months: 12 },
];

const TOLERANCE = 0.15;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

interface Item {
  line: StatementLine;
  index: number;
}

/** Splits a merchant's charges into amount clusters within ±15% (or `tol`) of the cluster median. */
function amountClusters(items: Item[], tol = TOLERANCE): Item[][] {
  const sorted = [...items].sort((a, b) => a.line.amountInr - b.line.amountInr);
  const clusters: Item[][] = [];
  for (const it of sorted) {
    const c = clusters[clusters.length - 1];
    if (c) {
      // Sorted ascending: the cluster's first item is its minimum and `it` the maximum, so a
      // sweep with an O(1) median of (cluster + it) replaces re-sorting the cluster each time.
      const n = c.length + 1;
      const at = (k: number) => (k < c.length ? c[k].line.amountInr : it.line.amountInr);
      const mid = Math.floor(n / 2);
      const med = n % 2 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
      if (
        Math.abs(c[0].line.amountInr - med) <= med * tol &&
        Math.abs(it.line.amountInr - med) <= med * tol
      ) {
        c.push(it);
        continue;
      }
    }
    clusters.push([it]);
  }
  return clusters;
}

/**
 * One merchant billed as two plans (₹1,999 on one account and ₹195 on another): when charges
 * form two or more amount groups (±10%) that each recur in two or more months, each group is
 * its own candidate. Usage merchants are never split.
 */
function splitByPlan(items: Item[], alias: StatementAlias | null): Item[][] {
  if (alias?.usage || alias?.multiConnection) return [items];
  const clusters = amountClusters(items, 0.1).filter(
    (c) => new Set(c.map((it) => monthOfLine(it.line))).size >= 2,
  );
  return clusters.length >= 2 ? clusters : [items];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const WIDE_TOLERANCE = 0.4;

/** The statement month when known (cards bill across calendar months), else the calendar month. */
function monthOfLine(line: StatementLine): string {
  return line.statementPeriod ?? line.date.slice(0, 7);
}

/** Several equal charges (±₹1) in one month: top-ups, not a plan. */
function hasRepeatsInMonth(items: Item[], min: number): boolean {
  const byMonth = new Map<string, number[]>();
  for (const it of items) {
    const k = monthOfLine(it.line);
    const list = byMonth.get(k);
    if (list) list.push(it.line.amountInr);
    else byMonth.set(k, [it.line.amountInr]);
  }
  for (const amounts of byMonth.values()) {
    amounts.sort((x, y) => x - y);
    // Sliding window: is there a run of `min` amounts within ±₹1 of one of them?
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < amounts.length; i++) {
      while (amounts[lo] < amounts[i] - 1) lo++;
      if (hi < i) hi = i;
      while (hi + 1 < amounts.length && amounts[hi + 1] <= amounts[i] + 1) hi++;
      if (hi - lo + 1 >= min) return true;
    }
  }
  return false;
}

/**
 * Foreign-currency or known subscription merchants: their INR amount moves with the exchange
 * rate and they sometimes bill twice a month (top-ups, overage). Recurring when seen in two or
 * more distinct months; monthly totals must stay within ±40% unless they are usage top-ups.
 */
function monthlyMerchant(
  key: string,
  label: string,
  items: Item[],
  alias: StatementAlias | null,
): RecurringCandidate | null {
  const sorted = [...items].sort(
    (a, b) => a.line.date.localeCompare(b.line.date) || a.index - b.index,
  );
  const monthTotals = new Map<string, number>();
  for (const it of sorted) {
    const m = monthOfLine(it.line);
    monthTotals.set(m, (monthTotals.get(m) ?? 0) + it.line.amountInr);
  }
  const months = [...monthTotals.keys()];
  if (months.length < 2) return null;
  // More than a charge a day is a shop or a feed of top-ups, not one plan: no average to offer.
  if (sorted.length / months.length > 31) return null;
  const totals = [...monthTotals.values()];
  const usage = alias?.usage === true || hasRepeatsInMonth(sorted, 3);
  const med = median(totals);
  // A prorated first month or one overage month does not make it irregular: most months must sit
  // within ±40% of the median month.
  const within = totals.filter((t) => Math.abs(t - med) <= med * WIDE_TOLERANCE).length;
  const stable = within >= 2 && within > totals.length / 2;
  const kind: RecurringCandidate['kind'] = usage
    ? 'usage_topup'
    : !stable
      ? 'unknown'
      : alias?.bill
        ? 'bill'
        : 'subscription';
  const lastDate = sorted[sorted.length - 1].line.date;
  const rails = sorted.map((it) => railFor(it.line));
  const fx = sorted.find((it) => it.line.foreignCurrency)?.line.foreignCurrency;
  const out: RecurringCandidate = {
    key,
    label,
    rail: rails.find((r) => r === 'upi_autopay' || r === 'bank_mandate') ?? rails[rails.length - 1],
    cadence: 'monthly',
    averageInr: round2(med),
    lastDate,
    nextExpected: addMonthsClamped(lastDate, 1),
    occurrences: sorted.length,
    confidence: kind === 'unknown' ? 'low' : months.length >= 3 ? 'high' : 'medium',
    lineIndexes: sorted.map((it) => it.index),
    kind,
  };
  if (fx) out.foreignCurrency = fx;
  if (alias?.multiConnection) {
    // Distinct amounts paid in a month ≈ number of connections (numbers) paid separately.
    const counts = months.map(
      (m) =>
        new Set(
          sorted
            .filter((it) => monthOfLine(it.line) === m)
            .map((it) => Math.round(it.line.amountInr)),
        ).size,
    );
    out.connections = Math.round(median(counts));
  }
  return out;
}

/**
 * Recurring candidates: same merchant, steady amount (±15%), monthly (26–35 days), quarterly or
 * yearly gaps. Two occurrences = medium confidence, three or more = high. Credits, payments,
 * fees, interest, taxes and reversals are never subscriptions. Foreign-currency and known
 * subscription merchants use the wider monthly rule above.
 */
export function detectRecurring(lines: StatementLine[]): RecurringCandidate[] {
  const groups = new Map<
    string,
    { label: string; items: Item[]; alias: StatementAlias | null; fx: boolean }
  >();
  const p2p = new Map<string, { label: string; items: Item[] }>();
  lines.forEach((line, index) => {
    if (!(line.amountInr > 0)) return;
    const alias0 = statementAlias(line.narration);
    let kind = line.lineKind ?? lineKindOf(line.narration);
    // A known merchant alias always wins over the person-to-person guess.
    if (kind === 'p2p' && alias0) kind = 'purchase';
    if (kind === 'p2p' && !line.selfTransfer) {
      const { key, label } = statementMerchant(line.narration, line.amountInr);
      const g = p2p.get(key) ?? { label, items: [] };
      g.items.push({ line, index });
      p2p.set(key, g);
      return;
    }
    if (kind !== 'purchase') return;
    if (line.selfTransfer || alias0?.billPayment) return;
    const { key, label } = statementMerchant(line.narration, line.amountInr);
    if (key === 'unknown') return;
    const g = groups.get(key) ?? {
      label,
      items: [],
      alias: statementAlias(line.narration),
      fx: false,
    };
    g.items.push({ line, index });
    if (line.foreignCurrency) g.fx = true;
    groups.set(key, g);
  });
  const out: RecurringCandidate[] = [];
  const mark = (c: RecurringCandidate, items: Item[]): RecurringCandidate => {
    const sources = new Set(items.map((it) => it.line.source));
    if (sources.size > 1) c.severalPaymentMethods = true;
    return c;
  };
  // Regular transfers to a person: only reported with three or more months, never a subscription.
  for (const [key, g] of p2p) {
    const months = new Set(g.items.map((it) => monthOfLine(it.line)));
    if (months.size < 3) continue;
    const sorted = [...g.items].sort((a, b) => a.line.date.localeCompare(b.line.date));
    const last = sorted[sorted.length - 1].line.date;
    const totals = [...months].map((m) =>
      sorted
        .filter((it) => monthOfLine(it.line) === m)
        .reduce((s2, it) => s2 + it.line.amountInr, 0),
    );
    out.push({
      key,
      label: g.label,
      rail: 'unknown',
      cadence: 'monthly',
      averageInr: round2(median(totals)),
      lastDate: last,
      nextExpected: addMonthsClamped(last, 1),
      occurrences: sorted.length,
      confidence: 'low',
      lineIndexes: sorted.map((it) => it.index),
      kind: 'regular_transfer',
    });
  }
  for (const [key, g] of groups) {
    if (g.fx || g.alias?.subscription) {
      for (const part of splitByPlan(g.items, g.alias)) {
        const c = monthlyMerchant(key, g.label, part, g.alias);
        if (c) out.push(mark(c, part));
      }
      if (out.some((c) => c.key === key)) continue;
    }
    // Unknown merchants need more evidence: 3+ charges in 3+ months, amount within ±10%.
    const known = !!g.alias || !!canonicalMerchant(g.items[0].line.narration);
    for (const cluster of amountClusters(g.items, known ? TOLERANCE : 0.1)) {
      if (cluster.length < 2) continue;
      if (
        !known &&
        (cluster.length < 3 || new Set(cluster.map((it) => monthOfLine(it.line))).size < 3)
      )
        continue;
      const items = [...cluster].sort(
        (a, b) => a.line.date.localeCompare(b.line.date) || a.index - b.index,
      );
      const gaps = items.slice(1).map((it, i) => daysBetween(items[i].line.date, it.line.date));
      const fit = CADENCES.find((c) => gaps.every((d) => d >= c.min && d <= c.max));
      if (!fit) continue;
      const rails = items.map((it) => railFor(it.line));
      const rail =
        rails.find((r) => r === 'upi_autopay' || r === 'bank_mandate') ?? rails[rails.length - 1];
      const lastDate = items[items.length - 1].line.date;
      const confidence: MoveConfidence = items.length >= 3 ? 'high' : 'medium';
      out.push({
        key,
        label: g.label,
        rail,
        cadence: fit.cadence,
        averageInr: round2(items.reduce((s, it) => s + it.line.amountInr, 0) / items.length),
        lastDate,
        nextExpected: addMonthsClamped(lastDate, fit.months),
        occurrences: items.length,
        confidence,
        lineIndexes: items.map((it) => it.index),
        kind: 'subscription',
      });
      mark(out[out.length - 1], items);
    }
  }
  return out.sort((a, b) => b.averageInr - a.averageInr || a.key.localeCompare(b.key));
}
