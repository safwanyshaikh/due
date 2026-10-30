import { appendObservation, factFor } from './observations';
import type { Cadence, OfferRecord, SourceKind, SourceObservation } from './types';

export interface PublicObservation {
  offerId: string;
  sourceUrl: string;
  sourceKind: SourceKind;
  fact: string;
  observedAt: string;
  disappeared?: boolean;
}

/** Reads public pages only. No login, private API, OTP, checkout or provider-side change. */
export interface SourceAdapter {
  sourceId: string;
  provider: string;
  urls: string[];
  cadence: Cadence;
  fetchPublicObservation(): Promise<PublicObservation[]>;
}

/**
 * Local adapter for the browser build: replays the saved catalog snapshot. It does not contact
 * provider sites. Live fetching needs a server-side job.
 */
export function snapshotAdapter(
  catalog: OfferRecord[],
  provider: string,
  now: string,
): SourceAdapter {
  const offers = catalog.filter((o) => o.provider === provider);
  return {
    sourceId: `snapshot:${provider}`,
    provider,
    urls: [...new Set(offers.flatMap((o) => o.sourceUrls))],
    cadence: 'on_demand',
    fetchPublicObservation: async () =>
      offers.flatMap((o) =>
        o.sources.map((s) => ({
          offerId: o.offerId,
          sourceUrl: s.url,
          sourceKind: s.kind,
          fact: factFor(o),
          observedAt: now,
        })),
      ),
  };
}

export interface RefreshResult {
  observations: SourceObservation[];
  changed: number;
  checkedAt: string;
  errors: string[];
}

export async function runRefresh(
  adapters: SourceAdapter[],
  existing: readonly SourceObservation[],
  now: string,
): Promise<RefreshResult> {
  let list = [...existing];
  let changed = 0;
  const errors: string[] = [];
  for (const a of adapters) {
    try {
      for (const o of await a.fetchPublicObservation()) {
        list = appendObservation(list, o);
        const last = list[list.length - 1];
        if (last.changeType === 'changed' || last.changeType === 'disappeared') changed++;
      }
    } catch (e) {
      errors.push(`${a.sourceId}: ${(e as Error).message}`);
    }
  }
  return { observations: list, changed, checkedAt: now, errors };
}
