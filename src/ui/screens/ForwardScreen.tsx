import { useEffect, useRef, useState } from 'react';
import { FORWARD_RETENTION } from '../../content/privacy';
import type { UserEvent as ServerUserEvent } from '../../lib/account/types';
import { useAccount } from '../account/AccountContext';
import { describeApiError, useIntake } from '../account/useIntake';
import { EmailIngestionCard } from './Landing';
import { Badge, ConfirmButton, Notice, Panel } from '../components/ui';
import { useToast } from '../components/Toast';
import { download } from '../common';
import { localDateTime } from '../lib/format';

const POLL_MS = 30_000;

export function ForwardScreen() {
  const intake = useIntake();
  const { status } = useAccount();
  const [agreed, setAgreed] = useState(false);
  const { load, refreshEvents, phase } = intake;
  const started = useRef(false);

  useEffect(() => {
    if (status === 'checking' || started.current) return;
    started.current = true;
    void load();
  }, [status, load]);

  // Poll for forwarded emails while this screen is open and forwarding is live.
  useEffect(() => {
    if (phase !== 'ready') return;
    void refreshEvents();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshEvents();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [phase, refreshEvents]);

  return (
    <div className="page2">
      <header className="page-head">
        <h1>Forward a subscription email</h1>
        <p className="muted">
          Forward one bill, renewal, trial or receipt email to your own Due address. You review
          every field before anything is saved.
        </p>
      </header>

      <EmailIngestionCard />

      <Panel title="Your forwarding address" id="fw-addr">
        <ForwardAddress intake={intake} agreed={agreed} setAgreed={setAgreed} />
      </Panel>

      {(phase === 'ready' || intake.events.length > 0) && <ServerEvents intake={intake} />}

      <Panel title="Other ways in" id="fw-alt">
        <div className="btn-row">
          <a className="btn btn-secondary press" href="#/upload">
            Upload or paste the email text
          </a>
          <a className="btn btn-secondary press" href="#/add">
            Add manually
          </a>
        </div>
      </Panel>
    </div>
  );
}

export function ForwardAddress({
  intake,
  agreed,
  setAgreed,
}: {
  intake: ReturnType<typeof useIntake>;
  agreed: boolean;
  setAgreed: (v: boolean) => void;
}) {
  const toast = useToast();
  const { phase, alias, message } = intake;
  if (phase === 'idle' || phase === 'loading') return <p className="muted">Checking…</p>;
  if (phase === 'not_live')
    return (
      <Notice tone="warn" title="Forwarding isn’t live yet">
        {message ?? 'Inbound email isn’t configured on Due’s server yet.'} Meanwhile, paste the
        email text in <a href="#/upload">Upload</a> or <a href="#/add">add it manually</a>. Nothing
        you forward now would arrive.
      </Notice>
    );
  if (phase === 'unreachable' || phase === 'error')
    return (
      <div className="stack-8">
        <Notice tone="warn" title="Forwarding is unavailable right now">
          {message} Forwarding needs Due’s server. You can still{' '}
          <a href="#/upload">paste the email text</a> or <a href="#/add">add it manually</a>.
        </Notice>
        <button
          type="button"
          className="btn btn-secondary press"
          onClick={() => void intake.load()}
        >
          Try again
        </button>
      </div>
    );
  if (phase === 'none' || phase === 'needs_session')
    return (
      <div className="stack-16">
        <label className="switch-row">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>I’ve read how forwarding works (above) and want a personal address.</span>
        </label>
        <button
          type="button"
          className="btn btn-primary press"
          disabled={!agreed}
          onClick={() => void intake.create()}
        >
          Get my forwarding address
        </button>
        <p className="muted small">
          Without an account, the address lasts for a temporary session. Sign in later to keep what
          arrives.
        </p>
      </div>
    );
  const address = alias?.address ?? null;
  const paused = alias?.status === 'paused';
  return (
    <div className="stack-16">
      <p className="alias">
        <code>{address ?? alias?.alias}</code>{' '}
        <Badge tone={paused ? 'warm' : 'calm'}>{paused ? 'Paused' : 'Active'}</Badge>
      </p>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary press"
          onClick={() => {
            const value = address ?? alias?.alias ?? '';
            navigator.clipboard
              ?.writeText(value)
              .then(() => toast.show({ message: 'Address copied', tone: 'success' }))
              .catch(() =>
                toast.show({
                  message: 'Copy failed. Select the address and copy it.',
                  tone: 'error',
                }),
              );
          }}
        >
          Copy address
        </button>
        {paused ? (
          <button
            type="button"
            className="btn btn-secondary press"
            onClick={() => void intake.resume()}
          >
            Resume
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-secondary press"
            onClick={() => void intake.pause()}
          >
            Pause
          </button>
        )}
        <ConfirmButton
          label="Rotate address"
          confirmLabel="Yes, rotate"
          className="btn btn-secondary press"
          message="You’ll get a new address. Emails sent to the old one will no longer arrive."
          onConfirm={() => void intake.rotate()}
        />
      </div>
      <p className="muted small">{FORWARD_RETENTION}</p>
    </div>
  );
}

export function ServerEvents({ intake }: { intake: ReturnType<typeof useIntake> }) {
  const { client } = useAccount();
  const toast = useToast();
  const { events, setEvents } = intake;
  const remove = (ev: ServerUserEvent) =>
    client
      .deleteIntakeEvent(ev.id)
      .then(() => {
        setEvents(events.filter((x) => x.id !== ev.id));
        toast.show({ message: 'Forwarded item deleted from Due’s server.', tone: 'success' });
      })
      .catch((e) => toast.show({ message: describeApiError(e), tone: 'error' }));
  return (
    <Panel title="Forwarded emails" id="fw-events">
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-secondary press"
          onClick={() => void intake.refreshEvents()}
        >
          Check for new emails
        </button>
        <a className="btn btn-quiet press" href="#/import">
          Open review queue
        </a>
      </div>
      <p className="muted small" role="status">
        {intake.eventsError
          ? intake.eventsError
          : intake.checkedAt
            ? `Last checked ${localDateTime(intake.checkedAt)}. Checks every 30 seconds while this page is open.`
            : 'Not checked yet.'}
        {intake.rawStorage === 'disabled' && ' Raw messages are not stored on this server.'}
      </p>
      {events.length === 0 ? (
        <p className="muted">Nothing received yet.</p>
      ) : (
        <ul className="plain-list">
          {events.map((ev) => (
            <li key={ev.id} className="event-row">
              <div>
                <strong>
                  {ev.extractedFields.provider ?? ev.extractedFields.service ?? 'Unknown sender'}
                </strong>{' '}
                <Badge>{ev.reviewStatus.replace('_', ' ')}</Badge>
                <p className="muted small">
                  {localDateTime(ev.createdAt)}
                  {ev.sourceDomain ? ` · from ${ev.sourceDomain}` : ''}
                  {ev.rawRetentionUntil
                    ? ` · raw kept until ${localDateTime(ev.rawRetentionUntil)}`
                    : ''}
                </p>
              </div>
              <div className="btn-row">
                {ev.rawAvailable && (
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm press"
                    onClick={() =>
                      client
                        .deleteIntakeRaw(ev.id)
                        .then(() => {
                          setEvents(
                            events.map((x) => (x.id === ev.id ? { ...x, rawAvailable: false } : x)),
                          );
                          toast.show({ message: 'Raw message deleted.', tone: 'success' });
                        })
                        .catch((e) => toast.show({ message: describeApiError(e), tone: 'error' }))
                    }
                  >
                    Delete raw message
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-quiet btn-sm press"
                  onClick={() =>
                    client
                      .exportIntakeEvent(ev.id)
                      .then((r) =>
                        download(
                          `due-forwarded-${ev.id}.json`,
                          JSON.stringify(r, null, 2),
                          'application/json',
                        ),
                      )
                      .catch((e) => toast.show({ message: describeApiError(e), tone: 'error' }))
                  }
                >
                  Export
                </button>
                <ConfirmButton
                  label="Delete"
                  confirmLabel="Yes, delete"
                  className="btn btn-quiet btn-sm press"
                  message="Delete this forwarded item and its raw message from Due’s server?"
                  onConfirm={() => void remove(ev)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
