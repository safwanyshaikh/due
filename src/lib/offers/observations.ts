import type { OfferRecord, SourceObservation } from './types';

/** FNV-1a 32-bit, hex. Stable across runs; used for change detection, not security. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  const s = text.trim().toLowerCase().replace(/\s+/g, ' ');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function factFor(
  o: Pick<OfferRecord, 'pageStatus' | 'termsStatus' | 'price' | 'officialEndAt'>,
): string {
  return `page=${o.pageStatus};terms=${o.termsStatus};price=${o.price ?? 'none'};end=${o.officialEndAt ?? 'none'}`;
}

function latest(
  list: SourceObservation[],
  offerId: string,
  url: string,
): SourceObservation | undefined {
  for (let i = list.length - 1; i >= 0; i--)
    if (list[i].offerId === offerId && list[i].sourceUrl === url) return list[i];
  return undefined;
}

/** Append-only: returns a new array; existing observations are never edited or removed. */
export function appendObservation(
  list: readonly SourceObservation[],
  obs: Omit<SourceObservation, 'id' | 'fingerprint' | 'changeType'> & { disappeared?: boolean },
): SourceObservation[] {
  const fp = fingerprint(obs.fact);
  const prev = latest(list as SourceObservation[], obs.offerId, obs.sourceUrl);
  const changeType: SourceObservation['changeType'] = obs.disappeared
    ? 'disappeared'
    : !prev
      ? 'new'
      : prev.fingerprint === fp
        ? 'unchanged'
        : 'changed';
  const { disappeared: _d, ...rest } = obs;
  void _d;
  return [
    ...list,
    { ...rest, id: `${obs.offerId}:${list.length + 1}`, fingerprint: fp, changeType },
  ];
}

export function historyFor(
  list: readonly SourceObservation[],
  offerId: string,
): SourceObservation[] {
  return list.filter((o) => o.offerId === offerId);
}
