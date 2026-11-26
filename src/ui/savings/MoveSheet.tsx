import { useId, useState, type FormEvent } from 'react';
import type { Assumption, Move, MoveStatus } from '../../lib/savings/types';
import { UNVERIFIED_PRICE } from '../../content/savings';
import { Sheet } from '../components/Sheet';
import { Badge } from '../components/ui';
import {
  CONFIDENCE_LABEL,
  CONFIDENCE_TONE,
  EFFORT_LABEL,
  SOURCE_KIND_LABEL,
  assumptionLead,
  assumptionValue,
  lastChecked,
  perMonth,
  rangeText,
  rupees,
} from './format';

/** One assumption as a chip: "We assumed 8 rides a month · Change". Editing saves an override. */
function AssumptionChip({
  a,
  onSave,
}: {
  a: Assumption;
  onSave: (key: string, value: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(a.value));
  const [err, setErr] = useState('');
  const id = useId();
  const text = `${assumptionLead(a)} ${assumptionValue(a)}`;
  if (!editing)
    return (
      <li className="sv-assume" data-assumption={a.key}>
        <span className="sv-assume-text">{text}</span>
        {a.editable && (
          <>
            <span aria-hidden="true"> · </span>
            <button
              type="button"
              className="text-btn press"
              aria-label={`Change: ${text}`}
              onClick={() => setEditing(true)}
            >
              Change
            </button>
          </>
        )}
      </li>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(val.replace(/[₹,\s]/g, ''));
    if (!val.trim() || !Number.isFinite(n) || n < 0) {
      setErr('Enter a number, 0 or more.');
      return;
    }
    // A typo such as an extra zero must not inflate the "found" total.
    if (n > (a.unit === '%' ? 100 : 1_000_000)) {
      setErr(a.unit === '%' ? 'Enter a percentage up to 100.' : 'Enter a smaller number.');
      return;
    }
    onSave(a.key, n);
    setEditing(false);
  };
  return (
    <li className="sv-assume sv-assume-edit" data-assumption={a.key}>
      <form className="sv-assume-form" onSubmit={submit} noValidate>
        <label htmlFor={id} className="label-like">
          {a.label}
          {a.unit && a.unit !== '₹' && a.unit !== '%' ? ` (${a.unit})` : ''}
          {a.unit === '₹' ? ' (₹)' : ''}
          {a.unit === '%' ? ' (%)' : ''}
        </label>
        <div className="btn-row">
          <input
            id={id}
            inputMode="decimal"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `${id}-err` : undefined}
            className="sv-num"
          />
          <button type="submit" className="btn btn-primary btn-sm press">
            Save
          </button>
          {a.source === 'you_entered' && (
            <button
              type="button"
              className="btn btn-quiet btn-sm press"
              onClick={() => {
                onSave(a.key, null);
                setEditing(false);
              }}
            >
              Use typical
            </button>
          )}
          <button
            type="button"
            className="btn btn-quiet btn-sm press"
            onClick={() => {
              setVal(String(a.value));
              setErr('');
              setEditing(false);
            }}
          >
            Cancel
          </button>
        </div>
        {err && (
          <small id={`${id}-err`} className="error-text">
            {err}
          </small>
        )}
      </form>
    </li>
  );
}

export function MoveSheet({
  move,
  status,
  onClose,
  onMark,
  onOverride,
  profileNote,
}: {
  move: Move;
  status: MoveStatus;
  onClose: () => void;
  onMark: (status: MoveStatus) => void;
  onOverride: (key: string, value: number | null) => void;
  /** Information line for a business profile's move (GST input tax credit), or null. */
  profileNote?: string | null;
}) {
  const settled = status === 'done' || status === 'dismissed';
  return (
    <Sheet
      title={move.title}
      onClose={onClose}
      footer={
        <div className="btn-row sv-sheet-actions">
          {move.action.url && (
            <a
              className="btn btn-primary press jelly"
              href={move.action.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {move.action.label || 'Open the official page'}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          )}
          {settled ? (
            <button type="button" className="btn btn-secondary press" onClick={() => onMark('new')}>
              Show this again
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-secondary press jelly"
                onClick={() => onMark('done')}
              >
                I did this
              </button>
              <button
                type="button"
                className="btn btn-quiet press"
                onClick={() => onMark('dismissed')}
              >
                Not for me
              </button>
            </>
          )}
        </div>
      }
    >
      <div className="stack-16" data-testid="move-sheet">
        <p>{move.why}</p>
        <div className="sv-sheet-amount">
          {move.severity === 'urgent' ? (
            <p className="sv-big">Fix this first</p>
          ) : (
            <>
              <p className="sv-big amt">{perMonth(move.monthlySavingInr)}</p>
              <p className="muted small">
                {Math.round(move.rangeInr[0]) === Math.round(move.rangeInr[1])
                  ? `About ${rupees(move.monthlySavingInr * 12)} a year. Check any upfront price on the provider’s page first.`
                  : `Likely range ${rangeText(move.rangeInr)} a month`}{' '}
                · {EFFORT_LABEL[move.effort]}
              </p>
            </>
          )}
          <div className="chips">
            <Badge tone={CONFIDENCE_TONE[move.confidence]}>
              {CONFIDENCE_LABEL[move.confidence]}
            </Badge>
            {move.unverifiedPrice && <Badge tone="warm">{UNVERIFIED_PRICE}</Badge>}
            {status === 'done' && <Badge tone="calm">You marked this done</Badge>}
          </div>
        </div>

        {move.assumptions.length > 0 && (
          <section aria-labelledby="sv-assume-h" className="stack-8">
            <h3 id="sv-assume-h" className="sv-h3">
              What this is based on
            </h3>
            <ul className="sv-assumes">
              {move.assumptions.map((a) => (
                <AssumptionChip key={a.key} a={a} onSave={onOverride} />
              ))}
            </ul>
          </section>
        )}

        {move.sources.length > 0 && (
          <section aria-labelledby="sv-src-h" className="stack-8">
            <h3 id="sv-src-h" className="sv-h3">
              Sources
            </h3>
            <ul className="sv-sources">
              {move.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noopener noreferrer" className="sv-src-link">
                    {s.label}
                    <span className="sr-only"> (opens in a new tab)</span>
                  </a>
                  <span className="muted small">
                    {[SOURCE_KIND_LABEL[s.kind], lastChecked(s)].filter(Boolean).join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {move.legalNote && <p className="muted small sv-legal">{move.legalNote}</p>}
        {profileNote && (
          <p className="muted small sv-legal" data-testid="move-profile-note">
            {profileNote}
          </p>
        )}
        <p className="muted small">
          Due never switches, cancels or pays anything. You decide on the provider’s own page.
        </p>
      </div>
    </Sheet>
  );
}
