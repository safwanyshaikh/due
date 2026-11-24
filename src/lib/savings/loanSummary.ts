/**
 * Loan "Statement of Account" and welcome-letter reader (NBFC / bank home loans), on the device.
 * Reads printed values only; anything not printed stays null. Account numbers are never kept.
 */
import { leadingDate, parseAmountCell } from './statement';
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

/** A loan statement or welcome-letter summary, or null when the text is neither. */
export function parseLoanStatement(text: string): LoanStatementSummary | null {
  if (!text || !/loan/i.test(text)) return null;
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
  };
}

/** Key for one loan across statements. */
export function loanKey(
  s: Pick<LoanStatementSummary, 'obligationId' | 'lender' | 'product' | 'disbursementDate'>,
): string {
  if (s.obligationId) return s.obligationId;
  const slug = (v: string | null) => (v ?? 'x').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `loan-${slug(s.lender)}-${slug(s.product)}-${s.disbursementDate ?? 'x'}`;
}
