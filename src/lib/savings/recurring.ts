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
  if (/UPI[\s-_/]*AUTO\s*PAY|UPI[\s-_/]*MANDATE|\bAUTO\s*PAY\b|\bAUTOPAY\b/.test(n))
    return 'upi_autopay';
  if (
    /\bNACH\b|\bACH[\s-]*D(R)?\b|\bACH\s+DEBIT\b|\bECS\b|\bSI[-/\s]|\bSTANDING\s+INSTRUCTION\b/.test(
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
}

export const STATEMENT_ALIASES: StatementAlias[] = [
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
    squash: ['googleworkspace', 'gsuite'],
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
export function statementMerchant(narration: string): { key: string; label: string } {
  const alias = statementAlias(narration);
  if (alias) return { key: alias.key, label: alias.label };
  const cleaned = narration
    .replace(/^\s*UPI[\s-/]+/i, ' ')
    .replace(/[a-z0-9._]+@[a-z0-9.]+/gi, ' ') // UPI handles / emails
    .replace(/\.(com|dev|io|in|ai|net|org|co|app)\b/gi, ' ') // domains: keep the name
    .replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, ' ') // IFSC codes
    .replace(/\b[A-Z]{2,6}\d{5,}\w*\b/gi, ' ') // mandate / reference ids like HDFC0000123456
    .replace(/\d+/g, ' ');
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

/** Splits a merchant's charges into amount clusters within ±15% of the cluster median. */
function amountClusters(items: Item[]): Item[][] {
  const sorted = [...items].sort((a, b) => a.line.amountInr - b.line.amountInr);
  const clusters: Item[][] = [];
  for (const it of sorted) {
    const c = clusters[clusters.length - 1];
    if (c) {
      const med = median([...c, it].map((x) => x.line.amountInr));
      if ([...c, it].every((x) => Math.abs(x.line.amountInr - med) <= med * TOLERANCE)) {
        c.push(it);
        continue;
      }
    }
    clusters.push([it]);
  }
  return clusters;
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
    byMonth.set(k, [...(byMonth.get(k) ?? []), it.line.amountInr]);
  }
  for (const amounts of byMonth.values())
    for (const a of amounts)
      if (amounts.filter((b) => Math.abs(a - b) <= 1).length >= min) return true;
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
  const months = [...new Set(sorted.map((it) => monthOfLine(it.line)))];
  if (months.length < 2) return null;
  const totals = months.map((m) =>
    sorted.filter((it) => monthOfLine(it.line) === m).reduce((s, it) => s + it.line.amountInr, 0),
  );
  const usage = alias?.usage === true || hasRepeatsInMonth(sorted, 3);
  const med = median(totals);
  const stable = totals.every((t) => Math.abs(t - med) <= med * WIDE_TOLERANCE);
  const kind: RecurringCandidate['kind'] = usage
    ? 'usage_topup'
    : stable
      ? 'subscription'
      : 'unknown';
  const lastDate = sorted[sorted.length - 1].line.date;
  const rails = sorted.map((it) => railFor(it.line));
  const fx = sorted.find((it) => it.line.foreignCurrency)?.line.foreignCurrency;
  const out: RecurringCandidate = {
    key,
    label,
    rail: rails.find((r) => r === 'upi_autopay' || r === 'bank_mandate') ?? rails[rails.length - 1],
    cadence: 'monthly',
    averageInr: round2(totals.reduce((s, t) => s + t, 0) / totals.length),
    lastDate,
    nextExpected: addMonthsClamped(lastDate, 1),
    occurrences: sorted.length,
    confidence: kind === 'unknown' ? 'low' : months.length >= 3 ? 'high' : 'medium',
    lineIndexes: sorted.map((it) => it.index),
    kind,
  };
  if (fx) out.foreignCurrency = fx;
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
  lines.forEach((line, index) => {
    if (!(line.amountInr > 0)) return;
    const kind = line.lineKind ?? lineKindOf(line.narration);
    if (kind !== 'purchase') return;
    const { key, label } = statementMerchant(line.narration);
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
  for (const [key, g] of groups) {
    if (g.fx || g.alias?.subscription) {
      const c = monthlyMerchant(key, g.label, g.items, g.alias);
      if (c) {
        out.push(c);
        continue;
      }
    }
    for (const cluster of amountClusters(g.items)) {
      if (cluster.length < 2) continue;
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
    }
  }
  return out.sort((a, b) => b.averageInr - a.averageInr || a.key.localeCompare(b.key));
}
