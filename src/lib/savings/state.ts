/**
 * Savings state on the device (AppData.savings): defaults and profile mutations.
 * Pure functions: every mutation returns a new state and never touches the input.
 */
import type { CommuteLeg, SavingsProfile, SavingsState, TransportMode } from './types';

const MODES: TransportMode[] = [
  'cab',
  'auto',
  'bike_taxi',
  'local_train',
  'metro',
  'bus',
  'shuttle',
  'own_vehicle',
];

export function defaultSavingsProfile(): SavingsProfile {
  return {
    cityPack: null,
    homeLocality: null,
    commute: [],
    overrides: {},
    communityOptIn: false,
    researchSent: [],
  };
}

export function defaultSavingsState(): SavingsState {
  return { profile: defaultSavingsProfile(), ledger: [] };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cleanText(v: unknown, max = 80): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\s+/g, ' ').trim().slice(0, max);
  return t || null;
}

function cleanLeg(raw: unknown): CommuteLeg | null {
  if (!isObj(raw)) return null;
  const id = cleanText(raw.id);
  const from = cleanText(raw.from);
  const to = cleanText(raw.to);
  if (!id || !from || !to) return null;
  const days =
    typeof raw.daysPerWeek === 'number' && Number.isFinite(raw.daysPerWeek) ? raw.daysPerWeek : 0;
  const mode = MODES.includes(raw.mode as TransportMode) ? (raw.mode as TransportMode) : 'cab';
  const cost =
    typeof raw.costPerTripInr === 'number' &&
    Number.isFinite(raw.costPerTripInr) &&
    raw.costPerTripInr >= 0
      ? raw.costPerTripInr
      : null;
  return { id, from, to, daysPerWeek: Math.max(0, Math.min(7, days)), mode, costPerTripInr: cost };
}

/** Repairs a stored (possibly old or partial) savings state. Unknown fields are dropped, never guessed. */
export function normaliseSavingsState(raw: unknown): SavingsState {
  const base = defaultSavingsState();
  if (!isObj(raw)) return base;
  const p = isObj(raw.profile) ? raw.profile : {};
  const overrides: Record<string, number> = {};
  if (isObj(p.overrides))
    for (const [k, v] of Object.entries(p.overrides))
      if (typeof v === 'number' && Number.isFinite(v)) overrides[k] = v;
  const profile: SavingsProfile = {
    cityPack: cleanText(p.cityPack),
    homeLocality: cleanText(p.homeLocality),
    commute: Array.isArray(p.commute)
      ? p.commute.map(cleanLeg).filter((l): l is CommuteLeg => l !== null)
      : [],
    overrides,
    communityOptIn: p.communityOptIn === true,
    researchSent: Array.isArray(p.researchSent)
      ? p.researchSent.filter((s): s is string => typeof s === 'string')
      : [],
  };
  const ledger = Array.isArray(raw.ledger)
    ? (raw.ledger.filter(
        (e) => isObj(e) && typeof e.moveId === 'string' && typeof e.status === 'string',
      ) as SavingsState['ledger'])
    : [];
  const out: SavingsState = { profile, ledger };
  if (Array.isArray(raw.statements))
    out.statements = raw.statements.filter(isObj) as unknown as SavingsState['statements'];
  if (Array.isArray(raw.loans))
    out.loans = (raw.loans.filter(isObj) as unknown as NonNullable<SavingsState['loans']>).map(
      (l) => ({
        ...l,
        bounceRows: Array.isArray(l.bounceRows) ? l.bounceRows : [],
        bounceCharges: Array.isArray(l.bounceCharges) ? l.bounceCharges : [],
      }),
    );
  return out;
}

function withProfile(state: SavingsState, patch: Partial<SavingsProfile>): SavingsState {
  return { ...state, profile: { ...state.profile, ...patch } };
}

export function setCityPack(state: SavingsState, cityPack: string | null): SavingsState {
  return withProfile(state, { cityPack: cleanText(cityPack) });
}

export function setHomeLocality(state: SavingsState, locality: string | null): SavingsState {
  return withProfile(state, { homeLocality: cleanText(locality) });
}

let legSeq = 0;
function newLegId(): string {
  legSeq += 1;
  return `leg_${Date.now().toString(36)}${legSeq.toString(36)}`;
}

export type CommuteLegInput = Omit<CommuteLeg, 'id'> & { id?: string };

/** Adds a leg, or replaces the leg with the same id. Invalid legs (no from/to) leave the state unchanged. */
export function upsertCommuteLeg(state: SavingsState, input: CommuteLegInput): SavingsState {
  const leg = cleanLeg({ ...input, id: input.id ?? newLegId() });
  if (!leg) return state;
  const exists = state.profile.commute.some((l) => l.id === leg.id);
  const commute = exists
    ? state.profile.commute.map((l) => (l.id === leg.id ? leg : l))
    : [...state.profile.commute, leg];
  return withProfile(state, { commute });
}

export function removeCommuteLeg(state: SavingsState, legId: string): SavingsState {
  return withProfile(state, { commute: state.profile.commute.filter((l) => l.id !== legId) });
}

/** Replaces an assumption with the user's own value. `null` (or a non-finite number) restores the default. */
export function setOverride(state: SavingsState, key: string, value: number | null): SavingsState {
  const overrides = { ...state.profile.overrides };
  if (value === null || !Number.isFinite(value) || value < 0) delete overrides[key];
  else overrides[key] = value;
  return withProfile(state, { overrides });
}

export function setCommunityOptIn(state: SavingsState, optIn: boolean): SavingsState {
  return withProfile(state, { communityOptIn: optIn });
}

/** Remembers provider labels already sent for research so they are not sent again. */
export function markResearchSent(state: SavingsState, labels: string[]): SavingsState {
  const seen = new Set(state.profile.researchSent.map((s) => s.toLowerCase()));
  const add = labels.filter((l) => l && !seen.has(l.toLowerCase()));
  if (!add.length) return state;
  return withProfile(state, { researchSent: [...state.profile.researchSent, ...add] });
}
