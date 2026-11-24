/**
 * The UI's only door to the Savings engine (src/lib/savings/index.ts). Keeps call sites stable if an
 * engine signature changes, and makes every network call failure-tolerant.
 */
import {
  addCardBill,
  addLoanEmi,
  parseCardStatementSummary,
  parseLoanStatement,
  type CardStatementSummary,
  type LoanStatementSummary,
  computeMoves,
  defaultSavingsState,
  detectRecurring,
  fetchCommunity,
  fetchSavingsCatalog,
  markMove,
  markResearchSent,
  parseStatementText,
  postReport,
  postResearch,
  proveSavings,
  removeCommuteLeg,
  setCityPack,
  setCommunityOptIn,
  setHomeLocality,
  setOverride,
  upsertCommuteLeg,
  loadSavingsCatalogCache,
  unsentResearch,
  type CommunityItem,
  type CommuteLegInput,
  type LedgerEntry,
  type Move,
  type MoveStatus,
  type RecurringCandidate,
  type ResearchNeed,
  type SavingsCatalog,
  type SavingsState,
  type StatementLine,
} from '../../lib/savings';
import type { AppData } from '../../lib/types';

export type CommunityRow = CommunityItem;

/** Last good catalog kept on this device, for a fast first paint and offline use. */
export function cachedCatalog(): SavingsCatalog | null {
  try {
    return loadSavingsCatalogCache()?.catalog ?? null;
  } catch {
    return null;
  }
}

/** Research needs not yet sent from this device. */
export function unsent(needs: ResearchNeed[], state: SavingsState): ResearchNeed[] {
  return unsentResearch(needs, state);
}

export function savingsOf(d: AppData): SavingsState {
  return (d as AppData & { savings?: SavingsState }).savings ?? defaultSavingsState();
}

export function computeMovesFor(
  data: AppData,
  catalog: SavingsCatalog,
  now: string,
): { moves: Move[]; research: ResearchNeed[] } {
  try {
    const r = computeMoves(data, catalog, now);
    return { moves: r.moves, research: r.research };
  } catch {
    return { moves: [], research: [] };
  }
}

export async function loadCatalog(): Promise<SavingsCatalog | null> {
  try {
    const r = await fetchSavingsCatalog();
    return r.catalog;
  } catch {
    return null;
  }
}

export function proveLedger(data: AppData, ledger: LedgerEntry[]): LedgerEntry[] {
  try {
    return proveSavings(data, ledger);
  } catch {
    return ledger;
  }
}

export function markMoveIn(
  data: AppData,
  state: SavingsState,
  move: Move,
  status: MoveStatus,
  now: string,
): SavingsState {
  return markMove(state, move.id, status, { now, move, data });
}

export async function sendResearch(need: ResearchNeed, cityPack: string | null): Promise<boolean> {
  try {
    const r = await postResearch(
      { providerLabel: need.providerLabel, category: need.category },
      cityPack,
    );
    return !!r;
  } catch {
    return false;
  }
}

export async function reportSaving(
  entry: LedgerEntry,
  moduleId: string | null,
  cityPack: string | null,
): Promise<void> {
  try {
    await postReport({
      moveKind: entry.kind,
      moduleId,
      cityPack,
      savedMonthlyInr: entry.savedMonthlyInr ?? 0,
    });
  } catch {
    /* anonymous report is best-effort */
  }
}

export async function loadCommunity(cityPack: string | null): Promise<CommunityRow[]> {
  try {
    const r = await fetchCommunity(cityPack);
    return r?.items ?? [];
  } catch {
    return [];
  }
}

export function parseStatement(text: string, source: StatementLine['source']): StatementLine[] {
  try {
    return parseStatementText(text, source);
  } catch {
    return [];
  }
}

export function findRecurring(lines: StatementLine[]): RecurringCandidate[] {
  try {
    return detectRecurring(lines);
  } catch {
    return [];
  }
}

export const profileEdits = {
  setCity: (s: SavingsState, id: string | null) => setCityPack(s, id),
  setHome: (s: SavingsState, loc: string | null) => setHomeLocality(s, loc),
  upsertLeg: (s: SavingsState, leg: CommuteLegInput) => upsertCommuteLeg(s, leg),
  removeLeg: (s: SavingsState, id: string) => removeCommuteLeg(s, id),
  setOverride: (s: SavingsState, key: string, value: number | null) => setOverride(s, key, value),
  setOptIn: (s: SavingsState, on: boolean) => setCommunityOptIn(s, on),
  markSent: (s: SavingsState, labels: string[]) => markResearchSent(s, labels),
};

/** Card statement summary (due date, totals, fees) from statement text, or null. */
export function readCardSummary(text: string): CardStatementSummary | null {
  try {
    return parseCardStatementSummary(text);
  } catch {
    return null;
  }
}

/** Loan statement / welcome letter summary from text, or null. */
export function readLoanSummary(text: string): LoanStatementSummary | null {
  try {
    return parseLoanStatement(text);
  } catch {
    return null;
  }
}

export { addCardBill, addLoanEmi };
