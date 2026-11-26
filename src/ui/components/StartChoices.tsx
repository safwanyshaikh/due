import { useState } from 'react';
import { useAccount } from '../account/AccountContext';
import { serverAllows } from '../lib/entitlement';
import {
  featureTag,
  modeLabel,
  modeTone,
  usePublicStatus,
  type IntegrationMode,
} from '../lib/platform';
import { guestUploadsRemaining, remainingText } from '../lib/uploads';
import { Glyph, type GlyphName } from './Glyph';
import { GmailConnectSheet } from './GmailConnect';
import { Badge } from './ui';

interface Choice {
  key: string;
  icon: GlyphName;
  title: string;
  body: string;
  href?: string;
  tag?: { text: string; tone: 'calm' | 'warm' | 'plain' };
}

/**
 * The five first-use choices. Integration labels come from /api/public/status so nothing is sold as live
 * when it isn't: live / test mode / verification pending / not configured / Plus required.
 */
export function StartChoices({
  headingId,
  compact = false,
}: {
  headingId?: string;
  compact?: boolean;
}) {
  const { status, entitlements } = useAccount();
  const st = usePublicStatus();
  const [gmail, setGmail] = useState(false);
  const plus = serverAllows(entitlements, 'email_import');
  const mode = (k: 'inbound' | 'gmail' | 'smtp'): IntegrationMode | 'unknown' =>
    st.state === 'ok' ? st.value.integrations[k] : 'unknown';
  const loading = st.state === 'loading';
  const signedIn = status === 'signed_in';
  const smtp = mode('smtp');

  // Only offer an integration that is actually on: no "Not configured" dead ends (UX audit 3).
  const available = (m: IntegrationMode | 'unknown') =>
    m === 'live' || m === 'test_mode' || m === 'verification_pending';

  const all: (Choice & { show?: boolean })[] = [
    {
      key: 'statement',
      icon: 'upload',
      title: 'Upload a bank/card statement',
      body: 'Read on your phone. Due finds your subscriptions and AutoPay for you.',
      href: '#/savings-import',
    },
    {
      key: 'manual',
      icon: 'plus',
      title: 'Add manually',
      body: 'Name, amount and date. Under a minute.',
      href: '#/add',
    },
    {
      key: 'upload',
      icon: 'upload',
      title: 'Upload a bill or sanction letter',
      body: 'PDF or photo, read on this device. Review every field first.',
      href: '#/upload',
      tag: signedIn ? undefined : { text: remainingText(guestUploadsRemaining()), tone: 'plain' },
    },
    {
      key: 'forward',
      icon: 'mail',
      title: 'Forward a subscription email',
      body: 'Send one email to your own private Due address.',
      href: '#/forward',
      tag: loading ? undefined : featureTag(mode('inbound'), true, plus),
      show: available(mode('inbound')),
    },
    {
      key: 'gmail',
      icon: 'shield',
      title: 'Connect Gmail',
      body: 'Read-only search for bills, renewals and trials.',
      tag: loading ? undefined : featureTag(mode('gmail'), true, plus),
      show: available(mode('gmail')),
    },
    {
      key: 'signin',
      icon: 'user',
      title: signedIn ? 'Sync and reminders' : 'Sign in for sync and reminders',
      body: 'Backup, other devices and email reminders.',
      href: '#/account',
      tag:
        loading || !available(smtp) || smtp === 'live'
          ? undefined
          : { text: `Email ${modeLabel(smtp).toLowerCase()}`, tone: modeTone(smtp) },
    },
  ];
  const choices = all.filter((c) => c.show !== false);

  return (
    <>
      <ul className={`paths ${compact ? 'paths-compact' : ''}`} aria-labelledby={headingId}>
        {choices.map((c) => {
          const inner = (
            <>
              <span className="path-icon jelly-ic">
                <Glyph name={c.icon} />
              </span>
              <span className="path-text">
                <strong>{c.title}</strong>
                <span className="muted small">{c.body}</span>
              </span>
              {c.tag && (
                <span className="path-tag">
                  <Badge tone={c.tag.tone}>{c.tag.text}</Badge>
                </span>
              )}
            </>
          );
          return (
            <li key={c.key}>
              {c.href ? (
                <a className="path press jelly" href={c.href} data-choice={c.key}>
                  {inner}
                </a>
              ) : (
                <button
                  type="button"
                  className="path press jelly"
                  data-choice={c.key}
                  onClick={() => setGmail(true)}
                >
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {gmail && <GmailConnectSheet onClose={() => setGmail(false)} />}
    </>
  );
}
