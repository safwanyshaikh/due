/** Regression tests on a synthetic Union Bank of India savings statement (scripts/generate-statement-fixtures.mjs). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataWith } from '../../__tests__/helpers';
import {
  computeMoves,
  defaultSavingsState,
  detectRecurring,
  incomeTiming,
  parseBankStatementSummary,
  parseLoanStatement,
  parseStatementText,
  priceSteps,
  railFor,
  statementMerchant,
  timingSentence,
  type StatementLine,
} from '..';
import { emptyIfNull } from './fixtureHelpers';
import { HOME_LOAN, catalogWith } from './testCatalog';

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const UNION = fx('union-bank-savings.txt');
const NOW = '2026-11-24T05:00:00.000Z';

/** The fixture's own sums: every "[instr] amount balance" row, direction from the balance change. */
function fixtureSums() {
  const re = /^(?:\S+\s+)?(\d[\d,]*\.\d{2})\s+(-?\d[\d,]*\.\d{2})$/;
  const rows = UNION.split(/\r?\n/)
    .map((l) => re.exec(l.trim()))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      amount: Number(m[1].replace(/,/g, '')),
      balance: Number(m[2].replace(/,/g, '')),
    }));
  let debits = 0;
  let credits = 0;
  rows.forEach((r, i) => {
    const prev = i ? rows[i - 1].balance : r.balance + r.amount; // first row is a /DR/ payment
    if (Math.abs(prev + r.amount - r.balance) < Math.abs(prev - r.amount - r.balance))
      credits += r.amount;
    else debits += r.amount;
  });
  return {
    rows: rows.length,
    debits: Math.round(debits * 100) / 100,
    credits: Math.round(credits * 100) / 100,
  };
}

describe('Union Bank multi-line statement', () => {
  const lines = parseStatementText(UNION, 'bank');

  it('reads all 240 rows; page headers and footers are ignored', () => {
    expect(fixtureSums().rows).toBe(240);
    expect(lines).toHaveLength(240);
    for (const l of lines)
      expect(l.narration).not.toMatch(
        /system generated|LOAN PRODUCTS|Page No|Tran Id|For any queries/i,
      );
    expect(lines[0]).toMatchObject({
      date: '2026-08-02',
      time: '18:56:36',
      amountInr: 187.25,
      balanceInr: 5925.15,
    });
    expect(lines[2]).toMatchObject({
      narration: 'MAND DR-Insufficient Balance-Service Charges',
      amountInr: 531.3,
      lineKind: 'fee',
    });
    // Tran Id split over two lines ("SMB8D170" / "0") is not part of the remarks.
    expect(lines[3].narration).toBe('MAND DR-Insufficient Balance-Service Charges');
  });

  it('balance chain is consistent and debit/credit totals match the fixture', () => {
    for (let i = 1; i < lines.length; i++)
      expect(
        Math.abs(
          (lines[i - 1].balanceInr as number) -
            lines[i].amountInr -
            (lines[i].balanceInr as number),
        ),
      ).toBeLessThanOrEqual(0.02);
    const sums = fixtureSums();
    const debits = lines.filter((l) => l.amountInr > 0).reduce((s, l) => s + l.amountInr, 0);
    const credits = lines.filter((l) => l.amountInr < 0).reduce((s, l) => s - l.amountInr, 0);
    expect(Math.round(debits * 100) / 100).toBe(sums.debits);
    expect(Math.round(credits * 100) / 100).toBe(sums.credits);
    expect(lines.find((l) => /NEFT:PAYEE009/.test(l.narration))!.amountInr).toBe(-7080);
    expect(lines.find((l) => /NEFTO-PAYEE123/.test(l.narration))).toMatchObject({
      amountInr: 78846.91,
      narration: 'NEFTO-PAYEE123 FINANCE LIMITED 000000',
    });
  });

  it('merchant keys from joined remarks', () => {
    const key = (re: RegExp) =>
      statementMerchant(lines.find((l) => re.test(l.narration))!.narration).key;
    expect(key(/googleworkspa/)).toBe('google_workspace');
    expect(key(/gpay-utility/)).toBe('gpay_bills');
    expect(key(/gpay\.bp\.toll/)).toBe('gpay_bills');
    expect(key(/gpay-toll/)).toBe('gpay_bills');
    expect(key(/iruts/)).toBe('indian_railways');
    expect(key(/MYGATE/)).toBe('mygate');
    expect(key(/gpayrecharge/)).toBe('mobile_recharge');
    expect(key(/Lovable/)).toBe('lovable');
    expect(key(/BLINKIT/)).toBe('blinkit');
    expect(key(/META\/ICIC/)).toBe('facebook_ads');
    expect(key(/L AND T/)).toBe('lnt_finance_emi');
    expect(key(/FINANCE LIMITED/)).toBe('lnt_finance_emi');
    for (const [n, k] of [
      ['UPIAR/1 /DR/JIO Post/paytm', 'jio_postpaid'],
      ['APPLE MEDIA SERVICES', 'apple'],
      ['UPI-appleservic', 'apple'],
      ['UPIAR/1 /DR/SBI Card/sbicardp', 'sbi_card_bill'],
      ['L n T FI', 'lnt_finance_emi'],
      ['UPIAR/1 /DR/Meta Verified', 'meta_verified'],
    ])
      expect(statementMerchant(n).key).toBe(k);
    expect(railFor(lines[2])).toBe('bank_mandate');
  });

  it('recurring: Google Workspace monthly; bill payments and fees never; usage merchants classed', () => {
    const found = detectRecurring(lines);
    const by = Object.fromEntries(found.map((c) => [c.key, c]));
    expect(by.google_workspace).toMatchObject({
      cadence: 'monthly',
      kind: 'subscription',
      averageInr: 1185.5,
      occurrences: 4,
    });
    expect(by.gpay_bills.kind).toBe('usage_topup');
    expect(by.lnt_finance_emi).toBeUndefined();
    expect(found.some((c) => /mand|insufficient/i.test(c.key))).toBe(false);
    expect(found.some((c) => /^(sbin|hdfc|utib)$/.test(c.key))).toBe(false);
  });

  it('flags merchants billed on several payment methods (bank + card lines together)', () => {
    const card = [
      'sbi-card-a-2026-09.txt',
      'sbi-card-a-2026-10.txt',
      'sbi-card-a-2026-11.txt',
    ].flatMap((f) => parseStatementText(fx(f), 'card'));
    const by = Object.fromEntries(detectRecurring([...lines, ...card]).map((c) => [c.key, c]));
    expect(by.facebook_ads.severalPaymentMethods).toBe(true);
    expect(by.meta_verified).toMatchObject({ kind: 'unknown' });
    expect(by.google_workspace.severalPaymentMethods).toBeUndefined();
  });

  it('postpaid connections ≈ distinct amounts paid per month', () => {
    const L = (date: string, amountInr: number): StatementLine => ({
      date,
      narration: 'UPIAR/1 /DR/JIO Post/paytm',
      amountInr,
      source: 'bank',
    });
    const [c] = detectRecurring([
      L('2026-09-05', 399),
      L('2026-09-06', 599),
      L('2026-10-05', 399),
      L('2026-10-07', 599),
      L('2026-11-05', 399),
      L('2026-11-05', 599),
    ]);
    expect(c).toMatchObject({ key: 'jio_postpaid', connections: 2, kind: 'subscription' });
  });
});

describe('bank summary: failed auto-debits, morning balances, price steps', () => {
  const s = emptyIfNull(parseBankStatementSummary(UNION));

  it('counts failed auto-debit charges per month', () => {
    expect(s.bank).toBe('Union Bank of India');
    expect([s.periodFrom, s.periodTo]).toEqual(['2026-08-01', '2026-11-21']);
    expect(s.failedAutoDebits).toEqual([
      { month: '2026-08', count: 3, chargesInr: 1593.9 },
      { month: '2026-09', count: 2, chargesInr: 1062.6 },
      { month: '2026-10', count: 3, chargesInr: 1593.9 },
      { month: '2026-11', count: 4, chargesInr: 2125.2 },
    ]);
    // A prorated first Workspace month (₹56 → ₹867) is not a price rise.
    expect(s.priceSteps).toEqual([]);
  });

  it('incomeTiming: balance at 09:00 on the 3rd vs the EMIs', () => {
    const months = incomeTiming(parseStatementText(UNION, 'bank'), 3, 78846.91);
    expect(months.map((m) => [m.date, m.balanceInr])).toEqual([
      ['2026-08-03', 4800.4],
      ['2026-09-03', 951.96],
      ['2026-10-03', 941.38],
      ['2026-11-03', 3032.08],
    ]);
    expect(months[0].shortfallInr).toBe(74046.51);
    expect(incomeTiming(s, 3, 78846.91)).toEqual(months);
    expect(timingSentence(s, 3, 78846.91)).toBe(
      'On the 3rd your balance was ₹2,431 against ₹78,847 of EMIs in 4 of 4 months.',
    );
  });

  it('price_change from statement lines: stepped up ≥5% and stayed, no obligation needed', () => {
    const L = (date: string, amountInr: number): StatementLine => ({
      date,
      narration: 'UPI-APPLE MEDIA SERVICES',
      amountInr,
      source: 'bank',
    });
    const steps = priceSteps([
      L('2026-08-10', 999),
      L('2026-09-10', 999),
      L('2026-10-10', 1999),
      L('2026-11-10', 1999),
    ]);
    expect(steps).toEqual([
      { key: 'apple', label: 'Apple services', fromInr: 999, toInr: 1999, since: '2026-10' },
    ]);
    const data = {
      ...dataWith(),
      savings: { ...defaultSavingsState(), banks: [{ ...s, priceSteps: steps }] },
    };
    const m = computeMoves(data, catalogWith(), NOW).moves.find((x) => x.kind === 'price_change')!;
    expect(m).toMatchObject({
      id: 'price_change:statement:apple',
      title: 'Apple services went from ₹999 to ₹1,999 a month',
      monthlySavingInr: 1000,
      obligationIds: [],
    });
    expect(priceSteps([L('2026-08-10', 999), L('2026-09-10', 1999), L('2026-10-10', 999)])).toEqual(
      [],
    );
  });

  it('fee_leak: failed auto-debits alone', () => {
    const data = { ...dataWith(), savings: { ...defaultSavingsState(), banks: [s] } };
    const m = computeMoves(data, catalogWith(), NOW).moves.find((x) => x.kind === 'fee_leak')!;
    expect(m).toMatchObject({
      id: 'fee_leak:failed_debit:bank-union-bank-of-india',
      title: 'Your bank charged ₹6,376 for 12 failed auto-debits',
      monthlySavingInr: 1594,
    });
  });

  it('merged with the loan bounce move when loan summaries exist, with income timing', () => {
    const soa = emptyIfNull(parseLoanStatement(fx('ltf-home-loan-soa.txt')));
    const welcome = emptyIfNull(parseLoanStatement(fx('ltf-home-loan-welcome.txt')));
    const data = {
      ...dataWith(),
      savings: { ...defaultSavingsState(), banks: [s], loans: [welcome, soa] },
    };
    const moves = computeMoves(data, catalogWith(HOME_LOAN), NOW).moves.filter(
      (x) => x.kind === 'fee_leak',
    );
    expect(moves).toHaveLength(1);
    expect(moves[0].why).toBe(
      'EMI bounced 14 times in 12 months: ₹15,930 in bounce charges + ₹2,702 late interest. Your bank charged ₹6,376 for 12 failed auto-debits. On the 3rd your balance was ₹2,431 against ₹78,847 of EMIs in 4 of 4 months. Or ask the lender to move the EMI date nearer your income date.',
    );
    // (₹15,930 + ₹2,702.23) / 12 + ₹6,375.60 over 4 months
    expect(moves[0].monthlySavingInr).toBe(3147);
  });
});
