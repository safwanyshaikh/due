import type { OfferReminder, RelayState, UserServiceRecord } from './offers/types';
import type { RecurrenceRule } from './recurrence';
import type { AuditEvent } from './audit';
import type { ImportItem } from './imports';
import type { DuplicateDecision } from './duplicates';
import type { ReminderState, ReminderSeverity, DeliveryChannel } from './reminderPlan';
import type { UserEvent } from './intake';

export type { RecurrenceRule };

export type ISODate = string; // YYYY-MM-DD, interpreted in the user's timezone (default Asia/Kolkata)

export type CommitmentType =
  'subscription' | 'emi' | 'other_loan' | 'credit_card' | 'school_fee' | 'bill' | 'other';

export type Frequency =
  'one_time' | 'monthly' | 'quarterly' | 'half_yearly' | 'annual' | 'custom_months';

export type Importance = 'essential' | 'important' | 'optional';

export type Status =
  | 'active'
  | 'trial'
  | 'review_needed'
  | 'pause_planned'
  | 'pause_confirmed_by_user'
  | 'cancel_pending'
  | 'cancelled_confirmed_by_user'
  | 'seasonal_plan'
  | 'overdue_user_entered'
  | 'unknown';

/** v1 confidence (legacy mirror; prefer `ValueConfidence` on `amount` / `date`). */
export type Confidence = 'confirmed' | 'estimate' | 'unknown';

/* ---------- v2: value vs provenance ---------- */

export type ValueConfidence = 'confirmed' | 'estimated' | 'user_entered' | 'imported';
export type SourceKind = 'manual' | 'csv' | 'email_forward' | 'statement' | 'calendar';

export interface Provenance {
  kind: SourceKind;
  /** Human label, e.g. "Entered by you", "CSV import", "Forwarded receipt". */
  label: string;
  /** ISO timestamp the value was imported (non-manual sources). */
  importedAt?: string;
  /** Opaque reference to the raw source (e.g. an ImportItem id). Never raw content. */
  rawRef?: string;
}

/** A value with its own confidence and provenance, stored separately from the value. */
export interface Tracked<T> {
  value: T;
  confidence: ValueConfidence;
  source: Provenance;
  updatedAt: string;
}

/** Changes the next occurrence only. The rule and past history stay untouched. */
export interface OccurrenceOverride {
  id: string;
  /** The occurrence's original generated date (its identity). */
  occurrenceDate: ISODate;
  newDate?: ISODate;
  newAmountPaise?: number | null;
  reason: string;
  at: string;
  confidence: ValueConfidence;
  source: Provenance;
}

export type OccurrenceEventKind = 'paid' | 'reviewed' | 'snoozed' | 'revoked';

/** Append-only per-occurrence history. A 'revoked' event cancels the event it names. */
export interface OccurrenceEvent {
  id: string;
  occurrenceDate: ISODate;
  kind: OccurrenceEventKind;
  at: string;
  actor: 'user' | 'import' | 'system';
  /** snoozed: remind again on/after this date. */
  until?: ISODate;
  /** paid: amount recorded at the time (history keeps its own value). */
  amountPaise?: number | null;
  /** revoked: id of the event being cancelled. */
  revokes?: string;
  /** paid via import: ImportItem id used as evidence. */
  evidenceRef?: string;
  note?: string;
}

/** A past date from an imported bill/notice that needs the person to confirm what happened. */
export interface OverdueReview {
  occurrenceDate: ISODate;
  /** The past date the document carried. */
  date: ISODate;
  sourceLabel: string;
  importItemId: string;
  at: string;
}

/** A change made by an import or sync that the user has not acknowledged yet. */
export interface PendingChange {
  id: string;
  field: 'amount' | 'date';
  from: number | string | null;
  to: number | string | null;
  at: string;
  sourceLabel: string;
}

export type Rail =
  'upi_autopay' | 'credit_card' | 'debit_card' | 'bank_mandate' | 'manual' | 'other' | 'unknown';

export interface ReminderPrefs {
  enabled: boolean;
  /** Days before a date (lead times). Defaults to 7, 3, 1. */
  offsets: number[];
  /** v2: default 'normal'. */
  severity?: ReminderSeverity;
  /** v2: preferred channel for this obligation (falls back to settings). */
  channel?: DeliveryChannel;
  /** v2: local time of day HH:MM (default 09:00), shifted out of quiet hours. */
  time?: string;
}

export interface SubscriptionDetails {
  trialEnd?: ISODate | null;
  cancellationBy?: ISODate | null;
  helpUrl?: string;
  seasonStart?: ISODate | null;
  seasonEnd?: ISODate | null;
}

export interface LoanTerms {
  lenderNickname?: string;
  loanType?: string;
  principalPaise?: number | null;
  interestRatePct?: number | null;
  rateType?: 'fixed' | 'variable' | null;
  originalTenureMonths?: number | null;
}

export interface StatementDetails {
  cardNickname: string;
  periodStart?: ISODate | null;
  periodEnd?: ISODate | null;
  confirmedFromLatest: boolean;
}

export interface Commitment {
  id: string;
  type: CommitmentType;
  provider: string;
  nickname: string;
  /** Integer paise. null = "amount not entered" (never treated as zero). */
  amountPaise: number | null;
  currency: 'INR';
  frequency: Frequency;
  intervalMonths?: number | null;
  /** Next scheduled due/renewal date, entered by the user. */
  nextDue: ISODate;
  dueConfidence: Confidence;
  amountConfidence: Confidence;
  /** Instalments/occurrences left. null/undefined = open-ended. */
  remainingOccurrences?: number | null;
  rail: Rail;
  accountNickname: string;
  ownerLabel: string;
  importance: Importance;
  notes: string;
  lastConfirmed: ISODate | null;
  reminder: ReminderPrefs;
  status: Status;
  billingEmailLabelId?: string | null;
  subscription?: SubscriptionDetails;
  loan?: LoanTerms;
  statement?: StatementDetails;
  /** Optional 24-hour cooling-off: show a gentle "revisit" prompt on/after this date. Never moves a due date. */
  coolingOffUntil?: ISODate | null;
  /** v1 source (legacy mirror). See `amount.source` / `date.source`. */
  source: 'manual' | 'csv_import';
  createdAt: string;
  updatedAt: string;

  /* ---------- v2 (authoritative; legacy flat fields above are kept in sync as mirrors) ---------- */
  /** Alias key from merchants.ts (e.g. 'netflix'); null when unrecognised. `nickname` is the merchant nickname. */
  canonicalProvider?: string | null;
  amount: Tracked<number | null>;
  /** Reference date the schedule is anchored on (=== ruleAnchor(rule) when the rule has one). */
  date: Tracked<ISODate>;
  rule: RecurrenceRule;
  overrides: OccurrenceOverride[];
  history: OccurrenceEvent[];
  pendingChanges?: PendingChange[];
  /**
   * Set when an imported bill or notice (not a receipt) carried a date that has already passed.
   * Due never assumes such a date was paid; Home asks the person to check it ('overdue_review').
   * Cleared by marking that occurrence paid, reviewing it, or acknowledging changes.
   */
  overdueReview?: OverdueReview | null;
  /** Soft delete: restorable; hidden from every selector. */
  deletedAt?: string | null;
  /** Set when merged into another obligation via a duplicate suggestion. */
  mergedInto?: string | null;
}

/** v2 name for a commitment. */
export type Obligation = Commitment;

export interface CommitmentLink {
  id: string;
  parentId: string; // the credit-card statement commitment
  componentId: string; // the item charged to that statement
  relation: 'included_in_statement';
  confirmedByUser: boolean;
}

export interface Budget {
  enabled: boolean;
  overallMonthlyCapPaise: number | null;
  discretionaryMonthlyCapPaise: number | null;
  /** Percent thresholds, default [80, 100]. "Above cap" is always evaluated. */
  thresholds: number[];
}

export interface Season {
  id: string;
  name: string;
  start: ISODate;
  end: ISODate;
  linkedCommitmentIds: string[];
  considerLeadDays: number;
  reviewLeadDays: number;
  /** Optional: user intends to pause until this date. */
  restartDate?: ISODate | null;
}

export interface BillingEmailLabel {
  id: string;
  label: string; // user-typed address or label; the app never reads this inbox
  displayName?: string;
}

export type ReminderChannel = 'in_app' | 'calendar_ics' | 'email' | 'whatsapp';

export interface Settings {
  timezone: string;
  channel: ReminderChannel;
  quietHours: { start: string; end: string }; // HH:MM
  defaultOffsets: number[];
  consents: { storeLocally: boolean; acknowledgedEstimates: boolean };
  /** v2 reminder channel preference (default 'in_app'). */
  deliveryChannel?: DeliveryChannel;
  /** v2 household member labels for `ownerLabel`. */
  householdMembers?: string[];
}

export interface ActionLogEntry {
  id: string;
  commitmentId: string;
  action: string;
  confirmationSource: 'user_entered';
  at: string;
}

export interface DeliveryLogEntry {
  key: string;
  channel: 'in_app';
  /** Only ever "shown_in_app". Email/WhatsApp delivery is unavailable in this release. */
  status: 'shown_in_app';
  at: string;
  label: string;
}

export const DATA_VERSION = 2;

export interface AppData {
  version: 2;
  commitments: Commitment[];
  links: CommitmentLink[];
  budget: Budget;
  seasons: Season[];
  labels: BillingEmailLabel[];
  settings: Settings;
  actionLog: ActionLogEntry[];
  deliveryLog: DeliveryLogEntry[];
  /** Due & Offers: the user's own service records (no credentials). */
  services: UserServiceRecord[];
  /** Dates and labels only. */
  offerReminders: OfferReminder[];
  relay: RelayState;
  /** One-time data migrations already applied to this dataset. */
  migrations?: string[];
  /* ---------- v2 ---------- */
  /** Append-only audit log. Undo appends an 'undo' event; nothing is removed. */
  audit: AuditEvent[];
  importQueue: ImportItem[];
  /** Private intake candidates (documents, forwarded email, shared SMS). */
  userEvents: UserEvent[];
  duplicateDecisions: DuplicateDecision[];
  reminderStates: ReminderState[];
}

/** Shape of a v1 dataset (before the v2 migration). */
export type AppDataV1 = Omit<
  AppData,
  | 'version'
  | 'audit'
  | 'importQueue'
  | 'userEvents'
  | 'duplicateDecisions'
  | 'reminderStates'
  | 'commitments'
> & {
  version: 1;
  commitments: CommitmentV1[];
};

export type CommitmentV1 = Omit<
  Commitment,
  | 'canonicalProvider'
  | 'amount'
  | 'date'
  | 'rule'
  | 'overrides'
  | 'history'
  | 'pendingChanges'
  | 'deletedAt'
  | 'mergedInto'
>;

export interface Period {
  start: ISODate;
  end: ISODate;
}
