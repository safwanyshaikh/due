/**
 * Loan "Statement of Account" and welcome-letter reader (NBFC / bank home loans), on the device.
 * Reads printed values only; anything not printed stays null. Account numbers are never kept.
 */
import { leadingDate, parseAmountCell } from './statement';
import { looksLikeOrganisation } from '../profiles/detect';
import type { LoanStatementSummary } from './types';

const NUM = '(\\d{1,3}(?:,\\d{2,3})+(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)';
const DATE =
  "(\\d{1,2}[\\s\\-/.]+[a-z]{3,9}[\\s\\-/.,']+\\d{2,4}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4})";
const MON: Record<string, string> = {
  JAN: '01',
  FEB: '02',
  MAR: '03',
  APR: '04',
  MAY: '05',
  JUN: '06',
  JUL: '07',
  AUG: '08',
  SEP: '09',
  OCT: '10',
  NOV: '11',
  DEC: '12',
};

const LENDERS: [RegExp, string][] = [
  [/L&T\s+Finance|\bLTF\b/i, 'L&T Finance'],
  [/\bLIC\s+Housing\b/i, 'LIC Housing Finance'],
  [/\bBajaj\s+(Housing\s+)?Finance\b/i, 'Bajaj Finance'],
  [/\bHDFC\b/i, 'HDFC Bank'],
  [/\bICICI\b/i, 'ICICI Bank'],
  [/\bState\s+Bank\s+of\s+India\b|\bSBI\b/i, 'SBI'],
  [/\bAxis\s+Bank\b/i, 'Axis Bank'],
  [/\bKotak\b/i, 'Kotak Mahindra Bank'],
  [/\bPNB\s+Housing\b/i, 'PNB Housing Finance'],
  [/\bTata\s+Capital\b/i, 'Tata Capital'],
  [/\bAditya\s+Birla\b/i, 'Aditya Birla Finance'],
  [/\bAadhar\s+Housing\b/i, 'Aadhar Housing Finance'],
];

function num(text: string, label: string, gap = 25): number | null {
  const m = new RegExp(`${label}[^0-9\\n]{0,${gap}}?${NUM}`, 'i').exec(text);
  return m ? parseAmountCell(m[1]) : null;
}

function date(text: string, label: string): string | null {
  const m = new RegExp(`${label}[^0-9\\n]{0,20}?${DATE}`, 'i').exec(text);
  return m ? (leadingDate(m[1])?.iso ?? null) : null;
}

/** "3rd of Every Month", "3rd - Monthly", "5" → day of month. */
function dueDay(text: string): number | null {
  const m =
    /EMI\s+Due\s+Date[^0-9\n]{0,10}(\d{1,2})(?:st|nd|rd|th)?\b/i.exec(text) ??
    /\b(\d{1,2})(?:st|nd|rd|th)\s*-\s*Monthly\b/i.exec(text) ??
    /\b(\d{1,2})(?:st|nd|rd|th)\s+of\s+every\s+month\b/i.exec(text);
  if (!m) return null;
  const d = Number(m[1]);
  return d >= 1 && d <= 31 ? d : null;
}

/** Values on the line after a header that names them (pdf.js prints tables row by row). */
function underHeader(lines: string[], header: RegExp, column: number): number | null {
  const i = lines.findIndex((l) => header.test(l));
  if (i < 0 || i + 1 >= lines.length) return null;
  const vals = lines[i + 1]
    .trim()
    .split(/\s+/)
    .map((v) => parseAmountCell(v.replace(/^\./, '0.')));
  return vals[column] ?? null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Organisation co-applicants ("Co-Applicant Name(s): ACME ENTERPRISES LLP, RAVI KUMAR" → the LLP).
 * People's names are dropped: only an entity's name is useful for the "Is this your business?" question.
 */
export function coApplicantEntities(text: string): string[] {
  const out: string[] = [];
  const re = /Co[-\s]?Applicant(?:'s)?\s+Names?(?:\(s\))?\s*:?[ \t]*([^\n]*)/gi;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    for (const part of m[1].split(/\s*[,;/]\s*|\s{3,}/)) {
      const name = part.replace(/\s+/g, ' ').trim();
      if (name && looksLikeOrganisation(name) && !out.includes(name)) out.push(name.slice(0, 60));
    }
  }
  return out;
}

/** A loan statement or welcome-letter summary, or null when the text is neither. */
/**
 * SBI Gold Loan OD statement: limit, outstanding (DR), rate, monthly "TO INTEREST" debits,
 * "OD Penal Charge", and "Irregularity Recovery" / "SMA REC" credits.
 */
function parseGoldLoanOd(text: string): LoanStatementSummary {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\u00a0/g, ' ').trim());
  const rowStart = /^(\d{2}\/\d{2}\/\d{4})\s+\d{2}\/\d{2}\/\d{4}\s*(.*)$/;
  const cols = /-\s+(-|\d[\d,]*\.\d{2})\s+(-|\d[\d,]*\.\d{2})\s+(\d[\d,]*\.\d{2})\s*(?:DR|CR)?$/i;
  const rows: { date: string; text: string; debit: number | null; credit: number | null }[] = [];
  let cur: { date: string; parts: string[] } | null = null;
  for (const l of lines) {
    const st = rowStart.exec(l);
    if (st) {
      const d = leadingDate(st[1]);
      cur = d ? { date: d.iso, parts: [] } : null;
      if (!cur) continue;
      const end = cols.exec(st[2]);
      if (end) {
        rows.push({
          date: cur.date,
          text: st[2].slice(0, end.index),
          debit: end[1] === '-' ? null : parseAmountCell(end[1]),
          credit: end[2] === '-' ? null : parseAmountCell(end[2]),
        });
        cur = null;
      } else cur.parts.push(st[2]);
      continue;
    }
    if (!cur) continue;
    const end = cols.exec(l);
    if (end) {
      cur.parts.push(l.slice(0, end.index));
      rows.push({
        date: cur.date,
        text: cur.parts.join(' '),
        debit: end[1] === '-' ? null : parseAmountCell(end[1]),
        credit: end[2] === '-' ? null : parseAmountCell(end[2]),
      });
      cur = null;
    } else cur.parts.push(l);
  }
  const interest = rows
    .filter((r) => /\bTO\s+INTEREST\b/i.test(r.text) && r.debit !== null)
    .map((r) => ({ month: r.date.slice(0, 7), amountInr: r.debit as number }))
    .sort((a, b) => a.month.localeCompare(b.month));
  const penal = rows.filter((r) => /OD\s+Penal\s+Charge/i.test(r.text) && r.debit !== null);
  const irregular = rows
    .filter((r) => r.credit !== null && /Irregularity\s+Recovery|\bSMA\s+REC\b/i.test(r.text))
    .map((r) => ({
      date: r.date,
      amountInr: r.credit as number,
      label: /SMA/i.test(r.text) ? 'SMA REC' : 'Irregularity Recovery',
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const outstanding = /^-\s*(\d[\d,]*\.\d{2})$/m.exec(text);
  const limit = /^(\d{1,3}(?:,\d{2,3})+\.\d{2})$/m.exec(text);
  const rate = /^(\d+(?:\.\d+)?)%$/m.exec(text);
  const stmt = /Date\s+of\s+Statement\s*:?\s*(\d{2}-\d{2}-\d{4})/i.exec(text);
  const open = /^(\d{2}-\d{2}-\d{4})$/m.exec(text);
  return {
    source: 'statement',
    lender: LENDERS.find(([re]) => re.test(text))?.[1] ?? null,
    product: 'Gold Loan OD',
    productKind: 'gold_loan_od',
    rateType: null,
    annualRatePct: rate ? Number(rate[1]) : null,
    emiInr: null,
    emiDueDay: null,
    loanAmountInr: limit ? parseAmountCell(limit[1]) : null,
    loanTenureMonths: null,
    balanceTenureMonths: null,
    futurePrincipalInr: null,
    overdueInstalmentInr: null,
    latePaymentChargesInr: null,
    bounceCount: 0,
    bounceRows: [],
    bounceMonths: [],
    bounceChargesInr: 0,
    bounceCharges: [],
    processingFeeInr: null,
    disbursementDate: open ? (leadingDate(open[1])?.iso ?? null) : null,
    instalmentEndDate: null,
    statementDate: stmt ? (leadingDate(stmt[1])?.iso ?? null) : null,
    limitInr: limit ? parseAmountCell(limit[1]) : null,
    outstandingInr: outstanding ? parseAmountCell(outstanding[1]) : null,
    monthlyInterest: interest,
    penalChargesInr: penal.length ? r2(penal.reduce((s, r) => s + (r.debit as number), 0)) : null,
    irregularities: irregular,
    irregularityCount: irregular.length,
    ...withEntities(text),
  };
}

export function parseLoanStatement(text: string): LoanStatementSummary | null {
  if (!text || !/loan/i.test(text)) return null;
  if (/Gold\s+Loan\s+OD/i.test(text)) return parseGoldLoanOd(text);
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\u00a0/g, ' ').trim());
  const welcome = /welcome\s+letter/i.test(text);
  const isSoa =
    /statement\s+of\s+account|loan\s+account\s+statement|Annualised\s+Interest\s+Rate/i.test(text);
  if (!welcome && !isSoa) return null;

  const bounceRows: string[] = [];
  const bounceCharges: { date: string; amountInr: number }[] = [];
  for (const l of lines) {
    const b = /^Bounced\s+([A-Z]{3})\/(\d{4})\b/i.exec(l);
    if (b && MON[b[1].toUpperCase()]) bounceRows.push(`${b[2]}-${MON[b[1].toUpperCase()]}`);
    const c = new RegExp(
      `^${DATE}\\s+(?:${DATE}\\s+)?Bounce\\s+Charges\\S*(?:\\s+NA)?\\s+${NUM}`,
      'i',
    ).exec(l);
    if (c) {
      const d = leadingDate(c[1]);
      const amt = parseAmountCell(c[3]);
      if (d && amt !== null) bounceCharges.push({ date: d.iso, amountInr: amt });
    }
  }

  // Welcome letter table: "Loan Amount (Rs.)  Tenure  EMI Amount (Rs.)  EMI Cycle" then values.
  let loanAmountInr =
    num(text, 'Amount\\s+Sanctioned\\s*\\(Rs\\)') ?? num(text, 'Sanction\\s+Amount');
  let loanTenureMonths = num(text, 'Loan\\s+Tenure\\s*\\(Months\\)');
  let emiInr = num(text, 'EMI\\s+Amount\\s*\\(Rs\\)(?!\\.)');
  const head = lines.findIndex((l) => /Loan\s+Amount.*Tenure.*EMI\s+Amount/i.test(l));
  if (head >= 0 && lines[head + 1]) {
    const m = new RegExp(
      `(?:Rs\\.?\\s*)?${NUM}\\S*\\s+(\\d{1,3})\\s+(?:Rs\\.?\\s*)?${NUM}`,
      'i',
    ).exec(lines[head + 1]);
    if (m) {
      loanAmountInr = loanAmountInr ?? parseAmountCell(m[1]);
      loanTenureMonths = loanTenureMonths ?? Number(m[2]);
      emiInr = emiInr ?? parseAmountCell(m[3]);
    }
  }

  const annualRatePct = num(text, 'Annualised\\s+Interest\\s+Rate\\s*%?');
  // A bank statement can say "Statement of Account" and advertise loans; a loan document has terms.
  if (emiInr === null && annualRatePct === null && loanAmountInr === null) return null;

  const rateType = /Interest\s+(?:Rate\s+)?Type[^\n]{0,5}?Floating/i.test(text)
    ? 'floating'
    : /Interest\s+(?:Rate\s+)?Type[^\n]{0,5}?Fixed/i.test(text)
      ? 'fixed'
      : null;
  const product = /Product:?\s{1,}([A-Z][A-Z &]{2,40}?)\s*$/m.exec(text)?.[1]?.trim() ?? null;
  const statementDate = /\bDated\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/.exec(text)?.[1];

  return {
    source: welcome ? 'welcome_letter' : 'statement',
    lender: LENDERS.find(([re]) => re.test(text))?.[1] ?? null,
    product,
    rateType,
    annualRatePct,
    emiInr,
    emiDueDay: dueDay(text),
    loanAmountInr,
    loanTenureMonths,
    balanceTenureMonths: num(text, 'Balance\\s+Tenure\\s*\\(Months\\)'),
    futurePrincipalInr: underHeader(lines, /Future\s+Principal/i, 4),
    overdueInstalmentInr: num(text, 'Instalment\\s+overdue\\s*\\(Rs\\)'),
    latePaymentChargesInr: num(text, 'Late\\s+Payment\\s+Charges\\s*\\(Rs\\)'),
    bounceCount: bounceRows.length,
    bounceRows,
    bounceMonths: [...new Set(bounceRows)].sort(),
    bounceChargesInr: r2(bounceCharges.reduce((s, c) => s + c.amountInr, 0)),
    bounceCharges,
    processingFeeInr: num(text, 'Processing\\s+Fees?[^0-9\\n]{0,20}?'),
    disbursementDate: date(text, 'Disbursement\\s+Date'),
    instalmentEndDate: date(text, '(?:Instalment|EMI)\\s+End\\s+date'),
    statementDate: statementDate ? (leadingDate(statementDate)?.iso ?? null) : null,
    ...withEntities(text),
  };
}

function withEntities(text: string): Pick<LoanStatementSummary, 'coApplicantEntities'> {
  const list = coApplicantEntities(text);
  return list.length ? { coApplicantEntities: list } : {};
}

/** Key for one loan across statements. */
export function loanKey(
  s: Pick<LoanStatementSummary, 'obligationId' | 'lender' | 'product' | 'disbursementDate'>,
): string {
  if (s.obligationId) return s.obligationId;
  const slug = (v: string | null) => (v ?? 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `loan-${slug(s.lender)}-${slug(s.product)}-${s.disbursementDate ?? 'x'}`;
}
