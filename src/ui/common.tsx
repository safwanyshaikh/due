import type { ReactNode } from 'react';
import { formatDate } from '../lib/dates';
import { formatINR } from '../lib/money';
import { statusLabel } from '../lib/status';
import type { Commitment, Confidence } from '../lib/types';

export const inr = (p: number) => formatINR(p);

export function Badge({
  children,
  tone = 'plain',
}: {
  children: ReactNode;
  tone?: 'plain' | 'warm' | 'calm' | 'sample';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function ConfidenceBadge({ v }: { v: Confidence }) {
  return (
    <Badge tone={v === 'confirmed' ? 'calm' : 'warm'}>
      {v === 'confirmed' ? 'Confirmed by you' : v === 'estimate' ? 'Estimate' : 'Not sure'}
    </Badge>
  );
}

export function Card({
  title,
  children,
  right,
}: {
  title?: string;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <section className="card">
      {(title || right) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function CommitmentRow({
  c,
  linkedNote,
  onOpen,
}: {
  c: Commitment;
  linkedNote?: string;
  onOpen: (id: string) => void;
}) {
  return (
    <button className="row" onClick={() => onOpen(c.id)}>
      <span className="row-main">
        <strong>{c.nickname || c.provider}</strong>
        <small>
          {c.amountPaise === null ? 'Amount not entered' : inr(c.amountPaise)} · next{' '}
          {formatDate(c.nextDue)}
          {c.frequency !== 'one_time' ? ` · ${c.frequency.replace('_', ' ')}` : ' · one time'}
        </small>
        <small className="muted">
          {statusLabel(c.status)}
          {linkedNote ? ` · ${linkedNote}` : ''}
        </small>
      </span>
      <span className="row-side">
        <ConfidenceBadge v={c.amountConfidence} />
        {c.isSample && <Badge tone="sample">Sample data</Badge>}
      </span>
    </button>
  );
}

export function download(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
