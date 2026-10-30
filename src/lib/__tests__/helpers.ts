import { blankCommitment, emptyData, setStatementLink } from '../data';
import { reconcileObligation, withMirrors } from '../provenance';
import type { AppData, Commitment } from '../types';

/** Test record: v1-style overrides on a blank record, reconciled into consistent v2 fields. */
export function mk(over: Partial<Commitment> & { id: string }): Commitment {
  const type = over.type ?? 'bill';
  return reconcileObligation({ ...blankCommitment(type, '2026-01-01'), provider: 'P', ...over });
}

export function dataWith(...cs: Commitment[]): AppData {
  return { ...emptyData(), commitments: cs };
}

export const NOW = '2026-10-30T06:00:00.000Z';
export const TODAY = '2026-10-30';
export const ctx = (now = NOW, today = TODAY) => ({ now, today });

export { setStatementLink };

/** Test record built from v2 fields (mirrors derived from them). */
export function ob(over: Partial<Commitment> & { id: string }): Commitment {
  const type = over.type ?? 'bill';
  return withMirrors({ ...blankCommitment(type, '2026-01-01'), provider: 'P', ...over });
}
