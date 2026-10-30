/** Due & Offers: a read-only, source-linked evidence model. Nothing here buys, pays, activates or cancels. */

export type OfferStatus = 'active' | 'active_verify' | 'expired' | 'conflicting' | 'unknown';
export type BenefitType =
  'recurring_entitlement' | 'one_time_reward' | 'trial' | 'bundle' | 'capability';
export type ProviderId = 'jio' | 'airtel' | 'vi' | 'amazon' | 'google' | 'ecosystem';
export type SourceKind =
  | 'plan_page'
  | 'terms'
  | 'faq'
  | 'landing_page'
  | 'press_release'
  | 'help_page'
  | 'campaign_page'
  | 'product_page';
export type PageStatus = 'visible' | 'unavailable' | 'login_required' | 'dynamic' | 'unknown';
export type TermsStatus = 'active' | 'expired' | 'unavailable' | 'conflicting' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low';
export type Cadence = 'daily' | 'weekly' | 'monthly' | 'on_demand';

export interface SourceRef {
  url: string;
  kind: SourceKind;
  /** Descriptive link text, e.g. "Jio Gemini offer terms". */
  label: string;
  /** Reference number in the Oct 2026 research report. */
  ref: number;
}

export type EligibilityKind =
  | 'service_type'
  | 'plan_threshold'
  | 'tenure'
  | 'number_type'
  | 'address_circle'
  | 'age'
  | 'account_status'
  | 'payment_rail'
  | 'partner_app'
  | 'min_transaction'
  | 'frequency_cap'
  | 'promo_code'
  | 'existing_subscription'
  | 'device_platform'
  | 'claim_channel'
  | 'claim_deadline'
  | 'renewal_rule'
  | 'exclusion';

export interface EligibilityRule {
  kind: EligibilityKind;
  description: string;
  /** user_input: the user can answer it in Due. provider_only: only the provider app/site can confirm. */
  verification: 'user_input' | 'provider_only';
  /** For user_input rules: the service-record field to read and the value that meets the rule. */
  field?: keyof UserServiceRecord;
  expected?: string | boolean;
}

export interface OfferRecord {
  offerId: string;
  provider: ProviderId;
  productFamily: string;
  name: string;
  skuOrPlanCode?: string;
  benefitType: BenefitType;
  currency?: 'INR';
  /** Documented price in rupees, only when the source states it. */
  price?: number;
  billingPeriod?: 'monthly' | 'quarterly' | 'annual' | 'one_time' | 'none';
  benefitValue: Record<string, unknown>;
  geography?: string;
  sourceUrls: string[];
  sources: SourceRef[];
  observedAt: string;
  sourcePublishedAt?: string;
  officialStartAt?: string;
  officialEndAt?: string;
  lastConfirmedAt: string;
  pageStatus: PageStatus;
  termsStatus: TermsStatus;
  computedStatus: OfferStatus;
  confidence: Confidence;
  supersedesOfferId?: string;
  notes: string[];
  eligibility: EligibilityRule[];
  /** A press release alone is not a current offer unless a live claim path is documented. */
  liveClaimPath?: boolean;
  /** Who handles renewal or cancellation, if documented. */
  billingOwner?: string;
  cadence: Cadence;
}

export type ServiceType =
  | 'prepaid'
  | 'postpaid'
  | 'fiber'
  | 'ott'
  | 'cloud'
  | 'ai'
  | 'cashback'
  | 'payment_capability'
  | 'other';

export type ServiceProvider = ProviderId | 'cards_upi' | 'generic';

/**
 * The user's own assertion about a service. Deliberately has no fields for passwords, OTPs,
 * card numbers, bank credentials, Aadhaar/KYC or SIM details.
 */
export interface UserServiceRecord {
  id: string;
  provider: ServiceProvider;
  serviceType: ServiceType;
  label: string;
  planName?: string;
  approxPricePaise?: number | null;
  circle?: string;
  tenureMonths?: number | null;
  existingSubscription?: boolean | null;
  device?: 'android' | 'ios' | 'other' | null;
  numberType?: 'jio' | 'non_jio' | null;
  partnerAppStatus?: 'new' | 'existing' | null;
  paymentRail?: 'upi' | 'wallet' | 'card' | 'other' | null;
  claimCardVisible?: boolean | null;
  billedThrough?: 'direct' | 'google_play' | 'apple' | 'partner' | null;
  partnerName?: string;
  selectedOttCount?: number | null;
  renewalDate?: string | null;
  claimDeadline?: string | null;
  trialEnd?: string | null;
  benefitExpiry?: string | null;
  notes: string;
  createdAt: string;
  isSample?: boolean;
}

export interface SourceObservation {
  id: string;
  offerId: string;
  sourceUrl: string;
  sourceKind: SourceKind;
  /** Normalised fact text, e.g. "termsStatus=unavailable". */
  fact: string;
  fingerprint: string;
  observedAt: string;
  changeType: 'new' | 'unchanged' | 'changed' | 'disappeared';
}

/** Stores a date and a label only. Creating one never contacts a provider. */
export interface OfferReminder {
  id: string;
  refId: string;
  label: string;
  date: string;
}

export type RelayEventState = 'needs_confirmation' | 'saved' | 'ignored' | 'could_not_identify';
export type RelayClass =
  | 'receipt'
  | 'renewal'
  | 'trial'
  | 'offer'
  | 'recharge'
  | 'card_statement'
  | 'emi_loan'
  | 'school_fee'
  | 'utility'
  | 'irrelevant';

export interface RelayCandidate {
  provider: ServiceProvider | null;
  service: string | null;
  amountPaise: number | null;
  currency: 'INR' | null;
  date: string | null;
  trialEnd: string | null;
  benefit: string | null;
  senderDomain: string | null;
  links: string[];
}

export interface UserEvent {
  id: string;
  messageId: string;
  fingerprint: string;
  receivedAt: string;
  subject: string;
  classification: RelayClass;
  candidate: RelayCandidate;
  matchedOfferIds: string[];
  /** unverified until the user confirms or an official public source supports it. */
  verification: 'unverified' | 'source_supported' | 'user_confirmed';
  state: RelayEventState;
  parserVersion: string;
  confidence: Confidence;
  extractedAt: string;
  /** Short excerpt kept only until the retention date; null once purged. */
  rawExcerpt: string | null;
  rawPurgeAfter: string;
  isSample?: boolean;
}

export interface RelayState {
  status: 'not_connected' | 'connected' | 'paused';
  token: string | null;
  retentionDays: number;
  events: UserEvent[];
}
