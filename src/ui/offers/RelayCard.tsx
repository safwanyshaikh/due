import { useState } from 'react';
import { useApp } from '../store';
import { Card } from '../common';
import { deleteAllIntake } from '../../lib/offers/relay';
import {
  RELAY_EXPLAINER,
  RELAY_UNAVAILABLE,
  RELAY_UNAVAILABLE_WHY,
  SMS_WHATSAPP_NOTE,
} from '../../lib/offers/copy';

export function RelayCard() {
  const { data, update } = useApp();
  const r = data.relay;
  const [msg, setMsg] = useState('');
  const [armed, setArmed] = useState(false);

  return (
    <Card title="Due Relay" right={<span className="badge soft">Not available yet</span>}>
      <p>
        <b>{RELAY_UNAVAILABLE}</b>
      </p>
      <p className="muted small">{RELAY_UNAVAILABLE_WHY}</p>
      <p className="muted small">When it is available: {RELAY_EXPLAINER}</p>
      <div className="actions">
        <a className="btn quiet" href="#/relay">
          Organise one message in this browser
        </a>
      </div>
      <p className="muted small">
        Messages you paste are processed in this browser only. Raw text is kept for{' '}
        {r.retentionDays} days so you can check it, then removed. Only the fields you confirm are
        saved.
      </p>
      <div className="actions">
        {!armed ? (
          <button className="btn quiet warn" onClick={() => setArmed(true)}>
            Delete pasted messages
          </button>
        ) : (
          <>
            <span className="small">
              Delete all pasted messages and candidates? Saved services stay.
            </span>
            <button
              className="btn warn"
              onClick={() => {
                update((d) => ({ ...d, relay: deleteAllIntake(d.relay) }));
                setArmed(false);
                setMsg('Pasted messages deleted.');
              }}
            >
              Delete
            </button>
            <button className="btn quiet" onClick={() => setArmed(false)}>
              Not now
            </button>
          </>
        )}
      </div>
      <p className="muted small">{SMS_WHATSAPP_NOTE}</p>
      <p role="status" aria-live="polite" className="small">
        {msg}
      </p>
    </Card>
  );
}
