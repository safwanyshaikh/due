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
  /** Printed with a leading minus sign. */
  negative: boolean;
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
      negative: /(?:^|\s)[-−](?:(?:₹|Rs\.?|INR)\s*)?$/i.test(line.slice(0, m.index)),
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
  if (/\bUPI\s*LITE\b|\/UPILITE\b|^UPILITE\b/.test(n)) return 'wallet_topup';
  if (/\bSMA\s+REC\b|\bLOAN\s+REP(AYMENT)?\b/.test(n)) return 'loan_repayment';
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
    // A bare negative figure with no Dr/Cr marker: nothing says whether it is a payment, so skip it.
    if (!pick.marker && pick.negative) {
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

/* ---------- multi-line bank rows (Union Bank of India and similar, pdf.js order) ---------- */

// DD-MM-YYYY / HH:MM:SS / <TranId> <remarks…> / [Instr. ID] <amount> <balance>
const ROW_DATE = /^(\d{2})-(\d{2})-(\d{4})$/;
const ROW_TIME = /^(\d{2}:\d{2}:\d{2})$/;
const ROW_END = /^(?:(\S+)\s+)?(\d{1,3}(?:,\d{2,3})*\.\d{2})\s+(-?\d{1,3}(?:,\d{2,3})*\.\d{2})$/;
const PAGE_FURNITURE =
  /^Page\s*No\s*\d*|system\s+generated\s+output|TO\s+AVAIL\s+OUR\s+LOAN|^Date\s+Tran\s+Id|For\s+any\s+queries|^Records\s+from\s+\d+|^Statement\s+(Period|Date|of\s+Account)|^(Customer\s+Id|Account\s+(No|Type|Currency)|IFSC\s+Code|City|State|Country|Zip|Branch)\b/i;
// Anonymised / masked fragments ("x", "x x", "x/XXXX/xxxxxxxx") carry no merchant.
const MASKED = /^[xX\s/]+$/;

/** True when the text is a multi-line bank statement (date line, time line, …, amount + balance). */
export function isMultiLineBankText(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  let hits = 0;
  for (let i = 0; i + 1 < lines.length && hits < 3; i++)
    if (ROW_DATE.test(lines[i]) && ROW_TIME.test(lines[i + 1])) hits++;
  return hits >= 3;
}

/** Direction from the remarks alone (used for the first row, before a balance chain exists). */
function directionFromRemarks(n: string): 1 | -1 | 0 {
  const u = n.toUpperCase();
  if (/\/DR\/|UPIAR|MAND\s+DR|NEFTO-|\bDR\b|ATM|POS\b/.test(u)) return 1;
  if (/\/CR\/|UPIAB|NEFT:|\bCR\b|SALARY|INTEREST\s+CREDIT|REFUND/.test(u)) return -1;
  return 0;
}

function parseMultiLineBank(text: string, source: StatementLine['source']): StatementLine[] {
  const out: StatementLine[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\u00a0/g, ' ').trim());
  let cur: { date: string; time?: string; parts: string[] } | null = null;
  let prevBalance: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || PAGE_FURNITURE.test(l)) continue;
    const d = ROW_DATE.exec(l);
    if (d && ROW_TIME.test(lines[i + 1] ?? '')) {
      const iso = mkDate(+d[3], +d[2], +d[1]);
      cur = iso ? { date: iso, time: lines[i + 1], parts: [] } : null;
      i++;
      continue;
    }
    if (!cur) continue;
    const end = ROW_END.exec(l);
    if (end && (end[1] === undefined || end[1] === '-' || /^\d+$/.test(end[1]))) {
      const amount = parseAmountCell(end[2]);
      const balance = Number(end[3].replace(/,/g, ''));
      // Tran Id first ("TX0000000 UPIAR/…", or an id split over lines like "SMB8D170" / "0").
      const parts = [...cur.parts];
      if (parts.length) parts[0] = parts[0].replace(/^\S+\s+/, (m) => (/\d/.test(m) ? '' : m));
      while (
        parts.length > 1 &&
        /^[A-Z0-9]{1,10}$/.test(parts[0]) &&
        /\d/.test(parts[0]) &&
        !/[a-z]/.test(parts[0])
      )
        parts.shift();
      const narration = tidy(parts.filter((p) => !MASKED.test(p)).join(' '));
      if (amount !== null && amount > 0 && narration && Number.isFinite(balance)) {
        let sign: 1 | -1;
        if (prevBalance !== null) {
          const asDebit = Math.abs(prevBalance - amount - balance);
          const asCredit = Math.abs(prevBalance + amount - balance);
          sign = asCredit < asDebit ? -1 : 1;
        } else sign = directionFromRemarks(narration) === -1 ? -1 : 1;
        const line: StatementLine = {
          date: cur.date,
          narration,
          amountInr: sign * amount,
          source,
          balanceInr: Math.round(balance * 100) / 100,
          lineKind: lineKindOf(narration),
        };
        if (cur.time) line.time = cur.time;
        if (sign === -1 && line.lineKind === 'purchase') line.lineKind = 'credit';
        out.push(line);
        prevBalance = balance;
      }
      cur = null;
      continue;
    }
    cur.parts.push(l);
  }
  return out;
}

/* ---------- two-date bank rows (State Bank of India and similar) ---------- */

// "DD/MM/YYYY   DD/MM/YYYY   WDL TFR" … narration … "[ref]  -  <debit|->  <credit|->  <balance>"
const TWO_DATE = /^(\d{2})\/(\d{2})\/(\d{4})\s+\d{2}\/\d{2}\/\d{4}\s*(.*)$/;
const COLS_END =
  /^(?:(.*?)\s+)?-\s+(-|\d[\d,]*\.\d{2})\s+(-|\d[\d,]*\.\d{2})\s+(-?\d[\d,]*\.\d{2})$/;
const SBI_FURNITURE =
  /^\d+\s+Page\s+no\.?$|^Balance$|^STATEMENT\s+OF\s+ACCOUNT$|^State\s+Bank\s+of\s+India$|^Branch\s+Name\s*:|^Statement\s+(From|Summary)|^Please\s+do\s+not\s+share|computer\s+generated\s+statement/i;

export function isTwoDateBankText(text: string): boolean {
  let hits = 0;
  for (const l of text.split(/\r?\n/)) if (TWO_DATE.test(l.trim()) && ++hits >= 3) return true;
  return false;
}

/** The account holder's name printed in the statement header, upper-case, or null. */
export function holderName(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .slice(0, 20)
    .map((l) => l.trim());
  const bankIdx = lines.findIndex((l) => /^State\s+Bank\s+of\s+India$/i.test(l));
  const cand = (bankIdx >= 0 ? lines[bankIdx + 1] : null) ?? null;
  const union = lines
    .map((l) => /^([A-Z][A-Z .]{2,40}?)\s{2,}Union\s+Bank\s+of\s+India/.exec(l))
    .find(Boolean);
  const name = (union ? union[1] : cand)?.trim() ?? null;
  if (!name || !/^[A-Za-z][A-Za-z .]{2,40}$/.test(name) || /account|statement|bank/i.test(name))
    return null;
  return name.toUpperCase().replace(/\s+/g, ' ');
}

/** A transfer to or from the holder's own account (name in the narration), not a loan recovery. */
function isSelf(
  narration: string,
  holder: string | null,
  kind: StatementLine['lineKind'],
): boolean {
  if (!holder || kind === 'loan_repayment') return false;
  return mentionsHolder(narration, holder);
}

/**
 * The holder's name in a narration: in full, truncated by the column ("TEST USE", "RAVI KUM"),
 * or as their own UPI handle ("testuser@…").
 */
export function mentionsHolder(narration: string, holder: string): boolean {
  const n = narration.toUpperCase().replace(/[^A-Z0-9@]+/g, ' ');
  const h = holder
    .toUpperCase()
    .replace(/[^A-Z ]+/g, ' ')
    .trim()
    .split(/\s+/);
  if (!h.length || h[0].length < 3) return false;
  if (` ${n} `.includes(` ${h.join(' ')} `)) return true;
  const toks = n.split(/\s+/);
  for (let i = 0; i + 1 < toks.length; i++)
    if (toks[i] === h[0] && h[1] && toks[i + 1].length >= 1 && h[1].startsWith(toks[i + 1]))
      return true;
  const squashed = h.join('').toLowerCase();
  return squashed.length >= 6 && new RegExp(`${squashed}[0-9._-]*@`, 'i').test(narration);
}

function parseTwoDateBank(text: string, source: StatementLine['source']): StatementLine[] {
  const out: StatementLine[] = [];
  let cur: { date: string; parts: string[] } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\u00a0/g, ' ').trim();
    if (!l || SBI_FURNITURE.test(l)) continue;
    const d = TWO_DATE.exec(l);
    if (d) {
      const iso = mkDate(+d[3], +d[2], +d[1]);
      cur = iso ? { date: iso, parts: [] } : null;
      if (cur && d[4]) {
        const end = COLS_END.exec(d[4]);
        if (end) {
          cur.parts.push(end[1] ?? '');
          push(cur, end);
          cur = null;
        } else cur.parts.push(d[4]);
      }
      continue;
    }
    if (!cur) continue;
    const end = COLS_END.exec(l);
    if (end) {
      // A non-numeric fragment before the columns is narration ("TESTBR"); a bare ref is not.
      if (end[1] && !/^\d+$/.test(end[1])) cur.parts.push(end[1]);
      push(cur, end);
      cur = null;
      continue;
    }
    cur.parts.push(l);
  }
  function push(row: { date: string; parts: string[] }, end: RegExpExecArray) {
    const dr = end[2] === '-' ? null : parseAmountCell(end[2]);
    const cr = end[3] === '-' ? null : parseAmountCell(end[3]);
    const balance = Number(end[4].replace(/,/g, ''));
    const amount = dr ?? cr;
    const narration = tidy(row.parts.filter((p) => p && !MASKED.test(p)).join(' '));
    if (amount === null || !narration || !Number.isFinite(balance)) return;
    const sign = dr !== null ? 1 : -1;
    const line: StatementLine = {
      date: row.date,
      narration,
      amountInr: sign * amount,
      source,
      balanceInr: Math.round(balance * 100) / 100,
      lineKind: lineKindOf(narration),
    };
    if (sign === -1 && line.lineKind === 'purchase') line.lineKind = 'credit';
    out.push(line);
  }
  return out;
}

/* ---------- UPI app statements (Google Pay "Transaction statement") ---------- */

const GPAY_DATE = /^(\d{1,2})\s+([A-Za-z]{3}),?\s+(\d{4})$/;
const GPAY_TIME = /^\d{1,2}:\d{2}\s*[AP]M$/i;
const GPAY_KIND = /^(Paid to|Received from|Self transfer to|Top-up to)\s+(.+)$/i;
const GPAY_AMOUNT = /^₹\s*(\d[\d,]*(?:\.\d{1,2})?)$/;

export function isUpiAppStatement(text: string): boolean {
  return /Transaction\s+statement/i.test(text) && /UPI\s+Transaction\s+ID/i.test(text);
}

/**
 * Google Pay rows: date, time, "<Paid to|Received from|Self transfer to|Top-up to> <payee>",
 * "UPI Transaction ID", "Paid by <bank> <digits> | RuPay credit card" (or "UPI Lite | …"), amount.
 * Rows cut off at the end of the text (no amount yet) are skipped.
 */
function parseUpiApp(text: string): StatementLine[] {
  const out: StatementLine[] = [];
  let cur: { date: string; time?: string; kind?: string; payee?: string; paidBy?: string } | null =
    null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\u00a0/g, ' ').trim();
    if (!l) continue;
    const d = GPAY_DATE.exec(l);
    if (d) {
      const m = MONTHS[d[2].slice(0, 3).toLowerCase()];
      const iso = m ? mkDate(+d[3], m, +d[1]) : null;
      cur = iso ? { date: iso } : null;
      continue;
    }
    if (!cur) continue;
    if (GPAY_TIME.test(l) && !cur.time) {
      cur.time = l;
      continue;
    }
    const k = GPAY_KIND.exec(l);
    if (k && !cur.kind) {
      cur.kind = k[1].toLowerCase();
      cur.payee = k[2].trim();
      continue;
    }
    if (/^Paid\s+by\s+/i.test(l) || /^UPI\s+Lite\s*\|/i.test(l)) {
      cur.paidBy = l.replace(/^Paid\s+by\s+/i, '').trim();
      continue;
    }
    const a = GPAY_AMOUNT.exec(l);
    if (a && cur.kind && cur.payee) {
      const amount = parseAmountCell(a[1]);
      if (amount !== null && amount > 0) {
        const credit = cur.kind === 'received from';
        const card = /credit\s+card/i.test(cur.paidBy ?? '');
        const line: StatementLine = {
          date: cur.date,
          narration: `${cur.kind === 'paid to' ? 'Paid to' : cur.kind === 'received from' ? 'Received from' : cur.kind === 'self transfer to' ? 'Self transfer to' : 'Top-up to'} ${cur.payee}`,
          amountInr: credit ? -amount : amount,
          source: card ? 'card' : 'bank',
          lineKind: credit ? 'credit' : lineKindOf(cur.payee),
        };
        if (cur.kind === 'top-up to') line.lineKind = 'wallet_topup';
        if (cur.kind === 'self transfer to') line.selfTransfer = true;
        if (cur.paidBy) line.paidBy = cur.paidBy;
        if (cur.time) {
          const t = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(cur.time);
          if (t) {
            const h = (+t[1] % 12) + (/p/i.test(t[3]) ? 12 : 0);
            line.time = `${String(h).padStart(2, '0')}:${t[2]}:00`;
          }
        }
        out.push(line);
      }
      cur = null;
    }
  }
  return out;
}

// Signs that a UPI payee is a business, an app mandate or a merchant QR, not a person.
const MERCHANT_MARK =
  /\/MAND\b|\bMANDATE\b|\bEXEC\b|\/PAY\b|\bPAYM\b|\bMERCHANT\b|\bSHOP\b|PAYTMQR|RAZORPAY|\.RZ\b|\bRZP|BHARATPE|\bPOS\b|\bPVT\b|\bLTD\b|LIMITED|PRIVATE|\bSTORES?\b|ENTERPRISE|SERVICES?\b|TRADERS|\bHOTEL\b|\bMART\b|MEDICAL|CHEMIST|PHARMA|ASSOCIATION|SOCIETY|\bCAFE\b|RESTAURANT|FOODS?\b|\bBAKERY\b|\bAGENCY\b|\bCENTRE\b|\bCENTER\b|\bCLINIC\b|HOSPITAL|\bINDIA\b|\.COM\b|\bLLP\b|\bINC\b|\bBANK\b|\bFINANCE\b|\bINSURANCE\b|\bRECHARGE|POSTPAID|PREPAID|\bBILL|\bCARD\b|@YBL\s*MERCHANT/i;

/** The payee name of a UPI narration ("UPI/DR/123/RAHUL K/YESB/…", "Paid to RAHUL K"). */
function upiPayee(narration: string): { name: string; handle: string | null } | null {
  const handle = /([a-z0-9._-]+)@[a-z]+/i.exec(narration)?.[1] ?? null;
  const app = /^Paid to\s+(.+)$/i.exec(narration);
  if (app) return { name: app[1].trim(), handle };
  const m = /\/(?:DR|CR)\/(?:\d+\/)?\s*([^/]+)/i.exec(narration);
  if (!m || !/UPI/i.test(narration)) return null;
  return { name: m[1].trim(), handle };
}

/**
 * A person-to-person UPI payment: a personal handle (a phone number, or the payee's own name) or
 * a payee written like a person ("RAHUL K", "PERSON 003"), with no business or mandate markers.
 * Known merchants are re-checked by the recurring detector (an alias always wins).
 */
export function looksP2p(narration: string): boolean {
  if (MERCHANT_MARK.test(narration)) return false;
  const p = upiPayee(narration);
  if (!p || !p.name) return false;
  const name = p.name.replace(/\s+/g, ' ').trim();
  if (/^PERSON\s+\d+$/i.test(name) || /^PAYEE\d+$/i.test(name)) return true;
  if (p.handle && /^\d{10}$/.test(p.handle)) return true;
  const words = name.split(' ').filter(Boolean);
  if (!words.length || words.length > 4 || !words.every((w) => /^[A-Za-z.]+$/.test(w)))
    return false;
  const first = words[0].toLowerCase();
  if (p.handle && first.length >= 3 && p.handle.toLowerCase().startsWith(first)) return true;
  return words.length >= 2 && words[words.length - 1].replace('.', '').length <= 2;
}

/** Marks transfers between the holder's own accounts and person-to-person payments. */
function markSelf(lines: StatementLine[], holder: string | null): StatementLine[] {
  return lines.map((l) => {
    if (holder && isSelf(l.narration, holder, l.lineKind)) return { ...l, selfTransfer: true };
    if (l.amountInr > 0 && l.lineKind === 'purchase' && looksP2p(l.narration))
      return { ...l, lineKind: 'p2p' };
    return l;
  });
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
  const holder = holderName(src);
  if (isUpiAppStatement(src)) {
    const rows = parseUpiApp(src);
    if (rows.length) return markSelf(rows, holder);
  }
  if (isTwoDateBankText(src)) {
    const rows = parseTwoDateBank(src, source);
    if (rows.length) return markSelf(rows, holder);
  }
  if (isMultiLineBankText(src)) {
    const rows = parseMultiLineBank(src, source);
    if (rows.length) return markSelf(rows, holder);
  }
  const firstLines = src.split(/\r?\n/).slice(0, 30).join('\n');
  if (/[,\t]/.test(firstLines)) {
    const csv = parseCsvRows(src, source);
    if (csv && csv.length) return csv;
  }
  return parseTextLines(src, source);
}
