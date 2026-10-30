import { EMAIL_INGESTION_COPY, FORWARD_PERMISSIONS, INTAKE_LINE } from '../../content/privacy';
import { Glyph, type GlyphName } from '../components/Glyph';
import { Badge } from '../components/ui';
import { writePref } from '../lib/prefs';

/** First-run landing (no data yet): value-first CTA, then account options. */
export function Landing() {
  return (
    <div className="landing">
      <section className="landing-hero" aria-labelledby="landing-title">
        <p className="eyebrow">Calm reminders for what you owe</p>
        <h1 id="landing-title">Know what’s due next, how much, and how sure you can be.</h1>
        <p className="muted">
          Subscriptions, EMIs, card bills, school fees and household bills, ordered by date. Due
          never pays or cancels anything for you.
        </p>
        <div className="stack-8 landing-ctas">
          <a className="btn btn-primary btn-block btn-lg press" href="#/start">
            See my next due date
          </a>
          <a className="btn btn-secondary btn-block press" href="#/account">
            Continue with email
          </a>
          <a
            className="btn btn-quiet btn-block press"
            href="#/start"
            onClick={() => writePref('guest', '1')}
          >
            Use without an account
          </a>
        </div>
        <p className="muted small">
          No account needed to start. What you add stays on this device unless you sign in and turn
          on backup.
        </p>
      </section>
    </div>
  );
}

const PATHS: { href: string; icon: GlyphName; title: string; body: string; id?: string }[] = [
  {
    href: '#/add',
    icon: 'plus',
    title: 'Add manually',
    body: 'Type a name, amount and date. Takes under a minute.',
  },
  {
    href: '#/upload',
    icon: 'upload',
    title: 'Upload a bill or sanction letter',
    body: 'PDF or text, read in your browser. Review every field first.',
  },
  {
    href: '#/forward',
    icon: 'mail',
    title: 'Forward a subscription email',
    body: 'Send one email to your own Due address.',
    id: 'path-forward',
  },
  {
    href: '#/account',
    icon: 'user',
    title: 'Sign in for sync and reminders',
    body: 'Backup, other devices, email reminders.',
  },
];

/** The four equal intake paths, with the email-ingestion explanation beside forwarding. */
export function StartPaths() {
  return (
    <div className="page2">
      <header className="page-head">
        <h1>How would you like to start?</h1>
        <p className="muted">{INTAKE_LINE}</p>
      </header>
      <ul className="paths">
        {PATHS.map((p) => (
          <li key={p.href + p.title}>
            <a
              className="path press"
              href={p.href}
              aria-describedby={p.id ? 'email-ingestion' : undefined}
            >
              <span className="path-icon">
                <Glyph name={p.icon} />
              </span>
              <span className="path-text">
                <strong>{p.title}</strong>
                <span className="muted small">{p.body}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      <EmailIngestionCard />
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
