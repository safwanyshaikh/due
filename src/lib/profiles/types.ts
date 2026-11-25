/**
 * Profiles: Personal and Business.
 *
 * People in India often mix personal and business money. Due never assumes which is which: it asks,
 * and keeps the answer. Legal identity matters for whose dues they are:
 * - A proprietorship has no separate legal identity. It runs on the owner's PAN, so its dues are
 *   the owner's dues (`samePanAsOwner: true`).
 * - A partnership firm, LLP, Private Limited, OPC, HUF or trust is a separate entity with its own
 *   PAN. Its dues are the entity's, not the person's, unless the person signed as guarantor or
 *   co-applicant.
 * Information only: none of this is legal or tax advice.
 */

export type ProfileKind = 'personal' | 'business';

export type EntityType =
  | 'individual'
  | 'proprietorship'
  | 'partnership'
  | 'llp'
  | 'private_limited'
  | 'opc'
  | 'huf'
  | 'trust'
  | 'other';

export type ProfileRole =
  | 'self'
  | 'proprietor'
  | 'partner'
  | 'designated_partner'
  | 'director'
  | 'shareholder'
  | 'employee'
  | 'guarantor'
  | 'co_applicant'
  /** Head of an HUF: personally liable for its dues without limit. */
  | 'karta'
  | 'other';

export interface Profile {
  id: string;
  kind: ProfileKind;
  name: string;
  entityType: EntityType;
  /** The person's role in this profile ('self' for Personal). */
  role: ProfileRole;
  /** True when the profile has no PAN of its own (individual, proprietorship). */
  samePanAsOwner: boolean;
  /** null = the person said "Not sure" (or has not said). */
  gstRegistered: boolean | null;
  createdAt: string;
}

/**
 * Who has to pay a due, as far as the person told Due:
 * - 'you': Personal, or a business on the person's PAN (proprietorship).
 * - 'entity': a separate entity's due (LLP, company, trust …).
 * - 'you_as_guarantor': a separate entity's loan the person signed as guarantor or co-applicant.
 * - 'you_as_partner': a due the person is liable for without limit as a partner of a partnership
 *   firm or the karta of an HUF. Listed under the firm, counted in the person's exposure.
 */
export type LiabilityOwner = 'you' | 'entity' | 'you_as_guarantor' | 'you_as_partner';

/** How the person signed a business loan they are not the borrower of. */
export type SignedAs = 'guarantor' | 'co_applicant';

/** Why Due asks about a name. */
export type QuestionReason = 'regular_payments' | 'loan_co_applicant';

/**
 * A question Due wants to ask: never a decision. Names only (no amounts, no account numbers).
 */
export interface EntityQuestion {
  /** Stable key for the name (letters and digits, lower case). */
  key: string;
  /** The name as it appears, tidied (e.g. "ACME ENTERPRISES LLP"). */
  name: string;
  reason: QuestionReason;
  /** How many statement lines carried the name (1 for a loan co-applicant). */
  occurrences: number;
  /** Money in, out, or both (loan co-applicants: null). */
  direction: 'received' | 'paid' | 'both' | null;
  /** What the name itself says (e.g. it ends in "LLP"). A hint to show, never a choice made. */
  nameSays: EntityType | null;
}

export type QuestionAnswer = 'own' | 'family' | 'employee' | 'not_mine' | 'later';

/** The person's answer to an entity question, kept so Due does not ask again. */
export interface ProfileDecision {
  key: string;
  name: string;
  reason: QuestionReason;
  answer: QuestionAnswer;
  /** The profile created from the answer ('own' / 'family'). */
  profileId?: string | null;
  at: string;
}

/** Profile filter on Home and Savings: every profile, or one. */
export type ProfileSelection = 'all' | string;

export const PERSONAL_PROFILE_ID = 'personal';
