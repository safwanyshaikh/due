/** Wire types for Due's consumer account, sync, billing, household, telemetry and intake endpoints. */

export type PlanId = 'free' | 'plus' | 'household';
export type BillingPeriod = 'monthly' | 'yearly';

export type Feature =
  | 'manual_obligations'
  | 'upcoming_view'
  | 'basic_reminders'
  | 'csv_export'
  | 'local_data'
  | 'backup'
  | 'multi_device'
  | 'reminder_email'
  | 'email_import'
  | 'statement_import'
  | 'calendar_sync'
  | 'advanced_recurrence'
  | 'reconciliation_history'
  | 'multi_channel'
  | 'cancellation_guidance'
  | 'verified_evidence'
  | 'household_sharing';

export interface Account {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface Entitlements {
  plan: PlanId;
  status: 'active' | 'cancelled' | 'expired';
  billingPeriod: BillingPeriod | null;
  periodEnd: string | null;
  channel: 'razorpay' | 'manual' | null;
  features: Feature[];
  householdAccess: { householdId: string; role: 'owner' | 'member' } | null;
}

export interface MagicLinkResponse {
  ok: true;
  message: string;
  expiresInMinutes: number;
}

export interface VerifyResponse {
  account: Account;
  created: boolean;
  entitlements: Entitlements;
}

export interface MeResponse {
  account: Account;
  sessionId: string | null;
  entitlements: Entitlements;
}

export interface DeviceSession {
  id: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
}

export interface DeleteRequest {
  confirmationToken: string;
  expiresAt: string;
  warning: string;
}

export interface SyncDocument<T = Record<string, unknown>> {
  version: number;
  data: T | null;
  updatedAt: string | null;
}

export type EmailDeliveryState = 'active' | 'premium_required' | 'email_unavailable';

/** One reminder from the client's resolved plan (lead time, quiet hours and timezone already applied). */
export interface ReminderPlanItem {
  obligationRef: string;
  title: string;
  dueDate: string;
  remindAt: string;
  channel: 'email' | 'push';
  timezone?: string;
  quietHours?: { start: string; end: string } | null;
}

export interface PutDataResponse {
  version: number;
  updatedAt: string;
  reminders?: { stored: number; emailDelivery: EmailDeliveryState };
}

export interface ReminderDelivery {
  id: number;
  obligationRef: string;
  channel: string;
  scheduledFor: string;
  status: 'scheduled' | 'sent' | 'failed' | 'unavailable';
  providerMessageId: string | null;
  error: string | null;
  createdAt: string;
}

export interface RemindersResponse {
  emailDelivery: EmailDeliveryState;
  schedule: {
    obligationRef: string;
    title: string;
    dueDate: string;
    remindAt: string;
    channel: string;
    timezone: string;
    quietStart: string | null;
    quietEnd: string | null;
    attempts: number;
    deliveredAt: string | null;
  }[];
  deliveries: ReminderDelivery[];
}

export interface PublicPlan {
  id: PlanId;
  name: string;
  priceInrMonthly: number | null;
  priceInrYearly: number | null;
  billingCadences: BillingPeriod[];
  features: Feature[];
  active: boolean;
  checkoutAvailable: { monthly: boolean; yearly: boolean };
}

export interface PublicPlansResponse {
  currency: 'INR';
  plans: PublicPlan[];
  terms: {
    renewal: string;
    cancellation: string;
    refund: string;
    legalReviewStatus: 'pending' | 'reviewed';
  };
  cancellationPath: string;
  purchaseChannel: 'razorpay' | null;
  paymentsAvailable: boolean;
}

export interface CheckoutResponse {
  provider: 'razorpay';
  keyId: string;
  subscriptionId: string;
  shortUrl: string | null;
  plan: Exclude<PlanId, 'free'>;
  billingPeriod: BillingPeriod;
  amountInr: number;
  renewal: string;
  cancellationPath: string;
  terms: {
    renewal: string;
    cancellation: string;
    refund: string;
    legal_review_status: 'pending' | 'reviewed';
  };
}

export interface Household {
  id: string;
  name: string;
  ownerAccountId: string;
  createdAt: string;
}

export interface HouseholdMember {
  accountId: string;
  email: string;
  displayName: string | null;
  role: 'owner' | 'member';
  status: string;
  createdAt: string;
}

export type HouseholdResponse =
  | { household: null }
  | {
      household: Household;
      role: 'owner' | 'member';
      members: HouseholdMember[];
      pendingInvites: { email: string; createdAt: string; expiresAt: string }[];
    };

export const TELEMETRY_EVENT_NAMES = [
  'first_obligation_completed',
  'import_approved',
  'import_ignored',
  'reminder_resolved',
  'correction_made',
  'missed_or_late',
  'trial_converted',
  'churn_reason',
  'notification_opt_out',
] as const;
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

/** Props must be short enum-like tokens, numbers or booleans: never personal data. */
export interface TelemetryEvent {
  name: TelemetryEventName;
  props?: Record<string, string | number | boolean>;
  at?: string;
}

// ---- Intake ------------------------------------------------------------------------------------

export type IntakeType = 'forwarded_email' | 'document' | 'shared_sms' | 'manual';
export type ReviewStatus = 'needs_review' | 'confirmed' | 'ignored' | 'deleted' | 'unreadable';

export interface IntakeFields {
  provider?: string;
  service?: string;
  commitmentType?: string;
  amountInr?: number;
  billingCycle?: 'weekly' | 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';
  renewalDate?: string;
  dueDate?: string;
  trialEndDate?: string;
  benefit?: string;
  offerExpiryDate?: string;
  senderDomain?: string;
  links?: string[];
  referenceLabel?: string;
}

/** Field edits: `null` removes a field. Edited fields get confidence 1 (user-entered). */
export type IntakeFieldEdits = {
  [K in Exclude<keyof IntakeFields, 'senderDomain' | 'links'>]?: IntakeFields[K] | null;
};

export interface IntakeAlias {
  alias: string | null;
  address?: string | null;
  status?: 'active' | 'paused' | 'rotated';
  /** False until the server has inbound email configured: the UI must say intake is not live yet. */
  live: boolean;
  liveReason?: string | null;
  createdAt?: string;
}

export interface IntakeSessionResponse extends IntakeAlias {
  sessionExpiresAt: string;
}

export interface UserEvent {
  id: string;
  intakeType: IntakeType;
  messageFingerprint: string | null;
  sourceDomain: string | null;
  extractedFields: IntakeFields;
  confidence: Record<string, number>;
  reviewStatus: ReviewStatus;
  rawAvailable: boolean;
  rawRetentionUntil: string | null;
  parserVersion: string;
  createdAt: string;
  updatedAt: string;
  rawText?: string | null;
}

export interface OfferMatch {
  offerId: string;
  provider: string;
  name: string;
  computedStatus: string;
  sourceUrls: string[];
  lastConfirmedAt: string | null;
  officialEndAt: string | null;
  eligibility: 'unconfirmed';
  label: string;
}

export interface IntakeRecordExport {
  format: 'due-intake-record/1';
  exportedAt: string;
  record: Pick<
    UserEvent,
    | 'id'
    | 'intakeType'
    | 'sourceDomain'
    | 'confidence'
    | 'reviewStatus'
    | 'parserVersion'
    | 'createdAt'
  > & {
    fields: IntakeFields;
  };
}

export type ConsentPurpose =
  'email_intake' | 'document_parsing' | 'reminders_email' | 'telemetry' | 'sync_backup';

export interface ConsentsResponse {
  current: Partial<Record<ConsentPurpose, { granted: boolean; textVersion: string; at: string }>>;
  history: { purpose: ConsentPurpose; granted: boolean; textVersion: string; at: string }[];
}

export interface ClaimIntakeResponse {
  ok: true;
  moved: number;
  duplicatesDropped: number;
  aliasTransferred: boolean;
  alias: IntakeAlias;
}
