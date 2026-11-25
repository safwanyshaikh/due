import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { getPlatform, isNative } from '../../lib/platform';

/** Re-lock after this long in the background (short enough to matter, long enough not to nag). */
export const RELOCK_AFTER_MS = 30_000;

/**
 * Native app lock. Off by default: when the person has not turned it on this renders its children
 * untouched. When on, nothing is shown until Face ID / fingerprint / device passcode succeeds, at launch
 * and after the app has been in the background for 30 seconds. In the browser it does nothing.
 */
export function AppLockGate({ children }: { children: ReactNode }) {
  const native = isNative();
  const [state, setState] = useState<'checking' | 'locked' | 'open'>(native ? 'checking' : 'open');
  const [failed, setFailed] = useState(false);
  const away = useRef<number | null>(null);
  const busy = useRef(false);

  const unlock = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const ok = await getPlatform().appLock.authenticate('Unlock Due');
    busy.current = false;
    setFailed(!ok);
    if (ok) setState('open');
  }, []);

  useEffect(() => {
    if (!native) return;
    let stop: (() => void) | undefined;
    let gone = false;
    void (async () => {
      const lock = getPlatform().appLock;
      if (await lock.isEnabled().catch(() => false)) {
        setState('locked');
        void unlock();
      } else setState('open');
      const off = await lock.onActiveChange(async (active) => {
        if (!active) {
          away.current = Date.now();
          return;
        }
        const since = away.current;
        away.current = null;
        if (since !== null && Date.now() - since >= RELOCK_AFTER_MS && (await lock.isEnabled())) {
          setState('locked');
          void unlock();
        }
      });
      if (gone) off();
      else stop = off;
    })();
    return () => {
      gone = true;
      stop?.();
    };
  }, [native, unlock]);

  if (state === 'open') return <>{children}</>;
  return (
    <main className="page2 app-lock" data-testid="app-lock">
      <h1>Due is locked</h1>
      {state === 'locked' && (
        <>
          <p className="muted">
            {failed
              ? 'That didn’t work. Try again.'
              : 'Unlock with Face ID, fingerprint or your passcode.'}
          </p>
          <button type="button" className="btn btn-primary press" onClick={() => void unlock()}>
            Unlock
          </button>
        </>
      )}
    </main>
  );
}
