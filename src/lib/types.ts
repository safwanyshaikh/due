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

export type Confidence = 'confirmed' | 'estimate' | 'unknown';

export type Rail =
  'upi_autopay' | 'credit_card' | 'debit_card' | 'bank_mandate' | 'manual' | 'other' | 'unknown';

export interface ReminderPrefs {
  enabled: boolean;
  /** Days before a date. Defaults to 7, 3, 1. */
  offsets: number[];
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
  source: 'manual' | 'csv_import';
  isSample?: boolean;
  createdAt: string;
  updatedAt: string;
}

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
  isSample?: boolean;
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

export interface AppData {
  version: 1;
  commitments: Commitment[];
  links: CommitmentLink[];
  budget: Budget;
  seasons: Season[];
  labels: BillingEmailLabel[];
  settings: Settings;
  actionLog: ActionLogEntry[];
  deliveryLog: DeliveryLogEntry[];
}

export interface Period {
  start: ISODate;
  end: ISODate;
}
