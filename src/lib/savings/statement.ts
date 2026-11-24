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
    out.push({
      date: d.iso,
      narration: nar,
      amountInr: sign * value,
      source,
      lineKind: lineKindOf(nar),
    });
  }
  return out;
}

/* ---------- free text ---------- */

// Card statements (SBI Card and others): "<narration>   1,469.00   D" — the amount is the last
// money value before the trailing C/D marker; anything earlier on the line (a tax note, a foreign
// amount) is metadata.
const TRAILING =
  /^(.*?)\s+(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{1,2}|\d+)\s+(C|D|CR|DR|Cr|Dr)\.?$/;
const FOREIGN = /\s+(\d[\d,]*(?:\.\d{1,2})?)\s+(USD|EUR|GBP|SGD|AED|CAD|AUD|JPY|CHF|HKD|NZD)$/;
const EXCL_TAX = /\(?\s*EXCL\.?\s+TAX\s*(\d[\d,]*(?:\.\d{1,2})?)?\s*\)?/i;

/** What a statement line is, from its narration. Only 'purchase' lines can be subscriptions. */
export function lineKindOf(narration: string): NonNullable<StatementLine['lineKind']> {
  const n = narration.toUpperCase();
  if (/PAYMENT\s+RECEIVED|THANK\s*YOU|BBPS\s+PAYMENT|AUTO\s*DEBIT\s+PAYMENT|CARD\s+PAYMENT/.test(n))
    return 'payment';
  if (/REVERSA|REVERSAL|WAIVER|WAIVED|REFUND|CASHBACK|CASH\s+BACK/.test(n)) return 'reversal';
  if (/FIN(ANCE)?\s*CHARGE|\bINTEREST\b/.test(n)) return 'interest';
  if (/\b[ICSU]?GST\b|\bSERVICE\s+TAX\b/.test(n)) return 'tax';
  if (/\bFEE\b|LATE\s+PAYMENT|MARKUP|MARK-UP|SURCHARGE|OVER\s*LIMIT|CHARGES?\b|PENALTY/.test(n))
    return 'fee';
  return 'purchase';
}

function trailingLine(
  body: string,
  date: string,
  source: StatementLine['source'],
): (StatementLine & { singleMarker?: boolean }) | null {
  const m = TRAILING.exec(body);
  if (!m) return null;
  const single = m[3].length === 1;
  // Bank tables print "balance Dr/Cr" after the amount: leave those to the table reader.
  if (!single && source === 'bank' && amountHits(body).length > 1) return null;
  const value = parseAmountCell(m[2]);
  if (value === null || value === 0) return null;
  let narration = m[1];
  const line: StatementLine = { date, narration: '', amountInr: 0, source };
  const fx = FOREIGN.exec(narration);
  if (fx) {
    const fa = parseAmountCell(fx[1]);
    if (fa !== null) {
      line.foreignAmount = fa;
      line.foreignCurrency = fx[2];
    }
    narration = narration.slice(0, fx.index);
  }
  const tax = EXCL_TAX.exec(narration);
  if (tax) {
    const t = tax[1] ? parseAmountCell(tax[1]) : null;
    if (t !== null) line.taxInr = t;
    narration = `${narration.slice(0, tax.index)} ${narration.slice(tax.index + tax[0].length)}`;
  }
  line.narration = tidy(narration);
  if (!line.narration) return null;
  const credit = /^c/i.test(m[3]);
  line.amountInr = credit ? -value : value;
  line.lineKind = lineKindOf(line.narration);
  if (credit && line.lineKind === 'purchase') line.lineKind = 'reversal';
  return single ? Object.assign(line, { singleMarker: true }) : line;
}

function strip(l: StatementLine & { singleMarker?: boolean }): StatementLine {
  const { singleMarker: _s, ...rest } = l;
  void _s;
  return rest;
}

// Lines that are never transactions: table headings, reward/summary rows, page furniture.
const JUNK =
  /previous\s+balanc|closing\s+balance|earned|redeemed|transaction\s+details|transactions\s+for|statement\s+period|amount\s*\(|reward|page\s+\d|total\s+(amount|outstanding)/i;

/** "Statement Period: 16 Aug 26 to 15 Sep 26" → "2026-09". */
export function statementPeriodOf(text: string): string | null {
  const m =
    /statement\s+period\s*:?\s*(.{6,20}?)\s+to\s+(\d{1,2}[\s\-/.]+[a-z]{3,9}[\s\-/.,']+\d{2,4}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})/i.exec(
      text,
    );
  const d = m ? leadingDate(m[2]) : null;
  return d ? d.iso.slice(0, 7) : null;
}

function parseTextLines(text: string, source: StatementLine['source']): StatementLine[] {
  const period = statementPeriodOf(text);
  const out: StatementLine[] = [];
  let lastWasLine = false;
  let lastDate: string | null = null;
  let markerMode = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\u00a0/g, ' ').trim();
    if (!line) {
      lastWasLine = false;
      continue;
    }
    const d = leadingDate(line);
    if (!d) {
      // Card fee rows printed without a date ("IGST DB @ 18.00%   623.68   D") belong to the
      // previous dated row.
      if (markerMode && lastDate && !JUNK.test(line)) {
        const fee = trailingLine(line, lastDate, source);
        if (fee) {
          out.push(strip(fee));
          lastWasLine = false;
          continue;
        }
      }
      // Wrapped narration from a PDF table: a short line with no date and no amount.
      const prev = out[out.length - 1];
      if (
        !markerMode &&
        lastWasLine &&
        prev &&
        line.length <= 60 &&
        amountHits(line).length === 0 &&
        !JUNK.test(line) &&
        (line.match(/\b\d+\b/g) ?? []).length < 2
      )
        prev.narration = tidy(`${prev.narration} ${line}`);
      else lastWasLine = false;
      continue;
    }
    let rest = line.slice(d.length);
    const card = trailingLine(rest.trim(), d.iso, source);
    if (card) {
      if (card.singleMarker) markerMode = true;
      out.push(strip(card));
      lastDate = d.iso;
      lastWasLine = false;
      continue;
    }
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
      lineKind: lineKindOf(narration),
    });
    lastDate = d.iso;
    lastWasLine = true;
  }
  return period ? out.map((l) => ({ ...l, statementPeriod: period })) : out;
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
