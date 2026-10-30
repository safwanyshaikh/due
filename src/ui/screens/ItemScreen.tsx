import { useState } from 'react';
import {
  acknowledgeChanges,
  deleteObligation,
  restoreObligation,
  setObligationStatus,
  updateObligation,
} from '../../lib/mutations';
import { findObligation, liveHistory } from '../../lib/obligations';
import { obligationView } from '../../lib/home';
import { auditFor } from '../../lib/audit';
import { STATUS_LABELS, STATUS_NOTE } from '../../lib/status';
import { DEFAULT_OFFSETS } from '../../lib/reminders';
import { formatDate } from '../../lib/dates';
import { track } from '../../lib/telemetry';
import type { ReminderSeverity, DeliveryChannel } from '../../lib/reminderPlan';
import type { Commitment, Status } from '../../lib/types';
import { useApp } from '../store';
import { useObligationActions, SnoozeSheet, WhySheet } from '../components/obligation';
import { Badge, ConfidenceBadge, ConfirmButton, Field, Panel } from '../components/ui';
import { localDateTime } from '../lib/format';
import { nav } from '../lib/nav';

const STATUSES: Status[] = [
  'active',
  'trial',
  'review_needed',
  'pause_planned',
  'pause_confirmed_by_user',
  'cancel_pending',
  'cancelled_confirmed_by_user',
  'overdue_user_entered',
];

export function ItemScreen({ id }: { id: string }) {
  const { data } = useApp();
  const ob = findObligation(data, id);
  if (!ob)
    return (
      <div className="page2">
        <h1>Item not found</h1>
        <a className="btn btn-secondary press" href="#/">
          Back to Home
        </a>
      </div>
    );
  return <ItemDetail ob={ob} />;
}

function ItemDetail({ ob }: { ob: Commitment }) {
  const { data, today, mutate, ctx } = useApp();
  const v = obligationView(data, ob, today, data.settings.timezone);
  const actions = useObligationActions();
  const [sheet, setSheet] = useState<null | 'snooze' | 'why'>(null);
  const corrections = auditFor(data, ob.id);
  const history = liveHistory(ob).slice().reverse();
  const deleted = !!ob.deletedAt;

  return (
    <div className="page2">
      <header className="page-head">
        <h1>{v.nickname}</h1>
        <p className="muted">
          {v.providerName}
          {v.canonicalProvider ? ` · recognised as “${v.canonicalProvider}”` : ''}
        </p>
      </header>

      {deleted && (
        <div className="notice2 notice-warn">
          <strong>Deleted {formatDate(ob.deletedAt!.slice(0, 10))}</strong>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-secondary press"
              onClick={() => mutate((d) => restoreObligation(d, ob.id, ctx()))}
            >
              Restore
            </button>
          </div>
        </div>
      )}

      <section className="panel2 detail-card" aria-label="Summary">
        <p className="review-amount amt">
          {v.amountText}{' '}
          {v.amountPaise !== null && <span className="muted small">{v.currency}</span>}
        </p>
        <p>
          <strong>{v.dateText}</strong> · {v.statusText}
          {v.overridden && <> · moved for this occurrence</>}
        </p>
        <p className="muted">{v.ruleText}</p>
        <div className="chips">
          <ConfidenceBadge field="Date" c={v.dateConfidence} />
          {v.amountPaise !== null && <ConfidenceBadge field="Amount" c={v.amountConfidence} />}
          <Badge>{v.sourceBadge}</Badge>
          <Badge>{v.railText}</Badge>
        </div>
        <dl className="kv">
          <div>
            <dt>Owner</dt>
            <dd>{v.owner}</dd>
          </div>
          <div>
            <dt>Reminders</dt>
            <dd>{v.reminderText}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{STATUS_LABELS[ob.status]}</dd>
          </div>
        </dl>
        {!deleted && (
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary press"
              onClick={() => actions.review(v)}
            >
              Mark reviewed
            </button>
            <button
              type="button"
              className="btn btn-secondary press"
              onClick={() => actions.paid(v)}
            >
              Mark paid
            </button>
            <button
              type="button"
              className="btn btn-secondary press"
              onClick={() => setSheet('snooze')}
            >
              Snooze
            </button>
            <a className="btn btn-secondary press" href={`#/edit/${encodeURIComponent(ob.id)}`}>
              Edit
            </a>
            <button type="button" className="btn btn-quiet press" onClick={() => setSheet('why')}>
              Why this?
            </button>
          </div>
        )}
      </section>

      {(ob.pendingChanges?.length ?? 0) > 0 && (
        <Panel title="Changes to review" id="pc">
          <ul className="plain-list">
            {ob.pendingChanges!.map((p) => (
              <li key={p.id}>
                {p.field === 'amount' ? 'Amount' : 'Date'} changed from{' '}
                {String(p.from ?? 'not set')} to {String(p.to ?? 'not set')} ({p.sourceLabel})
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="btn btn-secondary press"
            onClick={() => mutate((d) => acknowledgeChanges(d, ob.id, ctx()))}
          >
            Looks right
          </button>
        </Panel>
      )}

      {!deleted && <ReminderPrefs ob={ob} />}

      <Panel title="Your status note" id="st">
        <Field label="Status" htmlFor="it-status" hint={STATUS_NOTE}>
          <select
            id="it-status"
            value={ob.status}
            onChange={(e) => {
              const status = e.target.value as Status;
              const r = mutate((d) => setObligationStatus(d, ob.id, status, ctx()));
              if (
                r &&
                ob.status === 'trial' &&
                (status === 'active' || status === 'cancelled_confirmed_by_user')
              )
                track('trial_converted', { kept: status === 'active' });
            }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </Field>
      </Panel>

      <Panel title="History and corrections" id="hist">
        {corrections.length === 0 && history.length === 0 ? (
          <p className="muted">No changes yet.</p>
        ) : (
          <ul className="audit-list">
            {corrections.map((e) => (
              <li key={e.id}>
                <span>{e.summary}</span>
                <span className="muted small">
                  {localDateTime(e.at, data.settings.timezone)} ·{' '}
                  {e.actor === 'user' ? 'you' : e.actor}
                </span>
              </li>
            ))}
          </ul>
        )}
        {history.length > 0 && (
          <p className="muted small">
            {history.length} payment/review event{history.length === 1 ? '' : 's'} recorded. Undoing
            adds a correction; nothing is deleted.
          </p>
        )}
      </Panel>

      {!deleted && (
        <Panel title="Delete" id="del">
          <p className="muted small">
            Deleting hides this item everywhere. It can be restored, and its history is kept.
          </p>
          <ConfirmButton
            label={`Delete ${v.nickname}`}
            confirmLabel="Yes, delete it"
            message={`Delete ${v.nickname}? You can undo this or restore it later.`}
            onConfirm={() => {
              if (mutate((d) => deleteObligation(d, ob.id, ctx()))) nav.go({ name: 'home' });
            }}
          />
        </Panel>
      )}

      {sheet === 'snooze' && <SnoozeSheet v={v} onClose={() => setSheet(null)} />}
      {sheet === 'why' && <WhySheet v={v} onClose={() => setSheet(null)} />}
    </div>
  );
}

function ReminderPrefs({ ob }: { ob: Commitment }) {
  const { mutate, ctx } = useApp();
  const r = ob.reminder;
  const [offsets, setOffsets] = useState(
    (r.offsets.length ? r.offsets : DEFAULT_OFFSETS).join(', '),
  );
  const save = (patch: Partial<Commitment['reminder']>) =>
    mutate((d) => updateObligation(d, ob.id, { reminder: { ...ob.reminder, ...patch } }, ctx()), {
      message: 'Reminder settings saved',
    });
  return (
    <Panel title="Reminders for this item" id="rem">
      <label className="switch-row">
        <input
          type="checkbox"
          checked={r.enabled}
          onChange={(e) => {
            save({ enabled: e.target.checked });
            if (!e.target.checked)
              track('notification_opt_out', { channel: r.channel ?? 'in_app' });
          }}
        />
        <span>Remind me about this item</span>
      </label>
      <div className="inline-row">
        <Field
          label="Days before (lead times)"
          htmlFor="rem-off"
          hint="Comma-separated, e.g. 7, 3, 1. Use 0 for the day itself."
        >
          <input
            id="rem-off"
            inputMode="numeric"
            value={offsets}
            onChange={(e) => setOffsets(e.target.value)}
            onBlur={() => {
              const list = offsets
                .split(/[,\s]+/)
                .map(Number)
                .filter((n) => Number.isInteger(n) && n >= 0 && n <= 60);
              if (list.join(',') !== r.offsets.join(',')) save({ offsets: list });
            }}
          />
        </Field>
        <Field
          label="Time of day"
          htmlFor="rem-time"
          hint="Moved out of quiet hours automatically."
        >
          <input
            id="rem-time"
            type="time"
            value={r.time ?? '09:00'}
            onChange={(e) => save({ time: e.target.value || undefined })}
          />
        </Field>
      </div>
      <div className="inline-row">
        <Field label="Severity" htmlFor="rem-sev">
          <select
            id="rem-sev"
            value={r.severity ?? ''}
            onChange={(e) =>
              save({ severity: (e.target.value || undefined) as ReminderSeverity | undefined })
            }
          >
            <option value="">From importance</option>
            <option value="info">Gentle</option>
            <option value="normal">Normal</option>
            <option value="important">Important</option>
          </select>
        </Field>
        <Field
          label="Channel"
          htmlFor="rem-ch"
          hint="Email needs sign-in and a configured email service; push isn’t available yet."
        >
          <select
            id="rem-ch"
            value={r.channel ?? ''}
            onChange={(e) =>
              save({ channel: (e.target.value || undefined) as DeliveryChannel | undefined })
            }
          >
            <option value="">Use my default</option>
            <option value="in_app">In the app</option>
            <option value="email">Email</option>
            <option value="push" disabled>
              Push (not available yet)
            </option>
          </select>
        </Field>
      </div>
      <a className="text-btn press" href="#/reminders">
        Quiet hours, timezone and delivery status
      </a>
    </Panel>
  );
}
