import { blankCommitment, emptyData, setStatementLink } from '../data';
import type { AppData, Commitment } from '../types';

export function mk(over: Partial<Commitment> & { id: string }): Commitment {
  const type = over.type ?? 'bill';
  return { ...blankCommitment(type, '2026-01-01'), provider: 'P', ...over };
}

export function dataWith(...cs: Commitment[]): AppData {
  return { ...emptyData(), commitments: cs };
}

export { setStatementLink };
