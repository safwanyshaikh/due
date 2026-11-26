import { describe, expect, it } from 'vitest';
import { dataWith, mk } from '../../__tests__/helpers';
import {
  computeMoves,
  defaultSavingsState,
  rankMoves,
  setCityPack,
  setOverride,
  upsertCommuteLeg,
  TYPICAL,
  type Move,
  type SavingsState,
} from '..';
import { balanceFromNotes, emi, rateFromNotes } from '../engine';
import { matchModule } from '../match';
import type { AppData, Commitment } from '../../types';
import {
  CARD_BT,
  CATALOG,
  HOME_LOAN,
  JIO,
  NULL_PRICE,
  SWIGGY_ONE,
  UBER_ONE,
  ZOMATO_GOLD,
  catalogWith,
  mod,
} from './testCatalog';

const NOW = '2026-11-24T05:00:00.000Z';

function run(cs: Commitment[], savings: SavingsState = defaultSavingsState(), catalog = CATALOG) {
  const data: AppData = { ...dataWith(...cs), savings };
  return computeMoves(data, catalog, NOW);
}
const sub = (over: Partial<Commitment> & { id: string }) =>
  mk({
    type: 'subscription',
    frequency: 'monthly',
    nextDue: '2026-12-10',
    amountConfidence: 'confirmed',
    ...over,
  });

describe('matchModule', () => {
  it('matches by alias, keyword and canonical key; prefers the longest alias', () => {
    expect(matchModule(sub({ id: 'a', provider: 'Uber One' }), CATALOG.modules)?.module.id).toBe(
      'uber-one-in',
    );
    expect(
      matchModule(sub({ id: 'b', provider: 'Reliance Jio' }), CATALOG.modules)?.module.id,
    ).toBe('jio-prepaid-in');
    expect(matchModule(sub({ id: 'c', provider: 'JioHotstar' }), CATALOG.modules)).toBeNull();
    const loan = mk({ id: 'l', type: 'emi', provider: 'HDFC', nickname: 'Home loan' });
    expect(matchModule(loan, CATALOG.modules)).toMatchObject({ via: 'keyword' });
  });
  it('falls back to a generic card module; never matches retired modules', () => {
    const card = mk({ id: 'k', type: 'credit_card', provider: 'Axis' });
    expect(matchModule(card, CATALOG.modules)).toMatchObject({
      via: 'generic',
      module: { id: CARD_BT.id },
    });
    const retired = { ...UBER_ONE, status: 'retired' as const };
    expect(matchModule(sub({ id: 'a', provider: 'Uber One' }), [retired])).toBeNull();
  });
});

describe('overlap', () => {
  it('telecom plan that includes JioHotstar while paying for JioHotstar', () => {
    const { moves } = run([
      sub({ id: 'jio', type: 'bill', provider: 'Jio', amountPaise: 34_900 }),
      sub({ id: 'hs', provider: 'JioHotstar', amountPaise: 29_900 }),
    ]);
    const o = moves.find((m) => m.kind === 'overlap')!;
    expect(o.id).toBe('overlap:jio-prepaid-in:jio+hs');
    // 3 months a year included: ₹299 × 3 / 12
    expect(o.monthlySavingInr).toBe(75);
    expect(o.rangeInr).toEqual([75, 299]);
    expect(o.why).toMatch(/for 3 months/);
  });
  it('no move when the duplicate has no price anywhere', () => {
    const { moves } = run([
      sub({ id: 'u', provider: 'Uber One', amountPaise: 14_900 }),
      sub({ id: 'z', provider: 'Zomato Gold', amountPaise: null }),
    ]);
    expect(moves.some((m) => m.kind === 'overlap')).toBe(false);
  });
  it('a cancelled duplicate is not an overlap', () => {
    const { moves } = run([
      sub({ id: 'u', provider: 'Uber One', amountPaise: 14_900 }),
      sub({
        id: 'z',
        provider: 'Zomato Gold',
        amountPaise: 9_900,
        status: 'cancelled_confirmed_by_user',
      }),
    ]);
    expect(moves.some((m) => m.kind === 'overlap')).toBe(false);
  });
});

describe('period_switch', () => {
  it('only for monthly obligations with a known cheaper yearly price', () => {
    expect(
      run([
        sub({ id: 'u', provider: 'Uber One', amountPaise: 14_900, frequency: 'annual' }),
      ]).moves.filter((m) => m.kind === 'period_switch'),
    ).toEqual([]);
    const { moves } = run(
      [sub({ id: 'm', provider: 'Mystery OTT', amountPaise: 19_900 })],
      undefined,
      catalogWith(NULL_PRICE),
    );
    expect(moves).toEqual([]);
  });
  it('uses the module price (flagged unverified) when the user has no amount', () => {
    const { moves } = run(
      [sub({ id: 'j', provider: 'Jio', amountPaise: null })],
      undefined,
      catalogWith(JIO),
    );
    const p = moves.find((m) => m.kind === 'period_switch')!;
    expect(p.unverifiedPrice).toBe(true);
    expect(p.confidence).toBe('medium');
  });
});

describe('membership_breakeven', () => {
  it('typical usage below the fee → pause before renewal, saving = fee, low confidence', () => {
    const { moves } = run(
      [sub({ id: 's', provider: 'Swiggy One', amountPaise: 29_900, nextDue: '2026-12-12' })],
      undefined,
      catalogWith(SWIGGY_ONE),
    );
    const m = moves.find((x) => x.kind === 'membership_breakeven')!;
    expect(m.id).toBe('membership_breakeven:swiggy-one-in:s');
    expect(m.title).toBe('Pause Swiggy One before 12 Dec 2026');
    expect(m.monthlySavingInr).toBe(299);
    // 6 orders × ₹20 = ₹120 back
    expect(m.rangeInr).toEqual([179, 299]);
    expect(m.confidence).toBe('low');
    expect(m.assumptions.map((a) => [a.key, a.value, a.source])).toEqual([
      ['swiggy-one-in:ordersPerMonth', TYPICAL.ordersPerMonth, 'typical'],
      ['swiggy-one-in:avgOrderInr', TYPICAL.avgOrderInr, 'typical'],
    ]);
  });
  it('profile overrides replace typical defaults (and can flip the answer)', () => {
    let s = setOverride(defaultSavingsState(), 'swiggy-one-in:ordersPerMonth', 20);
    s = setOverride(s, 'swiggy-one-in:avgOrderInr', 300);
    const { moves } = run(
      [sub({ id: 's', provider: 'Swiggy One', amountPaise: 29_900 })],
      s,
      catalogWith(SWIGGY_ONE),
    );
    // 20 × ₹20 = ₹400 ≥ ₹299: it pays back, no move
    expect(moves).toEqual([]);
    const s2 = setOverride(s, 'swiggy-one-in:ordersPerMonth', 10);
    const m = run(
      [sub({ id: 's', provider: 'Swiggy One', amountPaise: 29_900 })],
      s2,
      catalogWith(SWIGGY_ONE),
    ).moves[0];
    expect(m.assumptions[0]).toMatchObject({ value: 10, source: 'you_entered' });
    expect(m.confidence).toBe('medium');
  });
  it('mobility credit uses the city pack fare as a labelled typical fare', () => {
    const s = setCityPack(defaultSavingsState(), 'in-mmr');
    const { moves } = run(
      [sub({ id: 'u', provider: 'Uber One', amountPaise: 99_900 })],
      s,
      catalogWith(UBER_ONE),
    );
    const m = moves.find((x) => x.kind === 'membership_breakeven')!;
    // 8 rides × min(400 × 10%, 50) = ₹320 < ₹999
    expect(m.assumptions.find((a) => a.key === 'uber-one-in:avgFareInr')).toMatchObject({
      value: 400,
      source: 'typical',
    });
    expect(m.rangeInr).toEqual([679, 999]);
    // A pausing membership gets no "switch to yearly" advice.
    expect(moves.some((x) => x.kind === 'period_switch')).toBe(false);
  });
  it('a research module with unknown rules produces no money claim', () => {
    const { moves } = run(
      [sub({ id: 'z', provider: 'Zomato Gold', amountPaise: 9_900 })],
      undefined,
      catalogWith({ ...ZOMATO_GOLD, rules: {} }),
    );
    expect(moves).toEqual([]);
  });
});

describe('commute_pass', () => {
  const legs = (cost: number | null) => {
    let s = setCityPack(defaultSavingsState(), 'in-mmr');
    s = upsertCommuteLeg(s, {
      id: 'a',
      from: 'Vashi',
      to: 'Thane',
      daysPerWeek: 5,
      mode: 'cab',
      costPerTripInr: cost,
    });
    return s;
  };
  it('per-trip spend vs a pass covering both ends', () => {
    const [m] = run([], legs(300)).moves;
    // 21.67 trips × 300 = 6500 − 6083
    expect(m).toMatchObject({
      kind: 'commute_pass',
      moduleId: 'cityflo-nm-thane',
      monthlySavingInr: 417,
      effort: 'habit',
    });
  });
  it('typical fare is labelled and lowers confidence; no pass, no move', () => {
    const [m] = run([], legs(null)).moves;
    expect(m.assumptions[0]).toMatchObject({ source: 'typical', value: 400 });
    expect(m.confidence).toBe('low');
    expect(run([], legs(200)).moves).toEqual([]);
    const away = upsertCommuteLeg(setCityPack(defaultSavingsState(), 'in-mmr'), {
      id: 'x',
      from: 'Andheri',
      to: 'Thane',
      daysPerWeek: 5,
      mode: 'cab',
      costPerTripInr: 900,
    });
    expect(run([], away).moves).toEqual([]);
  });
  it('no city pack chosen → nothing', () => {
    expect(
      run(
        [],
        upsertCommuteLeg(defaultSavingsState(), {
          from: 'Vashi',
          to: 'Thane',
          daysPerWeek: 5,
          mode: 'cab',
          costPerTripInr: 900,
        }),
      ).moves,
    ).toEqual([]);
  });
});

describe('debt_rate', () => {
  const card = (notes: string, over: Partial<Commitment> = {}) =>
    mk({
      id: 'c',
      type: 'credit_card',
      provider: 'ICICI',
      nickname: 'ICICI Amazon Pay',
      amountPaise: 500_000,
      notes,
      ...over,
    });
  it('needs a revolving balance note', () => {
    expect(run([card('Paid in full every month')]).moves).toEqual([]);
  });
  it('stated rate vs module high rate, with the legal note', () => {
    const [m] = run([card('revolving 50k at 36% p.a.')]).moves;
    // 50,000 × 14% / 12 − 1%/12 = 583.33 − 41.67
    expect(m.monthlySavingInr).toBe(542);
    expect(m.legalNote).toBe("Information only. Check your bank's own offer.");
    expect(m.confidence).toBe('medium');
  });
  it('unknown rate → typical 42% labelled, low confidence; module without a rate → no move', () => {
    const [m] = run([card('carrying an outstanding balance')]).moves;
    expect(m.assumptions.find((a) => a.key === 'debt_rate:c:ratePct')).toMatchObject({
      value: 42,
      source: 'typical',
    });
    expect(m.confidence).toBe('low');
    expect(
      run(
        [card('revolving 50k at 36% p.a.')],
        undefined,
        catalogWith({ ...CARD_BT, rules: { ratePctHigh: null } }),
      ).moves,
    ).toEqual([]);
  });
  it('reads rates and balances from notes', () => {
    expect(rateFromNotes('3.5% a month')).toBe(42);
    expect(rateFromNotes('36% p.a.')).toBe(36);
    expect(rateFromNotes('3%')).toBe(36);
    expect(balanceFromNotes('balance ₹1,20,000')).toBe(120000);
    expect(balanceFromNotes('outstanding Rs 1.5 lakh')).toBe(150000);
    expect(balanceFromNotes('revolving 45k')).toBe(45000);
  });
});

describe('loan_switch', () => {
  const loan = (over: Partial<NonNullable<Commitment['loan']>>, extra: Partial<Commitment> = {}) =>
    mk({
      id: 'h',
      type: 'emi',
      provider: 'Axis',
      nickname: 'Home loan',
      amountPaise: 3_000_000,
      frequency: 'monthly',
      nextDue: '2026-12-05',
      remainingOccurrences: 240,
      loan: { rateType: 'variable', interestRatePct: 9.5, principalPaise: 3_000_000_00, ...over },
      ...extra,
    });
  it('EMI difference at the lowest published rate, with the RBI note and source', () => {
    const [m] = run([loan({})]).moves;
    const expected = Math.round(emi(3_000_000, 9.5, 240) - emi(3_000_000, 8.1, 240));
    expect(m.monthlySavingInr).toBe(expected);
    expect(m.rangeInr[0]).toBe(Math.round(emi(3_000_000, 9.5, 240) - emi(3_000_000, 9.0, 240)));
    expect(m.legalNote).toMatch(/RBI/);
    expect(m.legalNote).toMatch(/Information only/);
  });
  it('fixed rate, unknown rate, or rate within 0.5 of the best → no move', () => {
    expect(run([loan({ rateType: 'fixed' })]).moves).toEqual([]);
    expect(run([loan({ interestRatePct: null })]).moves).toEqual([]);
    expect(run([loan({ interestRatePct: 8.5 })]).moves).toEqual([]);
  });
  it('adds the RBI source when the module has no regulator source', () => {
    const [m] = run([loan({})], undefined, catalogWith({ ...HOME_LOAN, sources: [] })).moves;
    expect(m.sources).toEqual([expect.objectContaining({ kind: 'regulator' })]);
  });
  it('derives principal from EMI and months when only those are known', () => {
    const [m] = run([
      loan({ principalPaise: null }, { amountPaise: Math.round(emi(3_000_000, 9.5, 240) * 100) }),
    ]).moves;
    expect(
      Math.abs(
        m.monthlySavingInr - Math.round(emi(3_000_000, 9.5, 240) - emi(3_000_000, 8.1, 240)),
      ),
    ).toBeLessThanOrEqual(1);
  });
});

describe('price_change and trial_end', () => {
  it('last two paid amounts up by ≥ 5%', () => {
    const base = sub({ id: 'n', provider: 'Netflix', amountPaise: 64_900 });
    const paid = (d: string, a: number) => ({
      id: `e${d}`,
      occurrenceDate: d,
      kind: 'paid' as const,
      at: `${d}T00:00:00Z`,
      actor: 'user' as const,
      amountPaise: a,
    });
    const up = { ...base, history: [paid('2026-09-10', 49_900), paid('2026-10-10', 64_900)] };
    const [m] = run([up]).moves;
    expect(m).toMatchObject({
      id: 'price_change::n',
      monthlySavingInr: 150,
      confidence: 'high',
      moduleId: null,
    });
    const small = { ...base, history: [paid('2026-09-10', 64_900), paid('2026-10-10', 66_000)] };
    expect(run([small]).moves).toEqual([]);
  });
  it('trial ending within 7 days', () => {
    const t = sub({
      id: 't',
      provider: 'Spotify',
      amountPaise: 11_900,
      subscription: { trialEnd: '2026-11-28' },
    });
    const [m] = run([t]).moves;
    expect(m).toMatchObject({ id: 'trial_end::t', kind: 'trial_end', monthlySavingInr: 119 });
    expect(m.title).toBe('Free trial of Spotify ends 28 Nov 2026');
    expect(run([{ ...t, subscription: { trialEnd: '2026-12-20' } }]).moves).toEqual([]);
    expect(run([{ ...t, subscription: { trialEnd: '2026-11-20' } }]).moves).toEqual([]);
  });
});

describe('research needs', () => {
  it('only canonical providers without a module become research needs; free text never does (M6)', () => {
    const { research } = run([
      sub({ id: 'a', provider: 'Netflix', amountPaise: 64_900 }),
      sub({ id: 'b', provider: 'netflix', amountPaise: 19_900 }),
      sub({ id: 'c', provider: 'Uber One', amountPaise: 14_900 }),
      sub({ id: 'd', provider: 'Tata 1mg Care+ ref 9876543210 me@mail.com', amountPaise: 10_000 }),
      sub({ id: 'e', provider: '12345', amountPaise: 10_000 }),
      mk({ id: 'f', type: 'school_fee', provider: 'St. Mary School', amountPaise: 1_000_000 }),
    ]);
    expect(research).toEqual([
      { providerLabel: 'Netflix', category: 'ott', obligationIds: ['a', 'b'] },
    ]);
    for (const r of research) {
      expect(r.providerLabel).not.toMatch(/\d|@/);
      expect(r.providerLabel.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('ranking and contract', () => {
  const mv = (
    id: string,
    s: number,
    confidence: Move['confidence'],
    effort: Move['effort'],
  ): Move => ({
    id,
    kind: 'overlap',
    moduleId: null,
    obligationIds: [],
    title: id,
    why: '',
    monthlySavingInr: s,
    rangeInr: [s, s],
    confidence,
    assumptions: [],
    sources: [],
    effort,
    action: { url: null, label: '' },
    unverifiedPrice: false,
    legalNote: null,
    sponsored: false,
  });
  it('saving × confidence weight, effort breaks ties', () => {
    const r = rankMoves([
      mv('a', 100, 'low', 'tap'),
      mv('b', 60, 'high', 'tap'),
      mv('c', 100, 'medium', 'paperwork'),
      mv('d', 70, 'high', 'paperwork'),
      mv('e', 70, 'high', 'tap'),
    ]);
    expect(r.map((m) => m.id)).toEqual(['e', 'c', 'd', 'b', 'a']);
  });
  it('ids follow kind:module:obligations, savings are whole rupees ≥ 0', () => {
    const { moves } = run([
      sub({ id: 'jio', type: 'bill', provider: 'Jio', amountPaise: 34_900 }),
      sub({ id: 'hs', provider: 'JioHotstar', amountPaise: 29_900 }),
    ]);
    for (const m of moves) {
      expect(m.id).toBe(`${m.kind}:${m.moduleId ?? ''}:${m.obligationIds.join('+')}`);
      expect(Number.isInteger(m.monthlySavingInr)).toBe(true);
      expect(m.monthlySavingInr).toBeGreaterThan(0);
    }
  });
  it('no catalog / empty data does not throw', () => {
    expect(
      computeMoves(
        { ...dataWith() },
        { version: 'x', generatedAt: '', modules: [], cityPacks: [] },
        NOW,
      ),
    ).toEqual({ moves: [], research: [] });
    const old = dataWith(
      sub({ id: 'a', provider: 'Uber One', amountPaise: 14_900 }),
    ) as Partial<AppData>;
    delete old.savings;
    expect(() => computeMoves(old as AppData, CATALOG, NOW)).not.toThrow();
  });
  it('a research-status module marks prices unverified', () => {
    const research = mod({ ...JIO, status: 'research' });
    const [m] = run(
      [sub({ id: 'j', provider: 'Jio', amountPaise: 34_900 })],
      undefined,
      catalogWith(research),
    ).moves;
    expect(m.unverifiedPrice).toBe(true);
  });
});
