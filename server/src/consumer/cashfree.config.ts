/**
 * Everything version- or endpoint-specific about Cashfree Subscriptions lives here, so an API upgrade is a one-file
 * change. Based on Cashfree's PG Subscriptions API (header x-api-version 2023-08-01; newer versions exist, e.g.
 * 2025-01-01). Verify every value against a Cashfree SANDBOX account before going live: the adapter has only been
 * exercised against mocks (see docs/production/PAYMENTS.md).
 */
export const CASHFREE = {
  apiVersion: '2023-08-01',
  baseUrl: { sandbox: 'https://sandbox.cashfree.com/pg', production: 'https://api.cashfree.com/pg' },
  paths: {
    createSubscription: '/subscriptions',
    fetchSubscription: (id: string) => `/subscriptions/${encodeURIComponent(id)}`,
    manageSubscription: (id: string) => `/subscriptions/${encodeURIComponent(id)}/manage`,
  },
  /** Hosted subscription checkout page, opened with the subscription_session_id. VERIFY in sandbox. */
  hostedCheckout: {
    sandbox: 'https://sandbox.cashfree.com/pg/view/subscriptions/checkout?session_id=',
    production: 'https://api.cashfree.com/pg/view/subscriptions/checkout?session_id=',
  },
  /** Webhook headers; the signature is base64(HMAC-SHA256(timestamp + rawBody, secret)). */
  webhook: { signatureHeader: 'x-webhook-signature', timestampHeader: 'x-webhook-timestamp' },
  /** Subscription status values and how Due treats them (normalised to Due's provider-neutral vocabulary). */
  statusMap: {
    ACTIVE: 'active',
    CANCELLED: 'cancelled',
    CUSTOMER_CANCELLED: 'cancelled',
    COMPLETED: 'completed',
    EXPIRED: 'expired',
    PAUSED: 'paused',
    CUSTOMER_PAUSED: 'paused',
    // Retrying a failed charge: leave access to the grace period / paid period.
    ON_HOLD: 'pending',
    INITIALIZED: 'created',
    BANK_APPROVAL_PENDING: 'pending',
  } as Record<string, string>,
  /** Days of access kept after the first failed renewal charge of a cycle. */
  graceDays: 3,
  /** Mandate limits: the first authorisation charge (rupees) refunded by Cashfree; kept minimal. */
  authorizationAmountInr: 1,
  maxTotalCycles: { monthly: 120, yearly: 10 },
} as const;
