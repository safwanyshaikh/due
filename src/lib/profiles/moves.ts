/**
 * Savings moves and profiles: which profile a move belongs to, and the one information line a
 * business move may carry. Never tax advice beyond that line.
 */
import type { Move, ValueKind } from '../savings/types';
import type { AppData } from '../types';
import { findProfile, profileIdOf } from './profiles';
import { PERSONAL_PROFILE_ID } from './types';

/** The profile of a move: the profile of its first due; statement-only moves are Personal. */
export function moveProfileId(
  move: Pick<Move, 'obligationIds'>,
  data: Pick<AppData, 'commitments' | 'profiles'>,
): string {
  for (const id of move.obligationIds) {
    const c = data.commitments.find((x) => x.id === id);
    if (c) return profileIdOf(c, data);
  }
  return PERSONAL_PROFILE_ID;
}

export function withMoveProfiles<M extends Move>(
  moves: M[],
  data: Pick<AppData, 'commitments' | 'profiles'>,
): M[] {
  return moves.map((m) => ({ ...m, profileId: moveProfileId(m, data) }));
}

export const GST_NOTE =
  'Business expense? A GST-registered business may be able to claim input tax credit — check with your CA.';

/** Spending moves (not loan or card-debt rates) where a business may have paid GST. */
const GST_KINDS = new Set<ValueKind>([
  'overlap',
  'period_switch',
  'membership_breakeven',
  'commute_pass',
  'price_change',
  'trial_end',
  'fee_leak',
]);

/**
 * The GST information line for a move, or null. Shown only for a business profile that did not say
 * it is unregistered, and only for spending moves.
 */
export function gstNoteFor(
  move: Pick<Move, 'kind' | 'obligationIds'> & { profileId?: string },
  data: Pick<AppData, 'commitments' | 'profiles'>,
): string | null {
  const id = move.profileId ?? moveProfileId(move, data);
  const p = findProfile(data, id);
  if (!p || p.kind !== 'business' || p.gstRegistered === false) return null;
  return GST_KINDS.has(move.kind) ? GST_NOTE : null;
}
