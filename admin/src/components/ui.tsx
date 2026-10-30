import type { ReactNode } from 'react';
import { useId } from 'react';

export function LiveStatus({ status }: { status: { kind: 'ok' | 'error'; text: string } | null }) {
  return (
    <div className="live" role="status" aria-live="polite">
      {status ? <p className={status.kind === 'error' ? 'msg msg-error' : 'msg msg-ok'}>{status.text}</p> : null}
    </div>
  );
}

export function ErrorMessage({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="msg msg-error" role="alert">
      {text}
    </p>
  );
}

/** Loading / error / empty wrapper for API-backed content. */
export function Loadable({
  loading,
  error,
  empty,
  emptyText = 'Data unavailable',
  children,
}: {
  loading: boolean;
  error: string | null;
  empty?: boolean;
  emptyText?: ReactNode;
  children: ReactNode;
}) {
  if (loading) {
    return (
      <p className="muted" role="status" aria-live="polite">
        Loading…
      </p>
    );
  }
  if (error) {
    return (
      <div className="empty" role="alert">
        <strong>Data unavailable.</strong> {error}
      </div>
    );
  }
  if (empty) return <div className="empty">{emptyText}</div>;
  return <>{children}</>;
}

export function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'review' | 'error' | 'accent'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function statusTone(s: string | null | undefined): 'neutral' | 'ok' | 'review' | 'error' | 'accent' {
  switch (s) {
    case 'verified':
    case 'approved':
    case 'active':
    case 'success':
    case 'changed':
    case 'unchanged':
    case 'not_modified':
      return 'ok';
    case 'pending':
    case 'unverified':
    case 'running':
    case 'research_snapshot':
      return 'review';
    case 'rejected':
    case 'failed':
    case 'error':
    case 'failing':
    case 'inaccessible':
    case 'blocked_robots':
      return 'error';
    default:
      return 'neutral';
  }
}

interface FieldProps {
  label: string;
  hint?: string;
  children: (id: string, describedBy?: string) => ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, hintId)}
      {hint ? (
        <p className="hint" id={hintId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function PageHeader({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {children ? <div className="muted">{children}</div> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </header>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          className={value === o.value ? 'tab active' : 'tab'}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  return <pre className="json">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>;
}

export function ExternalLink({ href, children }: { href: string | null | undefined; children?: ReactNode }) {
  if (!href) return <span className="muted">—</span>;
  const safe = /^https?:\/\//i.test(href) ? href : undefined;
  if (!safe) return <span>{href}</span>;
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children ?? href}
    </a>
  );
}
