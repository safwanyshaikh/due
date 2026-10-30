import { useState } from 'react';
import { useApp } from '../store';
import type { Nav } from '../App';
import { Disclaimer, SourceLink, StatusBadge, priceText, useCatalog } from './parts';
import { PROVIDER_LABEL } from '../../lib/offers/catalog';
import {
  cancellationOwner,
  evaluateEligibility,
  matchSummary,
  offersForService,
} from '../../lib/offers/eligibility';
import { isRecommendable } from '../../lib/offers/status';
import {
  addOfferReminder,
  deleteService,
  nextServiceDate,
  removeOfferReminder,
} from '../../lib/offers/services';
import { formatDate, isValidISO } from '../../lib/dates';
import { formatINR } from '../../lib/money';

export function ServiceCard({ id, nav }: { id: string; nav: Nav }) {
  const { data, today, update } = useApp();
  const catalog = useCatalog(today);
  const s = data.services.find((x) => x.id === id);
  const [rDate, setRDate] = useState('');
  const [msg, setMsg] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  if (!s)
    return (
      <div className="page">
        <h1>Not found</h1>
        <p className="muted">This service was removed.</p>
      </div>
    );
  const offers = offersForService(s, catalog).filter((o) => isRecommendable(o.computedStatus));
  const evaluated = offers.map((o) => ({ o, sum: matchSummary(evaluateEligibility(o, s)) }));
  const included = evaluated.filter((e) => e.sum === 'may_qualify');
  const unsure = evaluated.filter((e) => e.sum !== 'may_qualify');
  const alternatives =
    s.approxPricePaise != null
      ? offers.filter(
          (o) =>
            o.price != null &&
            o.benefitType === 'recurring_entitlement' &&
            o.price * 100 < s.approxPricePaise!,
        )
      : [];
  const nd = nextServiceDate(s, today);
  const reminders = data.offerReminders.filter((r) => r.refId === s.id);
  const verifySrc = offers[0]?.sources[0];

  return (
    <div className="page">
      <section className="panel">
        <h1>{s.label || PROVIDER_LABEL[s.provider]}</h1>
        <p className="muted">
          {PROVIDER_LABEL[s.provider]} · {s.serviceType.replace('_', ' ')}
          {s.planName ? ` · ${s.planName}` : ''}
        </p>
        <div className="facts">
          <div className="fact">
            <b className="amt">
              {s.approxPricePaise != null ? formatINR(s.approxPricePaise) : 'Not entered'}
            </b>
            <small>what you pay (your entry)</small>
          </div>
          <div className="fact">
            <b>{nd ? formatDate(nd.date) : 'No date'}</b>
            <small>{nd ? nd.label.toLowerCase() : 'next charge or date'}</small>
          </div>
          <div className="fact">
            <b>{cancellationOwner(s)}</b>
            <small>handles renewal or cancellation</small>
          </div>
        </div>
        <p className="small">
          You remain in control. Due doesn’t change anything with {PROVIDER_LABEL[s.provider]}.
        </p>
      </section>

      <section className="panel">
        <h2>Documented benefits that may be included</h2>
        {included.length === 0 && (
          <p className="muted small">None confirmed from your details yet.</p>
        )}
        {included.map(({ o }) => (
          <p key={o.offerId}>
            <a href={`#/offer/${o.offerId}`}>{o.name}</a> <StatusBadge s={o.computedStatus} />
          </p>
        ))}
        {unsure.length > 0 && (
          <>
            <h3>Possible benefits to verify</h3>
            {unsure.map(({ o, sum }) => (
              <p key={o.offerId}>
                <a href={`#/offer/${o.offerId}`}>{o.name}</a>{' '}
                <span className="muted small">
                  {sum === 'may_not_qualify' ? '· you may not qualify' : '· details missing'}
                </span>
              </p>
            ))}
          </>
        )}
        {alternatives.length > 0 && (
          <>
            <h3>Documented lower-priced options</h3>
            {alternatives.map((o) => (
              <p key={o.offerId}>
                <a href={`#/offer/${o.offerId}`}>{o.name}</a> · {priceText(o)}{' '}
                <span className="muted small">(compare benefits before deciding)</span>
              </p>
            ))}
          </>
        )}
        {s.trialEnd && (
          <p className="note small">
            Trial ends {formatDate(s.trialEnd)}. If you do nothing, many trials renew into a paid
            plan. Check the terms with the provider.
          </p>
        )}
        <p className="muted small">
          Last checked {formatDate(catalog[0].lastConfirmedAt)} (saved public sources).
        </p>
        <div className="actions">
          {verifySrc ? (
            <a
              className="btn primary"
              href={verifySrc.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Verify in official provider app/site
              <span className="sr-only"> (opens {verifySrc.label})</span>
            </a>
          ) : (
            <span className="muted small">Verify in the provider’s official app or site.</span>
          )}
        </div>
        {offers.length > 0 && (
          <p className="small">
            Sources:{' '}
            {offers.slice(0, 3).map((o) => (
              <span key={o.offerId}>
                <SourceLink s={o.sources[0]} />{' '}
              </span>
            ))}
          </p>
        )}
      </section>

      <section className="panel">
        <h2>Reminders</h2>
        {reminders.map((r) => (
          <div className="line" key={r.id}>
            <span>
              {r.label} · {formatDate(r.date)}
            </span>
            <button
              className="btn quiet"
              onClick={() => update((d) => removeOfferReminder(d, r.id))}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="grid">
          <label className="f" htmlFor="srDate">
            Remind me on
            <input
              id="srDate"
              type="date"
              value={rDate}
              onChange={(e) => setRDate(e.target.value)}
            />
          </label>
        </div>
        <div className="actions">
          <button
            className="btn quiet"
            onClick={() => {
              if (!isValidISO(rDate)) return setMsg('Please choose a date.');
              update((d) =>
                addOfferReminder(
                  d,
                  s.id,
                  `${s.label || PROVIDER_LABEL[s.provider]}: review`,
                  rDate,
                ),
              );
              setMsg('Reminder saved.');
            }}
          >
            Save reminder
          </button>
        </div>
        <p role="status" aria-live="polite" className="small">
          {msg}
        </p>
      </section>

      <div className="actions">
        {!confirmDel ? (
          <button className="btn quiet warn" onClick={() => setConfirmDel(true)}>
            Remove this service
          </button>
        ) : (
          <>
            <span>Remove it from Due? Nothing changes with the provider.</span>
            <button
              className="btn warn"
              onClick={() => {
                update((d) => deleteService(d, s.id));
                nav.go({ name: 'offers' });
              }}
            >
              Remove
            </button>
            <button className="btn quiet" onClick={() => setConfirmDel(false)}>
              Not now
            </button>
          </>
        )}
      </div>
      <Disclaimer />
    </div>
  );
}
