import { useState } from 'react';
import { useApp } from '../store';
import type { Nav } from '../App';
import { Disclaimer, OfferRow, useCatalog } from './parts';
import { offersForService } from '../../lib/offers/eligibility';
import { isRecommendable, isStale } from '../../lib/offers/status';
import { nextServiceDate } from '../../lib/offers/services';
import { runRefresh, snapshotAdapter } from '../../lib/offers/refresh';
import { PROVIDER_LABEL } from '../../lib/offers/catalog';
import { PRIVATE_NOTE } from '../../lib/offers/copy';
import { addDays, formatDate } from '../../lib/dates';
import { formatINR } from '../../lib/money';
import type { OfferRecord } from '../../lib/offers/types';

export function OffersHome({ nav }: { nav: Nav }) {
  const { data, today, update } = useApp();
  const catalog = useCatalog(today);
  const [announce, setAnnounce] = useState('');
  const [busy, setBusy] = useState(false);

  const services = data.services;
  const horizon = addDays(today, 60);
  const upcoming = services
    .map((s) => ({ s, n: nextServiceDate(s, today) }))
    .filter((x) => x.n)
    .sort((a, b) => a.n!.date.localeCompare(b.n!.date));
  const matched = new Map<string, { o: OfferRecord; svc: string }>();
  for (const s of services)
    for (const o of offersForService(s, catalog))
      if (!matched.has(o.offerId))
        matched.set(o.offerId, { o, svc: s.label || PROVIDER_LABEL[s.provider] });
  const toVerify = [...matched.values()].filter(({ o }) => isRecommendable(o.computedStatus));
  const ending = [
    ...services.flatMap((s) =>
      (
        [
          ['trialEnd', 'Trial ends'],
          ['benefitExpiry', 'Benefit expires'],
          ['claimDeadline', 'Claim by'],
        ] as const
      )
        .filter(([k]) => s[k] && s[k]! >= today && s[k]! <= horizon)
        .map(([k, label]) => ({
          key: s.id + k,
          text: `${s.label || PROVIDER_LABEL[s.provider]} · ${label} ${formatDate(s[k]!)}`,
          href: `#/service/${s.id}`,
        })),
    ),
    ...catalog
      .filter(
        (o) => isRecommendable(o.computedStatus) && o.officialEndAt && o.officialEndAt <= horizon,
      )
      .map((o) => ({
        key: o.offerId,
        text: `${o.name} · ends ${formatDate(o.officialEndAt!)}`,
        href: `#/offer/${o.offerId}`,
      })),
  ];
  const problems = catalog.filter(
    (o) =>
      o.computedStatus === 'conflicting' ||
      o.computedStatus === 'unknown' ||
      (isRecommendable(o.computedStatus) && isStale(o, today)),
  );
  const browse = catalog.filter((o) => isRecommendable(o.computedStatus));
  const history = catalog.filter((o) => o.computedStatus === 'expired');

  async function refresh() {
    setBusy(true);
    const providers = [...new Set(catalog.map((o) => o.provider))];
    const now = new Date().toISOString();
    const r = await runRefresh(
      providers.map((p) => snapshotAdapter(catalog, p, now)),
      data.offerObservations,
      now,
    );
    update((d) => ({ ...d, offerObservations: r.observations, offersLastChecked: r.checkedAt }));
    setAnnounce(
      `Checked ${r.observations.length - data.offerObservations.length} saved source records. ${r.changed ? `${r.changed} changed.` : 'No changes found.'}`,
    );
    setBusy(false);
  }

  return (
    <div className="page">
      <section className="banner c-sky">
        <h1>Due &amp; Offers</h1>
        <p>
          Benefits, renewals, and expiry—kept in one place. Compare documented benefits and verify
          them with the provider.
        </p>
        <div className="actions">
          <button className="btn primary quiet" onClick={() => nav.go({ name: 'offers-add' })}>
            + Add a provider or service
          </button>
          <a className="btn quiet" href="#/offers-calc">
            Scenario calculator
          </a>
          <a className="btn quiet" href="#/relay">
            Due Relay inbox
          </a>
        </div>
      </section>

      <section className="panel">
        <div className="softline">
          <span className="muted small">
            Last checked{' '}
            {data.offersLastChecked
              ? new Date(data.offersLastChecked).toLocaleString('en-IN', {
                  timeZone: 'Asia/Kolkata',
                })
              : `${formatDate(catalog[0].lastConfirmedAt)} (research snapshot)`}
          </span>
          <button className="btn quiet" onClick={() => void refresh()} disabled={busy}>
            {busy ? 'Checking…' : 'Check sources again'}
          </button>
        </div>
        <p className="muted small">
          This checks Due’s saved public snapshot. Live checks of provider sites need a server and
          are not running yet. {PRIVATE_NOTE}
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>
        {announce && <p className="small">{announce}</p>}
      </section>

      <Section
        title="Upcoming due dates"
        empty="Add a service with a renewal or trial date to see it here."
      >
        {upcoming.map(({ s, n }) => (
          <a key={s.id} className="item" href={`#/service/${s.id}`}>
            <span className="row">
              <strong>{s.label || PROVIDER_LABEL[s.provider]}</strong>
              <span className="amt">
                {s.approxPricePaise != null ? formatINR(s.approxPricePaise) : ''}
              </span>
            </span>
            <span className="foot2">
              <span className="muted small">
                {n!.label} {formatDate(n!.date)} · your entry
              </span>
              <span className="go">View details ›</span>
            </span>
          </a>
        ))}
      </Section>

      <Section
        title="Benefits to verify"
        empty={
          services.length
            ? 'No documented benefits matched your services yet.'
            : 'Add a provider or service to see benefits that may be included.'
        }
      >
        {toVerify.map(({ o, svc }) => (
          <OfferRow key={o.offerId} o={o} today={today} context={`For ${svc}`} />
        ))}
      </Section>

      <Section title="Expiring or trial-ending" empty="Nothing ending in the next 60 days.">
        {ending.map((e) => (
          <a key={e.key} className="item" href={e.href}>
            <span>{e.text}</span>
            <span className="go">View details ›</span>
          </a>
        ))}
      </Section>

      <Section title="Conflicting or stale sources" empty="No source problems found.">
        {problems.map((o) => (
          <OfferRow key={o.offerId} o={o} today={today} />
        ))}
      </Section>

      <Section title="Saved providers and services" empty="Nothing saved yet.">
        {services.map((s) => (
          <a key={s.id} className="item" href={`#/service/${s.id}`}>
            <span className="row">
              <strong>{s.label || PROVIDER_LABEL[s.provider]}</strong>
              {s.isSample && <span className="badge soft">Demo</span>}
            </span>
            <span className="foot2">
              <span className="muted small">
                {PROVIDER_LABEL[s.provider]} · {s.serviceType.replace('_', ' ')}
              </span>
              <span className="go">View details ›</span>
            </span>
          </a>
        ))}
      </Section>

      <details className="panel">
        <summary>
          <b>Browse documented benefits ({browse.length})</b>
        </summary>
        <div className="cards">
          {browse.map((o) => (
            <OfferRow key={o.offerId} o={o} today={today} />
          ))}
        </div>
      </details>
      <details className="panel">
        <summary>
          <b>History ({history.length})</b>
        </summary>
        <p className="muted small">Past offers are kept for reference. They are not current.</p>
        <div className="cards">
          {history.map((o) => (
            <OfferRow key={o.offerId} o={o} today={today} />
          ))}
        </div>
      </details>
      <Disclaimer />
    </div>
  );
}

function Section({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const list = Array.isArray(children)
    ? children.flat().filter(Boolean)
    : children
      ? [children]
      : [];
  return (
    <section className="group">
      <h2>{title}</h2>
      <div className="cards">
        {list.length ? children : <p className="muted small emptyline">{empty}</p>}
      </div>
    </section>
  );
}
