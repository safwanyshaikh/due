import { useState } from 'react';
import { EMAIL_INGESTION_COPY, FORWARD_PERMISSIONS, INTAKE_LINE } from '../../content/privacy';
import { Glyph } from '../components/Glyph';
import { Badge } from '../components/ui';
import { StartChoices } from '../components/StartChoices';
import { BetaBadge } from '../components/BetaBadge';
import { useApp } from '../store';
import { useAccount } from '../account/AccountContext';
import { readPref, writePref } from '../lib/prefs';
import { usePublicStatus } from '../lib/platform';
import { useT } from '../lib/lang';
import { Home } from './Home';
import { LegalLinks } from './LegalScreen';

/** The five first-use choices on their own page (also shown on an empty Home). */
export const START_BENEFITS = [
  'See every bill, subscription and EMI in one place.',
  'Get reminded before money leaves your account.',
  'Spot where you may be overpaying, then decide for yourself.',
] as const;

export const HOW_IT_WORKS = [
  'Add a bill, or upload a statement or receipt.',
  'Check every field. Nothing is saved until you approve it.',
  'See what is due and get reminded, on your terms.',
] as const;

export const LANDING_PRIVACY_LINE = 'Your statements are read on your phone.';
const OPENED_PREF = 'landing-opened';

/**
 * The public landing, shown at the root to someone who is signed out, has nothing saved on this device and has
 * not pressed "Open Due" before. Everyone else goes straight to Home. Store buttons appear only when an admin
 * has set the links (GET /api/public/status).
 */
export function LandingPage({ onOpen }: { onOpen: () => void }) {
  const st = usePublicStatus();
  const apps = st.state === 'ok' ? st.value.apps : { androidUrl: null, iosUrl: null };
  const t = useT();
  return (
    <div className="page2 landing" data-testid="landing">
      <header className="page-head start-hero" data-block="hero">
        <p className="hero-beta">
          <BetaBadge />
        </p>
        <h1>{t('landing.headline')}</h1>
        <p className="hero-sub">{t('landing.sub')}</p>
        <ul className="hero-benefits" data-testid="start-benefits">
          {(['landing.benefit1', 'landing.benefit2', 'landing.benefit3'] as const).map((k) => (
            <li key={k}>{t(k)}</li>
          ))}
        </ul>
        <div className="btn-row landing-cta">
          <a className="btn btn-primary press" href="#/start" onClick={onOpen}>
            {t('landing.cta')}
          </a>
          {apps.androidUrl && (
            <a
              className="btn btn-secondary press"
              href={apps.androidUrl}
              rel="noopener noreferrer"
              data-testid="store-android"
            >
              Get it on Google Play
            </a>
          )}
          {apps.iosUrl && (
            <a
              className="btn btn-secondary press"
              href={apps.iosUrl}
              rel="noopener noreferrer"
              data-testid="store-ios"
            >
              Download on the App Store
            </a>
          )}
        </div>
        <p className="muted small" data-testid="landing-privacy">
          {t('landing.privacy')}
        </p>
      </header>
      <section className="stack-8" aria-labelledby="how-h">
        <h2 id="how-h">How it works</h2>
        <ol className="how-steps" data-testid="how-steps">
          {HOW_IT_WORKS.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ol>
        <p className="muted small">
          Information only. Due never pays, cancels or switches anything for you.{' '}
          <a href="/compare" data-testid="compare-link">
            How Due is different
          </a>
        </p>
      </section>
      <LegalLinks />
    </div>
  );
}

/** Root route: the landing for a signed-out visitor with nothing saved, otherwise Home. */
export function HomeOrLanding() {
  const { data } = useApp();
  const { status } = useAccount();
  const [opened, setOpened] = useState(() => readPref(OPENED_PREF) === '1');
  const fresh = data.commitments.length === 0 && data.services.length === 0;
  if (opened || !fresh || status === 'signed_in') return <Home />;
  if (status === 'checking') return <div className="page2" aria-busy="true" />;
  return (
    <LandingPage
      onOpen={() => {
        writePref(OPENED_PREF, '1');
        setOpened(true);
      }}
    />
  );
}

export function StartPaths() {
  return (
    <div className="page2">
      <header className="page-head" data-block="hero">
        <h1 id="start-h">How would you like to start?</h1>
        <p className="muted">{INTAKE_LINE}</p>
        <p className="hero-beta">
          <BetaBadge />
        </p>
      </header>
      <StartChoices headingId="start-h" />
      <EmailIngestionCard />
      <LegalLinks />
    </div>
  );
}

/** Exact ingestion copy, explicit permission preview and an illustrative receipt. */
export function EmailIngestionCard({ compact = false }: { compact?: boolean }) {
  return (
    <section className="ingest panel2" aria-labelledby="ingest-title">
      <h2 id="ingest-title">About email forwarding</h2>
      <p id="email-ingestion" className="ingest-copy">
        {EMAIL_INGESTION_COPY}
      </p>
      <div className="perm-grid">
        <div>
          <h3 className="perm-h">
            <Glyph name="check" size={18} /> Due can see
          </h3>
          <ul className="perm-list">
            {FORWARD_PERMISSIONS.can.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="perm-h">
            <Glyph name="close" size={18} /> Due cannot see
          </h3>
          <ul className="perm-list">
            {FORWARD_PERMISSIONS.cannot.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      </div>
      {!compact && <ExampleReceipt />}
    </section>
  );
}

/** Illustration only: shows what a review looks like. It is not data and cannot be saved. */
export function ExampleReceipt() {
  return (
    <figure className="example" aria-labelledby="example-cap">
      <div className="example-head">
        <Badge tone="premium">Example</Badge>
        <span className="muted small">Forwarded email · illustration, not your data</span>
      </div>
      <dl className="example-fields">
        <div>
          <dt>Merchant</dt>
          <dd>
            A streaming service <Badge tone="calm">High confidence</Badge>
          </dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>
            ₹199 <Badge tone="calm">High confidence</Badge>
          </dd>
        </div>
        <div>
          <dt>Renewal date</dt>
          <dd>
            5th of next month <Badge tone="warm">Check this</Badge>
          </dd>
        </div>
        <div>
          <dt>Link</dt>
          <dd>
            Account page link <Badge>Not found</Badge>
          </dd>
        </div>
      </dl>
      <div className="example-actions" aria-hidden="true">
        <span className="fake-btn fake-primary">Review</span>
        <span className="fake-btn">Ignore</span>
      </div>
      <figcaption id="example-cap" className="muted small">
        Example of a review card. In real use every field is shown like this, with its confidence,
        and nothing is saved until you approve it.
      </figcaption>
    </figure>
  );
}
