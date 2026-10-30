import type { Commitment, Rail } from './types';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface DuplicateCandidate {
  id?: string;
  provider: string;
  type: Commitment['type'];
  amountPaise: number | null;
}

/** Suggestions only. The user decides; nothing is merged automatically. */
export function findDuplicates(cand: DuplicateCandidate, existing: Commitment[]): Commitment[] {
  const p = norm(cand.provider);
  if (!p) return [];
  return existing.filter(
    (e) =>
      e.id !== cand.id &&
      norm(e.provider) === p &&
      (e.type === cand.type || (cand.amountPaise !== null && e.amountPaise === cand.amountPaise)),
  );
}

/** If an item says it is charged to a card, suggest the matching statement so it isn't counted twice. */
export function suggestStatementLinks(
  cand: { id?: string; type: Commitment['type']; rail: Rail; accountNickname: string },
  existing: Commitment[],
): Commitment[] {
  if (cand.type === 'credit_card' || cand.rail !== 'credit_card') return [];
  const nick = norm(cand.accountNickname);
  return existing.filter(
    (e) =>
      e.type === 'credit_card' &&
      e.id !== cand.id &&
      (nick === '' || norm(e.statement?.cardNickname ?? '') === nick),
  );
}
