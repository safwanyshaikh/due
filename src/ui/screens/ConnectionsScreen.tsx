import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteLabel, newId, upsertLabel } from '../../lib/data';
import { LABEL_NOTE } from '../../content/privacy';
import type { EmailIdentity, IdentityKind } from '../../lib/account/identities';
import { gmailReasonMessage, type GmailScanRun } from '../../lib/account/gmail';
import { useApp } from '../store';
import { useAccount } from '../account/AccountContext';
import { describeApiError, useIntake } from '../account/useIntake';
import { ForwardAddress, ServerEvents } from './ForwardScreen';
import { Badge, ConfirmButton, Field, Notice, Panel } from '../components/ui';
import { GmailConnectSheet } from '../components/GmailConnect';
import { useToast } from '../components/Toast';
import { localDateTime } from '../lib/format';
import {
  featureTag,
  gmailClient,
  identitiesClient,
  modeLabel,
  modeTone,
  useGmailStatus,
} from '../lib/platform';
import { serverAllows } from '../lib/entitlement';

const KIND_LABEL: Record<IdentityKind, string> = {
  gmail: 'Gmail (read-only)',
  work: 'Work email',
  family: 'Family / shared',
  forwarding: 'Forwarding only',
};

const STATUS_LABEL: Record<
  EmailIdentity['status'],
  { text: string; tone: 'calm' | 'warm' | 'plain' }
> = {
  active: { text: 'Active', tone: 'calm' },
  paused: { text: 'Paused', tone: 'warm' },
  disconnected: { text: 'Disconnected', tone: 'plain' },
  error: { text: 'Needs attention', tone: 'warm' },
};

function IdentityCard({ it, onChanged }: { it: EmailIdentity; onChanged: () => void }) {
  const toast = useToast();
  const [deleteImported, setDeleteImported] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [scans, setScans] = useState<GmailScanRun[] | null>(null);
  const [busy, setBusy] = useState(false);
  const gmail = it.kind === 'gmail';
  const st = STATUS_LABEL[it.status] ?? STATUS_LABEL.error;
  const fail = (e: unknown) => toast.show({ message: describeApiError(e), tone: 'error' });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.show({ message: ok, tone: 'success' });
      onChanged();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="ident" data-identity={it.id}>
      <div className="ident-head">
        <div>
          <strong>{it.label || KIND_LABEL[it.kind]}</strong>
          <p className="muted small">{it.email}</p>
        </div>
        <div className="chips">
          <Badge>{KIND_LABEL[it.kind]}</Badge>
          <Badge tone={st.tone}>{st.text}</Badge>
          {it.scanning && <Badge tone="warm">Scanning…</Badge>}
        </div>
      </div>
      {it.statusReason && it.status !== 'active' && (
        <p className="muted small">{gmailReasonMessage(it.statusReason)}</p>
      )}
      <dl className="kv">
        <div>
          <dt>Consent</dt>
          <dd>
            {it.consentVersion
              ? `Version ${it.consentVersion}${it.consentedAt ? ` · ${localDateTime(it.consentedAt)}` : ''}`
              : 'Not recorded'}
          </dd>
        </div>
        {gmail && (
          <div>
            <dt>Last scan</dt>
            <dd>
              {it.lastScanAt
                ? `${localDateTime(it.lastScanAt)} · ${it.lastScanStatus === 'ok' ? 'OK' : it.lastScanStatus === 'error' ? `Failed${it.lastScanErrorCode ? ` (${it.lastScanErrorCode})` : ''}` : (it.lastScanStatus ?? '—')}`
                : 'Not scanned yet'}
            </dd>
          </div>
        )}
        {gmail && it.scopes?.length ? (
          <div>
            <dt>Access granted</dt>
            <dd>
              {it.scopes.map((s) => (
                <code key={s} className="small">
                  {s}{' '}
                </code>
              ))}
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="btn-row">
        {gmail && it.status === 'active' && (
          <button
            type="button"
            className="btn btn-secondary btn-sm press jelly"
            disabled={busy || it.scanning}
            onClick={() =>
              void run(
                () => gmailClient().scan(it.id),
                'Scan queued. Results appear in your review queue.',
              )
            }
          >
            Rescan
          </button>
        )}
        {gmail && (
          <button
            type="button"
            className="btn btn-quiet btn-sm press"
            aria-expanded={scans !== null}
            onClick={() =>
              scans ? setScans(null) : gmailClient().scans(it.id).then(setScans).catch(fail)
            }
          >
            {scans ? 'Hide scan history' : 'Scan history'}
          </button>
        )}
      </div>
      {scans && (
        <ul className="plain-list small">
          {scans.length === 0 && <li className="muted">No scans yet.</li>}
          {scans.slice(0, 10).map((r) => (
            <li key={r.id}>
              {localDateTime(r.requestedAt)} · {r.trigger} · <Badge>{r.status}</Badge> ·{' '}
              {r.eventsCreated} to review, {r.duplicates} duplicates
              {r.errorCode ? ` · ${r.errorCode}` : ''}
            </li>
          ))}
        </ul>
      )}
      {gmail && it.status !== 'disconnected' && (
        <div className="stack-8">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={deleteImported}
              onChange={(e) => setDeleteImported(e.target.checked)}
            />
            <span>Also delete review items imported from this Gmail</span>
          </label>
          <ConfirmButton
            label="Disconnect Gmail"
            confirmLabel="Yes, disconnect"
            className="btn btn-secondary btn-sm press"
            message="Due stops reading immediately and revokes its access at Google."
            onConfirm={() =>
              void run(async () => {
                const r = await gmailClient().disconnect(it.id, deleteImported);
                if (!r.revoked)
                  toast.show({
                    message:
                      'Google did not confirm the revocation. You can also remove Due at myaccount.google.com/permissions.',
                    tone: 'info',
                  });
              }, 'Gmail disconnected.')
            }
          />
        </div>
      )}
      <div className="stack-8">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={deleteData}
            onChange={(e) => setDeleteData(e.target.checked)}
          />
          <span>Also delete everything this identity imported</span>
        </label>
        <ConfirmButton
          label="Delete identity"
          confirmLabel="Yes, delete"
          className="btn btn-danger btn-sm press"
          message={
            gmail
              ? 'Removes this identity and revokes Gmail access first.'
              : 'Removes this identity from your account.'
          }
          onConfirm={() =>
            void run(() => identitiesClient().remove(it.id, deleteData), 'Identity deleted.')
          }
        />
      </div>
    </li>
  );
}

function AddIdentity({ onAdded }: { onAdded: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Exclude<IdentityKind, 'gmail'>>('work');
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="stack-12"
      onSubmit={(e) => {
        e.preventDefault();
        setErr(null);
        identitiesClient()
          .create({ kind, label: label.trim() || undefined, email: email.trim() })
          .then(() => {
            setLabel('');
            setEmail('');
            toast.show({ message: 'Identity added.', tone: 'success' });
            onAdded();
          })
          .catch((x) => setErr(describeApiError(x)));
      }}
    >
      <Field label="Type" htmlFor="id-kind">
        <select
          id="id-kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as Exclude<IdentityKind, 'gmail'>)}
        >
          <option value="work">Work email</option>
          <option value="family">Family / shared subscription email</option>
          <option value="forwarding">Forwarding only</option>
        </select>
      </Field>
      <Field label="Label (optional)" htmlFor="id-label">
        <input id="id-label" value={label} onChange={(e) => setLabel(e.target.value)} />
      </Field>
      <Field label="Email address" htmlFor="id-email">
        <input
          id="id-email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
        />
      </Field>
      <p className="muted small">
        Due does not read these inboxes. They label where forwarded mail comes from, and are never
        merged with another identity just because the sender matches.
      </p>
      <button type="submit" className="btn btn-secondary press jelly" disabled={!email.trim()}>
        Add identity
      </button>
      {err && <Notice tone="warn">{err}</Notice>}
    </form>
  );
}

function IdentitiesPanel() {
  const { status, entitlements } = useAccount();
  const gs = useGmailStatus();
  const [items, setItems] = useState<EmailIdentity[] | null>(null);
  const [max, setMax] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [connect, setConnect] = useState(false);
  const signedIn = status === 'signed_in';
  const plus = serverAllows(entitlements, 'email_import');
  const mode = gs.state === 'ok' ? gs.value.mode : 'unknown';
  const tag = featureTag(mode, true, plus);

  const load = useCallback(() => {
    identitiesClient()
      .list()
      .then((r) => {
        setItems(r.items);
        setMax(r.max);
        setErr(null);
      })
      .catch((e) => setErr(describeApiError(e)));
  }, []);
  useEffect(() => {
    if (signedIn) load();
  }, [signedIn, load]);

  return (
    <Panel title="Email identities" id="cn-ids">
      <div className="kv-row">
        <span>
          Gmail on this server{' '}
          <Badge tone={modeTone(mode)}>
            {gs.state === 'loading' ? 'Checking…' : modeLabel(mode)}
          </Badge>
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm press jelly"
          onClick={() => setConnect(true)}
        >
          Connect Gmail
        </button>
      </div>
      {tag.text === 'Plus required' && (
        <p className="muted small">Gmail scanning and forwarding are part of Plus.</p>
      )}
      {!signedIn ? (
        <Notice tone="info">
          <a href="#/account">Sign in</a> to add work, family or forwarding identities and to
          connect Gmail. Upload and manual entry work without an account.
        </Notice>
      ) : (
        <>
          {err && <Notice tone="warn">{err}</Notice>}
          {items && items.length === 0 && <p className="muted">No email identities yet.</p>}
          {items && items.length > 0 && (
            <ul className="ident-list">
              {items.map((it) => (
                <IdentityCard key={it.id} it={it} onChanged={load} />
              ))}
            </ul>
          )}
          {max !== null && items && (
            <p className="muted small">
              {items.length} of {max} identities used.
            </p>
          )}
          <details className="more">
            <summary className="press">Add a work, family or forwarding identity</summary>
            <AddIdentity onAdded={load} />
          </details>
        </>
      )}
      {connect && <GmailConnectSheet onClose={() => setConnect(false)} />}
    </Panel>
  );
}

/** Connections: email identities (Gmail, work, family, forwarding), forwarding health and labels. */
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
          Optional and read-only. Due has no bank, SMS or WhatsApp connection. Gmail (if you connect
          it) and the forwarding address you create are the only email sources. Due can read; it
          can’t send, move, pay or cancel anything.
        </p>
      </header>

      <IdentitiesPanel />

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
              ) : intake.phase === 'needs_session' ? (
                <Badge>Sign in required</Badge>
              ) : intake.phase === 'needs_plus' ? (
                <Badge tone="warm">Plus required</Badge>
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
