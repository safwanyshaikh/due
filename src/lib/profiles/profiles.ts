/**
 * Profiles: defaults, repair (migration), edits and pure selectors. Every edit returns new data.
 */
import { newId } from '../ids';
import { can, type Entitlement } from '../plans';
import { monthlyEquivalentPaise } from '../schedule';
import { countsTowardForecast } from '../status';
import { linkedParentMap } from '../totals';
import type { AppData, Commitment } from '../types';
import {
  PERSONAL_PROFILE_ID,
  type EntityType,
  type LiabilityOwner,
  type Profile,
  type ProfileDecision,
  type ProfileKind,
  type ProfileRole,
  type ProfileSelection,
  type QuestionAnswer,
  type SignedAs,
} from './types';

export const ENTITY_TYPES: EntityType[] = [
  'individual',
  'proprietorship',
  'partnership',
  'llp',
  'private_limited',
  'opc',
  'huf',
  'trust',
  'other',
];

export const PROFILE_ROLES: ProfileRole[] = [
  'self',
  'proprietor',
  'partner',
  'designated_partner',
  'director',
  'shareholder',
  'employee',
  'guarantor',
  'co_applicant',
  'karta',
  'other',
];

/** Entities without a PAN of their own: their dues are the owner's dues. */
export function samePanFor(entityType: EntityType): boolean {
  return entityType === 'individual' || entityType === 'proprietorship';
}

/** Roles that fit an entity type, most likely first. Guarantor and co-applicant fit any entity. */
export function rolesFor(entityType: EntityType): ProfileRole[] {
  switch (entityType) {
    case 'individual':
      return ['self'];
    case 'proprietorship':
      return ['proprietor'];
    case 'partnership':
      return ['partner', 'guarantor', 'employee', 'other'];
    case 'llp':
      return ['designated_partner', 'partner', 'guarantor', 'co_applicant', 'employee', 'other'];
    case 'private_limited':
    case 'opc':
      return ['director', 'shareholder', 'guarantor', 'co_applicant', 'employee', 'other'];
    case 'huf':
      return ['karta', 'other', 'guarantor', 'co_applicant', 'employee'];
    case 'trust':
    case 'other':
      return ['other', 'guarantor', 'co_applicant', 'partner', 'director', 'employee'];
  }
}

export function personalProfile(createdAt: string): Profile {
  return {
    id: PERSONAL_PROFILE_ID,
    kind: 'personal',
    name: 'Personal',
    entityType: 'individual',
    role: 'self',
    samePanAsOwner: true,
    gstRegistered: null,
    createdAt,
  };
}

export function defaultProfiles(createdAt: string = new Date().toISOString()): Profile[] {
  return [personalProfile(createdAt)];
}

/** Letters and digits only, lower case: "ACME Enterprises LLP." → "acmeenterprisesllp". */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function cleanName(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
}

function cleanProfile(raw: unknown, fallbackAt: string): Profile | null {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) return null;
  const name = cleanName(raw.name);
  if (!name) return null;
  const entityType = ENTITY_TYPES.includes(raw.entityType as EntityType)
    ? (raw.entityType as EntityType)
    : 'other';
  const kind: ProfileKind = raw.kind === 'personal' ? 'personal' : 'business';
  const role = PROFILE_ROLES.includes(raw.role as ProfileRole)
    ? (raw.role as ProfileRole)
    : kind === 'personal'
      ? 'self'
      : 'other';
  return {
    id: raw.id,
    kind,
    name,
    entityType,
    role,
    // Derived from the entity type, so a stored value can never disagree with it.
    samePanAsOwner: samePanFor(entityType),
    gstRegistered: typeof raw.gstRegistered === 'boolean' ? raw.gstRegistered : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : fallbackAt,
  };
}

const ANSWERS: QuestionAnswer[] = ['own', 'family', 'employee', 'not_mine', 'later'];

function cleanDecision(raw: unknown): ProfileDecision | null {
  if (!isObj(raw) || typeof raw.key !== 'string' || !raw.key) return null;
  if (!ANSWERS.includes(raw.answer as QuestionAnswer)) return null;
  return {
    key: raw.key,
    name: cleanName(raw.name) || raw.key,
    reason: raw.reason === 'loan_co_applicant' ? 'loan_co_applicant' : 'regular_payments',
    answer: raw.answer as QuestionAnswer,
    profileId: typeof raw.profileId === 'string' ? raw.profileId : null,
    at: typeof raw.at === 'string' ? raw.at : '',
  };
}

/**
 * Migration (idempotent, additive): makes sure there is exactly one Personal profile first, repairs
 * stored profiles and decisions, and points every due at a profile that exists. A due without a
 * profileId belongs to Personal and is not rewritten (records stay untouched); one that points at a
 * profile that no longer exists moves to Personal. Nothing the person entered is removed.
 */
export function ensureProfiles<T extends AppData>(input: T, now = new Date().toISOString()): T {
  const raw = Array.isArray((input as { profiles?: unknown }).profiles)
    ? ((input as { profiles: unknown[] }).profiles as unknown[])
    : [];
  const seen = new Set<string>();
  const cleaned: Profile[] = [];
  for (const r of raw) {
    const p = cleanProfile(r, now);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    cleaned.push(p);
  }
  const storedPersonal = cleaned.find((p) => p.id === PERSONAL_PROFILE_ID);
  const personal: Profile = storedPersonal
    ? {
        ...storedPersonal,
        kind: 'personal',
        entityType: 'individual',
        role: 'self',
        samePanAsOwner: true,
      }
    : personalProfile(now);
  // Only the fixed-id profile is Personal; anything else stored as personal becomes a business.
  const others = cleaned
    .filter((p) => p.id !== PERSONAL_PROFILE_ID)
    .map((p) => (p.kind === 'personal' ? { ...p, kind: 'business' as const } : p));
  const profiles = [personal, ...others];
  const ids = new Set(profiles.map((p) => p.id));
  const decisionsRaw = Array.isArray((input as { profileDecisions?: unknown }).profileDecisions)
    ? ((input as { profileDecisions: unknown[] }).profileDecisions as unknown[])
    : [];
  const profileDecisions = decisionsRaw
    .map(cleanDecision)
    .filter((d): d is ProfileDecision => d !== null);
  let changed = false;
  const commitments = input.commitments.map((c) => {
    // A due with no profile is Personal (`profileIdOf`), so it is left exactly as it was.
    const ok =
      c.profileId === undefined || (typeof c.profileId === 'string' && ids.has(c.profileId));
    const signedOk =
      c.signedAs === undefined ||
      c.signedAs === null ||
      c.signedAs === 'guarantor' ||
      c.signedAs === 'co_applicant';
    if (ok && signedOk) return c;
    changed = true;
    return {
      ...c,
      profileId: ok ? c.profileId : PERSONAL_PROFILE_ID,
      ...(signedOk ? {} : { signedAs: null }),
    };
  });
  return {
    ...input,
    profiles,
    profileDecisions,
    commitments: changed ? commitments : input.commitments,
  };
}

/* ---------- selectors ---------- */

export function profilesOf(data: Pick<AppData, 'profiles'>): Profile[] {
  const list = Array.isArray(data.profiles) ? data.profiles : [];
  return list.length ? list : defaultProfiles('1970-01-01T00:00:00.000Z');
}

export function businessProfiles(data: Pick<AppData, 'profiles'>): Profile[] {
  return profilesOf(data).filter((p) => p.kind === 'business');
}

export function findProfile(data: Pick<AppData, 'profiles'>, id: string | null | undefined) {
  return profilesOf(data).find((p) => p.id === id) ?? null;
}

/** The profile id a due belongs to (missing or unknown → Personal). */
export function profileIdOf(
  c: Pick<Commitment, 'profileId'>,
  data?: Pick<AppData, 'profiles'>,
): string {
  const id = c.profileId || PERSONAL_PROFILE_ID;
  if (data && !findProfile(data, id)) return PERSONAL_PROFILE_ID;
  return id;
}

export function profileOf(c: Pick<Commitment, 'profileId'>, data: Pick<AppData, 'profiles'>) {
  return findProfile(data, profileIdOf(c, data)) ?? profilesOf(data)[0];
}

const LOAN_TYPES = new Set<Commitment['type']>(['emi', 'other_loan', 'credit_card']);

/**
 * Whose due this is, from what the person told Due:
 * - Personal, or a business without its own PAN (proprietorship) → 'you'.
 * - A partner of a partnership firm (partners are jointly and severally liable without limit,
 *   Indian Partnership Act 1932), or the karta of an HUF → 'you_as_partner', for every due.
 * - A separate entity's loan the person signed as guarantor or co-applicant (on the due, or as
 *   their role in the entity) → 'you_as_guarantor'.
 * - Anything else of a separate entity (an LLP, a Pvt Ltd/OPC, a trust) → 'entity'.
 */
export function liabilityOwner(
  c: Pick<Commitment, 'profileId' | 'signedAs' | 'type'>,
  data: Pick<AppData, 'profiles'>,
): LiabilityOwner {
  const p = profileOf(c, data);
  if (p.kind === 'personal' || p.samePanAsOwner) return 'you';
  if (p.entityType === 'partnership' && p.role === 'partner') return 'you_as_partner';
  if (p.entityType === 'huf' && p.role === 'karta') return 'you_as_partner';
  const loan = LOAN_TYPES.has(c.type);
  if (loan && (c.signedAs === 'guarantor' || c.signedAs === 'co_applicant'))
    return 'you_as_guarantor';
  if (loan && (p.role === 'guarantor' || p.role === 'co_applicant')) return 'you_as_guarantor';
  return 'entity';
}

export function inSelection(
  c: Pick<Commitment, 'profileId'>,
  sel: ProfileSelection,
  data: Pick<AppData, 'profiles'>,
): boolean {
  return sel === 'all' || profileIdOf(c, data) === sel;
}

/** A selection that still exists (a deleted profile falls back to 'all'). */
export function validSelection(
  data: Pick<AppData, 'profiles'>,
  sel: ProfileSelection | null | undefined,
): ProfileSelection {
  if (!sel || sel === 'all') return 'all';
  return findProfile(data, sel) ? sel : 'all';
}

/**
 * The dataset as one profile sees it: only that profile's dues (and the card-statement links
 * between them). 'all' returns the data unchanged. Read-only: never save the result.
 */
export function scopeData(data: AppData, sel: ProfileSelection): AppData {
  if (sel === 'all') return data;
  const commitments = data.commitments.filter((c) => inSelection(c, sel, data));
  const ids = new Set(commitments.map((c) => c.id));
  return {
    ...data,
    commitments,
    links: data.links.filter((l) => ids.has(l.parentId) && ids.has(l.componentId)),
  };
}

export interface ProfileTotal {
  profileId: string;
  /** Live dues that count towards the plan. */
  count: number;
  /** Monthly planning estimate (paise) of the dues with an amount and a repeating schedule. */
  monthlyPaise: number;
  /** Dues without an amount (never counted as zero). */
  unknownCount: number;
  /** Split of the monthly estimate by who has to pay. */
  byOwner: Record<LiabilityOwner, number>;
  /** What can come to the person: 'you' + 'you_as_guarantor' + 'you_as_partner'. */
  exposurePaise: number;
}

/** Totals per profile. A card-statement item is counted once, in its statement. */
export function profileTotals(data: AppData): ProfileTotal[] {
  const linked = linkedParentMap(data);
  const out = new Map<string, ProfileTotal>(
    profilesOf(data).map((p) => [
      p.id,
      {
        profileId: p.id,
        count: 0,
        monthlyPaise: 0,
        unknownCount: 0,
        byOwner: { you: 0, entity: 0, you_as_guarantor: 0, you_as_partner: 0 },
        exposurePaise: 0,
      },
    ]),
  );
  for (const c of data.commitments) {
    if (c.deletedAt || c.mergedInto || !countsTowardForecast(c.status)) continue;
    const t = out.get(profileIdOf(c, data));
    if (!t) continue;
    t.count++;
    if (linked.has(c.id)) continue;
    const eq = monthlyEquivalentPaise(c);
    if (eq === null) {
      if ((c.amount?.value ?? c.amountPaise) === null) t.unknownCount++;
      continue;
    }
    const m = Math.round(eq);
    t.monthlyPaise += m;
    const owner = liabilityOwner(c, data);
    t.byOwner[owner] += m;
    if (owner !== 'entity') t.exposurePaise += m;
  }
  return [...out.values()];
}

/** Monthly estimate (paise) of every due that can come to the person, across all profiles. */
export function yourExposurePaise(data: AppData): number {
  return profileTotals(data).reduce((n, t) => n + t.exposurePaise, 0);
}

/* ---------- entitlements ---------- */

/** Free covers Personal and one business. More businesses need the 'business_profiles' feature. */
export const FREE_BUSINESS_PROFILES = 1;

export function canAddBusinessProfile(
  data: Pick<AppData, 'profiles'>,
  ent: Entitlement | null | undefined,
  now?: string,
): boolean {
  return (
    businessProfiles(data).length < FREE_BUSINESS_PROFILES || can(ent, 'business_profiles', now)
  );
}

/* ---------- edits ---------- */

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

export interface ProfileInput {
  name: string;
  entityType: EntityType;
  role: ProfileRole;
  gstRegistered: boolean | null;
}

function checkName(data: AppData, name: string, exceptId?: string): string {
  const clean = cleanName(name);
  if (!clean) throw new ProfileError('Enter a name for this business.');
  const key = nameKey(clean);
  if (profilesOf(data).some((p) => p.id !== exceptId && nameKey(p.name) === key))
    throw new ProfileError('You already have a profile with this name.');
  return clean;
}

/** Adds a business profile. Callers check `canAddBusinessProfile` first. */
export function addProfile(
  data: AppData,
  input: ProfileInput,
  now: string,
): { data: AppData; profile: Profile } {
  const name = checkName(data, input.name);
  const entityType = input.entityType === 'individual' ? 'proprietorship' : input.entityType;
  const profile: Profile = {
    id: newId('pf'),
    kind: 'business',
    name,
    entityType,
    role: input.role === 'self' ? 'other' : input.role,
    samePanAsOwner: samePanFor(entityType),
    gstRegistered: input.gstRegistered,
    createdAt: now,
  };
  return { data: { ...data, profiles: [...profilesOf(data), profile] }, profile };
}

/** Edits a business profile (Personal keeps its kind and entity type; only GST can change). */
export function updateProfile(data: AppData, id: string, input: Partial<ProfileInput>): AppData {
  const p = findProfile(data, id);
  if (!p) throw new ProfileError('This profile no longer exists.');
  let next: Profile;
  if (p.kind === 'personal') {
    next = {
      ...p,
      gstRegistered: input.gstRegistered === undefined ? p.gstRegistered : input.gstRegistered,
    };
  } else {
    const entityType =
      input.entityType === undefined || input.entityType === 'individual'
        ? input.entityType === 'individual'
          ? 'proprietorship'
          : p.entityType
        : input.entityType;
    next = {
      ...p,
      name: input.name === undefined ? p.name : checkName(data, input.name, id),
      entityType,
      role: input.role === undefined || input.role === 'self' ? p.role : input.role,
      samePanAsOwner: samePanFor(entityType),
      gstRegistered: input.gstRegistered === undefined ? p.gstRegistered : input.gstRegistered,
    };
  }
  return { ...data, profiles: profilesOf(data).map((x) => (x.id === id ? next : x)) };
}

function moveDues(data: AppData, fromId: string, toId: string, now: string): AppData {
  return {
    ...data,
    commitments: data.commitments.map((c) =>
      profileIdOf(c) === fromId
        ? {
            ...c,
            profileId: toId,
            // Signed-as only means something for a separate entity's loan.
            signedAs: toId === PERSONAL_PROFILE_ID ? null : c.signedAs,
            updatedAt: now,
          }
        : c,
    ),
  };
}

/** Deletes a business profile. Its dues move to Personal (nothing is deleted with it). */
export function deleteProfile(data: AppData, id: string, now: string): AppData {
  if (id === PERSONAL_PROFILE_ID) throw new ProfileError('The Personal profile can’t be deleted.');
  if (!findProfile(data, id)) return data;
  const moved = moveDues(data, id, PERSONAL_PROFILE_ID, now);
  return {
    ...moved,
    profiles: profilesOf(moved).filter((p) => p.id !== id),
    profileDecisions: (moved.profileDecisions ?? []).map((d) =>
      d.profileId === id ? { ...d, profileId: null } : d,
    ),
  };
}

/** Merges one profile into another: every due of `fromId` moves to `intoId`, then `fromId` goes. */
export function mergeProfiles(data: AppData, fromId: string, intoId: string, now: string): AppData {
  if (fromId === intoId) throw new ProfileError('Choose two different profiles.');
  if (fromId === PERSONAL_PROFILE_ID)
    throw new ProfileError('Merge a business into Personal, not the other way round.');
  if (!findProfile(data, fromId) || !findProfile(data, intoId))
    throw new ProfileError('This profile no longer exists.');
  const moved = moveDues(data, fromId, intoId, now);
  return {
    ...moved,
    profiles: profilesOf(moved).filter((p) => p.id !== fromId),
    profileDecisions: (moved.profileDecisions ?? []).map((d) =>
      d.profileId === fromId ? { ...d, profileId: intoId } : d,
    ),
  };
}

/** Sets which profile a due belongs to (and, for a separate entity's loan, how the person signed). */
export function assignProfile(
  data: AppData,
  commitmentId: string,
  profileId: string,
  now: string,
  signedAs?: SignedAs | null,
): AppData {
  if (!findProfile(data, profileId)) throw new ProfileError('This profile no longer exists.');
  return {
    ...data,
    commitments: data.commitments.map((c) =>
      c.id === commitmentId
        ? {
            ...c,
            profileId,
            signedAs:
              profileId === PERSONAL_PROFILE_ID
                ? null
                : signedAs === undefined
                  ? (c.signedAs ?? null)
                  : signedAs,
            updatedAt: now,
          }
        : c,
    ),
  };
}

/* ---------- questions and answers ---------- */

/** Records (or replaces) the person's answer for a name. */
export function recordDecision(data: AppData, d: ProfileDecision): AppData {
  const rest = (data.profileDecisions ?? []).filter((x) => x.key !== d.key);
  return { ...data, profileDecisions: [...rest, d] };
}

/** Forgets the answer for a name, so Due may ask again. */
export function forgetDecision(data: AppData, key: string): AppData {
  return {
    ...data,
    profileDecisions: (data.profileDecisions ?? []).filter((x) => x.key !== key),
  };
}

/** Questions the person asked to see later, oldest first. */
export function laterQuestions(data: AppData): ProfileDecision[] {
  return (data.profileDecisions ?? []).filter((d) => d.answer === 'later');
}
