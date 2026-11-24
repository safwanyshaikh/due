/**
 * Credit-card statement summary (due date, total/minimum due, limits, fees) read on the device.
 * pdf.js prints the summary labels and their values on separate lines, so the value block is
 * read by shape: two single amounts (total due, minimum due), two pairs (limit / cash limit,
 * available credit / cash), a triple (payments, purchases, fees+taxes+interest), the statement
 * and due dates, then a pair (total outstanding, previous balance). Labelled "Label: value"
 * text is read as a fallback. Nothing is guessed: what is not printed stays null.
 */
import { leadingDate, parseAmountCell, parseStatementText } from './statement';
import type { CardStatementSummary, StatementLine } from './types';

const MONEY = /^\d{1,3}(?:,\d{2,3})*\.\d{2}$|^\d+\.\d{2}$/;

function moneyRow(line: string): number[] | null {
  const parts = line.trim().split(/\s+/);
  if (!parts.length || !parts.every((p) => MONEY.test(p))) return null;
  return parts.map((p) => parseAmountCell(p) as number);
}

function dateRow(line: string): string | null {
  const t = line.trim();
  const d = leadingDate(t);
  return d && d.length === t.length ? d.iso : null;
}

const ISSUERS: [RegExp, string][] = [
  [/\bSBI\s*Card\b/i, 'SBI Card'],
  [/\bHDFC\s+Bank\b/i, 'HDFC Bank'],
  [/\bICICI\s+Bank\b/i, 'ICICI Bank'],
  [/\bAxis\s+Bank\b/i, 'Axis Bank'],
  [/\bKotak\b/i, 'Kotak'],
  [/\bAmerican\s+Express\b|\bAmex\b/i, 'American Express'],
  [/\bIndusInd\b/i, 'IndusInd Bank'],
  [/\bYES\s+Bank\b/i, 'YES Bank'],
  [/\bIDFC\s+FIRST\b/i, 'IDFC FIRST Bank'],
  [/\bAU\s+Small\s+Finance\b/i, 'AU Small Finance Bank'],
  [/\bRBL\s+Bank\b/i, 'RBL Bank'],
  [/\bStandard\s+Chartered\b/i, 'Standard Chartered'],
];

interface Block {
  totalDue: number;
  minimumDue: number;
  creditLimit: number;
  availableCredit: number;
  payments: number;
  purchases: number;
  feesTaxesInterest: number;
  statementDate: string;
  dueDate: string;
  previousBalance: number;
}

function valueBlock(lines: string[]): Block | null {
  for (let i = 0; i + 7 < lines.length; i++) {
    const a = moneyRow(lines[i]);
    if (!a || a.length !== 1) continue;
    const b = moneyRow(lines[i + 1]);
    const c = moneyRow(lines[i + 2]);
    const d = moneyRow(lines[i + 3]);
    const e = moneyRow(lines[i + 4]);
    const sd = dateRow(lines[i + 5]);
    const dd = dateRow(lines[i + 6]);
    const f = moneyRow(lines[i + 7]);
    if (b?.length !== 1 || c?.length !== 2 || d?.length !== 2 || e?.length !== 3) continue;
    if (!sd || !dd || f?.length !== 2) continue;
    return {
      totalDue: a[0],
      minimumDue: b[0],
      creditLimit: c[0],
      availableCredit: d[0],
      payments: e[0],
      purchases: e[1],
      feesTaxesInterest: e[2],
      statementDate: sd,
      dueDate: dd,
      previousBalance: f[1],
    };
  }
  return null;
}

function labelled(text: string, label: RegExp): number | null {
  const re = new RegExp(
    `${label.source}[^0-9\\n]{0,40}?(?:₹|rs\\.?|inr)?\\s*(\\d{1,3}(?:,\\d{2,3})*(?:\\.\\d{1,2})?|\\d+(?:\\.\\d{1,2})?)`,
    'i',
  );
  const m = re.exec(text);
  return m ? parseAmountCell(m[1]) : null;
}

function labelledDate(text: string, label: RegExp): string | null {
  const re = new RegExp(
    `${label.source}[^0-9\\n]{0,30}?(\\d{1,2}[\\s\\-/.]+[a-z]{3,9}[\\s\\-/.,']+\\d{2,4}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})`,
    'i',
  );
  const m = re.exec(text);
  return m ? (leadingDate(m[1])?.iso ?? null) : null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function sum(lines: StatementLine[], re: RegExp, withTax: boolean, credits = false): number | null {
  const hit = lines.filter(
    (l) => re.test(l.narration) && (credits ? l.amountInr < 0 : l.amountInr > 0),
  );
  if (!hit.length) return null;
  return r2(hit.reduce((s, l) => s + Math.abs(l.amountInr) + (withTax ? (l.taxInr ?? 0) : 0), 0));
}

/**
 * Fee lines carry "(EXCL TAX n)": n is informational. GST is billed once on the separate IGST/CGST
 * lines, so adding n would double count (sum of fee lines + IGST === "Fee, Taxes & Interest").
 */
/** The statement's account summary, or null when the text is not a card statement. */
export function parseCardStatementSummary(text: string): CardStatementSummary | null {
  if (!text || !text.trim()) return null;
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\u00a0/g, ' ').trim())
    .filter(Boolean);
  const block = valueBlock(rows);
  const lines = parseStatementText(text, 'card');
  const issuer = ISSUERS.find(([re]) => re.test(text))?.[1] ?? null;
  const masked = /(?:X{4}[\s-]?){2,3}X{0,4}(\d{2,4})\b/i.exec(text);
  const rate = /(\d+(?:\.\d+)?)\s*%\s*p\.?\s*m\.?/i.exec(text);
  const waivers = [
    ...text.matchAll(/waived\s+off\s+on\s+annual\s+spends?\s+of\s+([^)\n]{3,60})/gi),
  ];

  const totalDue = block?.totalDue ?? labelled(text, /total\s+(?:amount\s+)?due/);
  const minimumDue = block?.minimumDue ?? labelled(text, /minimum\s+(?:amount\s+)?due/);
  const dueDate = block?.dueDate ?? labelledDate(text, /(?:payment\s+)?due\s+date/);
  const statementDate = block?.statementDate ?? labelledDate(text, /statement\s+date/);
  if (totalDue === null && dueDate === null) return null;

  const foreign = lines.filter((l) => l.foreignCurrency && l.amountInr > 0);
  return {
    issuer,
    last4: masked ? masked[1] : null,
    statementDate,
    dueDate,
    creditLimit: block?.creditLimit ?? labelled(text, /credit\s+limit/),
    availableCredit: block?.availableCredit ?? labelled(text, /available\s+credit(?:\s+limit)?/),
    totalDue,
    minimumDue,
    previousBalance: block?.previousBalance ?? labelled(text, /previous\s+balance/),
    payments: block?.payments ?? null,
    purchases: block?.purchases ?? null,
    feesTaxesInterest: block?.feesTaxesInterest ?? null,
    financeChargeInr: sum(lines, /FIN(ANCE)?\s*CHARGE|\bINTEREST\b/i, false),
    lateFeeInr: sum(lines, /LATE\s+PAYMENT|LATE\s+FEE/i, false),
    forexMarkupInr: sum(lines, /FORGN|FOREIGN\s+CURR|MARK-?UP|CROSS\s+CURRENCY/i, false),
    annualFeeInr: sum(lines, /ANNUAL\s+FEE|RENEWAL\s+FEE/i, false),
    annualFeeReversedInr: sum(lines, /ANNUAL\s+FEE|RENEWAL\s+FEE/i, false, true),
    annualFeeWaiver:
      waivers.length === 1 ? `Waived on annual spends of ${waivers[0][1].trim()}` : null,
    monthlyRatePct: rate ? Number(rate[1]) : null,
    foreignSpendInr: foreign.length ? r2(foreign.reduce((s, l) => s + l.amountInr, 0)) : null,
  };
}

/** Key for one card across statements: the linked obligation, else issuer + masked digits. */
export function cardKey(
  s: Pick<CardStatementSummary, 'obligationId' | 'issuer' | 'last4'>,
): string {
  if (s.obligationId) return s.obligationId;
  const issuer = (s.issuer ?? 'card').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `card-${issuer}-${s.last4 ?? 'x'}`;
}
