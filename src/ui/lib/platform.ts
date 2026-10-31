/**
 * Typed calls for the public platform endpoints the UI labels features with (status, legal, plans tax
 * note), document upload limits and account-deletion progress. Agent A owns the server side; these follow
 * docs/production/LAUNCH_CONTRACT.md. Every call is tolerant: a missing or unreachable endpoint yields an
 * honest "unavailable" state, never a fake "live" one.
 */
import { useEffect, useState } from 'react';
import {
  createIdentitiesClient,
  createRequester,
  type IdentitiesClient,
  type Requester,
} from '../../lib/account/identities';
import { createGmailClient, type GmailClient, type GmailStatus } from '../../lib/account/gmail';

import type { AccountClientOptions } from '../../lib/account/client';

export type IntegrationMode = 'live' | 'test_mode' | 'verification_pending' | 'not_configured';

export interface PublicStatus {
  incident: null | { level: string; message: string; updatedAt: string };
  integrations: {
    smtp: IntegrationMode;
    inbound: IntegrationMode;
    gmail: IntegrationMode;
    billing: IntegrationMode;
  };
}

export interface Subprocessor {
  name: string;
  purpose: string;
  region: string;
}

export interface PublicLegal {
  entityName: string | null;
  address: string | null;
  grievanceOfficerName: string | null;
  grievanceEmail: string | null;
  grievancePhone: string | null;
  supportEmail: string | null;
  incidentContact: string | null;
  privacyPolicyMd: string | null;
  termsMd: string | null;
  deletionPolicyMd: string | null;
  subprocessors: Subprocessor[] | null;
  effectiveDate: string | null;
  complete: boolean;
  missing?: string[];
}

export interface UploadCount {
  month: string;
  used: number;
  limit: number | null;
  remaining: number | null;
  unlimited: boolean;
}

export interface DeletionStatus {
  requestId: string | null;
  status: 'none' | 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  steps: { step: string; done: boolean; doneAt: string | null }[];
  requestedAt?: string;
  completedAt?: string | null;
  errorCode?: string | null;
  retentionExceptions?: unknown;
}

export interface DeletionAccepted {
  ok: true;
  status: 'queued';
  requestId: string;
  statusToken: string;
  statusUrl: string;
}

export interface PlansTax {
  note: string | null;
  pricesIncludeTax?: boolean | null;
}

const MODES: IntegrationMode[] = ['live', 'test_mode', 'verification_pending', 'not_configured'];
const asMode = (v: unknown): IntegrationMode =>
  MODES.includes(v as IntegrationMode) ? (v as IntegrationMode) : 'not_configured';

/** Normalises a status payload; unknown values become 'not_configured' (never 'live'). */
export function normaliseStatus(raw: unknown): PublicStatus {
  const r = (raw ?? {}) as { incident?: unknown; integrations?: Record<string, unknown> };
  const i = r.integrations ?? {};
  const inc = r.incident as PublicStatus['incident'] | undefined;
  return {
    incident:
      inc && typeof inc === 'object' && typeof inc.message === 'string' && inc.message
        ? {
            level: String(inc.level ?? 'info'),
            message: inc.message,
            updatedAt: String(inc.updatedAt ?? ''),
          }
        : null,
    integrations: {
      smtp: asMode(i.smtp),
      inbound: asMode(i.inbound),
      gmail: asMode(i.gmail),
      billing: asMode(i.billing),
    },
  };
}

export function createPlatformClient(opts: AccountClientOptions = {}, request?: Requester) {
  const req = request ?? createRequester(opts);
  return {
    status: async () => normaliseStatus(await req<unknown>('GET', '/api/public/status')),
    legal: () => req<PublicLegal>('GET', '/api/public/legal'),
    plansTax: async () =>
      ((await req<{ tax?: PlansTax }>('GET', '/api/public/plans')).tax ?? null) as PlansTax | null,
    uploadCount: () => req<UploadCount>('GET', '/api/account/uploads/count'),
    /** Counts one upload before processing; 402 premium_required once the Free allowance is used. */
    countUpload: () => req<UploadCount>('POST', '/api/account/uploads/count', {}),
    deletionStatus: (requestId?: string, token?: string) =>
      req<DeletionStatus>(
        'GET',
        requestId && token
          ? `/api/account/deletion-status?requestId=${encodeURIComponent(requestId)}&token=${encodeURIComponent(token)}`
          : '/api/account/deletion-status',
      ),
    /** DELETE /api/account answers 202 with a status token (the deletion runs asynchronously). */
    deleteAccount: (confirmationToken: string) =>
      req<DeletionAccepted>('DELETE', '/api/account', { confirmationToken }),
  };
}

export type PlatformClient = ReturnType<typeof createPlatformClient>;

let shared: PlatformClient | null = null;
/** One platform client per page (tests can replace it with setPlatformClient). */
export function platform(): PlatformClient {
  if (!shared) shared = createPlatformClient();
  return shared;
}
export function setPlatformClient(c: PlatformClient | null) {
  shared = c;
  statusCache = null;
  legalCache = null;
}

export type Loadable<T> =
  { state: 'loading' } | { state: 'ok'; value: T } | { state: 'unavailable' };

let statusCache: Promise<PublicStatus> | null = null;
let legalCache: Promise<PublicLegal> | null = null;

function useCached<T>(get: () => Promise<T>): Loadable<T> {
  const [v, setV] = useState<Loadable<T>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    get().then(
      (value) => live && setV({ state: 'ok', value }),
      () => live && setV({ state: 'unavailable' }),
    );
    return () => {
      live = false;
    };
  }, [get]);
  return v;
}

const getStatus = () => {
  if (!statusCache) {
    statusCache = platform().status();
    statusCache.catch(() => {
      statusCache = null;
    });
  }
  return statusCache;
};
const getLegal = () => {
  if (!legalCache) {
    legalCache = platform().legal();
    legalCache.catch(() => {
      legalCache = null;
    });
  }
  return legalCache;
};

/** GET /api/public/status, fetched once per page. */
export function usePublicStatus(): Loadable<PublicStatus> {
  return useCached(getStatus);
}

/** GET /api/public/legal, fetched once per page. */
export function usePublicLegal(): Loadable<PublicLegal> {
  return useCached(getLegal);
}

/** Honest, short label for an integration mode. */
export function modeLabel(mode: IntegrationMode | 'unknown'): string {
  switch (mode) {
    case 'live':
      return 'Live';
    case 'test_mode':
      return 'Test mode';
    case 'verification_pending':
      return 'Verification pending';
    case 'not_configured':
      return 'Not configured';
    default:
      return 'Status unavailable';
  }
}

export function modeTone(mode: IntegrationMode | 'unknown'): 'calm' | 'warm' | 'plain' {
  return mode === 'live'
    ? 'calm'
    : mode === 'not_configured' || mode === 'unknown'
      ? 'plain'
      : 'warm';
}

// ---- Gmail and identities (Agent B's wrappers), one instance per page --------------------------

let gmail: GmailClient | null = null;
let identities: IdentitiesClient | null = null;
let gmailStatusCache: Promise<GmailStatus> | null = null;

export function gmailClient(): GmailClient {
  if (!gmail) gmail = createGmailClient();
  return gmail;
}
export function identitiesClient(): IdentitiesClient {
  if (!identities) identities = createIdentitiesClient();
  return identities;
}
/** Test hook: replace the Gmail/identities clients (null restores the real ones). */
export function setAccountWrappers(g: GmailClient | null, i: IdentitiesClient | null) {
  gmail = g;
  identities = i;
  gmailStatusCache = null;
}

const getGmailStatus = () => {
  if (!gmailStatusCache) {
    gmailStatusCache = gmailClient().status();
    gmailStatusCache.catch(() => {
      gmailStatusCache = null;
    });
  }
  return gmailStatusCache;
};

/** GET /api/account/gmail/status (public), fetched once per page. */
export function useGmailStatus(): Loadable<GmailStatus> {
  return useCached(getGmailStatus);
}

/** Label for a feature that depends on an integration and possibly on Plus. */
export function featureTag(
  mode: IntegrationMode | 'unknown',
  needsPlus: boolean,
  hasPlus: boolean,
): { text: string; tone: 'calm' | 'warm' | 'plain' } {
  if (mode === 'live' && needsPlus && !hasPlus) return { text: 'Plus required', tone: 'warm' };
  return { text: modeLabel(mode), tone: modeTone(mode) };
}
