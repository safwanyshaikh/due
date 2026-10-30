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

export const TOAST_MS = 8000;

export interface ToastInput {
  message: string;
  /** Shows an Undo button that calls this. */
  undo?: () => void;
  tone?: 'info' | 'success' | 'error';
}

interface ToastState extends ToastInput {
  id: number;
  state: 'shown' | 'undone';
}

interface ToastCtx {
  show: (t: ToastInput) => void;
  dismiss: () => void;
}

const Ctx = createContext<ToastCtx | null>(null);

export function useToast(): ToastCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('ToastProvider missing');
  return c;
}

/**
 * One toast at a time. Toasts with Undo stay for 8 seconds (at least 6s as required), and the
 * timer pauses while the pointer or keyboard focus is on the toast.
 */
export function ToastProvider({
  children,
  durationMs = TOAST_MS,
}: {
  children: ReactNode;
  durationMs?: number;
}) {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [paused, setPaused] = useState(false);
  const seq = useRef(0);

  const show = useCallback((t: ToastInput) => {
    seq.current += 1;
    setPaused(false);
    setToast({ ...t, id: seq.current, state: 'shown' });
  }, []);
  const dismiss = useCallback(() => setToast(null), []);

  useEffect(() => {
    if (!toast || paused) return;
    const ms = toast.state === 'undone' ? 3000 : durationMs;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), ms);
    return () => clearTimeout(t);
  }, [toast, paused, durationMs]);

  const value = useMemo(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite" aria-atomic="true">
        {toast && (
          <div
            key={toast.id}
            className={`toast toast-${toast.state === 'undone' ? 'success' : (toast.tone ?? 'info')}`}
            data-testid="toast"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
          >
            <span className="toast-msg">{toast.message}</span>
            {toast.undo && toast.state === 'shown' && (
              <button
                type="button"
                className="btn btn-quiet btn-onink press"
                onClick={() => {
                  const fn = toast.undo!;
                  setToast({ ...toast, message: 'Undone', state: 'undone', undo: undefined });
                  fn();
                }}
              >
                Undo
              </button>
            )}
            <button
              type="button"
              className="icon-btn icon-btn-onink press"
              aria-label="Dismiss message"
              onClick={() => setToast(null)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
