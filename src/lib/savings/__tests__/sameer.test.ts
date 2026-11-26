import { describe, expect, it } from 'vitest';
import { dataWith, mk } from '../../__tests__/helpers';
import {
  computeMoves,
  defaultSavingsState,
  foundTotalInr,
  ledgerFromMoves,
  markMove,
  proveSavings,
  returnRatio,
  setCityPack,
  setHomeLocality,
  upsertCommuteLeg,
  type Move,
} from '..';
import type { AppData } from '../../types';
import { CATALOG } from './testCatalog';

const NOW = '2026-11-24T05:00:00.000Z';

function sameer(): AppData {
  let s = defaultSavingsState();
  s = setCityPack(s, 'in-mmr');
  s = setHomeLocality(s, 'Vashi, Navi Mumbai');
  s = upsertCommuteLeg(s, {
    id: 'am',
    from: 'Vashi, Navi Mumbai',
    to: 'Thane West',
    daysPerWeek: 5,
    mode: 'cab',
    costPerTripInr: 420,
  });
  s = upsertCommuteLeg(s, {
    id: 'pm',
    from: 'Thane West',
    to: 'Vashi, Navi Mumbai',
    daysPerWeek: 5,
    mode: 'cab',
    costPerTripInr: 420,
  });
  return {
    ...dataWith(
      mk({
        id: 'uber',
        type: 'subscription',
        provider: 'Uber One',
        amountPaise: 14_900,
        amountConfidence: 'confirmed',
        frequency: 'monthly',
        nextDue: '2026-12-12',
      }),
      mk({
        id: 'zomato',
        type: 'subscription',
        provider: 'Zomato Gold',
        amountPaise: 14_900,
        amountConfidence: 'confirmed',
        frequency: 'quarterly',
        nextDue: '2027-01-05',
      }),
      mk({
        id: 'jio',
        type: 'bill',
        provider: 'Jio',
        nickname: 'Jio prepaid',
        amountPaise: 34_900,
        amountConfidence: 'confirmed',
        frequency: 'monthly',
        nextDue: '2026-12-02',
      }),
      mk({
        id: 'card',
        type: 'credit_card',
        provider: 'HDFC',
        nickname: 'HDFC Millennia',
        amountPaise: 1_200_000,
        notes: 'Carrying a revolving balance of ₹80,000 at 3.6% a month',
        nextDue: '2026-12-08',
      }),
      mk({
        id: 'home',
        type: 'emi',
        provider: 'SBI',
        nickname: 'SBI home loan',
        amountPaise: 4_500_000,
        amountConfidence: 'confirmed',
        frequency: 'monthly',
        nextDue: '2026-12-05',
        remainingOccurrences: 180,
        loan: {
          loanType: 'Home loan',
          interestRatePct: 9.4,
          rateType: 'variable',
          principalPaise: null,
        },
      }),
      mk({
        id: 'gym',
        type: 'subscription',
        provider: 'Cult.fit Elite 98765 sameer@example.com',
        amountPaise: 199_900,
        frequency: 'monthly',
        nextDue: '2026-12-01',
      }),
    ),
    savings: s,
  };
}

const byKind = (moves: Move[], kind: Move['kind']) => moves.filter((m) => m.kind === kind);

describe('Sameer: Navi Mumbai → Thane commuter', () => {
  const { moves, research } = computeMoves(sameer(), CATALOG, NOW);

  it('finds the Uber One + Zomato Gold overlap (Zomato Gold price is reported, not verified)', () => {
    const [o] = byKind(moves, 'overlap').filter((m) => m.obligationIds[1] === 'zomato');
    expect(o.id).toBe('overlap:uber-one-in:uber+zomato');
    expect(o.title).toBe('You already get Zomato Gold with Uber One');
    expect(o.monthlySavingInr).toBe(50); // ₹149 a quarter
    expect(o.unverifiedPrice).toBe(true);
    expect(o.effort).toBe('tap');
  });

  it('Uber One pays back on his cab commute, so no pause move; yearly plan is cheaper', () => {
    expect(
      byKind(moves, 'membership_breakeven').find((m) => m.moduleId === 'uber-one-in'),
    ).toBeUndefined();
    const p = moves.find((m) => m.id === 'period_switch:uber-one-in:uber')!;
    expect(p.monthlySavingInr).toBe(24); // (149×12 − 1499) / 12
  });

  it('switches Jio from 28-day packs to the yearly plan', () => {
    const j = moves.find((m) => m.id === 'period_switch:jio-prepaid-in:jio')!;
    // 349 × 365/28 = 4549.46 a year vs 3599 → 79.2 a month
    expect(j.monthlySavingInr).toBe(79);
    expect(j.confidence).toBe('high');
    expect(j.unverifiedPrice).toBe(false);
  });

  it('suggests the Cityflo pass for both commute legs', () => {
    const [c] = byKind(moves, 'commute_pass');
    expect(c.id).toBe('commute_pass:cityflo-nm-thane:');
    // 2 legs × 5 days × 52/12 = 43.33 trips × ₹420 = 18,200 vs ₹6,000 × 30.42/30 = 6,083
    expect(c.monthlySavingInr).toBe(12117);
    expect(c.unverifiedPrice).toBe(true);
    expect(c.confidence).toBe('medium');
    expect(c.assumptions.map((a) => a.source)).toEqual(['you_entered', 'you_entered']);
    // The bus pass has no price: no move for it.
    expect(moves.some((m) => m.moduleId === 'bus-unknown')).toBe(false);
  });

  it('card debt: balance-transfer EMI comparison with the legal note', () => {
    const [d] = byKind(moves, 'debt_rate');
    expect(d.id).toBe('debt_rate:card-balance-transfer-in:card');
    // 80,000 × (43.2 − 22)% / 12 − 1% fee over 12 months = 1413.33 − 66.67
    expect(d.monthlySavingInr).toBe(1347);
    expect(d.rangeInr[1]).toBeGreaterThan(d.rangeInr[0]);
    expect(d.legalNote).toBe("Information only. Check your bank's own offer.");
    expect(d.effort).toBe('paperwork');
  });

  it('floating home loan: EMI difference at the lowest published rate, with the RBI note', () => {
    const [l] = byKind(moves, 'loan_switch');
    expect(l.id).toBe('loan_switch:home-loan-floating-in:home');
    expect(l.monthlySavingInr).toBeGreaterThan(2500);
    expect(l.monthlySavingInr).toBeLessThan(3500);
    expect(l.legalNote).toMatch(/RBI/);
    expect(l.sources.some((s) => s.kind === 'regulator')).toBe(true);
  });

  it('never sends a free-text provider (the gym is not a known merchant) for research (M6)', () => {
    expect(research).toEqual([]);
  });

  it('ranks by saving × confidence and never marks anything sponsored', () => {
    expect(moves[0].kind).toBe('commute_pass');
    expect(moves.every((m) => m.sponsored === false)).toBe(true);
    const scores = moves.map(
      (m) => m.monthlySavingInr * { high: 1, medium: 0.7, low: 0.4 }[m.confidence],
    );
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('is stable: the same data gives the same move ids', () => {
    const again = computeMoves(sameer(), CATALOG, NOW).moves.map((m) => m.id);
    expect(again).toEqual(moves.map((m) => m.id));
  });

  it('end to end: found → done → proven by cancelling Zomato Gold', () => {
    let data = sameer();
    let state = data.savings;
    state = { ...state, ledger: ledgerFromMoves(state.ledger, moves, NOW, data) };
    expect(returnRatio(state.ledger).foundMonthlyInr).toBe(
      moves.reduce((s, m) => s + m.monthlySavingInr, 0),
    );
    expect(foundTotalInr(moves)).toBeLessThanOrEqual(returnRatio(state.ledger).foundMonthlyInr);
    state = markMove(state, 'overlap:uber-one-in:uber+zomato', 'done', { now: NOW });
    // Saying "I did this" is not proof.
    expect(
      proveSavings(data, state.ledger).find((e) => e.status === 'done')!.savedMonthlyInr,
    ).toBeNull();
    data = {
      ...data,
      commitments: data.commitments.map((c) =>
        c.id === 'zomato' ? { ...c, status: 'cancelled_confirmed_by_user' } : c,
      ),
    };
    const proven = proveSavings(data, state.ledger, NOW);
    const e = proven.find((x) => x.moveId === 'overlap:uber-one-in:uber+zomato')!;
    expect(e.savedMonthlyInr).toBe(50);
    expect(e.proofRef).toBe('obligation:zomato:cancelled');
    const rr = returnRatio(proven);
    expect(rr.planFeeMonthlyInr).toBe(149);
    expect(rr.savedRatio).toBe(Math.round((50 / 149) * 100) / 100);
  });
});
