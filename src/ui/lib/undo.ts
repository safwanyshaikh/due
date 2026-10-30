import { applyUndo, type MutationResult, type UndoRefusal } from '../../lib/audit';
import type { AppData } from '../../lib/types';

export type UndoOutcome = { ok: true; data: AppData } | { ok: false; reason: UndoRefusal };

/**
 * Undoes one or more mutation results (applied in order) against the current data.
 * When nothing else changed since the last result, the result's own `undo()` is used;
 * otherwise the audit event is undone with `applyUndo`, which refuses if the record changed.
 */
export function undoResults(current: AppData, results: MutationResult[], now: string): UndoOutcome {
  let d = current;
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i];
    if (d === r.data) {
      d = r.undo();
      continue;
    }
    const u = applyUndo(d, r.event.id, { now });
    if (!u.ok) return { ok: false, reason: u.reason };
    d = u.data;
  }
  return { ok: true, data: d };
}

export const UNDO_REFUSED: Record<Exclude<UndoOutcome, { ok: true }>['reason'], string> = {
  not_found: 'That change can no longer be found, so it can’t be undone.',
  already_undone: 'That change was already undone.',
  is_undo: 'An undo can’t itself be undone here.',
  changed_since: 'This item changed again since. Undo the later change first.',
  expired: 'Changes can only be undone shortly after you make them.',
};
