import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { todayInTz } from '../lib/dates';
import {
  backupCorrupt,
  clearStorage,
  listCorruptBackups,
  loadDataResult,
  removeCorruptBackup,
  saveData,
  type CorruptBackup,
} from '../lib/storage';
import { compactAudit } from '../lib/audit';
import { deleteAllData, emptyData } from '../lib/data';
import type { MutationResult } from '../lib/audit';
import { purgeExpiredRaw } from '../lib/imports';
import type { AppData } from '../lib/types';
import { useToast } from './components/Toast';
import { undoResults, UNDO_REFUSED } from './lib/undo';
import { errorMessage } from './lib/format';

export interface MutateOptions {
  /** Toast text; defaults to the audit event summary. `false` shows no toast. */
  message?: string | false;
  /** Called after a successful undo. */
  onUndo?: () => void;
}

interface Ctx {
  data: AppData;
  today: string;
  /** Plain state update (settings, legacy screens). Not audited. */
  update: (fn: (d: AppData) => AppData) => void;
  /** Replaces all data (sync "use server copy", restore). */
  replace: (d: AppData) => void;
  /**
   * Runs a domain mutation (or a chain where each result builds on the previous one), stores the
   * result, and shows an Undo toast that reverses it. Returns the last result, or null on error
   * (the error message is shown as a toast).
   */
  mutate: (
    fn: (d: AppData) => MutationResult | MutationResult[],
    opts?: MutateOptions,
  ) => MutationResult | null;
  /** Mutation context for the domain layer. */
  ctx: () => { now: string; today: string; actor: 'user' };
  wipe: () => void;
  persisted: boolean;
  /** Current data without waiting for a render (for async flows). */
  current: () => AppData;
  /**
   * A kept copy of saved data this device could not read (`due:corrupt-backup:<time>`), until the
   * person removes it. While set, nothing syncs automatically.
   */
  corruptBackup: CorruptBackup | null;
  /** Removes the kept copy (after the person exported it or decided they do not need it). */
  discardCorruptBackup: () => void;
}

interface Initial {
  data: AppData;
  backup: CorruptBackup | null;
  /** True when unreadable data could not be copied aside: saving would destroy it, so nothing is saved. */
  blockSave: boolean;
}

function initialState(initialData: AppData | undefined): Initial {
  const now = new Date().toISOString();
  if (initialData)
    return { data: initialData, backup: listCorruptBackups()[0] ?? null, blockSave: false };
  const r = loadDataResult();
  if (r.status === 'corrupt') {
    const backup = backupCorrupt(r.raw, now);
    return { data: emptyData(), backup, blockSave: backup === null };
  }
  return {
    data: compactAudit(r.status === 'ok' ? r.data : emptyData(), now),
    backup: listCorruptBackups()[0] ?? null,
    blockSave: false,
  };
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('AppProvider missing');
  return c;
}

export function AppProvider({
  children,
  initialData,
}: {
  children: ReactNode;
  initialData?: AppData;
}) {
  const toast = useToast();
  const [today] = useState(() => todayInTz());
  const [init] = useState(() => initialState(initialData));
  const [data, setData] = useState<AppData>(() =>
    purgeExpiredRaw(init.data, new Date().toISOString()),
  );
  const [persisted, setPersisted] = useState(!init.blockSave);
  const [corruptBackup, setCorruptBackup] = useState<CorruptBackup | null>(init.backup);
  const ref = useRef(data);
  const blockSave = useRef(init.blockSave);

  const apply = useCallback((next: AppData) => {
    ref.current = next;
    setData(next);
    if (blockSave.current) setPersisted(false);
    else setPersisted(saveData(next));
  }, []);

  const corruptRef = useRef(init.backup);
  const discardCorruptBackup = useCallback(() => {
    if (corruptRef.current) removeCorruptBackup(corruptRef.current.key);
    corruptRef.current = listCorruptBackups()[0] ?? null;
    setCorruptBackup(corruptRef.current);
  }, []);

  const update = useCallback((fn: (d: AppData) => AppData) => apply(fn(ref.current)), [apply]);

  const ctx = useCallback(
    () => ({ now: new Date().toISOString(), today, actor: 'user' as const }),
    [today],
  );

  const mutate = useCallback(
    (fn: (d: AppData) => MutationResult | MutationResult[], opts: MutateOptions = {}) => {
      let results: MutationResult[];
      try {
        const r = fn(ref.current);
        results = Array.isArray(r) ? r : [r];
      } catch (e) {
        toast.show({ message: errorMessage(e), tone: 'error' });
        return null;
      }
      if (!results.length) return null;
      const last = results[results.length - 1];
      apply(last.data);
      if (opts.message !== false) {
        toast.show({
          message: opts.message ?? last.event.summary,
          tone: 'success',
          undo: () => {
            const out = undoResults(ref.current, results, new Date().toISOString());
            if (out.ok) {
              apply(out.data);
              opts.onUndo?.();
            } else toast.show({ message: UNDO_REFUSED[out.reason], tone: 'error' });
          },
        });
      }
      return last;
    },
    [apply, toast],
  );

  const replace = useCallback((d: AppData) => apply(d), [apply]);
  const wipe = useCallback(() => {
    clearStorage();
    const d = deleteAllData();
    ref.current = d;
    setData(d);
  }, []);
  const current = useCallback(() => ref.current, []);

  const value = useMemo(
    () => ({
      data,
      today,
      update,
      replace,
      mutate,
      ctx,
      wipe,
      persisted,
      current,
      corruptBackup,
      discardCorruptBackup,
    }),
    [
      data,
      today,
      update,
      replace,
      mutate,
      ctx,
      wipe,
      persisted,
      current,
      corruptBackup,
      discardCorruptBackup,
    ],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
