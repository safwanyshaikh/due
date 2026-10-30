import { CURRENT_MIGRATIONS, deleteCommitment, emptyData } from './data';
import { emptyRelay } from './offers/relay';
import type { AppData } from './types';

export const DROP_BUNDLED_EXAMPLES = CURRENT_MIGRATIONS[0];

type Flagged = { isSample?: boolean };

function stripFlag<T extends object>(x: T): T {
  if (!('isSample' in x)) return x;
  const { isSample: _f, ...rest } = x as T & Flagged;
  void _f;
  return rest as T;
}

/**
 * Earlier builds pre-filled first launch with bundled example records, each flagged `isSample`,
 * plus a simulated Relay connection and replayed "source checks". This runs once per dataset:
 * it removes only flagged records and the simulated Relay/offer-check state, and leaves every
 * record the user created untouched.
 */
export function dropBundledExamples(input: AppData): AppData {
  const flaggedIds = input.commitments.filter((c) => (c as Flagged).isSample).map((c) => c.id);
  let data = input;
  for (const id of flaggedIds) data = deleteCommitment(data, id);
  const legacy = data as AppData & { offerObservations?: unknown; offersLastChecked?: unknown };
  const { offerObservations: _o, offersLastChecked: _l, ...rest } = legacy;
  void _o;
  void _l;
  const relayEvents = (rest.relay?.events ?? []).filter((e) => !(e as Flagged).isSample);
  return {
    ...rest,
    commitments: rest.commitments.map(stripFlag),
    seasons: rest.seasons.filter((s) => !(s as Flagged).isSample).map(stripFlag),
    services: rest.services.filter((s) => !(s as Flagged).isSample).map(stripFlag),
    // The forwarding address was never live, so the "connected" state is reset.
    relay: {
      ...emptyRelay(),
      retentionDays: rest.relay?.retentionDays ?? emptyRelay().retentionDays,
      events: relayEvents.map(stripFlag),
    },
    migrations: [...(rest.migrations ?? []), DROP_BUNDLED_EXAMPLES],
  };
}

/** Fills missing fields and applies pending one-time migrations. */
export function migrateData(parsed: AppData): AppData {
  let data: AppData = { ...emptyData(), migrations: [], ...parsed };
  if (!data.migrations?.includes(DROP_BUNDLED_EXAMPLES)) data = dropBundledExamples(data);
  return data;
}
