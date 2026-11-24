/**
 * Pasted or extracted bank / card statement text and CSV → statement lines.
 * Runs on the device. Nothing here is stored or sent; callers keep only what the user confirms.
 */
import { parseCSV } from '../csv';
import { daysInMonth, isValidISO, toISO } from '../dates';
import type { StatementLine } from './types';

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';

function yearOf(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

function mkDate(y: number, m: number, d: number): string | null {
  if (!(m >= 1 && m <= 12) || !(d >= 1) || d > daysInMonth(y, m)) return null;
  const iso = toISO(y, m, d);
  return isValidISO(iso) ? iso : null;
}

const DATE_RES: [RegExp, (m: RegExpExecArray) => string | null][] = [
  [/^(\d{4})-(\d{1,2})-(\d{1,2})\b/, (m) => mkDate(+m[1], +m[2], +m[3])],
  [
    new RegExp(`^(\\d{1,2})[\\s\\-/.]+${MON}[\\s\\-/.,']+(\\d{4}|\\d{2})\\b`, 'i'),
    (m) => mkDate(yearOf(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]),
  ],
  [
    new RegExp(`^${MON}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, 'i'),
    (m) => mkDate(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]),
  ],
  // Numeric dates are dd/mm/yyyy in India.
  [/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/, (m) => mkDate(yearOf(m[3]), +m[2], +m[1])],
];

/** A date at the very start of `s`: its ISO value and length. */
export function leadingDate(s: string): { iso: string; length: number } | null {
  for (const [re, f] of DATE_RES) {
    const m = re.exec(s);
    if (!m) continue;
    const iso = f(m);
    if (iso) return { iso, length: m[0].length };
  }
  return null;
}

/** "₹1,299.00", "Rs. 649", "12,500.50", "1299.00 Dr" → rupees. */
export function parseAmountCell(raw: string): number | null {
  const t = raw
    .replace(/₹|\bINR\b|\bRs\.?/gi, '')
    .replace(/\b(dr|cr)\b\.?/gi, '')
    .replace(/[\s()]/g, '')
    .replace(/,/g, '');
  if (!t || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(Math.abs(n) * 100) / 100 : null;
}

// An amount token in free text: needs a currency mark, Indian/Western grouping or two decimals,
// so long reference numbers (UPI refs, mandate ids) are never read as money.
const AMOUNT_RE =
  /(?:₹|\bRs\.?|\bINR)\s*\d[\d,]*(?:\.\d{1,2})?|\b\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?\b|\b\d+\.\d{2}\b/gi;

const CREDIT_WORDS =
  /\b(refund|reversal|reversed|cashback|salary|interest\s+credit|int\.?\s*cr|payment\s+received|thank\s+you\s+for\s+(your\s+)?payment|neft\s+cr|imps\s+cr|by\s+transfer)\b/i;

interface AmountHit {
  value: number;
  start: number;
  end: number;
  marker: 'dr' | 'cr' | null;
}

function amountHits(line: string): AmountHit[] {
  const out: AmountHit[] = [];
  const re = new RegExp(AMOUNT_RE.source, 'gi');
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const value = parseAmountCell(m[0]);
    if (value === null) continue;
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 5);
    const before = line.slice(Math.max(0, m.index - 4), m.index);
    const mk = /^\s*\(?(dr|cr)\b/i.exec(after) ?? /\b(dr|cr)\.?\s*$/i.exec(before);
    out.push({
      value,
      start: m.index,
      end: m.index + m[0].length,
      marker: mk ? (mk[1].toLowerCase() as 'dr' | 'cr') : null,
    });
  }
  return out;
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[\s|,;:-]+|[\s|,;:-]+$/g, '')
    .trim();
}

/* ---------- CSV ---------- */

const HEAD = {
  date: /^(txn|transaction|tran|value|posting|post)?\s*\.?\s*date$|^date$/i,
  narration: /narration|description|particulars|details|remarks|transaction\s*details|merchant/i,
  debit:
    /^(debit|withdrawal|withdrawals|dr|debit\s*amount|withdrawal\s*amt\.?|withdrawal\s*amount)(\s*\(.*\))?(\s*inr|\s*₹)?$/i,
  credit:
    /^(credit|deposit|deposits|cr|credit\s*amount|deposit\s*amt\.?|deposit\s*amount)(\s*\(.*\))?(\s*inr|\s*₹)?$/i,
  amount: /^(amount|txn\s*amount|transaction\s*amount|amount\s*\(inr\)|amount\s*\(₹\)|amt)$/i,
  type: /^(dr\s*\/\s*cr|cr\s*\/\s*dr|type|debit\s*\/\s*credit|txn\s*type)$/i,
};

function findCol(header: string[], re: RegExp, taken: Set<number>): number {
  const i = header.findIndex((h, idx) => !taken.has(idx) && re.test(h.trim()));
  if (i >= 0) taken.add(i);
  return i;
}

function parseCsvRows(text: string, source: StatementLine['source']): StatementLine[] | null {
  const delim = text.includes('\t') && !text.split('\n')[0].includes(',') ? '\t' : ',';
  const rows = parseCSV(delim === '\t' ? text.replace(/\t/g, ',') : text);
  const headIdx = rows.findIndex(
    (r) =>
      r.length >= 3 &&
      r.some((c) => HEAD.date.test(c.trim())) &&
      r.some((c) => HEAD.narration.test(c.trim())),
  );
  if (headIdx < 0 || headIdx > 30) return null;
  const header = rows[headIdx].map((h) => h.trim());
  const taken = new Set<number>();
  const date = findCol(header, HEAD.date, taken);
  const narration = findCol(header, HEAD.narration, taken);
  const debit = findCol(header, HEAD.debit, taken);
  const credit = findCol(header, HEAD.credit, taken);
  const amount = findCol(header, HEAD.amount, taken);
  const type = findCol(header, HEAD.type, taken);
  if (date < 0 || narration < 0 || (debit < 0 && amount < 0)) return null;
  const out: StatementLine[] = [];
  for (const r of rows.slice(headIdx + 1)) {
    const d = leadingDate((r[date] ?? '').trim());
    const nar = tidy(r[narration] ?? '');
    if (!d || !nar) continue;
    let value: number | null = null;
    let sign = 1;
    const dr = debit >= 0 ? parseAmountCell(r[debit] ?? '') : null;
    const cr = credit >= 0 ? parseAmountCell(r[credit] ?? '') : null;
    if (dr !== null && dr > 0) value = dr;
    else if (cr !== null && cr > 0) {
      value = cr;
      sign = -1;
    } else if (amount >= 0) {
      const cell = r[amount] ?? '';
      value = parseAmountCell(cell);
      const t = `${type >= 0 ? (r[type] ?? '') : ''} ${cell}`.toLowerCase();
      if (/\bcr\b|credit/.test(t) || /^\s*-/.test(cell)) sign = -1;
      if (source === 'card' && /^\s*-/.test(cell)) sign = -1;
    }
    if (value === null || value === 0) continue;
    out.push({ date: d.iso, narration: nar, amountInr: sign * value, source });
  }
  return out;
}

/* ---------- free text ---------- */

function parseTextLines(text: string, source: StatementLine['source']): StatementLine[] {
  const out: StatementLine[] = [];
  let lastWasLine = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\u00a0/g, ' ').trim();
    if (!line) {
      lastWasLine = false;
      continue;
    }
    const d = leadingDate(line);
    if (!d) {
      // Wrapped narration from a PDF table: a short line with no date and no amount.
      const prev = out[out.length - 1];
      if (lastWasLine && prev && line.length <= 60 && amountHits(line).length === 0)
        prev.narration = tidy(`${prev.narration} ${line}`);
      else lastWasLine = false;
      continue;
    }
    let rest = line.slice(d.length);
    // A second (value) date right after the transaction date.
    const vd = leadingDate(rest.trim());
    if (vd) rest = rest.trim().slice(vd.length);
    const hits = amountHits(rest);
    if (!hits.length) {
      lastWasLine = false;
      continue;
    }
    const marked = hits.find((h) => h.marker);
    // Bank tables: [withdrawal | deposit] then balance. The transaction amount is the first figure.
    const pick = marked ?? hits[0];
    // Value dates printed between the narration and the amounts.
    const narration = tidy(
      rest
        .slice(0, hits[0].start)
        .replace(
          /(\s+(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}[\s-][a-z]{3}[\s-]\d{2,4}))+\s*$/i,
          '',
        ),
    );
    if (!narration) {
      lastWasLine = false;
      continue;
    }
    let credit = pick.marker === 'cr';
    if (!pick.marker) credit = CREDIT_WORDS.test(narration);
    out.push({
      date: d.iso,
      narration,
      amountInr: credit ? -pick.value : pick.value,
      source,
    });
    lastWasLine = true;
  }
  return out;
}

/**
 * Statement lines from pasted text or CSV. Debits are positive, credits negative.
 * Handles `05/11/2026`, `05-Nov-26`, `05 Nov 2026`, `2026-11-05`, `₹1,299.00`, `Dr`/`Cr` markers,
 * separate debit/credit columns and wrapped narrations. Lines it cannot read are skipped.
 */
export function parseStatementText(
  text: string,
  source: StatementLine['source'] = 'bank',
): StatementLine[] {
  if (!text || !text.trim()) return [];
  const src = text.replace(/^\uFEFF/, '');
  const firstLines = src.split(/\r?\n/).slice(0, 30).join('\n');
  if (/[,\t]/.test(firstLines)) {
    const csv = parseCsvRows(src, source);
    if (csv && csv.length) return csv;
  }
  return parseTextLines(src, source);
}
