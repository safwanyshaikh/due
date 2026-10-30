import { BENEFIT_LABEL, providerLabel } from '../../lib/offers/labels';
import { STATUS_ICON, STATUS_TEXT, isStale, isVerificationPending } from '../../lib/offers/status';
import { OFFERS_DISCLAIMER } from '../../lib/offers/copy';
import { isSafeHttpUrl } from '../../lib/offers/sources';
import { formatDateIST, formatIST } from '../../lib/offers/api';
import type { OfferRecord, OfferStatus, ServiceProvider, SourceRef } from '../../lib/offers/types';
import { formatDate } from '../../lib/dates';
import { formatINR } from '../../lib/money';
import { useCatalog } from './catalogStore';

export { useCatalog };

export const PENDING_TEXT = 'Verification pending';
export const PENDING_NOTE =
  'Research-derived. Due’s monitoring service has not confirmed this yet, so treat it as unverified.';

export function PendingBadge({ o }: { o: Pick<OfferRecord, 'verificationStatus'> }) {
  if (!isVerificationPending(o)) return null;
  return (
    <span className="badge soft" title={PENDING_NOTE}>
      {PENDING_TEXT}
    </span>
  );
}

/** Where the offers on screen came from, and when. Never claims live or real-time data. */
export function CatalogStatus({ compact = false }: { compact?: boolean }) {
  const { phase, generatedAt, busy, refresh } = useCatalog();
  const text =
    phase === 'unavailable'
      ? `Data unavailable — the monitoring service could not be reached. Last successful update: ${generatedAt ? formatIST(generatedAt) : 'never'}.`
      : phase === 'loading'
        ? generatedAt
          ? `Checking Due’s monitoring service… Showing the update from ${formatIST(generatedAt)}.`
          : 'Loading from Due’s monitoring service…'
        : `Last updated ${generatedAt ? formatIST(generatedAt) : 'unknown time'} from Due’s monitoring service`;
  return (
    <div className={compact ? '' : 'catalog-status'}>
      <div className="softline">
        <span
          className={`small ${phase === 'unavailable' ? '' : 'muted'}`}
          role="status"
          aria-live="polite"
        >
          {text}
        </span>
        <button className="btn quiet" onClick={refresh} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {phase === 'unavailable' && generatedAt && !compact && (
        <p className="muted small">
          The offers below are from that last successful update and may be out of date.
        </p>
      )}
    </div>
  );
}

/** True when the catalog has loaded (or failed) and holds no offers at all. */
export function useCatalogEmpty(): { empty: boolean; message: string } {
  const { phase, offers, generatedAt } = useCatalog();
  if (offers.length) return { empty: false, message: '' };
  if (phase === 'loading') return { empty: true, message: 'Loading offers…' };
  if (phase === 'unavailable' && !generatedAt)
    return {
      empty: true,
      message: 'Data unavailable. No offers have been loaded from Due’s monitoring service yet.',
    };
  return {
    empty: true,
    message:
      'No offers published yet. Due’s monitoring service has no offer records to show right now.',
  };
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
  if (!isSafeHttpUrl(s.url)) return null;
  return (
    <a href={s.url} target="_blank" rel="noopener noreferrer">
      {s.label} <span className="sr-only">(opens in a new tab)</span>
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
        <span className="badges">
          <StatusBadge s={o.computedStatus} />
          <PendingBadge o={o} />
        </span>
      </span>
      <span className="muted small">
        {providerLabel(o.provider)} · {BENEFIT_LABEL[o.benefitType]} · {priceText(o)}
      </span>
      <span className="small">{valueText(o)}</span>
      <span className="foot2">
        <span className="muted small">
          {context ? `${context} · ` : ''}
          {o.lastConfirmedAt
            ? `Last confirmed ${formatDateIST(o.lastConfirmedAt)}`
            : 'Not yet confirmed by monitoring'}
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
