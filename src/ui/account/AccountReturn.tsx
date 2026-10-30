import { useEffect, useRef, useState } from 'react';
import { AccountApiError } from '../../lib/account/client';
import { Sheet } from '../components/Sheet';
import { useToast } from '../components/Toast';
import { Notice } from '../components/ui';
import { readPref, writePref } from '../lib/prefs';
import { useApp } from '../store';
import { useAccount } from './AccountContext';

type Banner = null | 'link-invalid';

/** Short, non-identifying label for this device ("Chrome on Android"), shown in the device list. */
export function deviceLabel(
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): string {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * Handles the magic-link return and household invites.
 * - `?account=confirm&token=…` (from the e-mailed link): asks "Confirm sign-in on this device"; only
 *   the button press consumes the link (POST), so link scanners cannot sign anyone in.
 * - `?account=signed-in|link-invalid`, `?household_invite=…`: invites are never accepted
 *   automatically; once signed in the person is asked to accept or decline.
 * After sign-in it offers to back up this device's data and to bring forwarded emails from this
 * browser's temporary intake session into the account.
 */
export function AccountReturn() {
  const { status, client, refresh, enableSync, sync } = useAccount();
  const { data } = useApp();
  const toast = useToast();
  const [banner, setBanner] = useState<Banner>(null);
  const [welcome, setWelcome] = useState(false);
  const [claim, setClaim] = useState<string | null>(null);
  const [confirmToken, setConfirmToken] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);
  const [invite, setInvite] = useState<string | null>(() => readPref('household-invite'));
  const [inviteBusy, setInviteBusy] = useState(false);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const params = new URLSearchParams(window.location.search);
    const account = params.get('account');
    const inviteToken = params.get('household_invite');
    const token = params.get('token');
    if (!account && !inviteToken) return;
    if (inviteToken) writePref('household-invite', inviteToken);
    // Secrets leave the address bar (and history) at once.
    params.delete('account');
    params.delete('household_invite');
    params.delete('token');
    const qs = params.toString();
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash}`,
    );
    queueMicrotask(() => {
      if (inviteToken) setInvite(inviteToken);
      if (account === 'link-invalid') setBanner('link-invalid');
      if (account === 'confirm') {
        if (token && /^[A-Za-z0-9_-]{16,256}$/.test(token)) setConfirmToken(token);
        else setBanner('link-invalid');
      }
      if (account === 'signed-in') {
        setWelcome(true);
        void refresh();
      }
    });
  }, [refresh]);

  const confirmSignIn = async () => {
    if (!confirmToken) return;
    setConfirming(true);
    setConfirmErr(null);
    try {
      await client.verifyMagicLink(confirmToken, deviceLabel());
      setConfirmToken(null);
      setWelcome(true);
      await refresh();
    } catch (e) {
      if (e instanceof AccountApiError && e.status === 400) {
        setConfirmToken(null);
        setBanner('link-invalid');
      } else setConfirmErr(e instanceof AccountApiError ? e.message : 'Sign-in failed. Try again.');
    } finally {
      setConfirming(false);
    }
  };

  const dropInvite = () => {
    writePref('household-invite', null);
    setInvite(null);
  };

  const acceptInvite = async () => {
    if (!invite) return;
    setInviteBusy(true);
    try {
      const r = await client.acceptHouseholdInvite(invite);
      dropInvite();
      toast.show({ message: `You joined ${r.household.name}.`, tone: 'success' });
      await refresh();
    } catch (e) {
      // An invalid or expired invite is dropped; anything else can be retried.
      if (e instanceof AccountApiError && e.status >= 400 && e.status < 500) dropInvite();
      toast.show({
        message:
          e instanceof AccountApiError ? e.message : 'The household invite could not be accepted.',
        tone: 'error',
      });
    } finally {
      setInviteBusy(false);
    }
  };

  return (
    <>
      {confirmToken && (
        <Sheet title="Confirm sign-in on this device" onClose={() => setConfirmToken(null)}>
          <p>
            You opened a Due sign-in link. Sign in on this device? Only continue if you asked for
            this link just now.
          </p>
          {confirmErr && <Notice tone="warn">{confirmErr}</Notice>}
          <div className="stack-8">
            <button
              type="button"
              className="btn btn-primary btn-block press"
              disabled={confirming}
              onClick={() => void confirmSignIn()}
            >
              {confirming ? 'Signing in…' : 'Sign in on this device'}
            </button>
            <button
              type="button"
              className="btn btn-quiet btn-block press"
              onClick={() => setConfirmToken(null)}
            >
              Cancel
            </button>
          </div>
        </Sheet>
      )}
      {invite && status === 'signed_in' && !confirmToken && !welcome && (
        <Sheet title="Join a household?" onClose={dropInvite}>
          <p>
            You were invited to share Due data with a household. If you accept, the household’s
            members can see and edit the items you share there. You can leave at any time.
          </p>
          <div className="stack-8">
            <button
              type="button"
              className="btn btn-primary btn-block press"
              disabled={inviteBusy}
              onClick={() => void acceptInvite()}
            >
              Accept invitation
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-block press"
              disabled={inviteBusy}
              onClick={dropInvite}
            >
              Decline
            </button>
          </div>
        </Sheet>
      )}
      {banner === 'link-invalid' && (
        <div className="shell-notice">
          <Notice tone="warn" title="That sign-in link didn’t work">
            It may have expired or already been used. <a href="#/account">Request a new link</a>.
            You can keep using Due on this device meanwhile.
          </Notice>
        </div>
      )}
      {invite && status === 'signed_out' && (
        <div className="shell-notice">
          <Notice title="You’ve been invited to a household">
            <a href="#/account">Sign in</a> with the invited email address to join it.
          </Notice>
        </div>
      )}
      {welcome && status === 'signed_in' && (
        <Sheet title="You’re signed in" onClose={() => setWelcome(false)}>
          <p>
            Signing in adds backup, sync across devices and reminders. Nothing on this device has
            been uploaded yet.
          </p>
          {data.commitments.length > 0 && !sync.on && (
            <div className="stack-8">
              <p>
                Back up this device’s {data.commitments.length} item
                {data.commitments.length === 1 ? '' : 's'} to your account?
              </p>
              <button
                type="button"
                className="btn btn-primary press"
                onClick={() => {
                  void enableSync();
                  setWelcome(false);
                }}
              >
                Back up this device’s data
              </button>
            </div>
          )}
          <div className="stack-8">
            <p>
              If you forwarded emails before signing in, bring them into your account so they are
              not lost when the temporary session expires.
            </p>
            <button
              type="button"
              className="btn btn-secondary press"
              onClick={() => {
                client
                  .claimIntake()
                  .then((r) =>
                    setClaim(
                      `Moved ${r.moved} forwarded item${r.moved === 1 ? '' : 's'} to your account${
                        r.duplicatesDropped ? ` (${r.duplicatesDropped} duplicates dropped)` : ''
                      }.`,
                    ),
                  )
                  .catch((e) =>
                    setClaim(
                      e instanceof AccountApiError
                        ? e.message
                        : 'Forwarded items could not be moved right now.',
                    ),
                  );
              }}
            >
              Bring forwarded emails into my account
            </button>
            {claim && <p role="status">{claim}</p>}
          </div>
          <button type="button" className="btn btn-quiet press" onClick={() => setWelcome(false)}>
            Not now
          </button>
        </Sheet>
      )}
    </>
  );
}
