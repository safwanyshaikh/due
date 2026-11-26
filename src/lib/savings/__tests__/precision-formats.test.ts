/** Precision fixes (synthetic lines) and new formats (anonymised fixtures, amounts ×1.13). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataWith, mk } from '../../__tests__/helpers';
import {
  computeMoves,
  defaultSavingsState,
  detectRecurring,
  looksP2p,
  mentionsHolder,
  parseCardStatementSummary,
  parseJioFiberBill,
  parseJioPostpaidBill,
  parseLoanStatement,
  parseStatementText,
  parseUpiStatementSummary,
  railFor,
  recurringMoves,
  statementMerchant,
  type StatementLine,
} from '..';
import { emptyIfNull } from './fixtureHelpers';
import { catalogWith } from './testCatalog';

const fx = (n: string) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');
const NOW = '2026-11-24T05:00:00.000Z';
const L = (
  date: string,
  narration: string,
  amountInr: number,
  extra: Partial<StatementLine> = {},
): StatementLine => ({
  date,
  narration,
  amountInr,
  source: 'bank',
  ...extra,
});
const months = ['2026-08-05', '2026-09-05', '2026-10-05', '2026-11-05'];

describe('1. self transfers and person-to-person UPI', () => {
  it('holder name in full, truncated by the column, or as their own handle', () => {
    expect(mentionsHolder('UPI/CR/123/TEST USER/UBIN/x', 'TEST USER')).toBe(true);
    expect(mentionsHolder('UPI/DR/123/TEST USE/UBIN/x', 'TEST USER')).toBe(true);
    expect(mentionsHolder('UPI/DR/123/RAVI KUM/SBIN/x', 'RAVI KUMAR')).toBe(true);
    expect(mentionsHolder('UPI/DR/123/x/testuser99@okaxis', 'TEST USER')).toBe(true);
    expect(mentionsHolder('UPI/DR/123/TESTING CO/HDFC', 'TEST USER')).toBe(false);
  });

  it('Union Bank: the header name before "Union Bank of India" marks self transfers', () => {
    const text = `Statement of Account
RAHUL SHARMA   Union Bank of India
Date   Tran Id-1 Remarks   UTR Number   Instr. ID   Withdrawals   Deposits   Balance
${months
  .map(
    (d, i) => `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}
10:00:00
TX0000000 UPIAR/000000
/DR/RAHUL SHA
x/XXXX/xxxxxxxx
-   1,000.00   ${(10000 - (i + 1) * 1000).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
  )
  .join('\n')}`;
    const lines = parseStatementText(text, 'bank');
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.selfTransfer)).toBe(true);
    expect(detectRecurring(lines)).toEqual([]);
  });

  it('person payments are p2p, never subscriptions; regular ones need 3 months', () => {
    expect(looksP2p('UPI/DR/123/RAHUL K/YESB/9876543210@ybl/UPI')).toBe(true);
    expect(looksP2p('UPI/DR/123/Priya Nair/HDFC/priyanair@okhdfc/UPI')).toBe(true);
    expect(looksP2p('UPI/DR/123/ANAND STORES/YESB/paytmqr12@paytm/UPI')).toBe(false);
    expect(looksP2p('UPI/DR/123/Netflix/HDFC/x/Mand')).toBe(false);
    const two = ['2026-09-05', '2026-10-05'].map((d) =>
      L(d, 'UPI/DR/123/RAHUL K/YESB/9876543210@ybl/UPI', 5000, { lineKind: 'p2p' }),
    );
    expect(detectRecurring(two)).toEqual([]);
    const three = months
      .slice(0, 3)
      .map((d) => L(d, 'UPI/DR/123/RAHUL K/YESB/9876543210@ybl/UPI', 5000, { lineKind: 'p2p' }));
    expect(detectRecurring(three)).toMatchObject([
      { kind: 'regular_transfer', occurrences: 3, confidence: 'low' },
    ]);
    // parseStatementText marks them itself
    const text = `02/09/2026   02/09/2026   WDL TFR
UPI/DR/0000000/RAHUL K/YESB/9876543210@ybl/UPI
-   5,000.00   -   10,000.00
02/10/2026   02/10/2026   WDL TFR
UPI/DR/0000000/RAHUL K/YESB/9876543210@ybl/UPI
-   5,000.00   -   5,000.00
02/11/2026   02/11/2026   WDL TFR
UPI/DR/0000000/Netflix/HDFC/netflix@hdfc/Mand
-   649.00   -   4,351.00`;
    const ls = parseStatementText(text, 'bank');
    expect(ls.map((l) => l.lineKind)).toEqual(['p2p', 'p2p', 'purchase']);
  });
});

describe('2. small unknown merchants', () => {
  it('two charges of an unknown shop are dropped; 3+ in 3+ months within ±10% are kept', () => {
    expect(
      detectRecurring([
        L('2026-09-03', 'UPI/DR/1/FURNITURE HOUSE/YESB/x', 328),
        L('2026-10-03', 'UPI/DR/1/FURNITURE HOUSE/YESB/x', 328),
      ]),
    ).toEqual([]);
    const ok = detectRecurring(
      months.slice(0, 3).map((d, i) => L(d, 'POS ACME GYM', [1000, 1050, 980][i])),
    );
    expect(ok.map((c) => c.key)).toEqual(['acme gym']);
    expect(
      detectRecurring(
        months.slice(0, 3).map((d, i) => L(d, 'POS ACME GYM', [1000, 1200, 1000][i])),
      ),
    ).toEqual([]);
    // Known merchants keep the two-charge rule.
    expect(
      detectRecurring(
        ['2026-09-05', '2026-10-05'].map((d) => L(d, 'UPI/DR/1/Netflix/HDFC/x', 649)),
      )[0],
    ).toMatchObject({ key: 'netflix' });
  });
});

describe('3. rails on bank lines', () => {
  it.each([
    ['UPI/DR/1/Netflix/HDFC/netflix@hdfc/Mand', 'upi_autopay'],
    ['UPI/DR/1/YouTube/UTIB/youtube1.b/Exec', 'upi_autopay'],
    ['UPI/DR/1/PAYEE/HDFC/xxxx/Mont', 'upi_autopay'],
    ['UPI/DR/1/Google/x/YouT', 'upi_autopay'],
    ['UPI/DR/1/Amazon/x/Amaz', 'upi_autopay'],
    ['MAND DR-Insufficient Balance-Service Charges', 'bank_mandate'],
    ['NACH DR TP ACH BAJAJ', 'bank_mandate'],
    ['POS 1234 SHOPPERS', 'debit_card'],
  ])('%s → %s', (narration, rail) => expect(railFor({ narration, source: 'bank' })).toBe(rail));
  it('card lines stay credit_card', () =>
    expect(railFor({ narration: 'NETFLIX.COM', source: 'card' })).toBe('credit_card'));
});

describe('4. labels and aliases', () => {
  it.each([
    ['UPI/DR/1/Openai/UTIB/openaillc.cfp/Mand', 'openai', 'OpenAI (ChatGPT)'],
    ['UPI/DR/1/CHATGPT SUBSCRIPTION', 'openai', 'OpenAI (ChatGPT)'],
    ['UPI/DR/1/LinkedIn/ICIC/linkedin.pay', 'linkedin', 'LinkedIn'],
    ['UPI/DR/1/JioHotstar/YESB/hotstaronl/Su', 'jiohotstar', 'JioHotstar'],
    ['UPI/DR/1/Netflix/HDFC/netflix@hdfc', 'netflix', 'Netflix'],
    ['UPI/DR/1/Google/UTIB/youtube1.b/Mand', 'youtube_premium', 'YouTube Premium'],
    ['UPI/DR/1/Google/UTIB/playstore@axis/Mand', 'google_play', 'Google Play'],
    ['UPI/DR/1/APPLE/HDFC/appleservi/Mont', 'apple', 'Apple services'],
    ['UPI/DR/1/MYGATE/HDFC/myga', 'mygate', 'MyGate (society maintenance)'],
  ])('%s → %s', (n, key, label) => expect(statementMerchant(n)).toEqual({ key, label }));
  it('IKEA: handle fragments and repeated words are dropped', () => {
    expect(statementMerchant('UPI/DR/1/Ikea/HDFC/ikeaindiapv.tlt').label).toBe('Ikea');
  });
  it('Amazon over UPI is "possibly Prime" only at Prime amounts', () => {
    expect(statementMerchant('UPI/DR/1/Amazon/YESB/amazonupi@apl', 1499)).toEqual({
      key: 'amazon_prime',
      label: 'Amazon (possibly Prime)',
    });
    expect(statementMerchant('UPI/DR/1/Amazon/YESB/amazonupi@apl', 299)).toMatchObject({
      key: 'amazon_prime',
    });
    expect(statementMerchant('UPI/DR/1/Amazon/YESB/amazonupi@apl', 2345)).toMatchObject({
      key: 'amazon',
    });
  });
  it('MyGate recurs as a bill, not a subscription to cancel', () => {
    const [c] = detectRecurring(
      months.slice(0, 3).map((d) => L(d, 'UPI/DR/1/MYGATE/HDFC/myga', 5711.71)),
    );
    expect(c).toMatchObject({ key: 'mygate', kind: 'bill' });
  });
});

describe('5–6. statement-only overlaps', () => {
  const sub = (key: string, label: string, averageInr: number, extra = {}) => ({
    key,
    label,
    rail: 'upi_autopay' as const,
    cadence: 'monthly' as const,
    averageInr,
    lastDate: '2026-11-05',
    nextExpected: '2026-12-05',
    occurrences: 3,
    confidence: 'high' as const,
    lineIndexes: [],
    kind: 'subscription' as const,
    ...extra,
  });
  it('Jio Postpaid next to Netflix and JioHotstar paid separately', () => {
    const [m] = recurringMoves([
      sub('jio_postpaid', 'JIO Postpaid', 1242.73),
      sub('netflix', 'Netflix', 649),
      sub('jiohotstar', 'JioHotstar', 299),
    ]);
    expect(m).toMatchObject({
      id: 'overlap:statement:jio_postpaid',
      kind: 'overlap',
      title: 'Check if your Jio Postpaid plan already includes Netflix, Prime or JioHotstar',
      confidence: 'low',
      unverifiedPrice: true,
      monthlySavingInr: 948,
    });
    expect(m.why).toContain('Netflix ₹649, JioHotstar ₹299');
    expect(
      recurringMoves([
        sub('airtel_postpaid', 'Airtel postpaid', 999),
        sub('netflix', 'Netflix', 649),
      ])[0].title,
    ).toMatch(/^Check if your Airtel plan/);
    expect(recurringMoves([sub('netflix', 'Netflix', 649)])).toEqual([]);
  });
  it('one merchant billed as two plans across two bank statements', () => {
    const lines = [
      ...months.slice(0, 3).map((d) => L(d, 'UPIAR/1 /DR/APPLE MEDIA SERVICES/appleservi', 1999)),
      ...months
        .slice(0, 3)
        .map((d) => L(d.replace('-05', '-12'), 'WDL TFR UPI/DR/1/APPLE/HDFC/appleservi/Mont', 195)),
    ];
    const cands = detectRecurring(lines).filter((c) => c.key === 'apple');
    expect(cands.map((c) => c.averageInr)).toEqual([1999, 195]);
    const [m] = recurringMoves(cands);
    expect(m).toMatchObject({
      id: 'overlap:statement:apple:twice',
      title:
        'Apple services is billed twice: ₹1,999 and ₹195 a month — two plans or two Apple IDs?',
      monthlySavingInr: 195,
      confidence: 'low',
    });
  });
});

describe('A. Jio Postpaid bill', () => {
  const bill = emptyIfNull(parseJioPostpaidBill(fx('jio-postpaid-bill.txt')));
  it('reads plan, rental, taxes, total, due date and bill period', () => {
    expect(bill).toEqual({
      provider: 'Jio',
      service: 'postpaid',
      planName: '399 - Prime',
      baseRentalInr: 451.88,
      addOns: [],
      usageChargesInr: 0,
      taxesInr: 157.38,
      totalPayableInr: 1031.62,
      dueDate: '2026-10-16',
      periodFrom: '2026-09-07',
      periodTo: '2026-10-06',
      dataUsedGb: null,
      planDataGb: null,
      includes: [],
      ottAppCount: null,
    });
  });
  it('family usage and add-ons when printed → downsize hint and add-on line items', () => {
    const text = `${fx('jio-postpaid-bill.txt')}\nAdd-on Child   Rs 99.00\nShared data: 9.2 GB used of 75 GB`;
    const b = emptyIfNull(parseJioPostpaidBill(text));
    expect(b).toMatchObject({
      dataUsedGb: 9.2,
      planDataGb: 75,
      addOns: [{ label: 'Add-on Child', amountInr: 99 }],
    });
    const data = { ...dataWith(), savings: { ...defaultSavingsState(), telecom: [b] } };
    const moves = computeMoves(data, catalogWith(), NOW).moves;
    expect(moves.find((m) => m.id === 'period_switch:telecom:jio-postpaid')).toMatchObject({
      title: 'You use about 9 GB of 75 GB: a smaller plan may do',
      monthlySavingInr: 0,
      severity: 'info',
      confidence: 'low',
    });
    expect(moves.find((m) => m.id === 'fee_leak:addon:jio-postpaid:add-on-child')).toMatchObject({
      title: 'Add-on Child: ₹99 a month on your Jio Postpaid bill',
    });
  });
});

describe('B. JioFiber bill', () => {
  const bill = emptyIfNull(parseJioFiberBill(fx('jio-fiber-bill.txt')));
  it('reads plan, OTT bundle, total, due date and cycle', () => {
    expect(bill).toMatchObject({
      service: 'fiber',
      planName: '399+200(13 OTT)',
      ottAppCount: 13,
      includes: ['13 paid OTT apps (list not printed)'],
      baseRentalInr: 640.68,
      taxesInr: 115.32,
      totalPayableInr: 756,
      dueDate: '2026-11-12',
      periodFrom: '2026-11-03',
      periodTo: '2026-12-02',
    });
    expect(parseJioPostpaidBill(fx('jio-fiber-bill.txt'))).toBeNull();
  });
  it('OTT paid separately → check before renewing', () => {
    const hs = mk({
      id: 'hs',
      type: 'subscription',
      provider: 'JioHotstar',
      amountPaise: 29_900,
      frequency: 'monthly',
      nextDue: '2026-12-01',
    });
    const data = { ...dataWith(hs), savings: { ...defaultSavingsState(), telecom: [bill] } };
    const m = computeMoves(data, catalogWith(), NOW).moves.find(
      (x) => x.id === 'overlap:telecom:jio-fiber:jiohotstar',
    )!;
    expect(m).toMatchObject({
      title:
        'Your JioFiber plan includes OTT apps; check whether JioHotstar is one of them before renewing it',
      monthlySavingInr: 299,
      confidence: 'low',
      unverifiedPrice: true,
    });
    expect(m.why).toContain('13 paid OTT apps (list not printed)');
  });
});

describe('C. Google Pay statement', () => {
  const lines = parseStatementText(fx('gpay-statement.txt'), 'bank');
  it('reads rows (the cut-off last row is skipped) with kinds and payment source', () => {
    expect(lines).toHaveLength(132);
    expect(lines[0]).toMatchObject({
      date: '2026-05-01',
      time: '06:46:00',
      narration: 'Paid to DARGAH HOTEL',
      amountInr: 118.65,
      source: 'card',
      paidBy: 'State Bank of India 0000 | RuPay credit card',
    });
    expect(lines.filter((l) => l.lineKind === 'wallet_topup')).toHaveLength(4);
    expect(lines.filter((l) => l.selfTransfer).map((l) => l.narration)).toEqual([
      'Self transfer to PERSON 005',
    ]);
    expect(lines.filter((l) => l.amountInr < 0).map((l) => l.narration)).toEqual([
      'Received from Google Cloud',
      'Received from PERSON 038',
    ]);
    expect(lines.filter((l) => l.lineKind === 'p2p').length).toBeGreaterThan(50);
  });
  it('summary: UPI spends on the credit card', () => {
    expect(parseUpiStatementSummary(fx('gpay-statement.txt'))).toMatchObject({
      app: 'Google Pay',
      periodFrom: '2026-05-01',
      periodTo: '2026-10-31',
      creditCardSpend: [
        {
          paidBy: 'State Bank of India 0000 | RuPay credit card',
          last4: '0000',
          totalInr: 15040.59,
          months: 1,
        },
      ],
    });
  });
  it('card carrying a balance + UPI on that card → interest from day one', () => {
    const card = emptyIfNull(parseCardStatementSummary(fx('sbi-card-a-2026-11.txt')));
    const upi = emptyIfNull(parseUpiStatementSummary(fx('gpay-statement.txt')));
    const data = {
      ...dataWith(),
      savings: { ...defaultSavingsState(), statements: [card], upi: [upi] },
    };
    const m = computeMoves(data, catalogWith(), NOW).moves.find((x) =>
      x.id.startsWith('fee_leak:upi_credit'),
    )!;
    expect(m).toMatchObject({
      title:
        'Paying daily UPI with card ending 0000 while it carries a balance: these start costing ~3.75%/month at once',
      monthlySavingInr: 564,
      confidence: 'low',
      kind: 'fee_leak',
    });
  });
});

describe('D. SBI Gold Loan OD', () => {
  const g = emptyIfNull(parseLoanStatement(fx('sbi-gold-loan-od.txt')));
  it('reads limit, outstanding, rate, interest debits, penal charges, irregularities', () => {
    expect(g).toMatchObject({
      productKind: 'gold_loan_od',
      product: 'Gold Loan OD',
      limitInr: 960000,
      outstandingInr: 812584.01,
      annualRatePct: 9.7,
      penalChargesInr: 168.32,
      irregularityCount: 3,
      statementDate: '2026-11-24',
      disbursementDate: '2026-03-12',
    });
    expect(g.monthlyInterest).toEqual([
      { month: '2026-03', amountInr: 3912.4 },
      { month: '2026-04', amountInr: 7456.18 },
      { month: '2026-05', amountInr: 7702.33 },
      { month: '2026-06', amountInr: 7515.06 },
      { month: '2026-07', amountInr: 7598.71 },
      { month: '2026-08', amountInr: 7487.92 },
      { month: '2026-09', amountInr: 7390.44 },
      { month: '2026-10', amountInr: 7611.85 },
    ]);
    expect(g.irregularities).toEqual([
      { date: '2026-07-07', amountInr: 7210.45, label: 'SMA REC' },
      { date: '2026-07-23', amountInr: 17330.6, label: 'SMA REC' },
      { date: '2026-10-07', amountInr: 24118.9, label: 'Irregularity Recovery' },
    ]);
  });
  it('urgent alert for a recent irregularity; card-vs-gold information move', () => {
    const card = emptyIfNull(parseCardStatementSummary(fx('sbi-card-b-2026-09.txt')));
    const data = {
      ...dataWith(),
      savings: { ...defaultSavingsState(), loans: [g], statements: [card] },
    };
    const { moves } = computeMoves(data, catalogWith(), NOW);
    expect(moves[0]).toMatchObject({
      severity: 'urgent',
      title: 'Your gold loan OD went irregular recently',
    });
    expect(moves[0].why).toContain('₹24,119 as Irregularity Recovery on 7 Oct 2026');
    const x = moves.find((m) => m.id.startsWith('debt_rate:gold-loan'))!;
    expect(x).toMatchObject({
      title:
        'Card debt costs ~45%/yr, your gold loan ~9.7%: ask your bank whether a gold revaluation can raise the drawing power to clear the card',
      // card finance charge ₹13,244.58 − ₹3,52,153.20 × 9.7% / 12
      monthlySavingInr: 10398,
      confidence: 'low',
      effort: 'paperwork',
      legalNote: "Information only. Check your bank's own offer.",
    });
    // Older irregularities only: no alert.
    const old = { ...g, irregularities: g.irregularities!.slice(0, 2) };
    const quiet = computeMoves(
      { ...data, savings: { ...data.savings, loans: [old] } },
      catalogWith(),
      NOW,
    ).moves;
    expect(quiet.some((m) => m.severity === 'urgent')).toBe(false);
  });
});
