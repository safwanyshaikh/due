import { useEffect, useState } from 'react';
import { useApp } from '../store';
import type { Nav } from '../App';
import { Disclaimer, useCatalog } from './parts';
import {
  deleteEvent,
  organisePastedMessage,
  purgeRaw,
  setEventState,
} from '../../lib/offers/relay';
import { blankService, upsertService } from '../../lib/offers/services';
import { providerLabel } from '../../lib/offers/labels';
import {
  RELAY_LOCAL_NOTE,
  RELAY_UNAVAILABLE,
  RELAY_UNAVAILABLE_WHY,
  SMS_WHATSAPP_NOTE,
} from '../../lib/offers/copy';
import { formatINR } from '../../lib/money';
import type { RelayEventState, UserEvent } from '../../lib/offers/types';

const TABS: [RelayEventState, string][] = [
  ['needs_confirmation', 'Needs your confirmation'],
  ['saved', 'Saved'],
  ['ignored', 'Ignored'],
  ['could_not_identify', 'Could not identify'],
];

export function RelayInbox({ nav }: { nav: Nav }) {
  const { data, today, update } = useApp();
  const { offers: catalog } = useCatalog();
  const [tab, setTab] = useState<RelayEventState>('needs_confirmation');
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState('');
  const relay = data.relay;

  useEffect(() => {
    update((d) => ({ ...d, relay: purgeRaw(d.relay, new Date().toISOString()) }));
  }, [update]);

  function confirm(e: UserEvent) {
    update((d) => {
      const svc = {
        ...blankService(e.candidate.provider ?? 'generic', today),
        label: e.candidate.service ?? e.subject,
        approxPricePaise: e.candidate.amountPaise,
        renewalDate: e.candidate.date,
        trialEnd: e.candidate.trialEnd,
        notes: `From Due Relay (${e.parserVersion})`,
      };
      return { ...upsertService(d, svc), relay: setEventState(d.relay, e.id, 'saved') };
    });
    setMsg('Saved to your services.');
  }

  function organise() {
    const now = new Date().toISOString();
    const r = organisePastedMessage(paste, relay, catalog, now);
    if (!r.ok)
      return setMsg(
        r.reason === 'duplicate'
          ? 'This message was already added.'
          : 'This message could not be organised.',
      );
    update((d) => ({ ...d, relay: { ...d.relay, events: [...d.relay.events, r.event] } }));
    setTab(r.event.state);
    setPaste('');
    setMsg(
      r.event.state === 'needs_confirmation'
        ? 'Added. Please confirm the details.'
        : 'We could not identify this message.',
    );
  }

  const list = relay.events.filter((e) => e.state === tab);
  return (
    <div className="page">
      <h1>Due Relay inbox</h1>
      <p className="note small">
        <b>Email forwarding: {RELAY_UNAVAILABLE}</b> {RELAY_UNAVAILABLE_WHY}
      </p>
      <p className="muted">{RELAY_LOCAL_NOTE}</p>
      <div className="seg4" role="tablist" aria-label="Relay review">
        {TABS.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            aria-pressed={tab === k}
            onClick={() => setTab(k)}
          >
            {label} ({relay.events.filter((e) => e.state === k).length})
          </button>
        ))}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {msg}
      </p>
      {msg && <p className="small">{msg}</p>}
      <div className="cards">
        {list.length === 0 && (
          <p className="muted small emptyline">
            {relay.events.length === 0
              ? 'No messages yet. Paste one below to organise it in this browser.'
              : 'Nothing here.'}
          </p>
        )}
        {list.map((e) => (
          <article key={e.id} className="item">
            <span className="row">
              <strong>{e.subject}</strong>
            </span>
            <span className="muted small">
              {e.classification.replace('_', ' ')} ·{' '}
              {e.candidate.provider ? providerLabel(e.candidate.provider) : 'provider unknown'}
              {e.candidate.amountPaise != null ? ` · ${formatINR(e.candidate.amountPaise)}` : ''}
              {e.candidate.date ? ` · date ${e.candidate.date}` : ''}
            </span>
            <span className="small">
              {e.verification === 'user_confirmed'
                ? 'Confirmed by you'
                : e.verification === 'source_supported'
                  ? 'Matches a public source — still needs your confirmation'
                  : 'Unverified'}
              {' · '}confidence {e.confidence} · parser {e.parserVersion}
            </span>
            {e.rawExcerpt && (
              <span className="muted small">
                Raw text kept until {e.rawPurgeAfter.slice(0, 10)}, then removed.
              </span>
            )}
            <span className="actions">
              {e.state === 'needs_confirmation' && (
                <button className="btn quiet" onClick={() => confirm(e)}>
                  Save
                </button>
              )}
              {e.state === 'needs_confirmation' && (
                <button className="btn quiet" onClick={() => nav.go({ name: 'offers-add' })}>
                  Edit and add
                </button>
              )}
              {e.state !== 'ignored' && e.state !== 'saved' && (
                <button
                  className="btn quiet"
                  onClick={() =>
                    update((d) => ({ ...d, relay: setEventState(d.relay, e.id, 'ignored') }))
                  }
                >
                  Ignore
                </button>
              )}
              <button
                className="btn quiet warn"
                onClick={() => update((d) => ({ ...d, relay: deleteEvent(d.relay, e.id) }))}
              >
                Delete
              </button>
            </span>
          </article>
        ))}
      </div>
      <section className="panel">
        <h2>Organise one message (processed in this browser)</h2>
        <p className="muted small">
          Paste one bill, renewal, trial or offer email (first line = subject). It is processed in
          this browser only and is not sent anywhere.
        </p>
        <label className="f" htmlFor="relayPaste">
          Message
          <textarea
            id="relayPaste"
            rows={4}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
          />
        </label>
        <div className="actions">
          <button className="btn quiet" onClick={organise} disabled={!paste.trim()}>
            Organise this message
          </button>
          <a className="btn quiet" href="#/offers-add">
            Add it yourself
          </a>
        </div>
      </section>
      <p className="muted small">{SMS_WHATSAPP_NOTE}</p>
      <Disclaimer />
    </div>
  );
}
