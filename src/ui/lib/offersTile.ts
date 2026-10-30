import type { AppData } from '../../lib/types';
import type { OfferRecord } from '../../lib/offers/types';
import { offersForService } from '../../lib/offers/eligibility';
import { isRecommendable, isStale } from '../../lib/offers/status';
import { nextServiceDate } from '../../lib/offers/services';
import { parseISO } from '../../lib/dates';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(d: string) {
  const p = parseISO(d);
  return `${p.d} ${MONTHS[p.m - 1]}`;
}

export function offersTileText(
  data: AppData,
  today: string,
  catalog: OfferRecord[],
): { sub: string; line: string; tone: '' | 'review' } {
  if (!data.services.length)
    return {
      sub: 'Benefits, renewals, and expiry—kept in one place',
      line: 'Add a provider or recurring service.',
      tone: '',
    };
  const matched = data.services.flatMap((s) => offersForService(s, catalog));
  if (matched.some((o) => o.computedStatus === 'conflicting')) {
    return {
      sub: 'Benefits, renewals, and expiry—kept in one place',
      line: 'Source conflict—verify before relying on this.',
      tone: 'review',
    };
  }
  if (matched.some((o) => isRecommendable(o.computedStatus) && isStale(o, today))) {
    return {
      sub: 'Benefits, renewals, and expiry—kept in one place',
      line: 'Needs a refresh',
      tone: 'review',
    };
  }
  const verify = new Set(
    matched.filter((o) => o.computedStatus === 'active_verify').map((o) => o.offerId),
  ).size;
  const dates = data.services
    .map((s) => nextServiceDate(s, today))
    .filter((x): x is { date: string; label: string } => !!x)
    .sort((a, b) => a.date.localeCompare(b.date));
  const near = dates[0] ? `${dates[0].label} · ${shortDate(dates[0].date)}` : 'No dates added';
  return {
    sub: 'Benefits, renewals, and expiry—kept in one place',
    line: `${near} · ${verify} to verify`,
    tone: '',
  };
}
