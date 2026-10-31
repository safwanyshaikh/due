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
import {
  AccountApiError,
  createAccountClient,
  serverCopyFromConflict,
  type AccountClient,
} from '../../lib/account/client';
import type {
  EmailDeliveryState,
  Entitlements,
  MeResponse,
  ReminderPlanItem,
  SyncDocument,
} from '../../lib/account/types';
import { loadData } from '../../lib/storage';
import { planReminders } from '../../lib/reminderPlan';
import type { Entitlement } from '../../lib/plans';
import type { AppData } from '../../lib/types';
import { useApp } from '../store';
import { toDomainEntitlement } from '../lib/entitlement';
import { readJsonPref, writeJsonPref } from '../lib/prefs';
import { compactAudit } from '../../lib/audit';
import { normaliseSyncPref, reconcileAction, type SyncPref } from '../../lib/account/sync';
import { SYNC_BACKUP_CONSENT_VERSION } from '../../content/privacy';
import { hasReminderConsent } from '../lib/reminderConsent';
import { installTelemetry } from '../lib/telemetrySink';

export type AccountStatus = 'checking' | 'signed_out' | 'signed_in' | 'unreachable';

export interface SyncState {
  on: boolean;
  /** Server version this device last synced. */
  version: number;
  lastSyncedAt: string | null;
  /** Local data changed since the last sync. */
  dirty: boolean;
  /** 'paused': unreadable local data was kept aside; nothing syncs automatically until it is resolved. */
  status: 'off' | 'idle' | 'syncing' | 'error' | 'conflict' | 'paused';
  error: string | null;
  /** Server copy when a version conflict (409) or first-sync choice is pending. */
  conflict: SyncDocument<AppData> | null;
  emailDelivery: EmailDeliveryState | null;
}

interface AccountCtx {
  client: AccountClient;
  status: AccountStatus;
  me: MeResponse | null;
  entitlements: Entitlements | null;
  /** Domain mirror for display only; the server is the gate. */
  entitlement: Entitlement;
  refresh: () => Promise<void>;
  setEntitlements: (e: Entitlements) => void;
  signOut: (everywhere?: boolean) => Promise<void>;
  sync: SyncState;
  /** Turns sync on (recording the backup consent): uploads local data, or asks which copy to keep. */
  enableSync: () => Promise<void>;
  /** Turns sync off on this device. `reason` is shown in the sync panel. */
  disableSync: (reason?: string) => void;
  syncNow: () => Promise<void>;
  resolveConflict: (choice: 'mine' | 'server') => Promise<void>;
}

const Ctx = createContext<AccountCtx | null>(null);

export function useAccount(): AccountCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AccountProvider missing');
  return c;
}

const OFF: SyncState = {
  on: false,
  version: 0,
  lastSyncedAt: null,
  dirty: false,
  status: 'off',
  error: null,
  conflict: null,
  emailDelivery: null,
};

const PAUSED_COPY =
  'Sync is paused: some saved data on this device couldn’t be read. Export or remove the kept copy first.';
const CONSENT_COPY =
  'Backup and sync is off because the backup consent was withdrawn. Turn it on again to sync.';

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Sync failed');
const isConsentRequired = (e: unknown) =>
  e instanceof AccountApiError && e.code === 'consent_required';

function parseServerData(doc: SyncDocument<AppData>): AppData | null {
  if (!doc.data) return null;
  const raw = JSON.stringify(doc.data);
  return loadData({ getItem: () => raw });
}

/**
 * Reminder items the server can deliver (email only; push is not available in this release). Nothing is
 * sent until the person chose email as their reminder channel and agreed to it (see lib/reminderConsent).
 */
export function serverReminders(
  data: AppData,
  consented: boolean = hasReminderConsent('email'),
): ReminderPlanItem[] {
  if (!consented) return [];
  const plan = planReminders(data, new Date(), { available: { email: true } });
  return plan
    .filter((r) => r.channel === 'email' && !r.acknowledged)
    .slice(0, 200)
    .map((r) => ({
      obligationRef: r.obligationId,
      // The server rejects titles over 200 characters (which would fail the whole sync).
      title: r.title.slice(0, 200),
      dueDate: r.dueDate,
      remindAt: r.scheduledFor,
      channel: 'email' as const,
      timezone: r.timezone,
      quietHours: data.settings.quietHours ?? null,
    }));
}

export function AccountProvider({
  children,
  client: injected,
}: {
  children: ReactNode;
  client?: AccountClient;
}) {
  const client = useMemo(() => injected ?? createAccountClient(), [injected]);
  const { data, replace, current, corruptBackup } = useApp();
  const [status, setStatus] = useState<AccountStatus>('checking');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [entitlements, setEnt] = useState<Entitlements | null>(null);
  const [sync, setSync] = useState<SyncState>(OFF);
  const syncRef = useRef(sync);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);
  const accountId = me?.account.id ?? null;
  const accountRef = useRef<string | null>(null);
  const corruptRef = useRef(corruptBackup);
  useEffect(() => {
    corruptRef.current = corruptBackup;
  }, [corruptBackup]);
  /** The data object last pushed or adopted; any other object means local changes. */
  const syncedRef = useRef<AppData | null>(null);

  useEffect(() => installTelemetry(client), [client]);

  const savePref = useCallback(
    (s: Pick<SyncState, 'on' | 'version' | 'lastSyncedAt' | 'dirty'>) => {
      const id = accountRef.current;
      if (!id) return;
      const pref: SyncPref = {
        on: s.on,
        version: s.version,
        lastSyncedAt: s.lastSyncedAt,
        dirty: s.dirty,
      };
      writeJsonPref(`sync:${id}`, pref);
    },
    [],
  );

  /** Sync off on this device (pref kept so a later sign-in remembers the last synced version). */
  const turnOff = useCallback(
    (reason: string | null) => {
      const s = syncRef.current;
      savePref({ on: false, version: s.version, lastSyncedAt: s.lastSyncedAt, dirty: s.dirty });
      setSync({ ...OFF, error: reason });
    },
    [savePref],
  );

  const refresh = useCallback(async () => {
    try {
      const r = await client.me();
      accountRef.current = r.account.id;
      setMe(r);
      setEnt(r.entitlements);
      setStatus('signed_in');
      const pref = normaliseSyncPref(readJsonPref<unknown>(`sync:${r.account.id}`, null));
      let on = pref.on;
      let reason: string | null = null;
      if (on) {
        // A withdrawal recorded on any device stops sync here too.
        const consents = await client.getConsents().catch(() => null);
        if (consents?.current.sync_backup?.granted === false) {
          on = false;
          reason = CONSENT_COPY;
          writeJsonPref(`sync:${r.account.id}`, { ...pref, on: false });
        }
      }
      syncedRef.current = null;
      setSync(
        on
          ? {
              ...OFF,
              on: true,
              version: pref.version,
              lastSyncedAt: pref.lastSyncedAt,
              dirty: pref.dirty,
              status: 'idle',
            }
          : { ...OFF, error: reason },
      );
    } catch (e) {
      accountRef.current = null;
      setMe(null);
      setEnt(null);
      setSync(OFF);
      setStatus(e instanceof AccountApiError && e.status === 401 ? 'signed_out' : 'unreachable');
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Marks the given data as what the server holds at `version`. */
  const markSynced = useCallback(
    (synced: AppData, version: number, at: string | null, extra: Partial<SyncState> = {}) => {
      syncedRef.current = synced;
      const dirty = current() !== synced;
      const next = { on: true, version, lastSyncedAt: at, dirty };
      savePref(next);
      setSync((s) => ({ ...s, ...next, status: 'idle', error: null, conflict: null, ...extra }));
    },
    [current, savePref],
  );

  const push = useCallback(
    async (baseVersion: number) => {
      if (corruptRef.current) {
        setSync((s) => ({ ...s, status: 'paused', error: PAUSED_COPY }));
        return;
      }
      setSync((s) => ({ ...s, status: 'syncing', error: null }));
      try {
        const local = current();
        const r = await client.putData(
          baseVersion,
          compactAudit(local, new Date().toISOString()) as unknown as Record<string, unknown>,
          serverReminders(local),
        );
        markSynced(local, r.version, r.updatedAt, {
          emailDelivery: r.reminders?.emailDelivery ?? syncRef.current.emailDelivery,
        });
      } catch (e) {
        const server = serverCopyFromConflict<AppData>(e);
        if (server) setSync((s) => ({ ...s, status: 'conflict', conflict: server }));
        else if (isConsentRequired(e)) turnOff(CONSENT_COPY);
        else setSync((s) => ({ ...s, status: 'error', error: errorText(e) }));
      }
    },
    [client, current, markSynced, turnOff],
  );

  /** Adopts the server copy. Refuses (error) when it cannot be read, so nothing unknown replaces local data. */
  const adopt = useCallback(
    (doc: SyncDocument<AppData>) => {
      const serverData = parseServerData(doc);
      if (!serverData) {
        setSync((s) => ({
          ...s,
          status: 'error',
          error: 'The copy in your account couldn’t be read, so this device kept its own data.',
        }));
        return;
      }
      syncedRef.current = serverData;
      replace(serverData);
      markSynced(serverData, doc.version, doc.updatedAt);
    },
    [replace, markSynced],
  );

  /** Pulls the server copy and reconciles it with this device (app start, sign-in, "Sync now"). */
  const reconcile = useCallback(async () => {
    if (corruptRef.current) {
      setSync((s) => ({ ...s, status: 'paused', error: PAUSED_COPY }));
      return;
    }
    setSync((s) => ({ ...s, status: 'syncing', error: null }));
    try {
      const doc = await client.getData<AppData>();
      const s = syncRef.current;
      const dirty = s.dirty || (syncedRef.current !== null && current() !== syncedRef.current);
      const action = reconcileAction({
        serverVersion: doc.version,
        serverHasData: doc.data !== null,
        lastSyncedVersion: s.version,
        dirty,
      });
      if (action === 'adopt') adopt(doc);
      else if (action === 'push') await push(doc.version);
      else if (action === 'conflict') setSync((x) => ({ ...x, status: 'conflict', conflict: doc }));
      else {
        syncedRef.current = current();
        setSync((x) => ({ ...x, status: 'idle' }));
      }
    } catch (e) {
      setSync((s) => ({ ...s, status: 'error', error: errorText(e) }));
    }
  }, [client, current, adopt, push]);

  const enableSync = useCallback(async () => {
    if (corruptRef.current) {
      setSync((s) => ({ ...s, on: true, status: 'paused', error: PAUSED_COPY }));
      return;
    }
    setSync((s) => ({ ...s, on: true, status: 'syncing', error: null }));
    try {
      // Turning sync on is the consent to back up; it is recorded before anything is uploaded.
      await client.recordConsent('sync_backup', true, SYNC_BACKUP_CONSENT_VERSION);
      const doc = await client.getData<AppData>();
      const serverData = parseServerData(doc);
      const localHas = current().commitments.length > 0;
      if (!doc.data) await push(doc.version);
      else if (!serverData) adopt(doc);
      else if (!localHas) adopt(doc);
      else setSync((s) => ({ ...s, status: 'conflict', conflict: doc }));
    } catch (e) {
      setSync((s) => ({ ...s, status: 'error', error: errorText(e) }));
    }
  }, [client, current, push, adopt]);

  const disableSync = useCallback((reason?: string) => turnOff(reason ?? null), [turnOff]);

  const syncNow = useCallback(async () => {
    if (!syncRef.current.on) return;
    await reconcile();
  }, [reconcile]);

  const resolveConflict = useCallback(
    async (choice: 'mine' | 'server') => {
      const doc = syncRef.current.conflict;
      if (!doc) return;
      if (choice === 'mine') await push(doc.version);
      else adopt(doc);
    },
    [push, adopt],
  );

  // On app start and on sign-in: pull and reconcile once per account (after any kept copy of
  // unreadable data has been dealt with).
  const reconciledFor = useRef<string | null>(null);
  useEffect(() => {
    if (status !== 'signed_in' || !accountId) {
      reconciledFor.current = null;
      return;
    }
    if (!sync.on || corruptBackup || reconciledFor.current === accountId) return;
    reconciledFor.current = accountId;
    void reconcile();
  }, [status, accountId, sync.on, corruptBackup, reconcile]);

  // Track local changes (dirty) and push them (debounced) while sync is on and nothing is pending.
  const pushRef = useRef(push);
  useEffect(() => {
    pushRef.current = push;
  }, [push]);
  const canPush = status === 'signed_in' && sync.on && sync.status === 'idle' && !corruptBackup;
  useEffect(() => {
    if (!canPush) return;
    if (syncedRef.current === null) {
      syncedRef.current = data;
      if (!syncRef.current.dirty) return;
    } else if (syncedRef.current === data) return;
    if (!syncRef.current.dirty) {
      const s = syncRef.current;
      savePref({ on: true, version: s.version, lastSyncedAt: s.lastSyncedAt, dirty: true });
      setSync((x) => ({ ...x, dirty: true }));
    }
    const t = setTimeout(() => void pushRef.current(syncRef.current.version), 2000);
    return () => clearTimeout(t);
  }, [data, canPush, savePref]);

  const signOut = useCallback(
    async (everywhere = false) => {
      try {
        if (everywhere) await client.logoutAll();
        else await client.logout();
      } finally {
        accountRef.current = null;
        setMe(null);
        setEnt(null);
        setSync(OFF);
        setStatus('signed_out');
      }
    },
    [client],
  );

  const shownSync = useMemo<SyncState>(
    () =>
      corruptBackup && sync.on && sync.status !== 'conflict'
        ? { ...sync, status: 'paused', error: PAUSED_COPY }
        : sync,
    [sync, corruptBackup],
  );

  const value = useMemo<AccountCtx>(
    () => ({
      client,
      status,
      me,
      entitlements,
      entitlement: toDomainEntitlement(entitlements),
      refresh,
      setEntitlements: setEnt,
      signOut,
      sync: shownSync,
      enableSync,
      disableSync,
      syncNow,
      resolveConflict,
    }),
    [
      client,
      status,
      me,
      entitlements,
      refresh,
      signOut,
      shownSync,
      enableSync,
      disableSync,
      syncNow,
      resolveConflict,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
