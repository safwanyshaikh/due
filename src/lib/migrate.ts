import { CURRENT_MIGRATIONS, deleteCommitment, emptyData } from './data';
import { emptyRelay } from './offers/relay';
import { upgradeCommitment } from './provenance';
import type { AppData, AppDataV1, Commitment, CommitmentV1 } from './types';

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

const V2_KEYS = [
  'canonicalProvider',
  'amount',
  'date',
  'rule',
  'overrides',
  'history',
  'pendingChanges',
  'deletedAt',
  'mergedInto',
] as const;

/**
 * Data version 2. Lossless: every v1 field of every record is kept as it was; each commitment
 * gains tracked `amount`/`date` (confidence + provenance), a recurrence `rule`, and empty
 * override/history lists. v1 'confirmed' → 'confirmed'; 'estimate'/'unknown' → 'estimated'
 * ('imported' for CSV-imported records). Source 'manual'/'csv_import' → provenance kind
 * 'manual'/'csv'. The dataset gains empty audit / import queue / decision / reminder-state lists.
 */
export function migrateV1toV2(input: AppDataV1 | AppData): AppData {
  const base = input as AppData;
  return {
    ...base,
    version: 2,
    commitments: (input.commitments as (CommitmentV1 | Commitment)[]).map(upgradeCommitment),
    audit: base.audit ?? [],
    importQueue: base.importQueue ?? [],
    userEvents: base.userEvents ?? [],
    duplicateDecisions: base.duplicateDecisions ?? [],
    reminderStates: base.reminderStates ?? [],
  };
}

/** Inverse of `migrateV1toV2` for export to older builds: strips v2 fields (v1 fields were never changed). */
export function downgradeToV1(data: AppData): AppDataV1 {
  const {
    audit: _a,
    importQueue: _i,
    userEvents: _u,
    duplicateDecisions: _d,
    reminderStates: _r,
    ...rest
  } = data;
  void _a;
  void _i;
  void _u;
  void _d;
  void _r;
  return {
    ...rest,
    version: 1,
    commitments: data.commitments.map((c) => {
      const out: Record<string, unknown> = { ...c };
      for (const k of V2_KEYS) delete out[k];
      return out as unknown as CommitmentV1;
    }),
  };
}

/** Fills missing fields, applies pending one-time migrations, then upgrades to data version 2. */
export function migrateData(parsed: AppData | AppDataV1): AppData {
  let data = { ...emptyData(), migrations: [], ...parsed } as AppData;
  if (!data.migrations?.includes(DROP_BUNDLED_EXAMPLES)) data = dropBundledExamples(data);
  return migrateV1toV2(data);
}
