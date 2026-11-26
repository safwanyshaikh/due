import { LEGAL_DOCS, type LegalDoc } from '../lib/nav';
import { usePublicLegal, type PublicLegal } from '../lib/platform';
import { SafeMarkdown } from '../lib/markdown';
import { Glyph } from '../components/Glyph';
import { Notice } from '../components/ui';
import { formatDate } from '../../lib/dates';
import { PRIVACY_SUMMARY } from '../../content/privacy';

export const LEGAL_TITLES: Record<LegalDoc, string> = {
  privacy: 'Privacy notice',
  terms: 'Terms of use',
  refund: 'Refund and cancellation',
  delivery: 'Delivery (digital service)',
  contact: 'Contact us',
  cookies: 'Cookies and local storage',
  deletion: 'Deletion policy',
  subprocessors: 'Subprocessors',
  grievance: 'Grievance contact',
};

export const LEGAL_INCOMPLETE = 'Legal details are being finalised';

/** Footer links to every public policy page (payment gateways expect them on the site). */
export function LegalLinks() {
  return (
    <p className="muted small start-legal" data-testid="start-legal">
      {FOOTER_DOCS.map((d, i) => (
        <span key={d}>
          {i > 0 ? ' · ' : null}
          <a href={`#/legal/${d}`}>{FOOTER_LABEL[d]}</a>
        </span>
      ))}
    </p>
  );
}

const FOOTER_DOCS: LegalDoc[] = ['privacy', 'terms', 'refund', 'delivery', 'contact', 'cookies'];
const FOOTER_LABEL: Partial<Record<LegalDoc, string>> = {
  privacy: 'Privacy',
  terms: 'Terms',
  refund: 'Refunds and cancellation',
  delivery: 'Delivery',
  contact: 'Contact',
  cookies: 'Cookies',
};

const has = (v: string | null | undefined): v is string => typeof v === 'string' && !!v.trim();

function Body({ doc, legal }: { doc: LegalDoc; legal: PublicLegal }) {
  if (doc === 'privacy')
    return has(legal.privacyPolicyMd) ? <SafeMarkdown source={legal.privacyPolicyMd} /> : null;
  if (doc === 'terms') return has(legal.termsMd) ? <SafeMarkdown source={legal.termsMd} /> : null;
  if (doc === 'refund')
    return has(legal.refundPolicyMd) ? <SafeMarkdown source={legal.refundPolicyMd} /> : null;
  if (doc === 'delivery')
    return has(legal.deliveryPolicyMd) ? <SafeMarkdown source={legal.deliveryPolicyMd} /> : null;
  if (doc === 'contact')
    return has(legal.contactMd) ? <SafeMarkdown source={legal.contactMd} /> : null;
  if (doc === 'cookies')
    return has(legal.cookiesMd) ? <SafeMarkdown source={legal.cookiesMd} /> : null;
  if (doc === 'deletion')
    return has(legal.deletionPolicyMd) ? <SafeMarkdown source={legal.deletionPolicyMd} /> : null;
  if (doc === 'subprocessors')
    return legal.subprocessors?.length ? (
      <table className="sub-table">
        <caption className="sr-only">Subprocessors</caption>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Purpose</th>
            <th scope="col">Region</th>
          </tr>
        </thead>
        <tbody>
          {legal.subprocessors.map((s) => (
            <tr key={s.name + s.purpose}>
              <td>{s.name}</td>
              <td>{s.purpose}</td>
              <td>{s.region}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null;
  // Grievance contact: the caller renders this only when complete, so no placeholder is shown as real.
  return (
    <dl className="kv">
      {has(legal.grievanceOfficerName) && (
        <div>
          <dt>Grievance officer</dt>
          <dd>{legal.grievanceOfficerName}</dd>
        </div>
      )}
      {has(legal.grievanceEmail) && (
        <div>
          <dt>Email</dt>
          <dd>
            <a href={`mailto:${legal.grievanceEmail}`}>{legal.grievanceEmail}</a>
          </dd>
        </div>
      )}
      {has(legal.grievancePhone) && (
        <div>
          <dt>Phone</dt>
          <dd>{legal.grievancePhone}</dd>
        </div>
      )}
      {has(legal.supportEmail) && (
        <div>
          <dt>Support</dt>
          <dd>
            <a href={`mailto:${legal.supportEmail}`}>{legal.supportEmail}</a>
          </dd>
        </div>
      )}
      {has(legal.entityName) && (
        <div>
          <dt>Entity</dt>
          <dd>{legal.entityName}</dd>
        </div>
      )}
      {has(legal.address) && (
        <div>
          <dt>Address</dt>
          <dd>{legal.address}</dd>
        </div>
      )}
    </dl>
  );
}

/** Legal pages rendered from GET /api/public/legal. Raw HTML is never rendered. */
export function LegalScreen({ doc }: { doc?: LegalDoc }) {
  const l = usePublicLegal();
  if (!doc)
    return (
      <div className="page2">
        <header className="page-head">
          <h1>Legal</h1>
          {l.state === 'ok' && !l.value.complete && (
            <Notice tone="warn">{LEGAL_INCOMPLETE}.</Notice>
          )}
        </header>
        <nav aria-label="Legal documents">
          <ul className="link-list">
            {LEGAL_DOCS.map((d) => (
              <li key={d}>
                <a className="link-row press" href={`#/legal/${d}`}>
                  <Glyph name="shield" />
                  <span>{LEGAL_TITLES[d]}</span>
                  <Glyph name="chevron" size={18} />
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    );
  const legal = l.state === 'ok' ? l.value : null;
  const body = legal ? <Body doc={doc} legal={legal} /> : null;
  return (
    <div className="page2">
      <header className="page-head">
        <h1>{LEGAL_TITLES[doc]}</h1>
        {legal && legal.complete && has(legal.effectiveDate) && (
          <p className="muted small">
            Effective{' '}
            {/^\d{4}-\d{2}-\d{2}/.test(legal.effectiveDate)
              ? formatDate(legal.effectiveDate.slice(0, 10))
              : legal.effectiveDate}
          </p>
        )}
      </header>
      {l.state === 'loading' && <p className="muted">Loading…</p>}
      {l.state === 'unavailable' && (
        <Notice tone="warn">
          {LEGAL_INCOMPLETE}. This page couldn’t be loaded from Due’s server right now.
        </Notice>
      )}
      {legal && !legal.complete && <Notice tone="warn">{LEGAL_INCOMPLETE}.</Notice>}
      {doc === 'privacy' && !legal?.complete && l.state !== 'loading' && (
        <section aria-labelledby="priv-sum-h" data-testid="privacy-bundled">
          <h2 id="priv-sum-h">{PRIVACY_SUMMARY.heading}</h2>
          <ul className="plain-list">
            {PRIVACY_SUMMARY.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </section>
      )}
      {legal?.complete && body}
      {legal && !body && legal.complete && <p className="muted">Not published yet.</p>}
      <a className="btn btn-quiet press" href="#/legal">
        All legal documents
      </a>
    </div>
  );
}
