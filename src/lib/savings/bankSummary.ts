/**
 * Bank-account statement summary: failed auto-debit charges, the balance each morning (for EMI
 * timing) and merchants whose price stepped up. Built from parsed lines, on the device.
 */
import { addDays, daysBetween, parseISO, toISO, daysInMonth } from '../dates';
import { statementAlias, statementMerchant } from './recurring';
import { leadingDate, parseStatementText } from './statement';
import type { BankStatementSummary, PriceStep, StatementLine } from './types';

const FAILED_DEBIT =
  /MAND\s*DR.{0,20}Insufficient|Insufficient\s+Bal\S*.{0,20}(Charge|Fee)|(ECS|NACH|ACH)\s*(RTN|RETURN).{0,20}(CHG|CHARGE)|MANDATE\s+RETURN\s+CHARGE/i;

const BANKS: [RegExp, string][] = [
  [/Union\s+Bank\s+of\s+India/i, 'Union Bank of India'],
  [/State\s+Bank\s+of\s+India/i, 'State Bank of India'],
  [/HDFC\s+Bank/i, 'HDFC Bank'],
  [/ICICI\s+Bank/i, 'ICICI Bank'],
  [/Axis\s+Bank/i, 'Axis Bank'],
  [/Kotak/i, 'Kotak Mahindra Bank'],
  [/Bank\s+of\s+Baroda/i, 'Bank of Baroda'],
  [/Canara\s+Bank/i, 'Canara Bank'],
  [/Punjab\s+National\s+Bank/i, 'Punjab National Bank'],
  [/IDFC\s+FIRST/i, 'IDFC FIRST Bank'],
  [/Yes\s+Bank/i, 'YES Bank'],
  [/IndusInd/i, 'IndusInd Bank'],
];

const r2 = (n: number) => Math.round(n * 100) / 100;
const month = (d: string) => d.slice(0, 7);

/** Balance-chain lines, oldest first, with an opening balance before the first row. */
function chain(lines: StatementLine[]): { lines: StatementLine[]; opening: number } | null {
  const withBal = lines.filter((l) => typeof l.balanceInr === 'number');
  if (!withBal.length) return null;
  const first = withBal[0];
  return { lines: withBal, opening: r2((first.balanceInr as number) + first.amountInr) };
}

/** Balance at a time of day (default 09:00) on a date: after every earlier row. */
export function balanceAt(lines: StatementLine[], date: string, time = '09:00:00'): number | null {
  const c = chain(lines);
  if (!c) return null;
  let bal: number | null = null;
  for (const l of c.lines) {
    if (l.date < date || (l.date === date && (l.time ?? '00:00:00') < time))
      bal = l.balanceInr as number;
    else if (l.date > date) break;
  }
  if (bal !== null) return bal;
  return date >= c.lines[0].date ? c.opening : null;
}

export interface IncomeTimingMonth {
  month: string;
  date: string;
  balanceInr: number;
  emiInr: number | null;
  /** EMI minus balance when the balance was short; 0 when it covered the EMI; null without an EMI. */
  shortfallInr: number | null;
}

/** Per month: the balance at 09:00 on the EMI due day vs the EMI total. */
export function incomeTiming(
  input: StatementLine[] | BankStatementSummary,
  dueDay: number,
  emiInr: number | null = null,
): IncomeTimingMonth[] {
  const out: IncomeTimingMonth[] = [];
  const balances: Map<string, number> = new Map();
  let first: string | null;
  let last: string | null;
  if (Array.isArray(input)) {
    const c = chain(input);
    if (!c) return [];
    first = c.lines[0].date;
    last = c.lines[c.lines.length - 1].date;
  } else {
    for (const b of input.morningBalances) balances.set(b.date, b.balanceInr);
    first = input.morningBalances[0]?.date ?? null;
    last = input.morningBalances[input.morningBalances.length - 1]?.date ?? null;
  }
  if (!first || !last) return [];
  const { y, m } = parseISO(first);
  for (
    let yy = y, mm = m;
    toISO(yy, mm, 1) <= last;
    mm === 12 ? ((yy += 1), (mm = 1)) : (mm += 1)
  ) {
    const date = toISO(yy, mm, Math.min(dueDay, daysInMonth(yy, mm)));
    if (date < first || date > last) continue;
    const bal = Array.isArray(input) ? balanceAt(input, date) : (balances.get(date) ?? null);
    if (bal === null) continue;
    out.push({
      month: month(date),
      date,
      balanceInr: bal,
      emiInr,
      shortfallInr: emiInr === null ? null : r2(Math.max(0, emiInr - bal)),
    });
  }
  return out;
}

/**
 * Merchants whose monthly charge stepped up by ≥5% and stayed (e.g. ₹999 → ₹1,999).
 * Only subscription-like merchants; usage top-ups, bill payments and jumps over 3× (prorated
 * first months, trials) are ignored.
 */
export function priceSteps(lines: StatementLine[]): PriceStep[] {
  const groups = new Map<string, { label: string; byMonth: Map<string, number> }>();
  for (const l of lines) {
    if (!(l.amountInr > 0) || l.selfTransfer || (l.lineKind && l.lineKind !== 'purchase')) continue;
    const alias = statementAlias(l.narration);
    if (!alias || !alias.subscription || alias.usage || alias.billPayment) continue;
    const { key, label } = statementMerchant(l.narration);
    const g = groups.get(key) ?? { label, byMonth: new Map() };
    const mk = l.statementPeriod ?? month(l.date);
    g.byMonth.set(mk, (g.byMonth.get(mk) ?? 0) + l.amountInr);
    groups.set(key, g);
  }
  const out: PriceStep[] = [];
  for (const [key, g] of groups) {
    const months = [...g.byMonth.keys()].sort();
    if (months.length < 2) continue;
    const totals = months.map((m) => g.byMonth.get(m) as number);
    for (let i = 1; i < totals.length; i++) {
      const before = totals.slice(0, i);
      const after = totals.slice(i);
      const a = before[before.length - 1];
      const b = after[0];
      const flatBefore = before.every((t) => Math.abs(t - a) <= a * 0.05);
      const stayed = after.every((t) => Math.abs(t - b) <= b * 0.05);
      if (flatBefore && stayed && b >= a * 1.05 && b <= a * 3) {
        out.push({ key, label: g.label, fromInr: r2(a), toInr: r2(b), since: months[i] });
        break;
      }
    }
  }
  return out;
}

/** The bank statement summary, or null when the text has no balance-chain rows. */
export function parseBankStatementSummary(text: string): BankStatementSummary | null {
  const lines = parseStatementText(text, 'bank');
  const c = chain(lines);
  if (!c) return null;
  const period =
    /Statement\s+Period\s+From\s*-?\s*(\S+)\s+To\s+(\S+)/i.exec(text) ??
    /Statement\s+From\s*:?\s*(\S+)\s+to\s+(\S+)/i.exec(text);
  const from = c.lines[0].date;
  const to = c.lines[c.lines.length - 1].date;
  const failed = new Map<string, { count: number; chargesInr: number }>();
  for (const l of lines)
    if (l.amountInr > 0 && FAILED_DEBIT.test(l.narration)) {
      const f = failed.get(month(l.date)) ?? { count: 0, chargesInr: 0 };
      f.count += 1;
      f.chargesInr = r2(f.chargesInr + l.amountInr);
      failed.set(month(l.date), f);
    }
  const morningBalances: BankStatementSummary['morningBalances'] = [];
  for (let d = from, i = 0; d <= to && i < 400; d = addDays(d, 1), i++) {
    const b = balanceAt(lines, d);
    if (b !== null) morningBalances.push({ date: d, balanceInr: b });
  }
  return {
    bank: BANKS.find(([re]) => re.test(text))?.[1] ?? null,
    periodFrom: (period && leadingDate(period[1])?.iso) || from,
    periodTo: (period && leadingDate(period[2])?.iso) || to,
    failedAutoDebits: [...failed.entries()].sort().map(([m, f]) => ({ month: m, ...f })),
    morningBalances,
    priceSteps: priceSteps(lines),
    smaSweeps: lines
      .filter((l) => l.amountInr > 0 && /\bSMA\s+REC\b/i.test(l.narration))
      .map((l) => ({ date: l.date, amountInr: l.amountInr })),
  };
}

/** Months covered by a bank summary (at least 1). */
export function bankMonths(s: Pick<BankStatementSummary, 'periodFrom' | 'periodTo'>): number {
  if (!s.periodFrom || !s.periodTo) return 1;
  return Math.max(1, Math.round((daysBetween(s.periodFrom, s.periodTo) + 1) / (365 / 12)));
}
