import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { todayInTz } from '../lib/dates';
import { clearStorage, loadData, saveData } from '../lib/storage';
import { deleteAllData, emptyData } from '../lib/data';
import type { AppData } from '../lib/types';

interface Ctx {
  data: AppData;
  today: string;
  update: (fn: (d: AppData) => AppData) => void;
  wipe: () => void;
  persisted: boolean;
}

const AppCtx = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppCtx);
  if (!c) throw new Error('AppProvider missing');
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [today] = useState(() => todayInTz());
  const [data, setData] = useState<AppData>(() => loadData() ?? emptyData());
  const [persisted, setPersisted] = useState(true);

  useEffect(() => {
    saveData(data);
  }, [data]);

  const update = useCallback((fn: (d: AppData) => AppData) => {
    setData((d) => {
      const next = fn(d);
      setPersisted(saveData(next));
      return next;
    });
  }, []);
  const wipe = useCallback(() => {
    clearStorage();
    setData(deleteAllData());
  }, []);

  const value = useMemo(
    () => ({ data, today, update, wipe, persisted }),
    [data, today, update, wipe, persisted],
  );
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}
