import { useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { ObligationView } from '../../lib/home';
import { markPaid, markReviewed, snooze } from '../../lib/mutations';
import { addDays, daysBetween, formatDate, isValidISO } from '../../lib/dates';
import { track } from '../../lib/telemetry';
import { useApp } from '../store';
import { nav } from '../lib/nav';
import { Badge, ConfidenceBadge, useSuccessRing } from './ui';
import { Sheet } from './Sheet';
import { Glyph } from './Glyph';
import { dayMonth, weekdayDate } from '../lib/format';

/** Mutations used from rows and cards; each shows an Undo toast via the store. */
export function useObligationActions() {
  const { mutate, ctx, today } = useApp();
  const occ = (v: ObligationView) => v.occurrenceDate ?? undefined;
  return {
    review(v: ObligationView) {
      const r = mutate((d) => markReviewed(d, v.id, ctx(), occ(v)));
      if (r) track('reminder_resolved', { action: 'reviewed' });
      return !!r;
    },
    paid(v: ObligationView) {
      const r = mutate((d) => markPaid(d, v.id, ctx(), occ(v)));
      if (r) {
        track('reminder_resolved', { action: 'paid' });
        if (v.date && v.date < today)
          track('missed_or_late', { daysLate: daysBetween(v.date, today) });
      }
      return !!r;
    },
    snooze(v: ObligationView, until: string) {
      const r = mutate((d) => snooze(d, v.id, until, ctx(), occ(v)));
      if (r) track('reminder_resolved', { action: 'snoozed' });
      return !!r;
    },
  };
}

export function WhySheet({ v, onClose }: { v: ObligationView; onClose: () => void }) {
  return (
    <Sheet title={`Why this? · ${v.nickname}`} onClose={onClose}>
      <dl className="why">
        <div>
          <dt>How it was matched</dt>
          <dd>{v.why.matchLogic}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{v.why.source}</dd>
        </div>
        <div>
          <dt>Last sync or import</dt>
          <dd>
            {v.why.lastSyncOrImport ??
              'None. You added this yourself, so nothing has been imported or synced for it.'}
          </dd>
        </div>
        <div>
          <dt>Confidence</dt>
          <dd>{v.why.confidence}</dd>
        </div>
        <div>
          <dt>Schedule</dt>
          <dd>{v.ruleText}</dd>
        </div>
      </dl>
      <p className="muted small">
        Due never pays, cancels or changes anything with a provider. Values come only from what you
        entered or approved.
      </p>
    </Sheet>
  );
}

export function SnoozeSheet({ v, onClose }: { v: ObligationView; onClose: () => void }) {
  const { today } = useApp();
  const actions = useObligationActions();
  const [custom, setCustom] = useState(addDays(today, 2));
  const opts: [string, string][] = [
    ['Tomorrow', addDays(today, 1)],
    ['In 3 days', addDays(today, 3)],
  ];
  if (v.date && v.date > addDays(today, 2))
    opts.push(['The day before it’s due', addDays(v.date, -1)]);
  const go = (until: string) => {
    if (actions.snooze(v, until)) onClose();
  };
  return (
    <Sheet title={`Snooze ${v.nickname}`} onClose={onClose}>
      <p className="muted">Snoozing only quiets reminders. The due date stays {v.dateText}.</p>
      <div className="stack-8">
        {opts.map(([label, d]) => (
          <button
            key={label}
            type="button"
            className="btn btn-secondary btn-block press"
            onClick={() => go(d)}
          >
            {label} <span className="muted small">({formatDate(d)})</span>
          </button>
        ))}
      </div>
      <div className="field2">
        <label htmlFor="snooze-custom">Or choose a date</label>
        <div className="inline-row">
          <input
            id="snooze-custom"
            type="date"
            min={addDays(today, 1)}
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary press"
            disabled={!isValidISO(custom) || custom <= today}
            onClick={() => go(custom)}
          >
            Snooze
          </button>
        </div>
      </div>
    </Sheet>
  );
}

export function ReviewSheet({ v, onClose }: { v: ObligationView; onClose: () => void }) {
  const actions = useObligationActions();
  const [why, setWhy] = useState(false);
  return (
    <Sheet title={`Review ${v.nickname}`} onClose={onClose}>
      <div className="review-summary">
        <p className="review-amount amt">
          {v.amountText} <span className="muted small">{v.currency}</span>
        </p>
        <p>
          {v.date ? weekdayDate(v.date) : 'No date yet'} · {v.statusText}
        </p>
        <p className="muted small">{v.ruleText}</p>
        <div className="chips">
          <ConfidenceBadge field="Date" c={v.dateConfidence} />
          {v.amountPaise !== null && <ConfidenceBadge field="Amount" c={v.amountConfidence} />}
          <Badge>{v.sourceBadge}</Badge>
          <Badge>{v.railText}</Badge>
        </div>
        <p className="muted small">
          {v.owner} · {v.reminderText}
        </p>
        {v.dateConfidence === 'estimated' && (
          <p>
            Date estimated. <a href={`#/edit/${encodeURIComponent(v.id)}`}>Want to adjust?</a>
          </p>
        )}
      </div>
      <div className="stack-8">
        <button
          type="button"
          className="btn btn-primary btn-block press"
          onClick={() => actions.review(v) && onClose()}
        >
          Mark reviewed
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-block press"
          onClick={() => actions.paid(v) && onClose()}
        >
          Mark paid
        </button>
        <a
          className="btn btn-secondary btn-block press"
          href={`#/edit/${encodeURIComponent(v.id)}`}
        >
          Edit date or amount
        </a>
        <a className="btn btn-quiet btn-block press" href={`#/item/${encodeURIComponent(v.id)}`}>
          Open full details
        </a>
        <button
          type="button"
          className="btn btn-quiet btn-block press"
          onClick={() => setWhy(true)}
        >
          Why this?
        </button>
      </div>
      {why && <WhySheet v={v} onClose={() => setWhy(false)} />}
    </Sheet>
  );
}

/** Hero obligation card: min 176px, radius 24px, padding 20px. */
export function HeroCard({ v }: { v: ObligationView }) {
  const [sheet, setSheet] = useState<null | 'review' | 'snooze' | 'why'>(null);
  const paid = v.status === 'paid';
  const risk = v.status === 'overdue';
  return (
    <article
      className={`hero ${risk ? 'hero-risk' : ''}`}
      data-block="hero"
      aria-labelledby="hero-name"
    >
      <div className="hero-top">
        <h2 id="hero-name" className="hero-name">
          {v.nickname}
        </h2>
        <p className="hero-amount amt">
          {v.amountText}
          {v.amountPaise !== null && <span className="hero-cur"> {v.currency}</span>}
        </p>
      </div>
      <div className="hero-meta">
        <div className="hero-meta-text">
          <p className="hero-line">
            {v.providerName !== v.nickname ? `${v.providerName} · ` : ''}
            {v.ruleText}
          </p>
          <p className="hero-line muted">
            {v.owner} · {v.reminderText}
          </p>
        </div>
        <button
          type="button"
          className="text-btn press"
          onClick={() => setSheet('why')}
          aria-label={`Why this? Explain ${v.nickname}`}
        >
          Why this?
        </button>
      </div>
      <p className="hero-date">
        <strong>{v.date ? weekdayDate(v.date) : 'No date yet'}</strong>
        <span className={`status ${risk ? 'status-risk' : ''}`}> · {v.statusText}</span>
      </p>
      <div className="chips">
        <ConfidenceBadge field="Date" c={v.dateConfidence} />
        {v.amountPaise !== null && <ConfidenceBadge field="Amount" c={v.amountConfidence} />}
        <Badge>
          {v.sourceBadge} · {v.railText}
        </Badge>
        {paid && <Badge tone="calm">You’re covered for this bill</Badge>}
      </div>
      <div className="hero-actions">
        <button
          type="button"
          className="btn btn-primary press"
          onClick={() => setSheet('review')}
          aria-label={`Review ${v.nickname}`}
        >
          Review
        </button>
        <button
          type="button"
          className="btn btn-secondary press"
          onClick={() => setSheet('snooze')}
          aria-label={`Snooze ${v.nickname}`}
        >
          <Glyph name="clock" size={18} /> Snooze
        </button>
        <a
          className="btn btn-secondary press"
          href={`#/edit/${encodeURIComponent(v.id)}`}
          aria-label={`Edit ${v.nickname}`}
        >
          <Glyph name="edit" size={18} /> Edit
        </a>
      </div>
      {sheet === 'review' && <ReviewSheet v={v} onClose={() => setSheet(null)} />}
      {sheet === 'snooze' && <SnoozeSheet v={v} onClose={() => setSheet(null)} />}
      {sheet === 'why' && <WhySheet v={v} onClose={() => setSheet(null)} />}
    </article>
  );
}

/** Compact 64px timeline row: service, date, amount, confidence, one inline action. */
export function TimelineRow({ v }: { v: ObligationView }) {
  const actions = useObligationActions();
  const [ring, fire] = useSuccessRing();
  const dm = v.date ? dayMonth(v.date) : null;
  const done = v.status === 'reviewed' || v.status === 'paid';
  return (
    <li className={`trow ${ring ? 'success-ring' : ''}`}>
      <a className="trow-main press" href={`#/item/${encodeURIComponent(v.id)}`}>
        <span className="trow-date" aria-hidden="true">
          <b>{dm?.day ?? '–'}</b>
          <small>{dm?.month ?? ''}</small>
        </span>
        <span className="trow-text">
          <span className="trow-name">{v.nickname}</span>
          <span className="trow-sub">
            <span className="sr-only">{v.dateText}. </span>
            {v.dateConfidenceText}
          </span>
        </span>
        <span className="trow-amt amt">{v.amountText}</span>
      </a>
      <button
        type="button"
        className={`icon-btn press ${done ? 'icon-btn-on' : ''}`}
        aria-pressed={done}
        aria-label={done ? `${v.nickname} reviewed` : `Mark ${v.nickname} reviewed`}
        disabled={done}
        onClick={() => actions.review(v) && fire()}
      >
        <Glyph name="check" />
      </button>
    </li>
  );
}

/** Full obligation row with every field, button actions and optional touch swipes. */
export function ObligationRow({ v }: { v: ObligationView }) {
  const actions = useObligationActions();
  const [sheet, setSheet] = useState<null | 'snooze' | 'why'>(null);
  const [reveal, setReveal] = useState<null | 'left' | 'right'>(null);
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const [ring, fire] = useSuccessRing();
  const done = v.status === 'reviewed' || v.status === 'paid';

  const down = (e: RPointerEvent) => {
    if (e.pointerType !== 'touch') return;
    start.current = { x: e.clientX, y: e.clientY };
  };
  const move = (e: RPointerEvent) => {
    if (!start.current) return;
    const ddx = e.clientX - start.current.x;
    if (Math.abs(e.clientY - start.current.y) > Math.abs(ddx)) return;
    setDx(Math.max(-96, Math.min(96, ddx)));
  };
  const up = () => {
    if (!start.current) return;
    start.current = null;
    if (dx > 56) setReveal('right');
    else if (dx < -56) setReveal('left');
    setDx(0);
  };

  return (
    <li className={`orow ${ring ? 'success-ring' : ''}`}>
      <div
        className="orow-body"
        style={dx ? { transform: `translateX(${dx}px)` } : undefined}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        <a className="orow-head press" href={`#/item/${encodeURIComponent(v.id)}`}>
          <span className="orow-title">
            <strong>{v.nickname}</strong>
            {v.providerName !== v.nickname && (
              <span className="muted small"> · {v.providerName}</span>
            )}
          </span>
          <span className="orow-amt amt">
            {v.amountText}
            {v.amountPaise !== null && <small className="muted"> {v.currency}</small>}
          </span>
        </a>
        <p className="orow-line">
          <strong>{v.dateText}</strong> · {v.statusText} · {v.ruleText}
        </p>
        <div className="chips">
          <ConfidenceBadge field="Date" c={v.dateConfidence} />
          {v.amountPaise !== null && <ConfidenceBadge field="Amount" c={v.amountConfidence} />}
          <Badge>{v.sourceBadge}</Badge>
        </div>
        <p className="muted small orow-line">
          {v.owner} · {v.railText} · {v.reminderText}
        </p>
        <div className="btn-row">
          <button
            type="button"
            className={`btn btn-secondary btn-sm press ${done ? 'is-on' : ''}`}
            aria-pressed={done}
            disabled={done}
            onClick={() => actions.review(v) && fire()}
            aria-label={done ? `${v.nickname} reviewed` : `Mark ${v.nickname} reviewed`}
          >
            <Glyph name="check" size={18} /> {done ? 'Reviewed' : 'Reviewed?'}
          </button>
          <button
            type="button"
            className="btn btn-quiet btn-sm press"
            onClick={() => setSheet('snooze')}
            aria-label={`Snooze ${v.nickname}`}
          >
            Snooze
          </button>
          <a
            className="btn btn-quiet btn-sm press"
            href={`#/edit/${encodeURIComponent(v.id)}`}
            aria-label={`Edit ${v.nickname}`}
          >
            Edit
          </a>
          <button
            type="button"
            className="btn btn-quiet btn-sm press"
            onClick={() => setSheet('why')}
            aria-label={`Why this? Explain ${v.nickname}`}
          >
            Why this?
          </button>
        </div>
      </div>
      {reveal && (
        <div className={`swipe-panel swipe-${reveal}`} role="group" aria-label="Quick actions">
          {reveal === 'right' ? (
            <>
              <button
                type="button"
                className="btn btn-primary btn-sm press"
                onClick={() => {
                  setReveal(null);
                  if (actions.review(v)) fire();
                }}
              >
                Mark reviewed
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm press"
                onClick={() => {
                  setReveal(null);
                  if (actions.paid(v)) fire();
                }}
              >
                Mark paid
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm press"
                onClick={() => {
                  setReveal(null);
                  setSheet('snooze');
                }}
              >
                Snooze
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm press"
                onClick={() => nav.go({ name: 'edit', id: v.id })}
              >
                Edit
              </button>
            </>
          )}
          <button
            type="button"
            className="btn btn-quiet btn-sm press"
            onClick={() => setReveal(null)}
          >
            Close
          </button>
        </div>
      )}
      {sheet === 'snooze' && <SnoozeSheet v={v} onClose={() => setSheet(null)} />}
      {sheet === 'why' && <WhySheet v={v} onClose={() => setSheet(null)} />}
    </li>
  );
}
