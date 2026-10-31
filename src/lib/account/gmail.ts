/**
 * Typed client for read-only Gmail connection and scans. The server decides the honest mode:
 * 'not_configured' | 'test_mode' | 'verification_pending' | 'live'. Never show Gmail as connected unless an
 * identity with kind 'gmail' and status 'active' exists (see ./identities.ts).
 */
import type { AccountClientOptions } from './client';
import { createRequester } from './identities';

export type GmailMode = 'not_configured' | 'test_mode' | 'verification_pending' | 'live';

export interface GmailStatus {
  mode: GmailMode;
  /** Exact scopes Due requests (gmail.readonly plus openid/email). */
  scopes: string[];
  /** Consent copy version the user must accept; pass it to `connect`. */
  consentVersion: string;
  consentText: string;
  /** Human-readable blocker for non-live modes, or null when live. */
  blocker: string | null;
  /** Missing/invalid server variables when not configured (operator information). */
  missing: string[];
}

export interface GmailScanRun {
  id: string;
  trigger: 'initial' | 'manual' | 'scheduled';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  messagesListed: number;
  messagesNew: number;
  eventsCreated: number;
  duplicates: number;
  attachmentsSkipped: number;
  errorCode: string | null;
}

export interface GmailDisconnectResponse {
  ok: true;
  revoked: boolean;
  deleted: { events: number; seen: number };
  /** Present when Google could not confirm revocation. */
  manualRevokeUrl?: string;
}

/** Result the OAuth callback leaves in the app URL: `/?gmail=connected&identity=…` or `/?gmail=error&reason=…`. */
export type GmailCallbackResult =
  { status: 'connected'; identityId: string | null } | { status: 'error'; reason: string } | null;

/** Reads (does not modify) the Gmail callback result from a URL search string such as `location.search`. */
export function readGmailCallback(search: string): GmailCallbackResult {
  const p = new URLSearchParams(search);
  const v = p.get('gmail');
  if (v === 'connected') return { status: 'connected', identityId: p.get('identity') };
  if (v === 'error') return { status: 'error', reason: p.get('reason') ?? 'unknown' };
  return null;
}

/** Short, user-facing explanation for a callback/identity reason code. */
export function gmailReasonMessage(reason: string): string {
  switch (reason) {
    case 'access_denied':
      return 'Gmail access was not granted.';
    case 'scope_mismatch':
      return 'Google did not grant exactly the read-only permission Due asked for. Please reconnect and allow read-only Gmail access.';
    case 'state_expired':
    case 'state_replayed':
    case 'invalid_state':
    case 'account_mismatch':
      return 'That sign-in link expired or was already used. Please start Connect Gmail again.';
    case 'token_revoked':
      return 'Gmail access was revoked. Reconnect to resume scanning.';
    case 'not_configured':
      return 'Gmail connection is not available on this server yet.';
    case 'identity_limit':
      return 'You have reached the maximum number of email identities.';
    default:
      return 'Gmail could not be connected. Please try again.';
  }
}

export function createGmailClient(opts: AccountClientOptions = {}) {
  const request = createRequester(opts);
  const id = (s: string) => encodeURIComponent(s);
  return {
    status: () => request<GmailStatus>('GET', '/api/account/gmail/status'),
    /** Returns Google's consent URL; navigate the top-level window to it. 503 gmail_not_configured, 402 premium_required. */
    connect: (consentVersion: string) =>
      request<{ authorizeUrl: string; expiresAt: string }>('POST', '/api/account/gmail/connect', {
        consentVersion,
      }),
    /** Queues a scan (202). 409 scan_in_progress / identity_not_active, 429 scan_limit. */
    scan: (identityId: string) =>
      request<{ ok: true; runId: string; jobId: string }>(
        'POST',
        `/api/account/gmail/${id(identityId)}/scan`,
        {},
      ),
    scans: async (identityId: string) =>
      (
        await request<{ items: GmailScanRun[] }>(
          'GET',
          `/api/account/gmail/${id(identityId)}/scans`,
        )
      ).items,
    /** Stops scanning immediately and revokes access at Google; optionally deletes imported review items. */
    disconnect: (identityId: string, deleteImported = false) =>
      request<GmailDisconnectResponse>('POST', `/api/account/gmail/${id(identityId)}/disconnect`, {
        deleteImported,
      }),
  };
}

export type GmailClient = ReturnType<typeof createGmailClient>;
