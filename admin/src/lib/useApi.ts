import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, request } from './api';

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Loads a GET endpoint; re-runs when `path` changes. Pass null to skip. */
export function useApi<T>(path: string | null, opts: { raw?: boolean } = {}): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [tick, setTick] = useState(0);
  const raw = opts.raw ?? false;
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    request<T>(path, { raw, signal: ctrl.signal })
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name === 'AbortError' || ctrl.signal.aborted) return;
        setError(errorText(e));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, raw, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Runs a mutation, tracking busy/status text for an aria-live region. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const run = useCallback(async <R,>(fn: () => Promise<R>, success?: string): Promise<R | undefined> => {
    setBusy(true);
    setStatus(null);
    try {
      const r = await fn();
      if (success) setStatus({ kind: 'ok', text: success });
      return r;
    } catch (e) {
      setStatus({ kind: 'error', text: errorText(e) });
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, status, setStatus, run };
}
