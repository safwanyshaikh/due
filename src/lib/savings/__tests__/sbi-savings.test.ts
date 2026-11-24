/** Regression tests on an anonymised State Bank of India savings statement (amounts ×1.13). */
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
const NOW = '2026-09-04T05:00:00.000Z';
const lines = parseStatementText(TEXT, 'bank');

describe('SBI savings statement (two dates, separate debit/credit columns)', () => {
  it('reads 113 rows across page breaks; the balance chain is consistent', () => {
    expect(lines).toHaveLength(113);
    for (let i = 1; i < lines.length; i++)
      expect(
        Math.abs(
          (lines[i - 1].balanceInr as number) -
            lines[i].amountInr -
            (lines[i].balanceInr as number),
        ),
      ).toBeLessThanOrEqual(0.02);
    expect(lines[0]).toMatchObject({ date: '2026-07-02', amountInr: 472.32, balanceInr: 11254.43 });
    // "6373   -   -   55,935.00   57,245.43": a ref fragment before the columns, a credit.
    expect(lines.find((l) => l.balanceInr === 57245.43)).toMatchObject({
      amountInr: -55935,
      narration: 'CSH DEP (CDM) 0000000',
    });
    expect(lines.find((l) => l.balanceInr === 95665.43)!.narration).toBe(
      'CASH DEPOSIT SELF AT 00343 TESTBR',
    );
    for (const l of lines) expect(l.narration).not.toMatch(/Page no|^Balance/);
  });

  it('matches the printed statement summary (79 debits, 34 credits; ±₹0.02 from scaling)', () => {
    const dr = lines.filter((l) => l.amountInr > 0);
    const cr = lines.filter((l) => l.amountInr < 0);
    expect([dr.length, cr.length]).toEqual([79, 34]);
    expect(Math.abs(dr.reduce((s, l) => s + l.amountInr, 0) - 346111.55)).toBeLessThanOrEqual(0.02);
    expect(Math.abs(cr.reduce((s, l) => s - l.amountInr, 0) - 334664.53)).toBeLessThanOrEqual(0.02);
    expect(lines[lines.length - 1].balanceInr).toBe(279.72);
  });

  it('kinds: UPI Lite top-ups, loan repayments/SMA recoveries, LIC credit, own-account transfers', () => {
    expect(holderName(TEXT)).toBe('TEST USER');
    expect(lines.filter((l) => l.lineKind === 'wallet_topup')).toHaveLength(22);
    expect(lines.filter((l) => l.lineKind === 'loan_repayment').map((l) => l.amountInr)).toEqual([
      8655.8, 11300, 11300, 20547.92,
    ]);
    expect(lines.filter((l) => l.lineKind === 'loan_repayment').some((l) => l.selfTransfer)).toBe(
      false,
    );
    const self = lines.filter((l) => l.selfTransfer);
    expect(self).toHaveLength(29);
    expect(self.every((l) => /TEST USER/.test(l.narration))).toBe(true);
    const lic = lines.find((l) => /LIFE INSURANCE/.test(l.narration))!;
    expect(lic.amountInr).toBe(-542.4);
    expect(statementMerchant(lic.narration).key).toBe('lic');
    expect(
      statementMerchant(
        'WDL TFR UPI/DR/0000000/SBI Card/KKBK/sbicardp.b/Pay 0000000 AT 00343 TESTBR',
      ).key,
    ).toBe('sbi_card_bill');
    expect(
      statementMerchant(
        'WDL TFR UPI/DR/0000000/JIO Post/YESB/paytm-5381/UPI 0000000 AT 00343 TESTBR',
      ).key,
    ).toBe('jio_postpaid');
  });

  it('recurring never includes UPI Lite, own transfers, card bills or loan repayments', () => {
    const keys = detectRecurring(lines).map((c) => c.key);
    expect(keys).not.toContain('upilite');
    expect(keys.some((k) => k.startsWith('test user'))).toBe(false);
    expect(keys).not.toContain('sbi_card_bill');
    expect(keys.some((k) => /sma|loan/.test(k))).toBe(false);
  });

  it('SMA recovery → an urgent alert ranked first', () => {
    const s = emptyIfNull(parseBankStatementSummary(TEXT));
    expect(s).toMatchObject({
      bank: 'State Bank of India',
      periodFrom: '2026-07-01',
      periodTo: '2026-08-31',
    });
    expect(s.smaSweeps).toEqual([
      { date: '2026-07-06', amountInr: 8655.8 },
      { date: '2026-07-24', amountInr: 20547.92 },
    ]);
    const data = { ...dataWith(), savings: { ...defaultSavingsState(), banks: [s] } };
    const { moves } = computeMoves(data, catalogWith(), NOW);
    expect(moves[0]).toMatchObject({
      id: 'fee_leak:sma:bank-state-bank-of-india',
      severity: 'urgent',
      title: 'A loan or overdraft is overdue (SMA)',
      why: 'Your bank swept ₹29,204 to an overdue account in Jul 2026. SMA status is reported to credit bureaus and blocks cheaper loans.',
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
