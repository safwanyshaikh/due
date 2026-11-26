/**
 * Regression tests on statement text. Every fixture is fully synthetic (scripts/generate-statement-fixtures.mjs).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataWith } from '../../__tests__/helpers';
import {
  addCardBill,
  addLoanEmi,
  bouncesIn12Months,
  computeMoves,
  defaultSavingsState,
  detectRecurring,
  emptyIfNull,
  parseCardStatementSummary,
  parseLoanStatement,
  parseStatementText,
  statementMerchant,
  BOUNCE_TRANSFER_NOTE,
} from './fixtureHelpers';
import { emi } from '../engine';
import type { AppData } from '../../types';
import { CARD_BT, HOME_LOAN, catalogWith } from './testCatalog';

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const A09 = fx('sbi-card-a-2026-09.txt');
const A10 = fx('sbi-card-a-2026-10.txt');
const A11 = fx('sbi-card-a-2026-11.txt');
const B09 = fx('sbi-card-b-2026-09.txt');
const SOA = fx('ltf-home-loan-soa.txt');
const WELCOME = fx('ltf-home-loan-welcome.txt');
const NOW = '2026-11-24T05:00:00.000Z';

const find = (lines: ReturnType<typeof parseStatementText>, re: RegExp) =>
  lines.filter((l) => re.test(l.narration));

describe('SBI Card statement lines', () => {
  const b = parseStatementText(B09, 'card');

  it('1. amount is the last money value before C/D, never the "(EXCL TAX …)" figure', () => {
    expect(find(b, /FIN CHARGE/)[0]).toMatchObject({
      amountInr: 14310.62,
      taxInr: 2575.91,
      lineKind: 'interest',
    });
    expect(find(b, /LATE PAYMENT/)[0]).toMatchObject({
      amountInr: 1180,
      taxInr: 212.4,
      lineKind: 'fee',
    });
    expect(find(b, /ANNUAL FEE/)[0]).toMatchObject({
      amountInr: -3399,
      taxInr: 611.82,
      lineKind: 'reversal',
    });
  });

  it('2. foreign-currency lines keep the INR amount; USD is metadata', () => {
    expect(find(b, /ANTHROPIC/)[0]).toMatchObject({
      amountInr: 2631.8,
      foreignAmount: 27.84,
      foreignCurrency: 'USD',
      narration: 'ANTHROPIC* CLAUDE SUB ANTHROPIC.COM CA',
    });
    const a = parseStatementText(A11, 'card');
    expect(find(a, /ANTHROPIC/).map((l) => [l.amountInr, l.foreignAmount])).toEqual([
      [1310.6, 13.85],
      [568.2, 6.02],
    ]);
  });

  it('3. narrations stop at the amount; reward and summary tables are not read as text', () => {
    const all = [A09, A10, A11, B09].flatMap((t) => parseStatementText(t, 'card'));
    for (const l of all)
      expect(l.narration).not.toMatch(
        /Previous Balanc|Transaction Details|Earned|TRANSACTIONS FOR/i,
      );
    expect(find(b, /GOOGLE WORKSPACE/)[0].narration).toBe('GOOGLE WORKSPACE MUMBAI IN');
    const a9 = parseStatementText(A09, 'card');
    expect(a9[a9.length - 1]).toMatchObject({
      narration: 'UPI-Facebook India Onliervices Private L',
      amountInr: 2399,
    });
    expect(b).toHaveLength(11);
    expect(a9).toHaveLength(19);
  });

  it('4. undated fee rows belong to the previous date', () => {
    expect(find(b, /FORGN CURR MARKUP/)[0]).toMatchObject({
      date: '2026-09-18',
      amountInr: 52.64,
      taxInr: 9.48,
      lineKind: 'fee',
    });
    expect(find(b, /IGST/)[0]).toMatchObject({
      date: '2026-09-18',
      amountInr: 2585.39,
      lineKind: 'tax',
    });
  });

  it('sums match the printed account summary', () => {
    const fees = b
      .filter((l) => l.lineKind !== 'purchase' && l.amountInr > 0)
      .reduce((s, l) => s + l.amountInr, 0);
    expect(Math.round(fees * 100) / 100).toBe(18128.65);
    const a9 = parseStatementText(A09, 'card');
    const credits = a9.filter((l) => l.amountInr < 0).reduce((s, l) => s - l.amountInr, 0);
    expect(Math.round(credits * 100) / 100).toBe(17508.78);
    expect(a9.every((l) => l.statementPeriod === '2026-09')).toBe(true);
  });
});

describe('recurring detection on SBI Card statements', () => {
  const three = [A09, A10, A11].flatMap((t) => parseStatementText(t, 'card'));
  const found = detectRecurring(three);
  const by = Object.fromEntries(found.map((c) => [c.key, c]));

  it('5. fees, finance charges, GST, markup, payments, waivers and reversals are never subscriptions', () => {
    for (const c of found)
      expect(c.label).not.toMatch(/fin|charge|gst|markup|payment|waiver|revers|fee/i);
    expect(detectRecurring(parseStatementText(B09, 'card'))).toEqual([]);
  });

  it('6. merchant spellings collapse to one merchant', () => {
    for (const n of [
      'UPI-FACEBOOK INDIA ONLIERVICES PVT LTD',
      'UPI-Facebook India Onliervices Private L',
      'FACEBOOKCOMADSMANAGER IN',
      'UPI-facebookadsmanager',
    ])
      expect(statementMerchant(n).key).toBe('facebook_ads');
    for (const n of ['UPI-Meta Verified', 'UPI-META'])
      expect(statementMerchant(n).key).toBe('meta_verified');
    expect(statementMerchant('ANTHROPIC* CLAUDE SUB ANTHROPIC.COM CA').key).toBe('anthropic');
    expect(statementMerchant('LOVABLE LOVABLE.DEV DE').key).toBe('lovable');
    expect(statementMerchant('GOOGLECLOUD IN').key).toBe('google_cloud');
    expect(statementMerchant('GOOGLE WORKSPACE MUMBAI IN').key).toBe('google_workspace');
    expect(statementMerchant('UPI-Jio Prepaid Recharg').key).toBe('jio');
    expect(statementMerchant('UPI-AIRTEL PAYMENTS BANMITED').key).toBe('airtel');
    expect(statementMerchant('UPI-URBAN COMPANY LIMIT').key).toBe('urban_company');
    expect(statementMerchant('UPI-Euronet Services InPvt Ltd').key).toBe('mobile_recharge');
  });

  it('7. foreign/known subscriptions recur across statement months with a wide tolerance; top-ups are classed', () => {
    expect(by.lovable).toMatchObject({
      kind: 'subscription',
      cadence: 'monthly',
      averageInr: 2947.35,
      occurrences: 4,
      confidence: 'medium',
    });
    expect(by.google_cloud).toMatchObject({ kind: 'usage_topup', occurrences: 7 });
    expect(by.facebook_ads.kind).toBe('usage_topup');
    // Anthropic appears in one statement only (twice): not yet recurring.
    expect(by.anthropic).toBeUndefined();
    // A single statement never makes a statement-month subscription.
    expect(detectRecurring(parseStatementText(A10, 'card'))).toEqual([]);
  });
});

describe('8. card statement summary', () => {
  it('reads the pdf.js value block (labels and values on separate lines)', () => {
    expect(parseCardStatementSummary(B09)).toEqual({
      issuer: 'SBI Card',
      last4: '00',
      statementDate: '2026-09-18',
      dueDate: '2026-10-08',
      creditLimit: 410000,
      availableCredit: 20239.03,
      totalDue: 389760.97,
      minimumDue: 19488.05,
      previousBalance: 396214.37,
      payments: 31299.25,
      purchases: 6717.2,
      feesTaxesInterest: 18128.65,
      financeChargeInr: 14310.62,
      lateFeeInr: 1180,
      forexMarkupInr: 52.64,
      annualFeeInr: null,
      annualFeeReversedInr: 3399,
      annualFeeWaiver: null,
      monthlyRatePct: 3.75,
      foreignSpendInr: 2631.8,
    });
  });
  it('other months', () => {
    expect(parseCardStatementSummary(A09)).toMatchObject({
      totalDue: 20465.75,
      minimumDue: 1023.29,
      dueDate: '2026-10-02',
      creditLimit: 85000,
      financeChargeInr: 648.2,
      forexMarkupInr: null,
    });
    expect(parseCardStatementSummary(A11)).toMatchObject({
      totalDue: 2435.82,
      dueDate: '2026-12-02',
      financeChargeInr: 412.8,
      forexMarkupInr: 58.35,
      foreignSpendInr: 1878.8,
    });
  });
  it('labelled text fallback; non-statements → null', () => {
    expect(
      parseCardStatementSummary(
        'HDFC Bank credit card\nTotal Amount Due: ₹12,345.00\nMinimum Amount Due ₹620.00\nPayment Due Date 05/12/2026',
      ),
    ).toMatchObject({
      issuer: 'HDFC Bank',
      totalDue: 12345,
      minimumDue: 620,
      dueDate: '2026-12-05',
      feesTaxesInterest: null,
    });
    expect(parseCardStatementSummary('hello')).toBeNull();
  });
});

describe('9. fee_leak moves from card summaries', () => {
  const withStatements = (...texts: string[]): AppData => ({
    ...dataWith(),
    savings: {
      ...defaultSavingsState(),
      statements: texts.map((t) => emptyIfNull(parseCardStatementSummary(t))),
    },
  });

  it('interest, late fee and forex markup; information-only legal note on interest', () => {
    const { moves } = computeMoves(withStatements(B09), catalogWith(CARD_BT), NOW);
    const by = Object.fromEntries(moves.map((m) => [m.id, m]));
    expect(by['fee_leak:interest:card-sbi-card-00']).toMatchObject({
      kind: 'fee_leak',
      title: 'You paid ₹14,311 interest this month',
      monthlySavingInr: 14311,
      moduleId: CARD_BT.id,
      legalNote: "Information only. Check your bank's own offer.",
    });
    expect(by['fee_leak:interest:card-sbi-card-00'].why).toMatch(/14–22%/);
    expect(by['fee_leak:late_fee:card-sbi-card-00']).toMatchObject({
      title: 'Set an autopay for at least the minimum due',
      monthlySavingInr: 1180,
    });
    expect(by['fee_leak:forex:card-sbi-card-00']).toMatchObject({
      title: '₹53 a month in forex markup + GST',
      monthlySavingInr: 53,
    });
    expect(by['fee_leak:forex:card-sbi-card-00'].why).toMatch(/zero-forex card or paying in INR/);
    // The annual fee was reversed: nothing to save.
    expect(moves.some((m) => m.id.startsWith('fee_leak:annual_fee'))).toBe(false);
    for (const m of moves) expect(m.why).not.toMatch(/SBI Card (PRIME|ELITE|PULSE)/);
  });

  it('uses only the latest statement of each card', () => {
    const { moves } = computeMoves(withStatements(A09, A10, A11), catalogWith(CARD_BT), NOW);
    const fees = moves.filter((m) => m.kind === 'fee_leak');
    expect(fees.map((m) => [m.id, m.monthlySavingInr])).toEqual([
      ['fee_leak:interest:card-sbi-card-00', 413],
      ['fee_leak:forex:card-sbi-card-00', 58],
    ]);
  });

  it('annual fee charged: waiver condition only when the statement prints one', () => {
    const s = {
      ...emptyIfNull(parseCardStatementSummary(A09)),
      financeChargeInr: null,
      annualFeeInr: 590,
    };
    const data = { ...dataWith(), savings: { ...defaultSavingsState(), statements: [s] } };
    const [m] = computeMoves(data, catalogWith(CARD_BT), NOW).moves;
    expect(m).toMatchObject({ id: 'fee_leak:annual_fee:card-sbi-card-00', monthlySavingInr: 49 });
    expect(m.why).not.toMatch(/Waived/);
    const w = { ...s, annualFeeWaiver: 'Waived on annual spends of Rs.1 Lakh or more' };
    const [m2] = computeMoves(
      { ...data, savings: { ...data.savings, statements: [w] } },
      catalogWith(CARD_BT),
      NOW,
    ).moves;
    expect(m2.why).toContain('Rs.1 Lakh');
  });
});

describe('10. adding the card bill', () => {
  it('creates, then updates, one credit_card obligation and links the saved summary', () => {
    const s = emptyIfNull(parseCardStatementSummary(A10));
    const r = addCardBill(dataWith(), s, { now: NOW });
    const c = r.data.commitments.find((x) => x.id === r.obligationId)!;
    expect(c).toMatchObject({
      type: 'credit_card',
      provider: 'SBI Card',
      amountPaise: 2244944,
      nextDue: '2026-11-01',
    });
    expect(c.statement).toMatchObject({ cardNickname: 'SBI Card ••00', periodEnd: '2026-10-12' });
    expect(r.data.savings.statements).toEqual([{ ...s, obligationId: r.obligationId }]);
    expect(r.data.audit).toHaveLength(1);
    const later = emptyIfNull(parseCardStatementSummary(A11));
    const r2 = addCardBill(r.data, later, { now: NOW });
    expect(r2.obligationId).toBe(r.obligationId);
    expect(r2.data.commitments).toHaveLength(1);
    expect(r2.data.commitments[0]).toMatchObject({ amountPaise: 243582, nextDue: '2026-12-02' });
    expect(r2.data.savings.statements).toHaveLength(2);
  });
});

describe('loan statement (SOA) and welcome letter', () => {
  const soa = emptyIfNull(parseLoanStatement(SOA));

  it('reads the statement of account', () => {
    expect(soa).toMatchObject({
      source: 'statement',
      lender: 'L&T Finance',
      product: 'HOME LOAN',
      rateType: 'floating',
      annualRatePct: 8.15,
      emiInr: 52777.89,
      emiDueDay: 3,
      loanAmountInr: 6240000,
      loanTenureMonths: 240,
      balanceTenureMonths: 210,
      futurePrincipalInr: 5895304.26,
      overdueInstalmentInr: 52777.89,
      latePaymentChargesInr: 2702.23,
      bounceCount: 19,
      bounceChargesInr: 19470,
      processingFeeInr: 14751.2,
      disbursementDate: '2024-04-30',
      instalmentEndDate: '2044-05-03',
      statementDate: '2026-11-24',
    });
    expect(soa.bounceMonths).toEqual([
      '2024-09',
      '2024-10',
      '2024-11',
      '2025-08',
      '2025-10',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-05',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(soa.bounceCharges).toHaveLength(11);
    expect(bouncesIn12Months(soa, '2026-11-24')).toBe(14);
    expect(JSON.stringify(soa)).not.toMatch(/H0000|xxxx|example\.com/i);
  });

  it('reads the welcome letter', () => {
    expect(parseLoanStatement(WELCOME)).toMatchObject({
      source: 'welcome_letter',
      lender: 'L&T Finance',
      loanAmountInr: 2850000,
      loanTenureMonths: 216,
      emiInr: 26069.02,
      annualRatePct: 8.65,
      rateType: 'floating',
      emiDueDay: 3,
      processingFeeInr: 24516.4,
      disbursementDate: '2024-06-12',
      instalmentEndDate: '2042-07-03',
      bounceCount: 0,
    });
    expect(parseLoanStatement('Grocery list')).toBeNull();
  });

  it('fee_leak: bounce charges + late interest over 12 months', () => {
    const data = { ...dataWith(), savings: { ...defaultSavingsState(), loans: [soa] } };
    const { moves } = computeMoves(data, catalogWith(HOME_LOAN), NOW);
    const b = moves.find((m) => m.id.startsWith('fee_leak:bounce:'))!;
    expect(b).toMatchObject({
      title: 'Keep the EMI amount in the account 1 day before the due date',
      effort: 'habit',
      // (9 × ₹1,770 + ₹2,702.23) / 12
      monthlySavingInr: 1553,
    });
    expect(b.why).toBe(
      'EMI bounced 14 times in 12 months: ₹15,930 in bounce charges + ₹2,702 late interest. Or ask the lender to move the EMI date nearer your income date.',
    );
    // 8.15% is within 0.5 of the published 8.1%: no switch move.
    expect(moves.some((m) => m.kind === 'loan_switch')).toBe(false);
  });

  it('loan_switch from the summary; bounces lower confidence and add the transfer note', () => {
    const cheaper = { ...HOME_LOAN, rules: { ratePctLow: 7.5, ratePctHigh: 8.0 } };
    const data = { ...dataWith(), savings: { ...defaultSavingsState(), loans: [soa] } };
    const l = computeMoves(data, catalogWith(cheaper), NOW).moves.find(
      (m) => m.kind === 'loan_switch',
    )!;
    const p = 5895304.26;
    expect(l.monthlySavingInr).toBe(Math.round(emi(p, 8.15, 210) - emi(p, 7.5, 210)));
    expect(l.confidence).toBe('low');
    expect(l.why).toContain(BOUNCE_TRANSFER_NOTE);
    expect(l.legalNote).toMatch(/RBI/);
    expect(l.sources.some((s) => s.kind === 'regulator')).toBe(true);
  });

  it('"Add this loan\'s EMI": emi obligation with loan terms on a bank mandate', () => {
    const r = addLoanEmi(dataWith(), soa, { now: NOW, today: '2026-11-24' });
    const c = r.data.commitments[0];
    expect(c).toMatchObject({
      type: 'emi',
      provider: 'L&T Finance',
      rail: 'bank_mandate',
      amountPaise: 5277789,
      nextDue: '2026-12-03',
      remainingOccurrences: 210,
      loan: {
        rateType: 'variable',
        interestRatePct: 8.15,
        principalPaise: 589530426,
        loanType: 'Home Loan',
      },
    });
    expect(r.data.savings.loans![0].obligationId).toBe(c.id);
    // The linked obligation and the summary give one loan move, the summary's.
    const cheaper = { ...HOME_LOAN, rules: { ratePctLow: 7.5, ratePctHigh: 8.0 } };
    const loanMoves = computeMoves(r.data, catalogWith(cheaper), NOW).moves.filter(
      (m) => m.kind === 'loan_switch',
    );
    expect(loanMoves).toHaveLength(1);
    expect(loanMoves[0].obligationIds).toEqual([c.id]);
    expect(loanMoves[0].why).toContain(BOUNCE_TRANSFER_NOTE);
    expect(
      addLoanEmi(r.data, soa, { now: NOW, today: '2026-11-24' }).data.commitments,
    ).toHaveLength(1);
  });
});
