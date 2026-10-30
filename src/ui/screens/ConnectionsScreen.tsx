import { useEffect, useRef, useState } from 'react';
import { deleteLabel, newId, upsertLabel } from '../../lib/data';
import { LABEL_NOTE } from '../../content/privacy';
import { useApp } from '../store';
import { useAccount } from '../account/AccountContext';
import { useIntake } from '../account/useIntake';
import { ForwardAddress, ServerEvents } from './ForwardScreen';
import { Badge, ConfirmButton, Field, Panel } from '../components/ui';
import { localDateTime } from '../lib/format';

/** Connection health: forwarding alias, last event, retry, fallbacks and controls. */
export function ConnectionsScreen() {
  const { data, update } = useApp();
  const { status } = useAccount();
  const intake = useIntake();
  const [agreed, setAgreed] = useState(false);
  const [label, setLabel] = useState('');
  const started = useRef(false);
  const { load, refreshEvents } = intake;

  useEffect(() => {
    if (status === 'checking' || started.current) return;
    started.current = true;
    void load().then(() => refreshEvents());
  }, [status, load, refreshEvents]);

  const last = intake.events
    .map((e) => e.createdAt)
    .sort()
    .pop();

  return (
    <div className="page2">
      <header className="page-head">
        <h1>Connections</h1>
        <p className="muted">
          Due has no bank, Gmail, SMS or WhatsApp connection. The only connected source is the email
          forwarding address you choose to create. Due can read what you forward; it can’t move, pay
          or cancel anything.
        </p>
      </header>

      <Panel title="Email forwarding" id="cn-fw">
        <dl className="kv">
          <div>
            <dt>Status</dt>
            <dd>
              {intake.phase === 'ready' ? (
                <Badge tone={intake.alias?.status === 'paused' ? 'warm' : 'calm'}>
                  {intake.alias?.status === 'paused' ? 'Paused' : 'Active'}
                </Badge>
              ) : intake.phase === 'not_live' ? (
                <Badge tone="warm">Not live on this server</Badge>
              ) : intake.phase === 'unreachable' || intake.phase === 'error' ? (
                <Badge tone="warm">Server unreachable</Badge>
              ) : intake.phase === 'loading' || intake.phase === 'idle' ? (
                'Checking…'
              ) : (
                <Badge>Not set up</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt>Access</dt>
            <dd>Read-only: only emails you forward to your address</dd>
          </div>
          <div>
            <dt>Last email received</dt>
            <dd>{last ? localDateTime(last) : 'None yet'}</dd>
          </div>
          <div>
            <dt>Last checked</dt>
            <dd>{intake.checkedAt ? localDateTime(intake.checkedAt) : 'Not checked'}</dd>
          </div>
        </dl>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary press"
            onClick={() => void load().then(() => refreshEvents())}
          >
            Retry
          </button>
        </div>
        <ForwardAddress intake={intake} agreed={agreed} setAgreed={setAgreed} />
        <p className="muted small">
          To disconnect, pause the address (new emails are refused) or rotate it (the old address
          stops working). Delete or export each forwarded item below.
        </p>
      </Panel>

      {intake.events.length > 0 && <ServerEvents intake={intake} />}

      <Panel title="Other ways in (no connection)" id="cn-alt">
        <div className="btn-row">
          <a className="btn btn-secondary press" href="#/upload">
            Upload a document
          </a>
          <a className="btn btn-secondary press" href="#/sms">
            Share one SMS
          </a>
          <a className="btn btn-secondary press" href="#/csv">
            CSV file
          </a>
          <a className="btn btn-secondary press" href="#/add">
            Add manually
          </a>
        </div>
      </Panel>

      <Panel title="Billing-email labels" id="cn-labels">
        <p className="muted">{LABEL_NOTE}</p>
        <ul className="plain-list">
          {data.labels.map((l) => (
            <li key={l.id} className="event-row">
              <span>
                {l.displayName ? `${l.displayName} · ` : ''}
                {l.label} <Badge>Organisation only</Badge>
              </span>
              <ConfirmButton
                label="Remove"
                confirmLabel="Yes, remove"
                className="btn btn-quiet btn-sm press"
                message="Remove this label? Items keep their other details."
                onConfirm={() => update((d) => deleteLabel(d, l.id))}
              />
            </li>
          ))}
        </ul>
        <form
          className="inline-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!label.trim()) return;
            update((d) => upsertLabel(d, { id: newId('lbl'), label: label.trim() }));
            setLabel('');
          }}
        >
          <Field label="Add a label" htmlFor="cn-label">
            <input id="cn-label" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-secondary press align-end">
            Add label
          </button>
        </form>
      </Panel>
    </div>
  );
}
