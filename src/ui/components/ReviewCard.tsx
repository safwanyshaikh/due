import { useState } from 'react';
import { effectiveFields, type ImportItem } from '../../lib/imports';
import { confidenceBand, type UserEvent } from '../../lib/intake';
import { findObligation } from '../../lib/obligations';
import { formatDate, isValidISO } from '../../lib/dates';
import { paiseToRupeeString, parseRupees } from '../../lib/money';
import { TYPE_SINGULAR, TYPES } from '../../lib/status';
import type { CommitmentType } from '../../lib/types';
import { useApp } from '../store';
import { Badge, ConfirmButton, Field } from './ui';
import { bandCopy, inr, localDateTime } from '../lib/format';

type Edits = NonNullable<ImportItem['edits']>;
type FieldKey = 'merchant' | 'amount' | 'date' | 'link';

const DATE_KINDS: [NonNullable<ImportItem['extracted']['dateKind']>, string][] = [
  ['due', 'Due date'],
  ['renewal', 'Renewal date'],
  ['trial_end', 'Trial ends'],
  ['paid', 'Already paid on'],
];
const CADENCES: [string, string][] = [
  ['', 'Not known'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Every 3 months'],
  ['half_yearly', 'Every 6 months'],
  ['annual', 'Yearly'],
];
const RAW_LABEL: Record<ImportItem['raw']['kind'], string> = {
  receipt_text: 'Pasted receipt',
  csv_row: 'CSV row',
  document: 'Uploaded document',
  forwarded_email: 'Forwarded email',
  shared_sms: 'Shared SMS',
};
const EXTRA_LABELS: Record<string, string> = {
  emi: 'EMI',
  interestRate: 'Interest rate',
  tenureMonths: 'Tenure',
  benefit: 'Benefit',
  referenceLabel: 'Reference',
  trialEnd: 'Trial ends',
  billingCycle: 'Billing cycle',
};

function FieldConfidence({ edited, n }: { edited: boolean; n: number | undefined }) {
  if (edited) return <Badge tone="calm">Edited by you</Badge>;
  const band = confidenceBand(n);
  return (
    <Badge tone={band === 'high' ? 'calm' : band === 'missing' ? 'plain' : 'warm'}>
      {bandCopy(band)}
    </Badge>
  );
}

function extraValue(k: string, v: unknown): string {
  if (k === 'emi' && typeof v === 'number') return inr(v);
  if (k === 'interestRate' && typeof v === 'number') return `${v}% a year`;
  if (k === 'tenureMonths' && typeof v === 'number') return `${v} months`;
  if (k === 'trialEnd' && typeof v === 'string' && isValidISO(v)) return formatDate(v);
  return String(v);
}

export interface ReviewActions {
  onConfirm: (edits: Edits, opts: { createNew: boolean }) => void;
  onIgnore: () => void;
  /** Draft documents: discard file/text from memory. Queued items: delete raw content. */
  onDelete?: () => void;
  deleteLabel?: string;
  onExport?: () => void;
  /** Queued items: persist edits without approving. */
  onSaveEdits?: (edits: Edits) => void;
  confirmLabel?: string;
}

/**
 * Editable review card for one extracted item. Every field shows its confidence; nothing is saved
 * as an obligation until Confirm. Raw provenance (redacted) stays visible.
 */
export function ReviewCard({
  item,
  userEvent,
  actions,
  headingLevel = 2,
}: {
  item: ImportItem;
  userEvent?: UserEvent | null;
  actions: ReviewActions;
  headingLevel?: 2 | 3;
}) {
  const { data } = useApp();
  const f = effectiveFields(item);
  const [editing, setEditing] = useState(false);
  const [merchant, setMerchant] = useState(f.merchant ?? '');
  const [amount, setAmount] = useState(paiseToRupeeString(f.amountPaise));
  const [date, setDate] = useState(f.date ?? '');
  const [cadence, setCadence] = useState<string>(f.cadence ?? '');
  const [type, setType] = useState<CommitmentType | ''>(f.commitmentType ?? '');
  const [link, setLink] = useState(f.link ?? '');
  const [createNew, setCreateNew] = useState(false);
  const [err, setErr] = useState('');
  const conf = item.extracted.confidencePerField;
  const editedSet = new Set<FieldKey>(
    Object.keys(item.edits ?? {}).map((k) => (k === 'amountPaise' ? 'amount' : k) as FieldKey),
  );
  const match = item.matchedObligationId ? findObligation(data, item.matchedObligationId) : null;
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const extras = Object.entries(userEvent?.extractedFields ?? {}).filter(
    ([k]) => k in EXTRA_LABELS,
  );

  const collect = (): Edits | null => {
    const e: Edits = {};
    const paise = amount.trim() ? parseRupees(amount) : null;
    if (amount.trim() && paise === null) {
      setErr('Enter the amount in rupees, like 649 or 1,950.50.');
      return null;
    }
    if (date && !isValidISO(date)) {
      setErr('Choose a valid date.');
      return null;
    }
    setErr('');
    if ((merchant.trim() || null) !== f.merchant) e.merchant = merchant.trim() || null;
    if (paise !== f.amountPaise) e.amountPaise = paise;
    if ((date || null) !== f.date) e.date = date || null;
    if ((link.trim() || null) !== f.link) e.link = link.trim() || null;
    if ((type || null) !== f.commitmentType)
      e.commitmentType = (type || null) as CommitmentType | null;
    if ((cadence || null) !== f.cadence) e.cadence = (cadence || null) as Edits['cadence'];
    return e;
  };

  const row = (label: string, key: FieldKey, value: string) => (
    <div className="rf-row">
      <dt>{label}</dt>
      <dd>
        <span>{value}</span>
        <FieldConfidence edited={editedSet.has(key)} n={conf[key]} />
      </dd>
    </div>
  );

  return (
    <article className="review-card panel2" aria-label={`Review ${f.merchant ?? 'imported item'}`}>
      <div className="section-head">
        <H>{f.merchant ?? 'Unknown merchant'}</H>
        <Badge>{RAW_LABEL[item.raw.kind]}</Badge>
      </div>

      {!editing ? (
        <dl className="rf">
          {row('Merchant', 'merchant', f.merchant ?? 'Not found')}
          {row(
            'Amount',
            'amount',
            f.amountPaise === null ? 'Not found' : `${inr(f.amountPaise)} INR`,
          )}
          {row(
            DATE_KINDS.find(([k]) => k === f.dateKind)?.[1] ?? 'Date',
            'date',
            f.date ? formatDate(f.date) : 'Not found',
          )}
          {row('Link', 'link', f.link ?? 'Not found')}
          <div className="rf-row">
            <dt>Type · cycle</dt>
            <dd>
              {f.commitmentType ? TYPE_SINGULAR[f.commitmentType] : 'Type not found'} ·{' '}
              {CADENCES.find(([k]) => k === (f.cadence ?? ''))?.[1]}
            </dd>
          </div>
          {extras.map(([k, v]) => (
            <div className="rf-row" key={k}>
              <dt>{EXTRA_LABELS[k]}</dt>
              <dd>
                <span>{extraValue(k, v)}</span>
                <FieldConfidence edited={false} n={userEvent?.confidence[k]} />
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="stack-16">
          {err && (
            <p className="error-text" role="alert">
              {err}
            </p>
          )}
          <Field label="Merchant" htmlFor={`rv-m-${item.id}`}>
            <input
              id={`rv-m-${item.id}`}
              value={merchant}
              onChange={(e) => setMerchant(e.target.value)}
            />
          </Field>
          <div className="inline-row">
            <Field label="Amount (₹)" htmlFor={`rv-a-${item.id}`}>
              <input
                id={`rv-a-${item.id}`}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Type" htmlFor={`rv-t-${item.id}`}>
              <select
                id={`rv-t-${item.id}`}
                value={type}
                onChange={(e) => setType(e.target.value as CommitmentType | '')}
              >
                <option value="">Not known</option>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_SINGULAR[t]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="inline-row">
            <Field label="Date" htmlFor={`rv-d-${item.id}`}>
              <input
                id={`rv-d-${item.id}`}
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <div className="field2">
              <span className="label-like">Date means</span>
              <span className="muted">
                {DATE_KINDS.find(([k]) => k === f.dateKind)?.[1] ?? 'Not stated in the source'}
              </span>
            </div>
          </div>
          <Field label="Billing cycle" htmlFor={`rv-c-${item.id}`}>
            <select
              id={`rv-c-${item.id}`}
              value={cadence}
              onChange={(e) => setCadence(e.target.value)}
            >
              {CADENCES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Link" htmlFor={`rv-l-${item.id}`}>
            <input id={`rv-l-${item.id}`} value={link} onChange={(e) => setLink(e.target.value)} />
          </Field>
        </div>
      )}

      {match ? (
        <div className="match">
          <p>
            <strong>Matches “{match.nickname || match.provider}”.</strong>{' '}
            <span className="muted small">{item.matchReason}</span>
          </p>
          <div className="seg2" role="radiogroup" aria-label="What to do with the match">
            <button
              type="button"
              role="radio"
              aria-checked={!createNew}
              className="press"
              onClick={() => setCreateNew(false)}
            >
              Update that item
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={createNew}
              className="press"
              onClick={() => setCreateNew(true)}
            >
              Add as new item
            </button>
          </div>
          <p className="muted small">
            Updating changes only the amount and the matching occurrence; the schedule is not
            rewritten.
          </p>
        </div>
      ) : (
        <p className="muted small">
          No existing item matches. Confirming adds a new item
          {f.cadence ? '' : ' with no fixed schedule (Due won’t invent one)'}.
        </p>
      )}

      <details className="raw">
        <summary className="press">Raw source and provenance</summary>
        <dl className="kv">
          <div>
            <dt>Source</dt>
            <dd>
              {RAW_LABEL[item.raw.kind]}
              {item.raw.fileName ? `: ${item.raw.fileName}` : ''}
            </dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd>{localDateTime(item.raw.receivedAt, data.settings.timezone)}</dd>
          </div>
          <div>
            <dt>Reference</dt>
            <dd>{item.raw.ref}</dd>
          </div>
          {userEvent?.sourceDomain && (
            <div>
              <dt>Sender domain</dt>
              <dd>{userEvent.sourceDomain} (sender alone is not proof)</dd>
            </div>
          )}
          {userEvent?.rawRetentionUntil && (
            <div>
              <dt>Raw text deleted by</dt>
              <dd>{localDateTime(userEvent.rawRetentionUntil, data.settings.timezone)}</dd>
            </div>
          )}
          {(item.redactions?.length ?? 0) > 0 && (
            <div>
              <dt>Masked</dt>
              <dd>
                {item.redactions!.map((r) => `${r.count} ${r.kind.replace(/_/g, ' ')}`).join(', ')}
              </dd>
            </div>
          )}
        </dl>
        {item.raw.text ? (
          <pre className="raw-text" tabIndex={0} aria-label="Redacted source text">
            {item.raw.text}
          </pre>
        ) : item.raw.row ? (
          <pre className="raw-text" tabIndex={0}>
            {JSON.stringify(item.raw.row, null, 2)}
          </pre>
        ) : (
          <p className="muted small">Raw content has been deleted. The reviewed fields remain.</p>
        )}
      </details>

      <div className="btn-row">
        {editing ? (
          <>
            <button
              type="button"
              className="btn btn-primary press"
              onClick={() => {
                const e = collect();
                if (!e) return;
                if (actions.onSaveEdits) {
                  actions.onSaveEdits(e);
                  setEditing(false);
                } else actions.onConfirm(e, { createNew });
              }}
            >
              {actions.onSaveEdits ? 'Save edits' : (actions.confirmLabel ?? 'Confirm')}
            </button>
            <button type="button" className="btn btn-quiet press" onClick={() => setEditing(false)}>
              Cancel edit
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-primary press"
              onClick={() => {
                const e = collect();
                if (e) actions.onConfirm(e, { createNew });
              }}
            >
              {actions.confirmLabel ?? 'Confirm'}
            </button>
            <button
              type="button"
              className="btn btn-secondary press"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button type="button" className="btn btn-secondary press" onClick={actions.onIgnore}>
              Ignore
            </button>
          </>
        )}
        {actions.onExport && (
          <button type="button" className="btn btn-quiet press" onClick={actions.onExport}>
            Export structured record
          </button>
        )}
        {actions.onDelete && (
          <ConfirmButton
            label={actions.deleteLabel ?? 'Delete document'}
            confirmLabel="Yes, delete"
            message="This removes the raw text now. Reviewed fields and the audit trail stay."
            className="btn btn-quiet press"
            onConfirm={actions.onDelete}
          />
        )}
      </div>
    </article>
  );
}
