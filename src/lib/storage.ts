import { emptyData } from './data';
import type { AppData } from './types';

export const STORAGE_KEY = 'payables-planner:v1';

export function loadData(storage: Pick<Storage, 'getItem'> | null = safeLocal()): AppData | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppData;
    if (parsed?.version !== 1 || !Array.isArray(parsed.commitments)) return null;
    return { ...emptyData(), ...parsed };
  } catch {
    return null;
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
