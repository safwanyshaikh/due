import { useMemo } from 'react';
import { buildCatalog, BENEFIT_LABEL, PROVIDER_LABEL } from '../../lib/offers/catalog';
import { STATUS_ICON, STATUS_TEXT, isStale } from '../../lib/offers/status';
import { OFFERS_DISCLAIMER } from '../../lib/offers/copy';
import { isOfficialUrl } from '../../lib/offers/sources';
import type { OfferRecord, OfferStatus, ServiceProvider, SourceRef } from '../../lib/offers/types';
import { formatDate } from '../../lib/dates';
import { formatINR } from '../../lib/money';

export function useCatalog(today: string): OfferRecord[] {
  return useMemo(() => buildCatalog(today), [today]);
}

export function StatusBadge({ s }: { s: OfferStatus }) {
  return (
    <span className={`ostatus os-${s}`}>
      <span aria-hidden="true">{STATUS_ICON[s]}</span> {STATUS_TEXT[s]}
    </span>
  );
}

export function Disclaimer() {
  return <p className="disclaimer small">{OFFERS_DISCLAIMER}</p>;
}

export function SourceLink({ s }: { s: SourceRef }) {
  if (!isOfficialUrl(s.url)) return null;
  return (
    <a href={s.url} target="_blank" rel="noopener noreferrer">
      {s.label} <span className="sr-only">(opens official site in a new tab)</span>
    </a>
  );
}

export function priceText(o: OfferRecord): string {
  if (o.price == null) return 'Price not stored — see source';
  const per =
    o.billingPeriod === 'monthly'
      ? '/month'
      : o.billingPeriod === 'annual'
        ? '/year'
        : o.billingPeriod === 'quarterly'
          ? '/quarter'
          : '';
  return `${formatINR(o.price * 100)}${per}`;
}

export function valueText(o: OfferRecord): string {
  const v = o.benefitValue;
  const parts: string[] = [];
  for (const [k, val] of Object.entries(v)) {
    const text = Array.isArray(val) ? val.join(', ') : String(val);
    parts.push(
      k === 'validityDays'
        ? `${text} days validity`
        : k === 'primeDays'
          ? `${text} days of Prime`
          : k === 'storageGb'
            ? `${text} GB`
            : k === 'trialMonths'
              ? `${text}-month trial`
              : k === 'months'
                ? `${text} months`
                : text,
    );
  }
  return parts.join(' · ');
}

export function OfferRow({
  o,
  today,
  context,
}: {
  o: OfferRecord;
  today: string;
  context?: string;
}) {
  const stale = isStale(o, today);
  return (
    <a className="item orow" href={`#/offer/${o.offerId}`}>
      <span className="row">
        <strong>{o.name}</strong>
        <StatusBadge s={o.computedStatus} />
      </span>
      <span className="muted small">
        {PROVIDER_LABEL[o.provider]} · {BENEFIT_LABEL[o.benefitType]} · {priceText(o)}
      </span>
      <span className="small">{valueText(o)}</span>
      <span className="foot2">
        <span className="muted small">
          {context ? `${context} · ` : ''}Last checked {formatDate(o.lastConfirmedAt)}
          {stale ? ' · Needs a refresh' : ''} ·{' '}
          {o.officialEndAt ? `Ends ${formatDate(o.officialEndAt)}` : 'Expiry not published'}
        </span>
        <span className="go">View details ›</span>
      </span>
    </a>
  );
}

export const PROVIDER_CHOICES: {
  id: ServiceProvider;
  label: string;
  types: { id: string; label: string }[];
}[] = [
  {
    id: 'jio',
    label: 'Jio',
    types: [
      { id: 'prepaid', label: 'Prepaid' },
      { id: 'postpaid', label: 'Postpaid' },
      { id: 'fiber', label: 'JioFiber / AirFiber' },
      { id: 'cloud', label: 'JioAICloud' },
    ],
  },
  {
    id: 'airtel',
    label: 'Airtel',
    types: [
      { id: 'prepaid', label: 'Prepaid' },
      { id: 'postpaid', label: 'Postpaid' },
      { id: 'fiber', label: 'Fiber' },
    ],
  },
  {
    id: 'vi',
    label: 'Vi',
    types: [
      { id: 'prepaid', label: 'Prepaid' },
      { id: 'postpaid', label: 'Postpaid' },
      { id: 'ott', label: 'Vi Movies & TV' },
    ],
  },
  { id: 'amazon', label: 'Amazon Prime', types: [{ id: 'ott', label: 'Prime membership' }] },
  {
    id: 'google',
    label: 'Google AI',
    types: [
      { id: 'ai', label: 'AI plan' },
      { id: 'cloud', label: 'Google One storage' },
    ],
  },
  {
    id: 'cards_upi',
    label: 'Cards / UPI',
    types: [
      { id: 'cashback', label: 'Cashback or rewards' },
      { id: 'payment_capability', label: 'Payment capability' },
    ],
  },
  {
    id: 'generic',
    label: 'Other recurring service',
    types: [
      { id: 'ott', label: 'OTT' },
      { id: 'cloud', label: 'Cloud' },
      { id: 'other', label: 'Other' },
    ],
  },
];

export const PROVIDER_HOME: Record<string, SourceRef | undefined> = {};
