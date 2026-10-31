import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AccountApiError } from '../../lib/account/client';
import type {
  ConsentPurpose,
  ConsentsResponse,
  DeleteRequest,
  DeviceSession,
  HouseholdResponse,
} from '../../lib/account/types';
import {
  EMAIL_INTAKE_CONSENT_VERSION,
  REMINDERS_EMAIL_CONSENT_VERSION,
  SYNC_BACKUP_CONSENT_VERSION,
  TELEMETRY_CONSENT_VERSION,
} from '../../content/privacy';
import { obligationViews } from '../../lib/home';
import { useAccount } from '../account/AccountContext';
import { describeApiError } from '../account/useIntake';
import { useApp } from '../store';
import { useToast } from '../components/Toast';
import { Badge, ConfirmButton, Field, Notice, Panel } from '../components/ui';
import { Sheet } from '../components/Sheet';
import { download } from '../common';
import { localDateTime } from '../lib/format';
import { serverAllows } from '../lib/entitlement';
import { readJsonPref, readPref, writeJsonPref } from '../lib/prefs';
import { platform, type DeletionStatus } from '../lib/platform';
import { setTelemetryOptOut, telemetryOptedOut } from '../lib/telemetrySink';

export const EMAIL_UNAVAILABLE_COPY =
  'Email sign-in isn’t available yet. You can keep using Due without an account.';

type LinkState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'sent'; message: string }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

export function SignInForm() {
  const { client } = useAccount();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<LinkState>({ kind: 'idle' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) {
      setState({ kind: 'error', message: 'Enter a valid email address.' });
      return;
    }
    setState({ kind: 'sending' });
    try {
      const r = await client.requestMagicLink(email.trim());
      setState({ kind: 'sent', message: r.message });
    } catch (err) {
      if (
        err instanceof AccountApiError &&
        (err.code === 'email_unavailable' || err.status === 503)
      )
        setState({ kind: 'unavailable' });
      else if (err instanceof AccountApiError && err.isRateLimited)
        setState({ kind: 'error', message: err.message });
      else setState({ kind: 'error', message: describeApiError(err) });
    }
  };
  return (
    <form className="stack-16" onSubmit={submit} noValidate>
      <Field
        label="Email address"
        htmlFor="signin-email"
        hint="We’ll email you a one-time sign-in link. No password."
      >
        <input
          id="signin-email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>
      <button type="submit" className="btn btn-primary press" disabled={state.kind === 'sending'}>
        {state.kind === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
      </button>
      <div aria-live="polite">
        {state.kind === 'sent' && (
          <Notice tone="ok" title="Check your email">
            {state.message} Open the link on this device to sign in.
          </Notice>
        )}
        {state.kind === 'unavailable' && <Notice tone="warn">{EMAIL_UNAVAILABLE_COPY}</Notice>}
        {state.kind === 'error' && <Notice tone="warn">{state.message}</Notice>}
      </div>
    </form>
  );
}

export function AccountScreen() {
  const { status, me } = useAccount();
  if (status === 'checking')
    return (
      <div className="page2">
        <h1>Account</h1>
        <p className="muted">Checking…</p>
      </div>
    );
  if (status !== 'signed_in' || !me)
    return (
      <div className="page2">
        <header className="page-head">
          <h1>Continue with email</h1>
          <p className="muted">
            An account is optional. It adds backup, sync across devices, email reminders and
            forwarding history. Everything else works without one.
          </p>
        </header>
        {status === 'unreachable' && (
          <Notice tone="warn" title="Due’s account service can’t be reached">
            You can keep using Due on this device. Sign-in will work once the server is reachable.
          </Notice>
        )}
        <DeletionProgress />
        {readPref('household-invite') && (
          <Notice title="Household invite waiting">Sign in with the invited email to join.</Notice>
        )}
        <Panel>
          <SignInForm />
        </Panel>
        <a className="btn btn-quiet press" href="#/">
          Keep using without an account
        </a>
      </div>
    );
  return <SignedIn />;
}

function SignedIn() {
  const { me, client, signOut, entitlements } = useAccount();
  const toast = useToast();
  const [name, setName] = useState(me?.account.displayName ?? '');
  return (
    <div className="page2">
      <header className="page-head">
        <h1>Your account</h1>
        <p className="muted">
          Signed in as <strong>{me!.account.email}</strong>
        </p>
      </header>

      <Panel title="Plan" id="acc-plan">
        <p>
          <Badge tone={entitlements?.plan === 'free' ? 'plain' : 'premium'}>
            {entitlements?.plan ?? 'free'}
          </Badge>{' '}
          {entitlements?.status === 'cancelled' && entitlements.periodEnd
            ? `Cancelled — access until ${localDateTime(entitlements.periodEnd)}`
            : entitlements?.periodEnd
              ? `Renews or ends ${localDateTime(entitlements.periodEnd)}`
              : ''}
        </p>
        <a className="btn btn-secondary press" href="#/plans">
          Plans and purchases
        </a>
      </Panel>

      <SyncPanel />

      <Panel title="Profile" id="acc-profile">
        <form
          className="inline-row"
          onSubmit={(e) => {
            e.preventDefault();
            client
              .updateProfile(name.trim() || null)
              .then(() => toast.show({ message: 'Name saved', tone: 'success' }))
              .catch((err) => toast.show({ message: describeApiError(err), tone: 'error' }));
          }}
        >
          <Field label="Display name (optional)" htmlFor="acc-name">
            <input id="acc-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-secondary press align-end">
            Save
          </button>
        </form>
      </Panel>

      <DevicesPanel />
      <HouseholdPanel />
      <ConsentsPanel />

      <Panel title="Sign out" id="acc-out">
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary press"
            onClick={() => void signOut(false)}
          >
            Sign out on this device
          </button>
          <ConfirmButton
            label="Sign out everywhere"
            confirmLabel="Yes, sign out everywhere"
            className="btn btn-secondary press"
            message="This ends every session on every device, including this one."
            onConfirm={() => void signOut(true)}
          />
        </div>
        <p className="muted small">Signing out keeps the data on this device.</p>
      </Panel>

      <DataPanel />
    </div>
  );
}

function SyncPanel() {
  const { sync, enableSync, disableSync, syncNow, resolveConflict } = useAccount();
  const { data, today } = useApp();
  const [review, setReview] = useState(false);
  return (
    <Panel title="Backup and sync" id="acc-sync">
      {!sync.on ? (
        <>
          {sync.error && <Notice tone="warn">{sync.error}</Notice>}
          <p className="muted">
            Off. Your data is only on this device. Turning it on uploads this device’s data to your
            account and keeps your devices in step.
          </p>
          <button type="button" className="btn btn-primary press" onClick={() => void enableSync()}>
            Turn on backup and sync
          </button>
        </>
      ) : (
        <>
          <p>
            <Badge tone={sync.status === 'error' || sync.status === 'paused' ? 'warm' : 'calm'}>
              {sync.status === 'syncing'
                ? 'Syncing…'
                : sync.status === 'error'
                  ? 'Not synced'
                  : sync.status === 'conflict'
                    ? 'Needs a decision'
                    : sync.status === 'paused'
                      ? 'Paused'
                      : sync.dirty
                        ? 'On · changes waiting'
                        : 'On'}
            </Badge>{' '}
            {sync.lastSyncedAt
              ? `Last synced ${localDateTime(sync.lastSyncedAt)}`
              : 'Not synced yet'}{' '}
            · version {sync.version}
          </p>
          {sync.error && <Notice tone="warn">{sync.error}</Notice>}
          {sync.emailDelivery && (
            <p className="muted small">
              Email reminders:{' '}
              {sync.emailDelivery === 'active'
                ? 'the server will send them'
                : sync.emailDelivery === 'premium_required'
                  ? 'need a Plus plan'
                  : 'not available on this server yet (no email service configured)'}
              .
            </p>
          )}
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-secondary press"
              onClick={() => void syncNow()}
            >
              Sync now
            </button>
            <button type="button" className="btn btn-quiet press" onClick={() => disableSync()}>
              Turn off sync
            </button>
          </div>
        </>
      )}
      {sync.status === 'conflict' && sync.conflict && (
        <Sheet title="Two versions of your data" onClose={() => setReview(false)}>
          <p>
            Your account has data from another device (updated{' '}
            {sync.conflict.updatedAt ? localDateTime(sync.conflict.updatedAt) : 'earlier'}), and
            this device has changes too. Choose which to keep. Nothing is lost until you choose.
          </p>
          <dl className="kv">
            <div>
              <dt>This device</dt>
              <dd>{data.commitments.filter((c) => !c.deletedAt).length} items</dd>
            </div>
            <div>
              <dt>Your account</dt>
              <dd>
                {(sync.conflict.data?.commitments ?? []).filter((c) => !c.deletedAt).length} items
              </dd>
            </div>
          </dl>
          {review && <ConflictReview />}
          <div className="stack-8">
            <button
              type="button"
              className="btn btn-primary btn-block press"
              onClick={() => void resolveConflict('mine')}
            >
              Keep this device’s version
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-block press"
              onClick={() => void resolveConflict('server')}
            >
              Use the account’s version
            </button>
            {!review && (
              <button
                type="button"
                className="btn btn-quiet btn-block press"
                onClick={() => setReview(true)}
              >
                Review the differences
              </button>
            )}
          </div>
          <p className="muted small">
            Tip: export a copy first from “Your data” if you’re unsure. {today}
          </p>
        </Sheet>
      )}
    </Panel>
  );
}

function ConflictReview() {
  const { sync } = useAccount();
  const { data, today } = useApp();
  const server = sync.conflict?.data;
  if (!server) return null;
  const mine = obligationViews(data, today);
  let theirs: ReturnType<typeof obligationViews>;
  try {
    theirs = obligationViews(server, today);
  } catch {
    theirs = [];
  }
  const key = (n: string) => n.toLowerCase();
  const mineNames = new Set(mine.map((v) => key(v.nickname)));
  const theirNames = new Set(theirs.map((v) => key(v.nickname)));
  const onlyMine = mine.filter((v) => !theirNames.has(key(v.nickname)));
  const onlyTheirs = theirs.filter((v) => !mineNames.has(key(v.nickname)));
  return (
    <div className="stack-8">
      <p>
        <strong>Only on this device:</strong>{' '}
        {onlyMine.length ? onlyMine.map((v) => v.nickname).join(', ') : 'none'}
      </p>
      <p>
        <strong>Only in your account:</strong>{' '}
        {onlyTheirs.length ? onlyTheirs.map((v) => v.nickname).join(', ') : 'none'}
      </p>
      <p className="muted small">Items in both may still differ in amount or date.</p>
    </div>
  );
}

function DevicesPanel() {
  const { client, refresh } = useAccount();
  const toast = useToast();
  const [items, setItems] = useState<DeviceSession[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    client
      .listSessions()
      .then((s) => {
        setItems(s);
        setErr(null);
      })
      .catch((e) => setErr(describeApiError(e)));
  }, [client]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Panel title="Devices and sessions" id="acc-dev">
      {err && <Notice tone="warn">{err}</Notice>}
      {!items && !err && <p className="muted">Loading…</p>}
      {items && (
        <ul className="plain-list">
          {items.map((s) => (
            <li key={s.id} className="event-row">
              <div>
                <strong>{s.deviceLabel ?? s.userAgent ?? 'Unknown device'}</strong>{' '}
                {s.current && <Badge tone="calm">This device</Badge>}
                <p className="muted small">
                  Last active {localDateTime(s.lastSeenAt)} · signed in {localDateTime(s.createdAt)}{' '}
                  · expires {localDateTime(s.expiresAt)}
                </p>
              </div>
              <ConfirmButton
                label={s.current ? 'Revoke (signs you out)' : 'Revoke'}
                confirmLabel="Yes, revoke"
                className="btn btn-quiet btn-sm press"
                message="That device will need a new sign-in link."
                onConfirm={() =>
                  client
                    .revokeSession(s.id)
                    .then((r) => {
                      toast.show({ message: 'Session revoked', tone: 'success' });
                      if (r.current) void refresh();
                      else load();
                    })
                    .catch((e) => toast.show({ message: describeApiError(e), tone: 'error' }))
                }
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function HouseholdPanel() {
  const { client, entitlements } = useAccount();
  const toast = useToast();
  const allowed = serverAllows(entitlements, 'household_sharing');
  const [h, setH] = useState<HouseholdResponse | null>(null);
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const load = useCallback(() => {
    client
      .getHousehold()
      .then(setH)
      .catch(() => setH(null));
  }, [client]);
  useEffect(() => {
    if (allowed) load();
  }, [allowed, load]);
  if (!allowed)
    return (
      <Panel title="Household" id="acc-hh">
        <p className="muted">Sharing with your household isn’t available yet.</p>
      </Panel>
    );
  const err = (e: unknown) => toast.show({ message: describeApiError(e), tone: 'error' });
  return (
    <Panel title="Household" id="acc-hh">
      {!h || !h.household ? (
        <form
          className="inline-row"
          onSubmit={(e) => {
            e.preventDefault();
            client
              .createHousehold(name.trim() || 'Our household')
              .then(load)
              .catch(err);
          }}
        >
          <Field label="Household name" htmlFor="hh-name">
            <input id="hh-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-secondary press align-end">
            Create household
          </button>
        </form>
      ) : (
        <div className="stack-16">
          <p>
            <strong>{h.household.name}</strong> · you are {h.role}
          </p>
          <ul className="plain-list">
            {h.members.map((m) => (
              <li key={m.accountId} className="event-row">
                <span>
                  {m.displayName ?? m.email} <Badge>{m.role}</Badge>
                </span>
                {h.role === 'owner' && m.role !== 'owner' && (
                  <ConfirmButton
                    label="Remove"
                    confirmLabel="Yes, remove"
                    className="btn btn-quiet btn-sm press"
                    message={`Remove ${m.email} from the household?`}
                    onConfirm={() =>
                      client.removeHouseholdMember(m.accountId).then(load).catch(err)
                    }
                  />
                )}
              </li>
            ))}
            {h.pendingInvites.map((p) => (
              <li key={p.email} className="muted small">
                Invited {p.email} · expires {localDateTime(p.expiresAt)}
              </li>
            ))}
          </ul>
          {h.role === 'owner' && (
            <form
              className="inline-row"
              onSubmit={(e) => {
                e.preventDefault();
                client
                  .inviteHouseholdMember(invite.trim())
                  .then(() => {
                    setInvite('');
                    load();
                    toast.show({ message: 'Invite sent', tone: 'success' });
                  })
                  .catch(err);
              }}
            >
              <Field label="Invite by email" htmlFor="hh-inv">
                <input
                  id="hh-inv"
                  type="email"
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                />
              </Field>
              <button type="submit" className="btn btn-secondary press align-end">
                Invite
              </button>
            </form>
          )}
        </div>
      )}
    </Panel>
  );
}

const CONSENTS: [ConsentPurpose, string, string][] = [
  ['sync_backup', 'Back up my Due data to my account', SYNC_BACKUP_CONSENT_VERSION],
  ['reminders_email', 'Send reminders by email', REMINDERS_EMAIL_CONSENT_VERSION],
  ['email_intake', 'Read emails I forward to my Due address', EMAIL_INTAKE_CONSENT_VERSION],
  ['document_parsing', 'Read documents I upload (in this browser)', 'documents-2026-10'],
  ['telemetry', 'Anonymous usage events', TELEMETRY_CONSENT_VERSION],
];

function ConsentsPanel() {
  const { client, disableSync, sync } = useAccount();
  const toast = useToast();
  const [c, setC] = useState<ConsentsResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    client
      .getConsents()
      .then((r) => {
        // A withdrawal recorded on another device also stops telemetry here.
        if (r.current.telemetry && !r.current.telemetry.granted) setTelemetryOptOut(true);
        setC(r);
        setErr(null);
      })
      .catch((e) => setErr(describeApiError(e)));
  }, [client]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <Panel title="Consents" id="acc-consent">
      {err && <Notice tone="warn">{err}</Notice>}
      {c && (
        <ul className="plain-list">
          {CONSENTS.map(([purpose, label, version]) => {
            const cur = c.current[purpose];
            // Telemetry is governed by this device's opt-out; keep the switch and the sink in step.
            const checked = purpose === 'telemetry' ? !telemetryOptedOut() : !!cur?.granted;
            return (
              <li key={purpose}>
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                      const granted = e.target.checked;
                      if (purpose === 'telemetry') setTelemetryOptOut(!granted);
                      return client
                        .recordConsent(purpose, granted, version)
                        .then(() => {
                          // Withdrawing backup consent stops sync on this device at once (the
                          // server also refuses uploads). Email reminders stop server-side.
                          if (purpose === 'sync_backup' && !granted && sync.on)
                            disableSync(
                              'Backup and sync is off because you withdrew the backup consent.',
                            );
                          load();
                        })
                        .catch((er) =>
                          toast.show({ message: describeApiError(er), tone: 'error' }),
                        );
                    }}
                  />
                  <span>
                    {label}
                    {cur && (
                      <span className="muted small"> · recorded {localDateTime(cur.at)}</span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function DataPanel() {
  const { client, refresh } = useAccount();
  const toast = useToast();
  const [req, setReq] = useState<DeleteRequest | null>(null);
  const [typed, setTyped] = useState('');
  return (
    <Panel title="Your account data" id="acc-data">
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-secondary press"
          onClick={() =>
            client
              .exportAccount()
              .then((r) =>
                download('due-account-export.json', JSON.stringify(r, null, 2), 'application/json'),
              )
              .catch((e) => toast.show({ message: describeApiError(e), tone: 'error' }))
          }
        >
          Export account data
        </button>
      </div>
      {!req ? (
        <button
          type="button"
          className="btn btn-danger press"
          onClick={() =>
            client
              .requestAccountDeletion()
              .then(setReq)
              .catch((e) => toast.show({ message: describeApiError(e), tone: 'error' }))
          }
        >
          Delete my account…
        </button>
      ) : (
        <div className="confirm stack-8">
          <p>{req.warning}</p>
          <p className="muted small">
            This request expires {localDateTime(req.expiresAt)}. Data on this device is not deleted;
            use Settings → Delete all data for that.
          </p>
          <Field label="Type DELETE to confirm" htmlFor="del-typed">
            <input
              id="del-typed"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-danger press"
              disabled={typed !== 'DELETE'}
              onClick={() =>
                platform()
                  .deleteAccount(req.confirmationToken)
                  .then((r) => {
                    if (r?.requestId && r.statusToken)
                      writeJsonPref(DELETION_KEY, {
                        requestId: r.requestId,
                        token: r.statusToken,
                        at: new Date().toISOString(),
                      });
                    toast.show({
                      message: 'Account deletion started. Progress is shown on this page.',
                      tone: 'success',
                    });
                    setReq(null);
                    void refresh();
                  })
                  .catch((e) => toast.show({ message: describeApiError(e), tone: 'error' }))
              }
            >
              Permanently delete account
            </button>
            <button type="button" className="btn btn-secondary press" onClick={() => setReq(null)}>
              Keep my account
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}

const DELETION_KEY = 'deletion-request';

const STEP_LABEL: Record<string, string> = {
  sessions: 'Sign-ins ended',
  households: 'Household membership removed',
  forwarding_aliases: 'Forwarding address removed',
  inbound_messages: 'Forwarded emails deleted',
  intake_events: 'Imported items deleted',
  gmail_and_identities: 'Gmail access revoked and identities removed',
  reminders_and_notifications: 'Reminders and notifications deleted',
  sign_in_links_and_invites: 'Sign-in links and invites deleted',
  audit_trail: 'Account audit trail removed',
  account_record: 'Account record deleted',
};

/**
 * Account deletion runs asynchronously on the server. This polls GET /api/account/deletion-status with the
 * request id and token returned when deletion was requested (the session has already ended by then).
 */
export function DeletionProgress() {
  const [req, setReq] = useState(() =>
    readJsonPref<{ requestId: string; token: string; at: string } | null>(DELETION_KEY, null),
  );
  const [st, setSt] = useState<DeletionStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!req) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () =>
      platform()
        .deletionStatus(req.requestId, req.token)
        .then((r) => {
          if (!live) return;
          setSt(r);
          setErr(null);
          if (r.status !== 'completed' && r.status !== 'failed') timer = setTimeout(tick, 3000);
        })
        .catch((e) => {
          if (!live) return;
          setErr(describeApiError(e));
          timer = setTimeout(tick, 10_000);
        });
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [req]);
  if (!req) return null;
  const done = st?.status === 'completed';
  return (
    <Panel title="Account deletion" id="acc-deletion">
      <p>
        {done
          ? 'Your account and its data have been deleted.'
          : st?.status === 'failed'
            ? 'Deletion hit a problem and will be retried by Due’s team. Contact support if this persists.'
            : 'Deleting your account. You can close this page; deletion continues on the server.'}
      </p>
      <div
        className="progress"
        role="progressbar"
        aria-label="Deletion progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={st?.progress ?? 0}
      >
        <span style={{ width: `${st?.progress ?? 0}%` }} />
      </div>
      {st?.steps?.length ? (
        <ul className="plain-list small">
          {st.steps.map((x) => (
            <li key={x.step}>
              {x.done ? '✓' : '…'} {STEP_LABEL[x.step] ?? x.step.replace(/_/g, ' ')}
            </li>
          ))}
        </ul>
      ) : null}
      {Array.isArray(st?.retentionExceptions) && st.retentionExceptions.length > 0 && (
        <p className="muted small">
          Kept where the law requires:{' '}
          {(st.retentionExceptions as unknown[])
            .map((x) => {
              if (typeof x === 'string') return x;
              const o = x as { record?: string; reason?: string };
              return [o.record, o.reason].filter(Boolean).join(' — ');
            })
            .filter(Boolean)
            .join('; ')}
        </p>
      )}
      {err && <Notice tone="warn">{err}</Notice>}
      {done && (
        <button
          type="button"
          className="btn btn-secondary press"
          onClick={() => {
            writeJsonPref(DELETION_KEY, null);
            setReq(null);
          }}
        >
          Dismiss
        </button>
      )}
    </Panel>
  );
}
