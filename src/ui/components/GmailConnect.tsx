import { useState } from 'react';
import { AccountApiError } from '../../lib/account/client';
import { gmailReasonMessage } from '../../lib/account/gmail';
import { GMAIL_CONSENT_COPY, GMAIL_SCOPE_LABELS } from '../../content/privacy';
import { useAccount } from '../account/AccountContext';
import { serverAllows } from '../lib/entitlement';
import { gmailClient, modeLabel, modeTone, useGmailStatus } from '../lib/platform';
import { Sheet } from './Sheet';
import { Badge, Notice } from './ui';

/** Where the browser goes for Google's consent screen. Replaceable in tests. */
export const redirectTo = { assign: (url: string) => window.location.assign(url) };

/**
 * Explains exactly what Gmail access means (consent copy and the scope list) before redirecting to
 * Google. Never shows Gmail as connected: the server decides the mode, and only a returned identity counts.
 */
export function GmailConnectSheet({ onClose }: { onClose: () => void }) {
  const { status, entitlements } = useAccount();
  const gs = useGmailStatus();
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const signedIn = status === 'signed_in';
  const plus = serverAllows(entitlements, 'email_import');
  const s = gs.state === 'ok' ? gs.value : null;
  const mode = s?.mode ?? 'unknown';
  const usable =
    !!s && (s.mode === 'live' || s.mode === 'test_mode' || s.mode === 'verification_pending');

  const go = async () => {
    if (!s) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await gmailClient().connect(s.consentVersion);
      redirectTo.assign(r.authorizeUrl);
    } catch (e) {
      setBusy(false);
      if (e instanceof AccountApiError) {
        if (e.isPremiumRequired) setErr('Gmail scanning is part of Plus.');
        else if (e.code === 'gmail_not_configured') setErr(gmailReasonMessage('not_configured'));
        else if (e.isUnauthorized) setErr('Sign in first, then connect Gmail.');
        else setErr(e.message);
      } else setErr('Gmail could not be connected. Please try again.');
    }
  };

  return (
    <Sheet title="Connect Gmail (read-only)" onClose={onClose}>
      <div className="stack-16">
        <p className="consent-copy" data-testid="gmail-consent">
          {GMAIL_CONSENT_COPY}
        </p>
        <div className="kv-row">
          <span className="muted small">Status on this server</span>
          <Badge tone={modeTone(mode)}>
            {gs.state === 'loading' ? 'Checking…' : modeLabel(mode)}
          </Badge>
        </div>
        {s?.blocker && <Notice tone="warn">{s.blocker}</Notice>}
        {s?.mode === 'test_mode' && (
          <p className="muted small">
            Test mode: only Google accounts Due has added as testers can connect for now.
          </p>
        )}
        <section aria-labelledby="gmail-scopes">
          <h3 id="gmail-scopes" className="h-small">
            Permissions Google will ask you for
          </h3>
          {s?.scopes?.length ? (
            <ul className="scope-list">
              {s.scopes.map((sc) => (
                <li key={sc}>
                  <code>{sc}</code>
                  {GMAIL_SCOPE_LABELS[sc] && (
                    <span className="muted small"> — {GMAIL_SCOPE_LABELS[sc]}</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">
              {gs.state === 'loading'
                ? 'Loading the exact permissions…'
                : 'The permission list is unavailable right now, so Due will not redirect you.'}
            </p>
          )}
        </section>
        <p className="muted small">
          You can disconnect at any time from Connections, and choose to delete what was imported.
          Nothing found is saved until you review and confirm it.
        </p>
        {!signedIn ? (
          <a className="btn btn-primary btn-block press jelly" href="#/account">
            Sign in to connect Gmail
          </a>
        ) : !plus ? (
          <a className="btn btn-primary btn-block press jelly" href="#/plans">
            Gmail scanning is part of Plus — see plans
          </a>
        ) : (
          <>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={agreed}
                onChange={(e) => setAgreed(e.target.checked)}
                disabled={!usable}
              />
              <span>I understand what Due can and cannot do with my Gmail.</span>
            </label>
            <button
              type="button"
              className="btn btn-primary btn-block press jelly"
              disabled={!usable || !agreed || busy || !s?.scopes?.length}
              onClick={() => void go()}
            >
              {busy ? 'Opening Google…' : 'Continue to Google'}
            </button>
          </>
        )}
        {err && <Notice tone="warn">{err}</Notice>}
      </div>
    </Sheet>
  );
}
