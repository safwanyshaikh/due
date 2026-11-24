import { describe, expect, it } from 'vitest';
import { parseStatementText } from '../statement';
import { detectRecurring, railFor, statementMerchant } from '../recurring';

const BANK_TEXT = `
HDFC BANK LTD  Statement of account
Date       Narration                                        Chq./Ref.No.   Value Dt   Withdrawal Amt.  Deposit Amt.  Closing Balance
05/08/26   UPI-AUTOPAY-NETFLIX.COM-412345678901-netflix@hdfcbank  0000412345678901  05/08/26  649.00   1,20,000.00
01/08/26   SALARY AUG ACME PVT LTD                                                   01/08/26  85,000.00  1,20,649.00
05/09/26   UPI-AUTOPAY-NETFLIX.COM-412345678902-netflix@hdfcbank  0000412345678902  05/09/26  649.00   1,04,351.00
07/09/26   NACH DR TP ACH BAJAJ FINANCE LTD-HDFC0000123456                            07/09/26  12,500.00  91,851.00
05/10/26   UPI-AUTOPAY-NETFLIX.COM-412345678903-netflix@hdfcbank  0000412345678903  05/10/26  649.00   90,202.00
07/10/26   NACH DR TP ACH BAJAJ FINANCE LTD-HDFC0000123456                            07/10/26  12,500.00  77,702.00
12/10/26   UPI/412399999999/SWIGGY/swiggy@icici/Food                                  12/10/26  412.00   77,290.00
15/10/26   UPI/412399999998/SWIGGY/swiggy@icici/Food                                  15/10/26  238.00   77,052.00
07/11/26   NACH DR TP ACH BAJAJ FINANCE LTD-HDFC0000123456                            07/11/26  12,500.00  64,552.00
`;

describe('parseStatementText', () => {
  it('reads an HDFC-style table: dd/mm/yy dates, value date, withdrawal then balance', () => {
    const lines = parseStatementText(BANK_TEXT, 'bank');
    expect(lines).toHaveLength(9);
    expect(lines[0]).toEqual({
      date: '2026-08-05',
      narration: 'UPI-AUTOPAY-NETFLIX.COM-412345678901-netflix@hdfcbank 0000412345678901',
      amountInr: 649,
      source: 'bank',
    });
    expect(lines[3].amountInr).toBe(12500);
  });

  it('never reads long reference numbers as money', () => {
    const lines = parseStatementText(BANK_TEXT, 'bank');
    expect(lines.every((l) => l.amountInr < 100_000)).toBe(true);
  });

  it('marks salary and refunds as credits (negative)', () => {
    const lines = parseStatementText(BANK_TEXT, 'bank');
    expect(lines.find((l) => /SALARY/.test(l.narration))!.amountInr).toBe(-85000);
    const r = parseStatementText('03/11/2026 REFUND AMAZON 499.00', 'card');
    expect(r[0].amountInr).toBe(-499);
  });

  it('reads dd-Mon-yy, ₹ amounts and Dr/Cr markers', () => {
    const t = `05-Nov-26 SPOTIFY INDIA MUMBAI ₹119.00 Dr
06-Nov-26 PAYMENT RECEIVED THANK YOU ₹12,000.00 Cr
07 Nov 2026 AMAZON PRIME ₹1,499.00`;
    expect(parseStatementText(t, 'card')).toEqual([
      { date: '2026-11-05', narration: 'SPOTIFY INDIA MUMBAI', amountInr: 119, source: 'card' },
      {
        date: '2026-11-06',
        narration: 'PAYMENT RECEIVED THANK YOU',
        amountInr: -12000,
        source: 'card',
      },
      { date: '2026-11-07', narration: 'AMAZON PRIME', amountInr: 1499, source: 'card' },
    ]);
  });

  it('joins wrapped narration lines from PDF text', () => {
    const t = `05/11/2026 UPI-AUTOPAY-JIO HOTSTAR 299.00
JIOHOTSTAR PREMIUM
06/11/2026 ACH D- TP ACH ICICI PRUDENTIAL 5,000.00 Dr`;
    const lines = parseStatementText(t, 'bank');
    expect(lines[0].narration).toBe('UPI-AUTOPAY-JIO HOTSTAR JIOHOTSTAR PREMIUM');
    expect(lines[1]).toMatchObject({ date: '2026-11-06', amountInr: 5000 });
  });

  it('reads CSV with separate debit and credit columns', () => {
    const csv = `Txn Date,Value Date,Description,Ref No./Cheque No.,Debit,Credit,Balance
05-11-2026,05-11-2026,"UPI-AUTOPAY-SPOTIFY","4123","119.00","","10,000.00"
06-11-2026,06-11-2026,"NEFT CR SALARY","","","50,000.00","60,000.00"
`;
    expect(parseStatementText(csv, 'bank')).toEqual([
      { date: '2026-11-05', narration: 'UPI-AUTOPAY-SPOTIFY', amountInr: 119, source: 'bank' },
      { date: '2026-11-06', narration: 'NEFT CR SALARY', amountInr: -50000, source: 'bank' },
    ]);
  });

  it('reads CSV with an amount + Dr/Cr column', () => {
    const csv = `Date,Transaction Details,Amount,Dr/Cr
2026-10-03,NETFLIX.COM,"₹649.00",Dr
2026-10-04,CASHBACK,"₹50.00",Cr`;
    const lines = parseStatementText(csv, 'card');
    expect(lines.map((l) => l.amountInr)).toEqual([649, -50]);
    expect(lines[0].date).toBe('2026-10-03');
  });

  it('returns nothing for empty or unreadable text', () => {
    expect(parseStatementText('', 'bank')).toEqual([]);
    expect(parseStatementText('hello\nworld', 'bank')).toEqual([]);
  });
});

describe('rails and merchants', () => {
  it.each([
    ['UPI-AUTOPAY-NETFLIX', 'bank', 'upi_autopay'],
    ['UPI MANDATE SPOTIFY', 'bank', 'upi_autopay'],
    ['AUTOPAY SI JIO', 'bank', 'upi_autopay'],
    ['NACH DR TP ACH BAJAJ FINANCE', 'bank', 'bank_mandate'],
    ['ACH D- TP ACH ICICI PRU', 'bank', 'bank_mandate'],
    ['ECS LIC OF INDIA', 'bank', 'bank_mandate'],
    ['SI-HDFC LIFE', 'bank', 'bank_mandate'],
    ['NETFLIX.COM', 'card', 'credit_card'],
    ['POS 4111XXXX SHOPPERS STOP', 'bank', 'debit_card'],
    ['CASH WITHDRAWAL', 'bank', 'unknown'],
  ] as const)('%s → %s', (narration, source, rail) => {
    expect(railFor({ narration, source })).toBe(rail);
  });

  it('cleans narrations to a merchant key', () => {
    expect(statementMerchant('UPI-AUTOPAY-NETFLIX.COM-412345678901-netflix@hdfcbank').key).toBe(
      'netflix',
    );
    expect(statementMerchant('NACH DR TP ACH BAJAJ FINANCE LTD-HDFC0000123456')).toEqual({
      key: 'bajaj finance',
      label: 'Bajaj Finance',
    });
  });
});

describe('detectRecurring', () => {
  it('finds monthly UPI AutoPay and NACH mandates on realistic statement text', () => {
    const lines = parseStatementText(BANK_TEXT, 'bank');
    const found = detectRecurring(lines);
    expect(found.map((c) => [c.key, c.rail, c.cadence, c.occurrences, c.confidence])).toEqual([
      ['bajaj finance', 'bank_mandate', 'monthly', 3, 'high'],
      ['netflix', 'upi_autopay', 'monthly', 3, 'high'],
    ]);
    const nf = found.find((c) => c.key === 'netflix')!;
    expect(nf).toMatchObject({
      label: 'Netflix',
      averageInr: 649,
      lastDate: '2026-10-05',
      nextExpected: '2026-11-05',
    });
    expect(nf.lineIndexes).toEqual([0, 2, 4]);
  });

  it('ignores irregular spends (Swiggy orders) and credits', () => {
    const found = detectRecurring(parseStatementText(BANK_TEXT, 'bank'));
    expect(found.some((c) => c.key.includes('swiggy') || c.key.includes('salary'))).toBe(false);
  });

  it('two charges = medium; quarterly and yearly cadences; ±15% amount tolerance', () => {
    const L = (date: string, narration: string, amountInr: number) => ({
      date,
      narration,
      amountInr,
      source: 'card' as const,
    });
    const found = detectRecurring([
      L('2026-03-10', 'GOOGLE ONE', 130),
      L('2026-06-09', 'GOOGLE ONE', 130),
      L('2026-09-08', 'GOOGLE ONE', 140),
      L('2025-11-01', 'AMAZON PRIME', 1499),
      L('2026-11-01', 'AMAZON PRIME', 1499),
      L('2026-09-01', 'SPOTIFY', 119),
      L('2026-10-01', 'SPOTIFY', 119),
      L('2026-08-01', 'ACME GYM', 1000),
      L('2026-09-01', 'ACME GYM', 1500),
    ]);
    const by = Object.fromEntries(found.map((c) => [c.key, c]));
    expect(by.google_one).toMatchObject({
      cadence: 'quarterly',
      occurrences: 3,
      confidence: 'high',
      rail: 'credit_card',
    });
    expect(by.amazon_prime).toMatchObject({ cadence: 'yearly', nextExpected: '2027-11-01' });
    expect(by.spotify).toMatchObject({ cadence: 'monthly', confidence: 'medium' });
    expect(by['acme gym']).toBeUndefined();
  });
});
