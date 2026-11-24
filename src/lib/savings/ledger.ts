/**
 * Savings ledger: what Due found, what the user says they did, and what later evidence proves.
 * A 'done' move becomes saved only when the data shows it (amount drop, cancel/pause by the user,
 * or a newer imported amount). Nothing is counted as saved on the user's word alone.
 */
import { PLANS } from '../plans';
import type { AppData, Commitment } from '../types';
import { obligationMonthlyInr, targetObligationId } from './engine';
import type { LedgerBaseline, LedgerEntry, Move, MoveStatus, SavingsState } from './types';

/** Plus monthly price in rupees, from plans.ts (the single price config). */
export function planFeeMonthlyInr(): number {
  const p = PLANS.plus.prices.find((x) => x.cadence === 'monthly');
  return p ? p.amountPaise / 100 : 0;
}

function snapshot(ob: Commitment | undefined, at: string): LedgerBaseline | null {
  if (!ob) return null;
  const monthly = obligationMonthlyInr(ob);
  return {
    obligationId: ob.id,
    monthlyPaise: monthly === null ? null : Math.round(monthly * 100),
    status: ob.status,
    interestRatePct: ob.loan?.interestRatePct ?? null,
    at,
  };
}

/**
 * Syncs the ledger with the current moves. New moves are added as 'new'; open entries ('new',
 * 'doing') refresh their amount, title and baseline; 'new' entries whose move is gone are dropped;
 * 'done' and 'dismissed' entries are kept as history.
 */
export function ledgerFromMoves(
  ledger: LedgerEntry[],
  moves: Move[],
  now: string,
  data?: Pick<AppData, 'commitments'>,
): LedgerEntry[] {
  const byId = new Map(moves.map((m) => [m.id, m]));
  const find = (id: string | null) => (id ? data?.commitments.find((c) => c.id === id) : undefined);
  const out: LedgerEntry[] = [];
  const seen = new Set<string>();
  for (const e of ledger) {
    seen.add(e.moveId);
    const m = byId.get(e.moveId);
    if (!m) {
      if (e.status !== 'new') out.push(e);
      continue;
    }
    if (e.status === 'new' || e.status === 'doing') {
      const target = targetObligationId(m);
      out.push({
        ...e,
        title: m.title,
        foundMonthlyInr: m.monthlySavingInr,
        moduleId: m.moduleId,
        obligationIds: m.obligationIds,
        targetObligationId: target,
        baseline: data ? snapshot(find(target), now) : (e.baseline ?? null),
        updatedAt:
          e.foundMonthlyInr !== m.monthlySavingInr || e.title !== m.title ? now : e.updatedAt,
      });
    } else out.push(e);
  }
  for (const m of moves) {
    if (seen.has(m.id)) continue;
    const target = targetObligationId(m);
    out.push({
      moveId: m.id,
      kind: m.kind,
      title: m.title,
      foundMonthlyInr: m.monthlySavingInr,
      status: 'new',
      savedMonthlyInr: null,
      proofRef: null,
      foundAt: now,
      updatedAt: now,
      moduleId: m.moduleId,
      obligationIds: m.obligationIds,
      targetObligationId: target,
      baseline: data ? snapshot(find(target), now) : null,
    });
  }
  return out;
}

/**
 * Sets a move's status. Takes the move or its id. When the ledger has no entry yet, the move
 * (or `opts.move`) creates one; pass `opts.data` so the entry gets a baseline for proof.
 * Leaving 'done' clears any proof (a saving is only kept while the move stands).
 */
export function markMove(
  state: SavingsState,
  moveOrId: string | Move,
  status: MoveStatus,
  nowOrOpts: string | { now?: string; move?: Move; data?: Pick<AppData, 'commitments'> } = {},
): SavingsState {
  const opts = typeof nowOrOpts === 'string' ? { now: nowOrOpts } : { ...nowOrOpts };
  const moveId = typeof moveOrId === 'string' ? moveOrId : moveOrId.id;
  if (typeof moveOrId !== 'string' && !opts.move) opts.move = moveOrId;
  const now = opts.now ?? new Date().toISOString();
  let ledger = state.ledger;
  if (!ledger.some((e) => e.moveId === moveId)) {
    if (!opts.move || opts.move.id !== moveId) return state;
    ledger = ledgerFromMoves(ledger, [opts.move], now, opts.data);
  }
  return {
    ...state,
    ledger: ledger.map((e) =>
      e.moveId !== moveId
        ? e
        : {
            ...e,
            status,
            savedMonthlyInr: status === 'done' ? e.savedMonthlyInr : null,
            proofRef: status === 'done' ? e.proofRef : null,
            updatedAt: now,
          },
    ),
  };
}

const STOPPED = new Set(['cancelled_confirmed_by_user', 'pause_confirmed_by_user']);

/** Evidence for one entry, from the target obligation compared with its baseline. */
function evidence(
  e: LedgerEntry,
  data: Pick<AppData, 'commitments'>,
): { saved: number; ref: string } | null {
  const b = e.baseline;
  if (!b) return null;
  const ob = data.commitments.find((c) => c.id === b.obligationId);
  if (!ob || ob.deletedAt) return null;
  if (b.monthlyPaise === null || b.monthlyPaise <= 0) return null;
  if (STOPPED.has(ob.status) && !STOPPED.has(b.status)) {
    const kind = ob.status === 'cancelled_confirmed_by_user' ? 'cancelled' : 'paused';
    return { saved: b.monthlyPaise / 100, ref: `obligation:${ob.id}:${kind}` };
  }
  const monthly = obligationMonthlyInr(ob);
  if (monthly === null) return null;
  const drop = b.monthlyPaise / 100 - monthly;
  if (drop < 1) return null;
  const imported = ob.amount?.source?.kind && ob.amount.source.kind !== 'manual';
  const ref = imported
    ? `import:${ob.amount.source.rawRef ?? ob.amount.source.kind}`
    : `obligation:${ob.id}:amount_drop`;
  return { saved: drop, ref };
}

/**
 * Turns 'done' entries into saved ones where the data proves it. Saved = the real monthly drop
 * of the target obligation (or its whole cost when the user cancelled or paused it), rounded.
 * Entries without evidence keep savedMonthlyInr null.
 */
export function proveSavings(
  data: Pick<AppData, 'commitments'>,
  ledger: LedgerEntry[],
  now: string = new Date().toISOString(),
): LedgerEntry[] {
  return ledger.map((e) => {
    if (e.status !== 'done') return e;
    if (!e.baseline && e.targetObligationId) {
      const ob = data.commitments.find((c) => c.id === e.targetObligationId);
      if (!ob || ob.deletedAt) return e;
      const snap = snapshot(ob, now);
      if (!snap) return e;
      if (STOPPED.has(ob.status)) {
        // Marked done without a snapshot, and the user has since cancelled or paused it.
        // The amount they no longer pay is their own recorded amount.
        const monthly = snap.monthlyPaise;
        if (monthly === null || monthly <= 0) return e;
        const kind = ob.status === 'cancelled_confirmed_by_user' ? 'cancelled' : 'paused';
        return {
          ...e,
          baseline: { ...snap, status: 'active' },
          savedMonthlyInr: Math.round(monthly / 100),
          proofRef: `obligation:${ob.id}:${kind}`,
          updatedAt: now,
        };
      }
      // No change yet: today's record is the "before" picture for later evidence.
      return { ...e, baseline: snap, updatedAt: now };
    }
    const ev = evidence(e, data);
    if (!ev)
      return e.savedMonthlyInr === null
        ? e
        : { ...e, savedMonthlyInr: null, proofRef: null, updatedAt: now };
    const saved = Math.round(ev.saved);
    if (e.savedMonthlyInr === saved && e.proofRef === ev.ref) return e;
    return { ...e, savedMonthlyInr: saved, proofRef: ev.ref, updatedAt: now };
  });
}

export interface ReturnRatio {
  planFeeMonthlyInr: number;
  foundMonthlyInr: number;
  savedMonthlyInr: number;
  /** found ÷ plan fee; null when the fee is 0. Internal KPI only, never shown as a promise. */
  foundRatio: number | null;
  savedRatio: number | null;
}

/** Found (open + done, not dismissed) and proven-saved totals against the plan fee. */
export function returnRatio(
  ledger: LedgerEntry[],
  planFee: number = planFeeMonthlyInr(),
): ReturnRatio {
  const found = ledger
    .filter((e) => e.status !== 'dismissed')
    .reduce((s, e) => s + e.foundMonthlyInr, 0);
  const saved = ledger.reduce(
    (s, e) => s + (e.status === 'done' ? (e.savedMonthlyInr ?? 0) : 0),
    0,
  );
  const ratio = (n: number) => (planFee > 0 ? Math.round((n / planFee) * 100) / 100 : null);
  return {
    planFeeMonthlyInr: planFee,
    foundMonthlyInr: found,
    savedMonthlyInr: saved,
    foundRatio: ratio(found),
    savedRatio: ratio(saved),
  };
}
