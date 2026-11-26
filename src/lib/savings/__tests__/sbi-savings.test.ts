/** Regression tests on a synthetic State Bank of India savings statement (scripts/generate-statement-fixtures.mjs). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataWith } from '../../__tests__/helpers';
import {
  computeMoves,
  defaultSavingsState,
  detectRecurring,
  holderName,
  parseBankStatementSummary,
  parseStatementText,
  rankMoves,
  statementMerchant,
} from '..';
import { emptyIfNull } from './fixtureHelpers';
import { catalogWith } from './testCatalog';

const TEXT = readFileSync(join(__dirname, 'fixtures', 'sbi-savings.txt'), 'utf8');
const NOW = '2026-08-03T05:00:00.000Z';
const lines = parseStatementText(TEXT, 'bank');

describe('SBI savings statement (two dates, separate debit/credit columns)', () => {
  it('reads 138 rows across page breaks; the balance chain is consistent', () => {
    expect(lines).toHaveLength(138);
    for (let i = 1; i < lines.length; i++)
      expect(
        Math.abs(
          (lines[i - 1].balanceInr as number) -
            lines[i].amountInr -
            (lines[i].balanceInr as number),
        ),
      ).toBeLessThanOrEqual(0.02);
    expect(lines[0]).toMatchObject({ date: '2026-06-02', amountInr: -2000, balanceInr: 11418.36 });
    // "6101   -   -   18,350.00   18,821.64": a ref fragment before the columns, a credit.
    expect(lines.find((l) => l.balanceInr === 18821.64)).toMatchObject({
      amountInr: -18350,
      narration: 'CSH DEP (CDM) 0000000',
    });
    expect(lines.find((l) => l.balanceInr === 33881.64)!.narration).toBe(
      'CASH DEPOSIT SELF AT 00999 DEMOBR',
    );
    for (const l of lines) expect(l.narration).not.toMatch(/Page no|^Balance/);
  });

  it('matches the printed statement summary (95 debits, 43 credits)', () => {
    const dr = lines.filter((l) => l.amountInr > 0);
    const cr = lines.filter((l) => l.amountInr < 0);
    expect([dr.length, cr.length]).toEqual([95, 43]);
    expect(Math.abs(dr.reduce((s, l) => s + l.amountInr, 0) - 170461.5)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(cr.reduce((s, l) => s - l.amountInr, 0) - 205582.11)).toBeLessThanOrEqual(0.02);
    expect(lines[lines.length - 1].balanceInr).toBe(44538.97);
  });

  it('kinds: UPI Lite top-ups, loan repayments/SMA recoveries, LIC credit, own-account transfers', () => {
    expect(holderName(TEXT)).toBe('DEMO CUSTOMER');
    expect(lines.filter((l) => l.lineKind === 'wallet_topup')).toHaveLength(22);
    expect(lines.filter((l) => l.lineKind === 'loan_repayment').map((l) => l.amountInr)).toEqual([
      6650.85, 9800, 9800, 20855.82,
    ]);
    expect(lines.filter((l) => l.lineKind === 'loan_repayment').some((l) => l.selfTransfer)).toBe(
      false,
    );
    const self = lines.filter((l) => l.selfTransfer);
    expect(self).toHaveLength(32);
    expect(self.every((l) => /DEMO CUSTOMER/.test(l.narration))).toBe(true);
    const lic = lines.find((l) => /LIFE INSURANCE/.test(l.narration))!;
    expect(lic.amountInr).toBe(-487.65);
    expect(statementMerchant(lic.narration).key).toBe('lic');
    expect(
      statementMerchant(
        'WDL TFR UPI/DR/0000000/SBI Card/KKBK/sbicardp.b/Pay 0000000 AT 00999 DEMOBR',
      ).key,
    ).toBe('sbi_card_bill');
    expect(
      statementMerchant(
        'WDL TFR UPI/DR/0000000/JIO Post/YESB/paytm-0000/UPI 0000000 AT 00999 DEMOBR',
      ).key,
    ).toBe('jio_postpaid');
  });

  it('recurring never includes UPI Lite, own transfers, card bills or loan repayments', () => {
    const keys = detectRecurring(lines).map((c) => c.key);
    expect(keys).not.toContain('upilite');
    expect(keys.some((k) => k.startsWith('demo customer'))).toBe(false);
    expect(keys).not.toContain('sbi_card_bill');
    expect(keys.some((k) => /sma|loan/.test(k))).toBe(false);
  });

  it('SMA recovery → an urgent alert ranked first', () => {
    const s = emptyIfNull(parseBankStatementSummary(TEXT));
    expect(s).toMatchObject({
      bank: 'State Bank of India',
      periodFrom: '2026-06-01',
      periodTo: '2026-07-31',
    });
    expect(s.smaSweeps).toEqual([
      { date: '2026-06-05', amountInr: 6650.85 },
      { date: '2026-06-23', amountInr: 20855.82 },
    ]);
    const data = { ...dataWith(), savings: { ...defaultSavingsState(), banks: [s] } };
    const { moves } = computeMoves(data, catalogWith(), NOW);
    expect(moves[0]).toMatchObject({
      id: 'fee_leak:sma:bank-state-bank-of-india',
      severity: 'urgent',
      title: 'A loan or overdraft is overdue (SMA)',
      why: 'Your bank swept ₹27,507 to an overdue account in Jun 2026. SMA status is reported to credit bureaus and blocks cheaper loans.',
      monthlySavingInr: 0,
    });
    const big = {
      ...moves[0],
      id: 'x',
      severity: undefined,
      monthlySavingInr: 99999,
      confidence: 'high' as const,
    };
    expect(rankMoves([big, moves[0]])[0].id).toBe(moves[0].id);
  });
});
