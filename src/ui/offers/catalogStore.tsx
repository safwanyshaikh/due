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
  fetchCatalog,
  loadCatalogCache,
  normaliseOffers,
  saveCatalogCache,
  type CatalogCache,
  type CatalogError,
} from '../../lib/offers/api';
import type { OfferRecord } from '../../lib/offers/types';
import { useApp } from '../store';

/**
 * loading: first request in flight. ready: the last request succeeded.
 * unavailable: the last request failed; any offers shown come from the last good response.
 */
export type CatalogPhase = 'loading' | 'ready' | 'unavailable';

export interface CatalogState {
  phase: CatalogPhase;
  offers: OfferRecord[];
  /** generatedAt of the response being shown, or null if none has ever succeeded. */
  generatedAt: string | null;
  error: CatalogError | null;
  busy: boolean;
  refresh: () => void;
}

const Ctx = createContext<CatalogState | null>(null);

export function CatalogProvider({ children }: { children: ReactNode }) {
  const { today } = useApp();
  const [cache, setCache] = useState<CatalogCache | null>(() => loadCatalogCache());
  const [phase, setPhase] = useState<CatalogPhase>('loading');
  const [error, setError] = useState<CatalogError | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const refresh = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    void fetchCatalog().then((r) => {
      inFlight.current = false;
      setBusy(false);
      if (r.ok) {
        saveCatalogCache(r.data);
        setCache(r.data);
        setError(null);
        setPhase('ready');
      } else {
        setError(r.error);
        setPhase('unavailable');
      }
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const offers = useMemo(() => (cache ? normaliseOffers(cache.offers, today) : []), [cache, today]);
  const value = useMemo<CatalogState>(
    () => ({ phase, offers, generatedAt: cache?.generatedAt ?? null, error, busy, refresh }),
    [phase, offers, cache, error, busy, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCatalog(): CatalogState {
  const c = useContext(Ctx);
  if (!c) throw new Error('CatalogProvider missing');
  return c;
}
