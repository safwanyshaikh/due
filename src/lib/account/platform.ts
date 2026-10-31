/**
 * Typed client for platform endpoints (Agent A): public status and legal content, notification preferences,
 * monthly upload allowance, and asynchronous account deletion progress. Same CSRF/credentials handling as the
 * other account clients.
 */
import type { AccountClientOptions } from './client';
import { createRequester } from './identities';

export type IntegrationMode = 'live' | 'test_mode' | 'verification_pending' | 'not_configured';

export interface PublicStatus {
  incident: null | {
    level: 'info' | 'minor' | 'major' | 'critical';
    message: string;
    updatedAt: string;
  };
  integrations: {
    smtp: IntegrationMode;
    inbound: IntegrationMode;
    gmail: IntegrationMode;
    billing: IntegrationMode;
  };
}

export interface LegalContent {
  entityName: string;
  address: string;
  grievanceOfficerName: string;
  grievanceEmail: string;
  grievancePhone: string;
  supportEmail: string;
  incidentContact: string;
  privacyPolicyMd: string;
  termsMd: string;
  deletionPolicyMd: string;
  subprocessors: { name: string; purpose: string; region: string }[];
  effectiveDate: string | null;
  /** False while any required field is empty or placeholder: show "Legal details incomplete". */
  complete: boolean;
  missing: string[];
}

export type NotificationChannel = 'email' | 'push';

export interface NotificationPreference {
  channel: NotificationChannel;
  enabled: boolean;
  timezone: string;
  quietHours: { start: string; end: string } | null;
  snoozeUntil: string | null;
  disabledVia: string | null;
  consent: 'none' | 'granted' | 'revoked';
  consentPolicyVersion: string | null;
  /** Push delivery is not available on this server yet. */
  available: boolean;
}

export interface NotificationPreferenceUpdate {
  channel: NotificationChannel;
  enabled?: boolean;
  timezone?: string;
  quietHours?: { start: string; end: string } | null;
  snoozeUntil?: string | null;
  /** Required the first time a channel is turned on (explicit consent). */
  consentVersion?: string;
}

export interface UploadAllowance {
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
  retentionExceptions: { record: string; reason: string }[];
}

/** Response of DELETE /api/account (202): keep requestId + statusToken to poll progress after sign-out. */
export interface DeletionQueued {
  ok: true;
  status: 'queued';
  requestId: string;
  statusToken: string;
  statusUrl: string;
}

export function createPlatformClient(opts: AccountClientOptions = {}) {
  const request = createRequester(opts);
  return {
    status: () => request<PublicStatus>('GET', '/api/public/status'),
    legal: () => request<LegalContent>('GET', '/api/public/legal'),
    notificationPreferences: () =>
      request<{ items: NotificationPreference[] }>('GET', '/api/account/notifications/preferences'),
    updateNotificationPreference: (u: NotificationPreferenceUpdate) =>
      request<{ items: NotificationPreference[] }>(
        'PUT',
        '/api/account/notifications/preferences',
        u,
      ),
    uploadAllowance: () => request<UploadAllowance>('GET', '/api/account/uploads/count'),
    /** Counts one document upload; rejects with code 'premium_required' (402) once a Free account hits its limit. */
    countUpload: () => request<UploadAllowance>('POST', '/api/account/uploads/count'),
    deletionStatus: (q?: { requestId: string; token: string }) =>
      request<DeletionStatus>(
        'GET',
        q
          ? `/api/account/deletion-status?requestId=${encodeURIComponent(q.requestId)}&token=${encodeURIComponent(q.token)}`
          : '/api/account/deletion-status',
      ),
  };
}
