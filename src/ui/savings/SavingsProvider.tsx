import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  LedgerEntry,
  Move,
  MoveStatus,
  ResearchNeed,
  SavingsCatalog,
  SavingsState,
} from '../../lib/savings/types';
import type { AppData } from '../../lib/types';
import { useApp } from '../store';
import { readJsonPref, writeJsonPref } from '../lib/prefs';
import {
  cachedCatalog,
  computeMovesFor,
  loadCatalog,
  markMoveIn,
  proveLedger,
  reportSaving,
  savingsOf,
} from './engine';

export type SavingsPhase = 'loading' | 'ready' | 'unavailable';

export interface SavingsView {
  phase: SavingsPhase;
  catalog: SavingsCatalog | null;
  state: SavingsState;
  /** Ranked moves the person has not dismissed or finished. */
  open: Move[];
  /** Moves marked "I did this" (still waiting for proof, or proven). */
  done: Move[];
  all: Move[];
  research: ResearchNeed[];
  ledger: LedgerEntry[];
  foundMonthlyInr: number;
  savedMonthlyInr: number;
  statusOf: (moveId: string) => MoveStatus;
  /** Applies a pure SavingsState edit to AppData.savings. */
  edit: (fn: (s: SavingsState) => SavingsState) => void;
  mark: (move: Move, status: MoveStatus) => void;
  refresh: () => void;
}

const Ctx = createContext<SavingsView | null>(null);
const REPORTED_KEY = 'savings-reported';

function withSavings(d: AppData, s: SavingsState): AppData {
  return { ...d, savings: s } as AppData;
}

export function SavingsProvider({ children }: { children: ReactNode }) {
  const { data, update } = useApp();
  const [catalog, setCatalog] = useState<SavingsCatalog | null>(() => cachedCatalog());
  const [phase, setPhase] = useState<SavingsPhase>('loading');
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    void loadCatalog().then((c) => {
      inFlight.current = false;
      if (c) {
        setCatalog(c);
        setPhase('ready');
      } else setPhase('unavailable');
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const state = savingsOf(data);
  // Recomputed only when the data or the catalog change (cheap, pure, on device).
  const [now] = useState(() => new Date().toISOString());
  const computed = useMemo(
    () => (catalog ? computeMovesFor(data, catalog, now) : { moves: [], research: [] }),
    [data, catalog, now],
  );
  const ledger = useMemo(() => proveLedger(data, state.ledger), [data, state.ledger]);

  const statusOf = useCallback(
    (id: string): MoveStatus => ledger.find((l) => l.moveId === id)?.status ?? 'new',
    [ledger],
  );

  const open = computed.moves.filter((m) => {
    const s = statusOf(m.id);
    return s === 'new' || s === 'doing';
  });
  const done = computed.moves.filter((m) => statusOf(m.id) === 'done');
  const foundMonthlyInr = open.reduce((n, m) => n + m.monthlySavingInr, 0);
  const savedMonthlyInr = ledger.reduce((n, l) => n + (l.savedMonthlyInr ?? 0), 0);

  const edit = useCallback(
    (fn: (s: SavingsState) => SavingsState) => update((d) => withSavings(d, fn(savingsOf(d)))),
    [update],
  );
  const mark = useCallback(
    (move: Move, status: MoveStatus) =>
      update((d) =>
        withSavings(d, markMoveIn(d, savingsOf(d), move, status, new Date().toISOString())),
      ),
    [update],
  );

  // Opt-in only: one anonymous, rounded report per proven saving.
  const optIn = state.profile.communityOptIn;
  const cityPack = state.profile.cityPack;
  useEffect(() => {
    if (!optIn) return;
    const sent = new Set(readJsonPref<string[]>(REPORTED_KEY, []));
    const fresh = ledger.filter(
      (l) => l.savedMonthlyInr && l.savedMonthlyInr > 0 && !sent.has(l.moveId),
    );
    if (!fresh.length) return;
    for (const l of fresh) {
      sent.add(l.moveId);
      const moduleId = computed.moves.find((m) => m.id === l.moveId)?.moduleId ?? null;
      void reportSaving(l, moduleId, cityPack);
    }
    writeJsonPref(REPORTED_KEY, [...sent]);
  }, [optIn, ledger, computed.moves, cityPack]);

  const value: SavingsView = {
    phase,
    catalog,
    state,
    open,
    done,
    all: computed.moves,
    research: computed.research,
    ledger,
    foundMonthlyInr,
    savedMonthlyInr,
    statusOf,
    edit,
    mark,
    refresh,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSavings(): SavingsView {
  const c = useContext(Ctx);
  if (!c) throw new Error('SavingsProvider missing');
  return c;
}
