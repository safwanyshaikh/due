import { describe, expect, it } from 'vitest';
import { dataWith, mk } from '../../__tests__/helpers';
import {
  computeMoves,
  defaultSavingsState,
  ledgerFromMoves,
  markMove,
  planFeeMonthlyInr,
  proveSavings,
  returnRatio,
} from '..';
import { PLANS } from '../../plans';
import type { AppData, Commitment } from '../../types';
import { CATALOG } from './testCatalog';

const T0 = '2026-11-24T05:00:00.000Z';
const T1 = '2026-12-20T05:00:00.000Z';

const jio = mk({
  id: 'jio',
  type: 'bill',
  provider: 'Jio',
  amountPaise: 34_900,
  amountConfidence: 'confirmed',
  frequency: 'monthly',
  nextDue: '2026-12-02',
});
const hs = mk({
  id: 'hs',
  type: 'subscription',
  provider: 'JioHotstar',
  amountPaise: 29_900,
  frequency: 'monthly',
  nextDue: '2026-12-02',
});

function setup() {
  const data: AppData = dataWith(jio, hs);
  const { moves } = computeMoves(data, CATALOG, T0);
  const ledger = ledgerFromMoves([], moves, T0, data);
  return { data, moves, state: { ...defaultSavingsState(), ledger } };
}
const edit = (data: AppData, id: string, patch: Partial<Commitment>): AppData => ({
  ...data,
  commitments: data.commitments.map((c) => (c.id === id ? mk({ ...c, ...patch }) : c)),
});

describe('ledger', () => {
  it('adds new moves with a baseline, drops stale new entries, keeps done/dismissed', () => {
    const { moves, state } = setup();
    expect(state.ledger.map((e) => e.moveId).sort()).toEqual(moves.map((m) => m.id).sort());
    const e = state.ledger.find((x) => x.moveId === 'overlap:jio-prepaid-in:jio+hs')!;
    expect(e).toMatchObject({
      status: 'new',
      savedMonthlyInr: null,
      targetObligationId: 'hs',
      baseline: { obligationId: 'hs', monthlyPaise: 29_900 },
    });
    const done = markMove(state, e.moveId, 'done', T1);
    const synced = ledgerFromMoves(done.ledger, [], T1);
    expect(synced.map((x) => x.moveId)).toEqual([e.moveId]);
  });

  it('markMove accepts a move not yet in the ledger, and ignores unknown ids', () => {
    const { moves } = setup();
    const s = markMove(defaultSavingsState(), moves[0], 'doing', T0);
    expect(s.ledger).toHaveLength(1);
    expect(s.ledger[0].status).toBe('doing');
    const same = defaultSavingsState();
    expect(markMove(same, 'nope', 'done')).toBe(same);
  });

  it('done is not saved until evidence: cancel, pause or amount drop', () => {
    const { data, state } = setup();
    const id = 'overlap:jio-prepaid-in:jio+hs';
    const s = markMove(state, id, 'done', { now: T1 });
    expect(
      proveSavings(data, s.ledger, T1).find((e) => e.moveId === id)!.savedMonthlyInr,
    ).toBeNull();
    const paused = proveSavings(
      edit(data, 'hs', { status: 'pause_confirmed_by_user' }),
      s.ledger,
      T1,
    );
    expect(paused.find((e) => e.moveId === id)).toMatchObject({
      savedMonthlyInr: 299,
      proofRef: 'obligation:hs:paused',
    });
    const cheaper = proveSavings(edit(data, 'hs', { amountPaise: 14_900 }), s.ledger, T1);
    expect(cheaper.find((e) => e.moveId === id)).toMatchObject({
      savedMonthlyInr: 150,
      proofRef: 'obligation:hs:amount_drop',
    });
  });

  it('switching Jio to yearly is proven by the new yearly amount', () => {
    const { data, state } = setup();
    const id = 'period_switch:jio-prepaid-in:jio';
    const s = markMove(state, id, 'done', T1);
    const proven = proveSavings(
      edit(data, 'jio', { amountPaise: 359_900, frequency: 'annual' }),
      s.ledger,
      T1,
    );
    // 349 − 3599/12 = 49.08
    expect(proven.find((e) => e.moveId === id)!.savedMonthlyInr).toBe(49);
  });

  it('a deleted obligation or a reverted change is not proof', () => {
    const { data, state } = setup();
    const id = 'overlap:jio-prepaid-in:jio+hs';
    const s = markMove(state, id, 'done', T1);
    expect(
      proveSavings(edit(data, 'hs', { deletedAt: T1 }), s.ledger, T1).find((e) => e.moveId === id)!
        .savedMonthlyInr,
    ).toBeNull();
    const proven = proveSavings(
      edit(data, 'hs', { status: 'cancelled_confirmed_by_user' }),
      s.ledger,
      T1,
    );
    expect(proveSavings(data, proven, T1).find((e) => e.moveId === id)!.savedMonthlyInr).toBeNull();
  });

  it('a move marked done without a baseline snapshots now, and later proves', () => {
    const { data, moves } = setup();
    const m = moves.find((x) => x.kind === 'overlap')!;
    const s = markMove(defaultSavingsState(), m, 'done', T0);
    expect(s.ledger[0].baseline).toBeNull();
    const snapped = proveSavings(data, s.ledger, T0);
    expect(snapped[0].baseline).toMatchObject({ monthlyPaise: 29_900 });
    expect(
      proveSavings(edit(data, 'hs', { status: 'cancelled_confirmed_by_user' }), snapped, T1)[0]
        .savedMonthlyInr,
    ).toBe(299);
  });

  it('leaving done clears the proof', () => {
    const { data, state } = setup();
    const id = 'overlap:jio-prepaid-in:jio+hs';
    const proven = proveSavings(
      edit(data, 'hs', { status: 'cancelled_confirmed_by_user' }),
      markMove(state, id, 'done', T1).ledger,
      T1,
    );
    const back = markMove({ ...state, ledger: proven }, id, 'doing', T1);
    expect(back.ledger.find((e) => e.moveId === id)).toMatchObject({
      savedMonthlyInr: null,
      proofRef: null,
    });
  });

  it('returnRatio uses the Plus monthly price from plans.ts and skips dismissed', () => {
    expect(planFeeMonthlyInr()).toBe(
      PLANS.plus.prices.find((p) => p.cadence === 'monthly')!.amountPaise / 100,
    );
    const { state } = setup();
    const found = state.ledger.reduce((s, e) => s + e.foundMonthlyInr, 0);
    const r = returnRatio(state.ledger);
    expect(r).toMatchObject({ foundMonthlyInr: found, savedMonthlyInr: 0, savedRatio: 0 });
    expect(r.foundRatio).toBeCloseTo(found / planFeeMonthlyInr(), 2);
    const dismissed = markMove(state, state.ledger[0].moveId, 'dismissed', T1);
    expect(returnRatio(dismissed.ledger).foundMonthlyInr).toBe(
      found - state.ledger[0].foundMonthlyInr,
    );
    expect(returnRatio([], 0).foundRatio).toBeNull();
  });
});
