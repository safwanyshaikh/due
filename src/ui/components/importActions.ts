import type { MutationResult } from '../../lib/audit';
import {
  addImportItems,
  approveImportItem,
  deleteImportRaw,
  editImportItem,
  ignoreImportItem,
  type ImportItem,
} from '../../lib/imports';
import type { UserEvent } from '../../lib/intake';
import { activeObligations } from '../../lib/obligations';
import { track } from '../../lib/telemetry';
import type { AppData } from '../../lib/types';
import { useApp } from '../store';
import { useAccount } from '../account/AccountContext';
import { useToast } from './Toast';
import { serverEventId } from '../lib/serverEvents';

type Edits = NonNullable<ImportItem['edits']>;

const hasEdits = (e: Edits) => Object.keys(e).length > 0;

export class AlreadyImportedError extends Error {
  constructor() {
    super('This text was already imported. Look for it in the review queue or your list.');
  }
}

/** Queue/draft actions for imported items. Each local change is audited and undoable. */
export function useImportActions() {
  const { mutate, ctx, current } = useApp();
  const { client } = useAccount();
  const toast = useToast();

  const remote = (p: Promise<unknown>, what: string) =>
    p.catch(() =>
      toast.show({
        message: `Saved on this device, but Due’s server couldn’t be updated (${what}). It will show again next time you check.`,
        tone: 'error',
      }),
    );

  const trackApprove = (item: ImportItem, edits: Edits, before: AppData) => {
    track('import_approved', {
      rawKind: item.raw.kind,
      matched: !!item.matchedObligationId,
      editedFields: Object.keys(edits).length,
    });
    if (activeObligations(before).length === 0)
      track('first_obligation_completed', { ruleKind: 'imported', source: 'import' });
  };

  return {
    /** Draft (not stored yet): queue + approve in one undoable step. */
    confirmDraft(
      item: ImportItem,
      userEvent: UserEvent | null,
      edits: Edits,
      opts: { createNew: boolean },
    ): boolean {
      const before = current();
      const r = mutate(
        (d): MutationResult[] => {
          const staged: ImportItem = hasEdits(edits)
            ? { ...item, edits: { ...(item.edits ?? {}), ...edits }, status: 'edited' }
            : item;
          const a = addImportItems(d, [{ item: staged, userEvent: userEvent ?? undefined }], ctx());
          if (a.skipped.length) throw new AlreadyImportedError();
          const b = approveImportItem(a.data, item.id, ctx(), { createNew: opts.createNew });
          return [a, b];
        },
        { message: 'Saved. Review it on Home.' },
      );
      if (r) trackApprove(item, edits, before);
      return !!r;
    },
    /** Draft: keep it in the review queue to decide later. */
    queueDraft(item: ImportItem, userEvent: UserEvent | null): boolean {
      const r = mutate(
        (d) => {
          const a = addImportItems(d, [{ item, userEvent: userEvent ?? undefined }], ctx());
          if (a.skipped.length) throw new AlreadyImportedError();
          return a;
        },
        { message: 'Added to the review queue' },
      );
      return !!r;
    },
    approve(item: ImportItem, edits: Edits, opts: { createNew: boolean }): boolean {
      const before = current();
      const r = mutate((d): MutationResult[] => {
        const out: MutationResult[] = [];
        let base = d;
        if (hasEdits(edits)) {
          const e = editImportItem(base, item.id, edits, ctx());
          out.push(e);
          base = e.data;
        }
        out.push(approveImportItem(base, item.id, ctx(), { createNew: opts.createNew }));
        return out;
      });
      if (r) {
        trackApprove(item, edits, before);
        const sid = serverEventId(item);
        if (sid) void remote(client.confirmIntakeEvent(sid), 'confirm');
      }
      return !!r;
    },
    saveEdits(item: ImportItem, edits: Edits): boolean {
      if (!hasEdits(edits)) return true;
      return !!mutate((d) => editImportItem(d, item.id, edits, ctx()));
    },
    ignore(item: ImportItem): boolean {
      const r = mutate((d) => ignoreImportItem(d, item.id, ctx()));
      if (r) {
        track('import_ignored', { rawKind: item.raw.kind });
        const sid = serverEventId(item);
        if (sid) void remote(client.ignoreIntakeEvent(sid), 'ignore');
      }
      return !!r;
    },
    deleteRaw(item: ImportItem): boolean {
      const r = mutate((d) => deleteImportRaw(d, item.id, ctx()), {
        message: 'Raw text deleted. Reviewed fields are kept.',
      });
      if (r) {
        const sid = serverEventId(item);
        if (sid) void remote(client.deleteIntakeRaw(sid), 'delete raw');
      }
      return !!r;
    },
  };
}
