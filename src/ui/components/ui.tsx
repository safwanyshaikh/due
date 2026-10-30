import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ValueConfidence } from '../../lib/types';
import { confidenceCopy, confidenceTone } from '../lib/format';

export function Badge({
  children,
  tone = 'plain',
  title,
}: {
  children: ReactNode;
  tone?: 'plain' | 'calm' | 'warm' | 'risk' | 'premium';
  title?: string;
}) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function ConfidenceBadge({ field, c }: { field: 'Date' | 'Amount'; c: ValueConfidence }) {
  return <Badge tone={confidenceTone(c)}>{confidenceCopy(field, c)}</Badge>;
}

/** Section heading row with optional trailing action. */
export function SectionHead({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="section-head">
      <h2 id={id}>{title}</h2>
      {children}
    </div>
  );
}

/** A panel (card) with an optional heading. */
export function Panel({
  title,
  children,
  id,
  className = '',
  actions,
}: {
  title?: string;
  children: ReactNode;
  id?: string;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={`panel2 ${className}`} aria-labelledby={title && id ? id : undefined}>
      {title && (
        <div className="section-head">
          <h2 id={id}>{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * In-page confirmation for destructive actions (never window.confirm). The first press reveals
 * an explanation plus "Yes, …" and "Keep" buttons.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  message,
  onConfirm,
  disabled,
  className = 'btn btn-danger press',
}: {
  label: string;
  confirmLabel: string;
  message: string;
  onConfirm: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) yes.current?.focus();
  }, [open]);
  if (!open)
    return (
      <button type="button" className={className} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  return (
    <div className="confirm" role="group" aria-label={label}>
      <p>{message}</p>
      <div className="btn-row">
        <button
          ref={yes}
          type="button"
          className="btn btn-danger press"
          onClick={() => {
            setOpen(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </button>
        <button type="button" className="btn btn-secondary press" onClick={() => setOpen(false)}>
          Keep
        </button>
      </div>
    </div>
  );
}

/** Field wrapper with a visible label (8px label/control gap). */
export function Field({
  label,
  hint,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field2">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <small className="hint">{hint}</small>}
    </div>
  );
}

export function Notice({
  tone = 'info',
  children,
  title,
}: {
  tone?: 'info' | 'warn' | 'ok';
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className={`notice2 notice-${tone}`} role={tone === 'warn' ? 'alert' : undefined}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

/** Adds the success ring class for 220ms after a successful action. */
export function useSuccessRing(): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (t.current) clearTimeout(t.current);
    },
    [],
  );
  return [
    on,
    () => {
      setOn(false);
      requestAnimationFrame(() => setOn(true));
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(() => setOn(false), 260);
    },
  ];
}
