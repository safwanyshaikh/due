import { migrateData } from './migrate';
import type { AppData, AppDataV1 } from './types';

/** Unchanged across data versions so existing local data is found and migrated in place. */
export const STORAGE_KEY = 'payables-planner:v1';

/** Prefix of the keys that keep an unreadable saved blob, e.g. `due:corrupt-backup:2026-10-30T10:00:00.000Z`. */
export const CORRUPT_BACKUP_PREFIX = 'due:corrupt-backup:';

export type LoadResult =
  | { status: 'empty' }
  | { status: 'ok'; data: AppData }
  /** Something is saved but it could not be read or migrated. `raw` is exactly what was stored. */
  | { status: 'corrupt'; raw: string };

/** Parses a stored blob. Unknown or damaged content is reported as corrupt, never silently dropped. */
export function parseStored(raw: string | null | undefined): LoadResult {
  if (raw === null || raw === undefined || raw === '') return { status: 'empty' };
  try {
    const parsed = JSON.parse(raw) as AppData | AppDataV1;
    if ((parsed?.version !== 1 && parsed?.version !== 2) || !Array.isArray(parsed.commitments))
      return { status: 'corrupt', raw };
    return { status: 'ok', data: migrateData(parsed) };
  } catch {
    return { status: 'corrupt', raw };
  }
}

export function loadDataResult(storage: Pick<Storage, 'getItem'> | null = safeLocal()): LoadResult {
  let raw: string | null;
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return { status: 'empty' };
  }
  return parseStored(raw);
}

/** Loaded data, or null when nothing usable is stored (see `loadDataResult` to tell empty from corrupt). */
export function loadData(storage: Pick<Storage, 'getItem'> | null = safeLocal()): AppData | null {
  const r = loadDataResult(storage);
  return r.status === 'ok' ? r.data : null;
}

export interface CorruptBackup {
  key: string;
  /** ISO time the copy was made (from the key). */
  at: string;
  raw: string;
}

/** Every kept copy of unreadable data, oldest first. */
export function listCorruptBackups(
  storage: Pick<Storage, 'getItem' | 'key' | 'length'> | null = safeLocal(),
): CorruptBackup[] {
  const out: CorruptBackup[] = [];
  try {
    if (!storage) return out;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(CORRUPT_BACKUP_PREFIX)) continue;
      const raw = storage.getItem(key);
      if (raw !== null) out.push({ key, at: key.slice(CORRUPT_BACKUP_PREFIX.length), raw });
    }
  } catch {
    /* storage blocked */
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Keeps an unreadable blob under `due:corrupt-backup:<timestamp>` so it is never overwritten.
 * The same blob is kept only once (reloading the page does not pile up copies).
 * Returns the backup, or null when storage refused the copy.
 */
export function backupCorrupt(
  raw: string,
  now: string,
  storage:
    (Pick<Storage, 'setItem'> & Pick<Storage, 'getItem' | 'key' | 'length'>) | null = safeLocal(),
): CorruptBackup | null {
  const existing = listCorruptBackups(storage).find((b) => b.raw === raw);
  if (existing) return existing;
  const key = `${CORRUPT_BACKUP_PREFIX}${now}`;
  try {
    if (!storage) return null;
    storage.setItem(key, raw);
    return { key, at: now, raw };
  } catch {
    return null;
  }
}

export function removeCorruptBackup(
  key: string,
  storage: Pick<Storage, 'removeItem'> | null = safeLocal(),
): void {
  if (!key.startsWith(CORRUPT_BACKUP_PREFIX)) return;
  try {
    storage?.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function saveData(
  data: AppData,
  storage: Pick<Storage, 'setItem'> | null = safeLocal(),
): boolean {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(data));
    return !!storage;
  } catch {
    return false;
  }
}

export function clearStorage(storage: Pick<Storage, 'removeItem'> | null = safeLocal()): void {
  try {
    storage?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

function safeLocal(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
