/**
 * Typed browser client for Due's consumer account endpoints (sign-in, devices, sync, reminders, plans,
 * household sharing, telemetry and intake). Every request sends `credentials: 'include'` and the
 * `X-Requested-With: due-app` header the server's CSRF guard requires. Errors are mapped to
 * `AccountApiError` with the server's `{ error: { code, message, details } }` payload.
 */
import type {
  BillingPeriod,
  CheckoutResponse,
  ClaimIntakeResponse,
  ConsentPurpose,
  ConsentsResponse,
  DeleteRequest,
  DeviceSession,
  Entitlements,
  HouseholdMember,
  HouseholdResponse,
  Household,
  IntakeAlias,
  IntakeFieldEdits,
  IntakeRecordExport,
  IntakeSessionResponse,
  IntakeType,
  MagicLinkResponse,
  MeResponse,
  OfferMatch,
  PlanId,
  PublicPlansResponse,
  PutDataResponse,
  ReminderPlanItem,
  RemindersResponse,
  ReviewStatus,
  SyncDocument,
  TelemetryEvent,
  UserEvent,
  VerifyResponse,
  Account,
  EmailDeliveryState,
} from './types';

export * from './types';

export const CSRF_HEADER = 'X-Requested-With';
export const CSRF_VALUE = 'due-app';

/** Codes meaning "this server cannot do that yet" — show a truthful unavailable state, not an error. */
export const UNAVAILABLE_CODES = [
  'email_unavailable',
  'payments_unavailable',
  'intake_unavailable',
] as const;

export class AccountApiError extends Error {
  constructor(
    /** HTTP status; 0 for network failures and timeouts. */
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AccountApiError';
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }
  get isPremiumRequired(): boolean {
    return this.code === 'premium_required';
  }
  get isUnavailable(): boolean {
    return (UNAVAILABLE_CODES as readonly string[]).includes(this.code);
  }
  get isConflict(): boolean {
    return this.status === 409 && this.code === 'version_conflict';
  }
  get isRateLimited(): boolean {
    return this.status === 429;
  }
}

/** The server copy carried by a 409 version_conflict from a sync write, or null. */
export function serverCopyFromConflict<T = Record<string, unknown>>(
  err: unknown,
): SyncDocument<T> | null {
  if (!(err instanceof AccountApiError) || !err.isConflict) return null;
  const server = (err.details as { server?: SyncDocument<T> } | undefined)?.server;
  return server ?? null;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface AccountClientOptions {
  /** API origin; defaults to import.meta.env.VITE_API_BASE ?? '' (same origin). */
  base?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function defaultApiBase(): string {
  let raw: string | undefined;
  try {
    raw = import.meta.env?.VITE_API_BASE as string | undefined;
  } catch {
    raw = undefined;
  }
  return (raw ?? '').trim().replace(/\/+$/, '');
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export function createAccountClient(opts: AccountClientOptions = {}) {
  const base = (opts.base ?? defaultApiBase()).replace(/\/+$/, '');
  const doFetch: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = opts.timeoutMs ?? 15_000;

  async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      [CSRF_HEADER]: CSRF_VALUE,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = (err as { name?: string } | null)?.name === 'AbortError';
      throw new AccountApiError(
        0,
        aborted ? 'timeout' : 'network_error',
        aborted ? 'The request timed out' : 'Could not reach the server',
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (!res.ok) {
      const e = (
        json as { error?: { code?: unknown; message?: unknown; details?: unknown } } | undefined
      )?.error;
      throw new AccountApiError(
        res.status,
        typeof e?.code === 'string' ? e.code : 'http_error',
        typeof e?.message === 'string' ? e.message : `Request failed (HTTP ${res.status})`,
        e?.details,
      );
    }
    if (json === undefined && text)
      throw new AccountApiError(
        res.status,
        'invalid_response',
        'The server returned an unexpected response',
      );
    return json as T;
  }

  const id = (s: string) => encodeURIComponent(s);

  return {
    // ---- Sign-in, profile, devices ---------------------------------------------------------------
    requestMagicLink: (email: string) =>
      request<MagicLinkResponse>('POST', '/api/account/magic-link', { email }),
    verifyMagicLink: (token: string, deviceLabel?: string) =>
      request<VerifyResponse>(
        'POST',
        '/api/account/verify',
        deviceLabel ? { token, deviceLabel } : { token },
      ),
    me: () => request<MeResponse>('GET', '/api/account/me'),
    updateProfile: (displayName: string | null) =>
      request<{ account: Account }>('PATCH', '/api/account/me', { displayName }),
    logout: () => request<{ ok: true }>('POST', '/api/account/logout', {}),
    listSessions: async () =>
      (await request<{ items: DeviceSession[] }>('GET', '/api/account/sessions')).items,
    revokeSession: (sessionId: string) =>
      request<{ ok: true; current: boolean }>(
        'POST',
        `/api/account/sessions/${id(sessionId)}/revoke`,
        {},
      ),
    logoutAll: () => request<{ ok: true; revoked: number }>('POST', '/api/account/logout-all', {}),
    requestAccountDeletion: () => request<DeleteRequest>('POST', '/api/account/delete-request', {}),
    deleteAccount: (confirmationToken: string) =>
      request<{ ok: true; deleted: true }>('DELETE', '/api/account', { confirmationToken }),
    exportAccount: () => request<Record<string, unknown>>('GET', '/api/account/export'),

    // ---- Backup / sync -------------------------------------------------------------------------
    getData: <T = Record<string, unknown>>() =>
      request<SyncDocument<T>>('GET', '/api/account/data'),
    /** Throws AccountApiError (isConflict) with the server copy on a version conflict; see serverCopyFromConflict. */
    putData: (baseVersion: number, data: Record<string, unknown>, reminders?: ReminderPlanItem[]) =>
      request<PutDataResponse>(
        'PUT',
        '/api/account/data',
        reminders ? { baseVersion, data, reminders } : { baseVersion, data },
      ),
    putReminders: (items: ReminderPlanItem[]) =>
      request<{ stored: number; emailDelivery: EmailDeliveryState }>(
        'PUT',
        '/api/account/reminders',
        { items },
      ),
    getReminders: () => request<RemindersResponse>('GET', '/api/account/reminders'),

    // ---- Plans, entitlements, purchases --------------------------------------------------------
    getEntitlements: () => request<Entitlements>('GET', '/api/account/entitlements'),
    getPublicPlans: () => request<PublicPlansResponse>('GET', '/api/public/plans'),
    /** billingPeriod is required: the server never defaults to yearly. */
    checkout: (plan: Exclude<PlanId, 'free'>, billingPeriod: BillingPeriod) =>
      request<CheckoutResponse>('POST', '/api/account/checkout', { plan, billingPeriod }),
    restorePurchase: () =>
      request<{ source: 'provider' | 'database'; entitlements: Entitlements }>(
        'POST',
        '/api/account/restore',
        {},
      ),
    cancelSubscription: () =>
      request<{ ok: true; entitlements: Entitlements }>(
        'POST',
        '/api/account/subscription/cancel',
        {},
      ),

    // ---- Household sharing ---------------------------------------------------------------------
    getHousehold: () => request<HouseholdResponse>('GET', '/api/account/household'),
    createHousehold: (name: string) =>
      request<{ household: Household; role: 'owner' }>('POST', '/api/account/household', { name }),
    deleteHousehold: () => request<{ ok: true }>('DELETE', '/api/account/household', {}),
    inviteHouseholdMember: (email: string) =>
      request<{ email: string; expiresAt: string }>('POST', '/api/account/household/invites', {
        email,
      }),
    acceptHouseholdInvite: (token: string) =>
      request<{ household: Household; role: 'member' }>('POST', '/api/account/household/accept', {
        token,
      }),
    listHouseholdMembers: async () =>
      (await request<{ items: HouseholdMember[] }>('GET', '/api/account/household/members')).items,
    removeHouseholdMember: (accountId: string) =>
      request<{ ok: true }>('DELETE', `/api/account/household/members/${id(accountId)}`, {}),
    getHouseholdData: <T = Record<string, unknown>>() =>
      request<SyncDocument<T>>('GET', '/api/account/household/data'),
    putHouseholdData: (baseVersion: number, data: Record<string, unknown>) =>
      request<{ version: number; updatedAt: string }>('PUT', '/api/account/household/data', {
        baseVersion,
        data,
      }),

    // ---- Telemetry (allow-listed, no PII) ------------------------------------------------------
    sendTelemetry: (anonId: string, events: TelemetryEvent[]) =>
      request<{ accepted: number }>('POST', '/api/telemetry', { anonId, events }),

    // ---- Intake --------------------------------------------------------------------------------
    startIntakeSession: (consentTextVersion: string) =>
      request<IntakeSessionResponse>('POST', '/api/intake/session', { consentTextVersion }),
    getIntakeAlias: () => request<IntakeAlias>('GET', '/api/intake/alias'),
    createIntakeAlias: (consentTextVersion: string) =>
      request<IntakeAlias>('POST', '/api/intake/alias', { consentTextVersion }),
    rotateIntakeAlias: () => request<IntakeAlias>('POST', '/api/intake/alias/rotate', {}),
    pauseIntakeAlias: () => request<IntakeAlias>('POST', '/api/intake/alias/pause', {}),
    resumeIntakeAlias: () => request<IntakeAlias>('POST', '/api/intake/alias/resume', {}),
    listIntakeEvents: async (status?: Exclude<ReviewStatus, 'deleted'>) =>
      request<{ items: UserEvent[]; rawStorage: 'encrypted' | 'disabled' }>(
        'GET',
        `/api/intake/events${status ? `?status=${status}` : ''}`,
      ),
    submitIntake: (input: {
      intakeType: Exclude<IntakeType, 'forwarded_email'>;
      text?: string;
      subject?: string;
      fields?: IntakeFieldEdits;
    }) => request<{ duplicate: boolean; event: UserEvent }>('POST', '/api/intake/events', input),
    getIntakeEvent: (eventId: string) =>
      request<{ event: UserEvent; offerMatches: Record<string, unknown>[] }>(
        'GET',
        `/api/intake/events/${id(eventId)}`,
      ),
    confirmIntakeEvent: (eventId: string) =>
      request<{ event: UserEvent; offerMatches: OfferMatch[] }>(
        'POST',
        `/api/intake/events/${id(eventId)}/confirm`,
        {},
      ),
    ignoreIntakeEvent: (eventId: string) =>
      request<{ event: UserEvent }>('POST', `/api/intake/events/${id(eventId)}/ignore`, {}),
    editIntakeEvent: (eventId: string, fields: IntakeFieldEdits) =>
      request<{ event: UserEvent }>('PATCH', `/api/intake/events/${id(eventId)}`, { fields }),
    deleteIntakeRaw: (eventId: string) =>
      request<{ ok: true }>('DELETE', `/api/intake/events/${id(eventId)}/raw`, {}),
    deleteIntakeEvent: (eventId: string) =>
      request<{ ok: true }>('DELETE', `/api/intake/events/${id(eventId)}`, {}),
    exportIntakeEvent: (eventId: string) =>
      request<IntakeRecordExport>('GET', `/api/intake/events/${id(eventId)}/export`),
    claimIntake: () => request<ClaimIntakeResponse>('POST', '/api/account/claim-intake', {}),
    recordConsent: (purpose: ConsentPurpose, granted: boolean, textVersion: string) =>
      request<{ ok: true; purpose: ConsentPurpose; granted: boolean; at: string }>(
        'POST',
        '/api/account/consents',
        { purpose, granted, textVersion },
      ),
    getConsents: () => request<ConsentsResponse>('GET', '/api/account/consents'),
  };
}

export type AccountClient = ReturnType<typeof createAccountClient>;
