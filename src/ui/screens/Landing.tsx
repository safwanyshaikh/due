import { EMAIL_INGESTION_COPY, FORWARD_PERMISSIONS, INTAKE_LINE } from '../../content/privacy';
import { Glyph } from '../components/Glyph';
import { Badge } from '../components/ui';
import { StartChoices } from '../components/StartChoices';

/** The five first-use choices on their own page (also shown on an empty Home). */
export function StartPaths() {
  return (
    <div className="page2">
      <header className="page-head">
        <h1 id="start-h">How would you like to start?</h1>
        <p className="muted">{INTAKE_LINE}</p>
      </header>
      <StartChoices headingId="start-h" />
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
