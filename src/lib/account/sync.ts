/**
 * Sync reconciliation rules (pure). The device remembers the server version it last synced
 * (`lastSyncedVersion`) and whether local data changed since (`dirty`). On app start and on
 * sign-in the app reads the server copy and decides:
 *
 * - same version: push when local changed, otherwise nothing to do;
 * - server newer, local unchanged: adopt the server copy;
 * - server newer and local changed: both changed, so the person chooses (conflict sheet);
 * - server older than what this device saw (account data reset): an empty server gets this
 *   device's copy; a server that holds other data is a conflict, never overwritten silently.
 */
export type ReconcileAction = 'none' | 'push' | 'adopt' | 'conflict';

export interface ReconcileInput {
  serverVersion: number;
  serverHasData: boolean;
  lastSyncedVersion: number;
  dirty: boolean;
}

export function reconcileAction(i: ReconcileInput): ReconcileAction {
  if (i.serverVersion === i.lastSyncedVersion) return i.dirty ? 'push' : 'none';
  if (i.serverVersion > i.lastSyncedVersion) {
    if (!i.serverHasData) return i.dirty ? 'push' : 'none';
    return i.dirty ? 'conflict' : 'adopt';
  }
  return i.serverHasData ? 'conflict' : 'push';
}

/** Per-account sync state kept on this device. */
export interface SyncPref {
  on: boolean;
  /** Server version this device last pushed or adopted. */
  version: number;
  lastSyncedAt: string | null;
  /** Local data changed since the last successful sync. */
  dirty: boolean;
}

export const SYNC_PREF_OFF: SyncPref = { on: false, version: 0, lastSyncedAt: null, dirty: false };

/** Reads a stored pref, tolerating older shapes and garbage. */
export function normaliseSyncPref(v: unknown): SyncPref {
  if (!v || typeof v !== 'object') return SYNC_PREF_OFF;
  const o = v as Partial<SyncPref>;
  return {
    on: o.on === true,
    version: typeof o.version === 'number' && o.version >= 0 ? o.version : 0,
    lastSyncedAt: typeof o.lastSyncedAt === 'string' ? o.lastSyncedAt : null,
    // Older builds did not track this: assume local changes so nothing is overwritten silently.
    dirty: typeof o.dirty === 'boolean' ? o.dirty : true,
  };
}
