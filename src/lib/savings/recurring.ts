/**
 * Recurring payment detection over statement lines: groups by merchant, checks cadence and
 * amount stability, and names the payment rail (UPI AutoPay, bank mandate, card).
 */
import { addMonthsClamped, daysBetween } from '../dates';
import { canonicalMerchant, normaliseMerchant } from '../merchants';
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

/** Merchant key and label for a statement narration. */
export function statementMerchant(narration: string): { key: string; label: string } {
  const cleaned = narration
    .replace(/[a-z0-9._]+@[a-z0-9.]+/gi, ' ') // UPI handles / emails
    .replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, ' ') // IFSC codes
    .replace(/\b[A-Z]{2,6}\d{5,}\w*\b/gi, ' ') // mandate / reference ids like HDFC0000123456
    .replace(/\d+/g, ' ');
  const canon = canonicalMerchant(cleaned);
  if (canon) return { key: canon.key, label: canon.displayName };
  const tokens = normaliseMerchant(cleaned)
    .split(' ')
    .filter((t) => t.length > 1 && !RAIL_NOISE.has(t) && !/^x+$/.test(t));
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

/**
 * Recurring candidates: same merchant, steady amount (±15%), monthly (26–35 days), quarterly or
 * yearly gaps. Two occurrences = medium confidence, three or more = high. Credits are ignored.
 */
export function detectRecurring(lines: StatementLine[]): RecurringCandidate[] {
  const groups = new Map<string, { label: string; items: Item[] }>();
  lines.forEach((line, index) => {
    if (!(line.amountInr > 0)) return;
    const { key, label } = statementMerchant(line.narration);
    if (key === 'unknown') return;
    const g = groups.get(key) ?? { label, items: [] };
    g.items.push({ line, index });
    groups.set(key, g);
  });
  const out: RecurringCandidate[] = [];
  for (const [key, g] of groups) {
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
      });
    }
  }
  return out.sort((a, b) => b.averageInr - a.averageInr || a.key.localeCompare(b.key));
}
