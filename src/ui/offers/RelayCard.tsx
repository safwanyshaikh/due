import { useState } from 'react';
import { useApp } from '../store';
import { Card } from '../common';
import { deleteAllIntake, newToken, relayAddress, rotateToken } from '../../lib/offers/relay';
import { RELAY_EXPLAINER, RELAY_ONBOARDING, SMS_WHATSAPP_NOTE } from '../../lib/offers/copy';

const STATUS_TEXT = {
  not_connected: 'Not connected',
  connected: 'Connected',
  paused: 'Paused',
} as const;

export function RelayCard() {
  const { data, update } = useApp();
  const r = data.relay;
  const [msg, setMsg] = useState('');
  const [armed, setArmed] = useState(false);
  const addr = r.token ? relayAddress(r.token) : null;

  async function copy() {
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      setMsg('Address copied.');
    } catch {
      setMsg('Copy isn’t available here. Select the address and copy it.');
    }
  }

  return (
    <Card title="Due Relay" right={<span className="badge soft">{STATUS_TEXT[r.status]}</span>}>
      <p>{RELAY_ONBOARDING}</p>
      <p className="muted small">{RELAY_EXPLAINER}</p>
      <p className="note small">
        Demo only: this address is not live yet and no email is received. Turning it on here shows
        how it will work.
      </p>
      {addr && (
        <p>
          Your private address: <code className="addr">{addr}</code>
        </p>
      )}
      <div className="actions">
        {r.status === 'not_connected' && (
          <button
            className="btn quiet"
            onClick={() =>
              update((d) => ({
                ...d,
                relay: { ...d.relay, status: 'connected', token: d.relay.token ?? newToken() },
              }))
            }
          >
            Turn on (demo)
          </button>
        )}
        {addr && (
          <button className="btn quiet" onClick={() => void copy()}>
            Copy
          </button>
        )}
        {addr && (
          <button
            className="btn quiet"
            onClick={() => {
              update((d) => ({ ...d, relay: rotateToken(d.relay) }));
              setMsg('New address created. The old one stops working.');
            }}
          >
            Rotate address
          </button>
        )}
        {r.status === 'connected' && (
          <button
            className="btn quiet"
            onClick={() => update((d) => ({ ...d, relay: { ...d.relay, status: 'paused' } }))}
          >
            Pause forwarding
          </button>
        )}
        {r.status === 'paused' && (
          <button
            className="btn quiet"
            onClick={() => update((d) => ({ ...d, relay: { ...d.relay, status: 'connected' } }))}
          >
            Resume forwarding
          </button>
        )}
        <a className="btn quiet" href="#/relay">
          Open review inbox
        </a>
      </div>
      <p className="muted small">
        Raw message text is kept for {r.retentionDays} days so you can check it, then removed. Only
        the fields you confirm are saved.
      </p>
      <div className="actions">
        {!armed ? (
          <button className="btn quiet warn" onClick={() => setArmed(true)}>
            Delete intake data
          </button>
        ) : (
          <>
            <span className="small">
              Delete all forwarded messages and candidates? Saved services stay.
            </span>
            <button
              className="btn warn"
              onClick={() => {
                update((d) => ({ ...d, relay: deleteAllIntake(d.relay) }));
                setArmed(false);
                setMsg('Intake data deleted.');
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
