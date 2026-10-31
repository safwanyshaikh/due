import { useEffect, useState } from 'react';
import { gmailReasonMessage, readGmailCallback } from '../../lib/account/gmail';
import { usePublicStatus } from '../lib/platform';
import { Notice } from './ui';

/** Incident banner from GET /api/public/status (set by Due's operators in Admin). */
export function IncidentBanner() {
  const st = usePublicStatus();
  const inc = st.state === 'ok' ? st.value.incident : null;
  if (!inc) return null;
  return (
    <div className="shell-notice" data-testid="incident">
      <Notice tone={inc.level === 'info' ? 'info' : 'warn'} title="Service notice">
        {inc.message}
      </Notice>
    </div>
  );
}

type GmailReturn = { ok: true } | { ok: false; message: string } | null;

/**
 * Handles the return from Google’s Gmail consent screen (`/?gmail=connected&identity=…` or `/?gmail=error&reason=…`): shows the
 * result once, removes the query from the address bar and opens Connections.
 */
export function GmailReturnBanner() {
  const [r, setR] = useState<GmailReturn>(() => {
    const cb = readGmailCallback(window.location.search);
    if (!cb) return null;
    return cb.status === 'connected'
      ? { ok: true }
      : { ok: false, message: gmailReasonMessage(cb.reason) };
  });
  useEffect(() => {
    if (!r) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('gmail');
    url.searchParams.delete('identity');
    url.searchParams.delete('reason');
    url.hash = '#/connections';
    window.history.replaceState(null, '', url.toString());
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    // Runs once for the value read at load.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!r) return null;
  return (
    <div className="shell-notice" data-testid="gmail-return">
      <Notice
        tone={r.ok ? 'ok' : 'warn'}
        title={r.ok ? 'Gmail connected (read-only)' : 'Gmail not connected'}
      >
        {r.ok
          ? 'Due will search only for billing and renewal messages. Anything found waits in your review queue; nothing is saved until you confirm it.'
          : r.message}{' '}
        <button type="button" className="text-btn press" onClick={() => setR(null)}>
          Dismiss
        </button>
      </Notice>
    </div>
  );
}
