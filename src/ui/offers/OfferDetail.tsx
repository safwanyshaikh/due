import { useState } from 'react';
import { useApp } from '../store';
import { Disclaimer, SourceLink, StatusBadge, priceText, useCatalog, valueText } from './parts';
import { BENEFIT_LABEL, PROVIDER_LABEL } from '../../lib/offers/catalog';
import {
  CHECK_TEXT,
  entitlementFor,
  evaluateEligibility,
  matchSummary,
  offersForService,
} from '../../lib/offers/eligibility';
import { expiryLabel, isStale } from '../../lib/offers/status';
import { historyFor } from '../../lib/offers/observations';
import { addOfferReminder } from '../../lib/offers/services';
import { ACCOUNT_NOTE, PAYMENT_NOTE } from '../../lib/offers/copy';
import { formatDate, isValidISO } from '../../lib/dates';

const ICON = { confirmed: '✓', missing: '…', provider_only: '↗', may_not_qualify: '!' } as const;

export function OfferDetail({ id }: { id: string }) {
  const { data, today, update } = useApp();
  const catalog = useCatalog(today);
  const o = catalog.find((x) => x.offerId === id);
  const services = data.services.filter(
    (s) => o && offersForService(s, catalog).some((x) => x.offerId === o.offerId),
  );
  const [svcId, setSvcId] = useState(services[0]?.id ?? '');
  const [rDate, setRDate] = useState('');
  const [rLabel, setRLabel] = useState('');
  const [msg, setMsg] = useState('');
  if (!o)
    return (
      <div className="page">
        <h1>Not found</h1>
        <p className="muted">This record isn’t in the catalog.</p>
      </div>
    );
  const svc = services.find((s) => s.id === svcId) ?? null;
  const checks = evaluateEligibility(o, svc);
  const summary = matchSummary(checks);
  const ent =
    o.offerId === 'vi-movies-tv'
      ? entitlementFor(o, svc)
      : { value: valueText(o), caveat: undefined };
  const hist = historyFor(data.offerObservations, o.offerId);
  const primary = o.sources.find((s) => s.kind === 'terms') ?? o.sources[0];
  const toVerify = [
    ...checks.filter((c) => c.state !== 'confirmed').map((c) => c.rule.description),
    ...(o.computedStatus !== 'active' ? ['That the offer is still available for you today'] : []),
  ];
  const paymentRelated = o.eligibility.some(
    (r) => r.kind === 'payment_rail' || r.kind === 'min_transaction',
  );
  const accountRelated = o.eligibility.some((r) =>
    ['claim_channel', 'address_circle', 'plan_threshold', 'account_status'].includes(r.kind),
  );

  function saveReminder() {
    if (!isValidISO(rDate)) return setMsg('Please choose a date for the reminder.');
    update((d) => addOfferReminder(d, o!.offerId, rLabel.trim() || o!.name, rDate));
    setMsg(
      `Reminder saved for ${formatDate(rDate)}. It only reminds you; nothing changes with the provider.`,
    );
  }

  return (
    <div className="page">
      <section className="panel">
        <h1>{o.name}</h1>
        <p className="muted">
          {PROVIDER_LABEL[o.provider]} · {o.productFamily}
        </p>
        <div className="actions">
          <StatusBadge s={o.computedStatus} />
          <span className="badge soft">Confidence: {o.confidence}</span>
          {isStale(o, today) && <span className="badge soft">Needs a refresh</span>}
        </div>
      </section>

      {o.computedStatus === 'conflicting' && (
        <div className="strip review" role="status">
          <span aria-hidden="true">△</span>
          <span>
            <b>Source conflict.</b> The official terms override the page that is still visible. Do
            not rely on this offer unless the provider confirms it.
          </span>
        </div>
      )}
      {o.computedStatus === 'expired' && (
        <div className="strip" role="status">
          <span aria-hidden="true">○</span>
          <span>This is a past offer kept for history. It is not current.</span>
        </div>
      )}

      <section className="panel">
        <h2>What it is</h2>
        <dl className="facts-dl">
          <dt>Benefit type</dt>
          <dd>{BENEFIT_LABEL[o.benefitType]}</dd>
          <dt>Price</dt>
          <dd>
            {priceText(o)}
            {o.price != null ? ' (documented)' : ''}
          </dd>
          <dt>Benefit details</dt>
          <dd>
            {ent.value}
            {ent.caveat && (
              <>
                <br />
                <span className="muted small">{ent.caveat}</span>
              </>
            )}
          </dd>
          {o.geography && (
            <>
              <dt>Where</dt>
              <dd>{o.geography}</dd>
            </>
          )}
          <dt>Expiry</dt>
          <dd>{expiryLabel(o)}</dd>
          {o.billingOwner && (
            <>
              <dt>Renewal or cancellation handled by</dt>
              <dd>{o.billingOwner}</dd>
            </>
          )}
          <dt>Observed</dt>
          <dd>{formatDate(o.observedAt)}</dd>
          <dt>Last confirmed</dt>
          <dd>{formatDate(o.lastConfirmedAt)}</dd>
        </dl>
        {o.notes.map((n) => (
          <p key={n} className="muted small">
            {n}
          </p>
        ))}
      </section>

      <section className="panel">
        <h2>Eligibility checklist</h2>
        {services.length > 0 ? (
          <label className="f" htmlFor="svcSel">
            Check against your service
            <select id="svcSel" value={svcId} onChange={(e) => setSvcId(e.target.value)}>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label || PROVIDER_LABEL[s.provider]}
                </option>
              ))}
              <option value="">None</option>
            </select>
          </label>
        ) : (
          <p className="muted small">
            Add a {PROVIDER_LABEL[o.provider]} service to check what you’ve already told us.{' '}
            <a href="#/offers-add">Add a provider or service</a>
          </p>
        )}
        {checks.length === 0 ? (
          <p className="muted small">
            No conditions are listed in the saved sources. Still verify with the provider.
          </p>
        ) : (
          <ul className="checks">
            {checks.map((c) => (
              <li key={c.rule.kind + c.rule.description} className={`ck ck-${c.state}`}>
                <span aria-hidden="true" className="ckicon">
                  {ICON[c.state]}
                </span>
                <span>
                  {c.rule.description}
                  <br />
                  <span className="muted small">{CHECK_TEXT[c.state]}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {svc && (
          <p className="small">
            <b>
              {summary === 'may_not_qualify'
                ? 'You may not qualify — verify in the provider app.'
                : summary === 'needs_details'
                  ? 'Some details are missing.'
                  : 'May qualify — verify in the provider app.'}
            </b>
          </p>
        )}
        {paymentRelated && <p className="note small">{PAYMENT_NOTE}</p>}
        {accountRelated && <p className="note small">{ACCOUNT_NOTE}</p>}
      </section>

      <section className="panel">
        <h2>What you still need to verify</h2>
        <ul>
          {toVerify.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <div className="actions">
          {primary && (
            <a className="btn primary" href={primary.url} target="_blank" rel="noopener noreferrer">
              Verify in official provider app/site
              <span className="sr-only"> (opens {primary.label} in a new tab)</span>
            </a>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>Set a reminder</h2>
        <div className="grid">
          <label className="f" htmlFor="rDate">
            Date
            <input
              id="rDate"
              type="date"
              value={rDate}
              onChange={(e) => setRDate(e.target.value)}
            />
          </label>
          <label className="f" htmlFor="rLabel">
            Label (optional)
            <input
              id="rLabel"
              value={rLabel}
              onChange={(e) => setRLabel(e.target.value)}
              placeholder="e.g. Check the claim card"
            />
          </label>
        </div>
        <div className="actions">
          <button className="btn quiet" onClick={saveReminder}>
            Save reminder
          </button>
        </div>
        <p role="status" aria-live="polite" className="small">
          {msg}
        </p>
      </section>

      <section className="panel">
        <h2>Official sources</h2>
        <ul className="srcs">
          {o.sources.map((s) => (
            <li key={s.url}>
              <SourceLink s={s} />{' '}
              <span className="muted small">
                ({s.kind.replace('_', ' ')}, ref {s.ref})
              </span>
            </li>
          ))}
        </ul>
        {hist.length > 0 && (
          <details>
            <summary>Change history ({hist.length})</summary>
            <ul>
              {hist.slice(-10).map((h) => (
                <li key={h.id} className="small">
                  {h.observedAt.slice(0, 10)} · {h.changeType} · {h.fact}
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      <Disclaimer />
    </div>
  );
}
