import { z } from 'zod';
import { parseTokenKeys, type TokenKeyRing } from './gmail/keys.js';

const boolish = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'yes'].includes(v.toLowerCase())));

/** Optional URL; an empty value (e.g. an unset Render `sync: false` variable) counts as not set. */
const optionalUrl = z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().trim().url().optional());

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(10000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ADMIN_SETUP_TOKEN: z.string().optional(),
  PUBLIC_APP_ORIGIN: z.string().optional(),
  PUBLIC_BASE_URL: optionalUrl,
  /** Set automatically by Render; used when PUBLIC_BASE_URL is not given. */
  RENDER_EXTERNAL_URL: optionalUrl,
  RUN_SCHEDULER: boolish,
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  TRUST_PROXY: boolish,
  ADMIN_DIST: z.string().optional(),
  APP_DIST: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  INBOUND_EMAIL_DOMAIN: z.string().optional(),
  INBOUND_WEBHOOK_SECRET: z.string().optional(),
  /** 32 random bytes, base64. Without it raw intake text is never stored (structured fields only). */
  DATA_ENCRYPTION_KEY: z.string().optional(),
  /** Gmail OAuth (read-only). All four are required; otherwise Gmail reports mode 'not_configured'. */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  GMAIL_TOKEN_KEYS: z.string().optional(),
  /** 'test' (Google app in Testing; only listed test users), 'verification_pending' or 'live'. Default 'test'. */
  GMAIL_OAUTH_MODE: z.string().optional(),
  /** Optional Sentry-compatible DSN for privacy-scrubbed error reports. */
  SENTRY_DSN: z.string().optional(),
  /** Run the durable-queue worker inside the web process (single-service deployments only). */
  RUN_QUEUE_WORKER: boolish,
});

export type GmailMode = 'not_configured' | 'test_mode' | 'verification_pending' | 'live';

export interface GmailEndpoints {
  authUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  gmailApiBase: string;
}

export const GOOGLE_ENDPOINTS: GmailEndpoints = {
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  revokeUrl: 'https://oauth2.googleapis.com/revoke',
  gmailApiBase: 'https://gmail.googleapis.com/gmail/v1',
};

export interface GmailConfig {
  mode: GmailMode;
  /** Names of missing or invalid variables when mode is 'not_configured' (shown as the exact blocker). */
  missing: string[];
  oauth: { clientId: string; clientSecret: string; redirectUri: string; tokenKeys: TokenKeyRing } | null;
  /** Google endpoints; tests point these at a local mock server. */
  endpoints: GmailEndpoints;
}

/** Redirect URIs must be absolute, without fragment, and https except on localhost. */
function validRedirectUri(v: string): boolean {
  try {
    const u = new URL(v);
    if (u.hash || u.username || u.password) return false;
    const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return u.protocol === 'https:' || (u.protocol === 'http:' && local);
  } catch {
    return false;
  }
}

export function loadGmailConfig(e: {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
  GMAIL_TOKEN_KEYS?: string;
  GMAIL_OAUTH_MODE?: string;
}): GmailConfig {
  const missing: string[] = [];
  const clientId = e.GOOGLE_CLIENT_ID?.trim() ?? '';
  const clientSecret = e.GOOGLE_CLIENT_SECRET?.trim() ?? '';
  const redirectUri = e.GOOGLE_REDIRECT_URI?.trim() ?? '';
  if (!clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!redirectUri) missing.push('GOOGLE_REDIRECT_URI');
  else if (!validRedirectUri(redirectUri)) missing.push('GOOGLE_REDIRECT_URI (must be an absolute https URL)');
  let tokenKeys: TokenKeyRing | null = null;
  try {
    tokenKeys = parseTokenKeys(e.GMAIL_TOKEN_KEYS);
    if (!tokenKeys) missing.push('GMAIL_TOKEN_KEYS');
  } catch {
    missing.push('GMAIL_TOKEN_KEYS (invalid: expected "kid:base64-32-byte-key,...")');
  }
  const rawMode = (e.GMAIL_OAUTH_MODE?.trim() || 'test').toLowerCase();
  const modes: Record<string, GmailMode> = { test: 'test_mode', test_mode: 'test_mode', verification_pending: 'verification_pending', live: 'live' };
  const mode = modes[rawMode];
  if (!mode) missing.push('GMAIL_OAUTH_MODE (must be test, verification_pending or live)');
  if (missing.length || !tokenKeys || !mode) return { mode: 'not_configured', missing, oauth: null, endpoints: { ...GOOGLE_ENDPOINTS } };
  return { mode, missing: [], oauth: { clientId, clientSecret, redirectUri, tokenKeys }, endpoints: { ...GOOGLE_ENDPOINTS } };
}

export interface MonitorOptions {
  userAgent: string;
  /** Minimum gap between two requests to the same host. */
  hostGapMs: number;
  timeoutMs: number;
  maxBytes: number;
  robotsTtlMs: number;
  maxRedirects: number;
  /** Allow fetching loopback/private addresses (tests only). */
  allowPrivateHosts: boolean;
}

export interface AppConfig {
  env: string;
  isProduction: boolean;
  port: number;
  host: string;
  databaseUrl: string;
  sessionSecret: string;
  adminSetupToken: string | null;
  publicAppOrigins: string[];
  publicBaseUrl: string | null;
  runScheduler: boolean;
  smtpUrl: string | null;
  smtpFrom: string | null;
  trustProxy: boolean;
  adminDist: string | null;
  appDist: string | null;
  sessionIdleMs: number;
  sessionMaxMs: number;
  /** Consumer (due_acct) sessions: 30 days idle, 180 days absolute. */
  accountSessionIdleMs: number;
  accountSessionMaxMs: number;
  /** Razorpay credentials; null when any of the three is missing (checkout is then unavailable). */
  razorpay: { keyId: string; keySecret: string; webhookSecret: string } | null;
  /** Forwarding-alias domain (e.g. inbox.example.com); intake is "live" only with this and the webhook secret. */
  inboundEmailDomain: string | null;
  inboundWebhookSecret: string | null;
  dataEncryptionKey: Buffer | null;
  gmail: GmailConfig;
  sentryDsn: string | null;
  runQueueWorker: boolean;
  schedulerTickMs: number;
  monitor: MonitorOptions;
}

export function userAgentFor(publicBaseUrl: string | null): string {
  const host = publicBaseUrl ? new URL(publicBaseUrl).host : 'localhost';
  return `DueSourceMonitor/1.0 (+https://${host}/about-monitoring)`;
}

function parseEncryptionKey(v: string | undefined): Buffer | null {
  if (!v?.trim()) return null;
  const key = Buffer.from(v.trim(), 'base64');
  if (key.length !== 32) throw new Error('Invalid environment: DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    sessionSecret: e.SESSION_SECRET,
    adminSetupToken: e.ADMIN_SETUP_TOKEN?.trim() ? e.ADMIN_SETUP_TOKEN.trim() : null,
    publicAppOrigins: (e.PUBLIC_APP_ORIGIN ?? e.RENDER_EXTERNAL_URL ?? '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
    publicBaseUrl: (e.PUBLIC_BASE_URL ?? e.RENDER_EXTERNAL_URL)?.replace(/\/$/, '') ?? null,
    runScheduler: e.RUN_SCHEDULER ?? false,
    smtpUrl: e.SMTP_URL?.trim() ? e.SMTP_URL.trim() : null,
    smtpFrom: e.SMTP_FROM?.trim() ? e.SMTP_FROM.trim() : null,
    trustProxy: e.TRUST_PROXY ?? isProduction,
    adminDist: e.ADMIN_DIST ?? null,
    appDist: e.APP_DIST ?? null,
    sessionIdleMs: 12 * 60 * 60 * 1000,
    sessionMaxMs: 7 * 24 * 60 * 60 * 1000,
    accountSessionIdleMs: 30 * 24 * 60 * 60 * 1000,
    accountSessionMaxMs: 180 * 24 * 60 * 60 * 1000,
    razorpay:
      e.RAZORPAY_KEY_ID?.trim() && e.RAZORPAY_KEY_SECRET?.trim() && e.RAZORPAY_WEBHOOK_SECRET?.trim()
        ? { keyId: e.RAZORPAY_KEY_ID.trim(), keySecret: e.RAZORPAY_KEY_SECRET.trim(), webhookSecret: e.RAZORPAY_WEBHOOK_SECRET.trim() }
        : null,
    inboundEmailDomain: e.INBOUND_EMAIL_DOMAIN?.trim() ? e.INBOUND_EMAIL_DOMAIN.trim().toLowerCase() : null,
    inboundWebhookSecret: e.INBOUND_WEBHOOK_SECRET?.trim() ? e.INBOUND_WEBHOOK_SECRET.trim() : null,
    dataEncryptionKey: parseEncryptionKey(e.DATA_ENCRYPTION_KEY),
    gmail: loadGmailConfig(e),
    sentryDsn: e.SENTRY_DSN?.trim() ? e.SENTRY_DSN.trim() : null,
    runQueueWorker: e.RUN_QUEUE_WORKER ?? false,
    schedulerTickMs: 60_000,
    monitor: {
      userAgent: userAgentFor(e.PUBLIC_BASE_URL ?? e.RENDER_EXTERNAL_URL ?? null),
      hostGapMs: 10_000,
      timeoutMs: 20_000,
      maxBytes: 5 * 1024 * 1024,
      robotsTtlMs: 24 * 60 * 60 * 1000,
      maxRedirects: 5,
      allowPrivateHosts: false,
    },
  };
}
