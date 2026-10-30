import { useEffect, useState } from 'react';
import { useApp } from '../store';
import type { Nav } from '../App';
import { Disclaimer, useCatalog } from './parts';
import {
  deleteEvent,
  processForwarded,
  purgeRaw,
  relayAddress,
  setEventState,
} from '../../lib/offers/relay';
import { blankService, upsertService } from '../../lib/offers/services';
import { PROVIDER_LABEL } from '../../lib/offers/catalog';
import { RELAY_EXPLAINER, SMS_WHATSAPP_NOTE } from '../../lib/offers/copy';
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
  const catalog = useCatalog(today);
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

  function trySample() {
    if (relay.status !== 'connected' || !relay.token)
      return setMsg('Connect Due Relay in Settings first (demo).');
    const [subject, ...rest] = paste.split('\n');
    const now = new Date().toISOString();
    const r = processForwarded(
      {
        messageId: `local-${now}`,
        to: relayAddress(relay.token),
        from: 'you@example.com',
        subject: subject || '(no subject)',
        body: rest.join('\n'),
        receivedAt: now,
      },
      relay,
      catalog,
      now,
    );
    if (!r.ok)
      return setMsg(
        r.reason === 'duplicate'
          ? 'This message was already added.'
          : r.reason === 'paused'
            ? 'Relay is paused.'
            : 'That address is not yours.',
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
      <p className="muted">{RELAY_EXPLAINER}</p>
      <p className="note small">
        Demo: no email service is connected yet, so nothing arrives automatically. Examples below
        are marked Demo.
      </p>
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
        {list.length === 0 && <p className="muted small emptyline">Nothing here.</p>}
        {list.map((e) => (
          <article key={e.id} className="item">
            <span className="row">
              <strong>{e.subject}</strong>
              {e.isSample && <span className="badge soft">Demo</span>}
            </span>
            <span className="muted small">
              {e.classification.replace('_', ' ')} ·{' '}
              {e.candidate.provider ? PROVIDER_LABEL[e.candidate.provider] : 'provider unknown'}
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
        <h2>Try it with one message</h2>
        <p className="muted small">
          Paste one bill, renewal, trial or offer email (first line = subject). It is read in this
          browser only.
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
          <button className="btn quiet" onClick={trySample} disabled={!paste.trim()}>
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
