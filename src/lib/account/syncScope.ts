/**
 * What leaves the device when backup/sync is on (H3, minimum fix). The server stores the backup encrypted per
 * account, but the most revealing statement detail never goes there unless the person opts in:
 * - bank statements: the day-by-day morning balances, SMA (overdue-loan) recovery sweeps and recurring lines;
 * - UPI app statements: recurring lines.
 * Summaries the person saved (totals, failed auto-debits, price steps) still sync. When a server copy is
 * adopted, the local-only detail on this device is kept (merged back), so it is never lost by syncing.
 * See docs/production/E2E_SYNC_PLAN.md for the end-to-end encryption plan.
 */
import type { AppData } from '../types';
import type { BankStatementSummary, SavingsState, UpiStatementSummary } from '../savings/types';

export const STATEMENT_DETAIL_PREF = 'sync-statement-detail';

const bankKey = (b: Pick<BankStatementSummary, 'bank' | 'periodFrom' | 'periodTo'>) => `${b.bank ?? ''}|${b.periodFrom ?? ''}|${b.periodTo ?? ''}`;
const upiKey = (u: Pick<UpiStatementSummary, 'app' | 'periodFrom' | 'periodTo'>) => `${u.app}|${u.periodFrom ?? ''}|${u.periodTo ?? ''}`;

/** The copy to upload: statement detail removed unless `includeDetail`. Never mutates `data`. */
export function syncPayload(data: AppData, includeDetail: boolean): AppData {
  if (includeDetail || !data.savings) return data;
  const s: SavingsState = data.savings;
  const banks = s.banks?.map((b) => {
    const rest: BankStatementSummary = { ...b, morningBalances: [] };
    delete rest.smaSweeps;
    delete rest.recurring;
    return rest;
  });
  const upi = s.upi?.map((u) => {
    const rest: UpiStatementSummary = { ...u };
    delete rest.recurring;
    return rest;
  });
  return {
    ...data,
    savings: { ...s, ...(banks ? { banks } : {}), ...(upi ? { upi } : {}) },
  };
}

/** Puts this device's local-only statement detail back into an adopted server copy. */
export function mergeLocalDetail(server: AppData, local: AppData): AppData {
  const lb = new Map((local.savings?.banks ?? []).map((b) => [bankKey(b), b]));
  const lu = new Map((local.savings?.upi ?? []).map((u) => [upiKey(u), u]));
  if (!server.savings || (!lb.size && !lu.size)) return server;
  const banks = server.savings.banks?.map((b) => {
    const l = lb.get(bankKey(b));
    if (!l) return b;
    return {
      ...b,
      morningBalances: b.morningBalances?.length ? b.morningBalances : l.morningBalances,
      ...(b.smaSweeps || !l.smaSweeps ? {} : { smaSweeps: l.smaSweeps }),
      ...(b.recurring || !l.recurring ? {} : { recurring: l.recurring }),
    };
  });
  const upi = server.savings.upi?.map((u) => {
    const l = lu.get(upiKey(u));
    return l && !u.recurring && l.recurring ? { ...u, recurring: l.recurring } : u;
  });
  return { ...server, savings: { ...server.savings, ...(banks ? { banks } : {}), ...(upi ? { upi } : {}) } };
}
