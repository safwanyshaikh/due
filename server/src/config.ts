import { isIP } from 'node:net';
import { z } from 'zod';
import { parseTokenKeys, type TokenKeyRing } from './gmail/keys.js';
import { parseDataKeys, type DataKeyRing } from './intake/crypto.js';

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
  /**
   * Origins the native (Capacitor) app is served from. Default: capacitor://localhost (iOS) and
   * https://localhost (Android). They get CORS (without credentials) on the consumer API only, and a
   * bearer-token session instead of cookies. Set to an empty string to turn the native API off.
   */
  MOBILE_APP_ORIGINS: z.string().optional(),
  /** Android App Links: comma-separated SHA-256 signing-cert fingerprints (AA:BB:...). Unset: assetlinks.json is 404. */
  ANDROID_SHA256_CERT_FINGERPRINTS: z.string().optional(),
  /** iOS Universal Links: 10-character Apple Developer Team ID. Unset: apple-app-site-association is 404. */
  APPLE_TEAM_ID: z.string().optional(),
  PUBLIC_BASE_URL: optionalUrl,
  /** Set automatically by Render; used when PUBLIC_BASE_URL is not given. */
  RENDER_EXTERNAL_URL: optionalUrl,
  RUN_SCHEDULER: boolish,
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  /**
   * Number of reverse-proxy hops in front of this server whose X-Forwarded-For entries are trusted.
   * Default 1 in production (Render's load balancer), 0 otherwise. Never "trust all": the left-most
   * X-Forwarded-For entries are client-controlled and would let anyone pick their own IP for rate limits.
   */
  TRUST_PROXY_HOPS: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(0).max(5).optional()),
  /** Optional comma-separated IPs/CIDRs allowed to reach the admin console and admin API. Unset: any IP. */
  ADMIN_ALLOWED_IPS: z.string().optional(),
  ADMIN_DIST: z.string().optional(),
  APP_DIST: z.string().optional(),
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  /** Which gateway sells subscriptions. Default razorpay keeps current behaviour. */
  BILLING_PROVIDER: z.enum(['razorpay', 'cashfree']).optional(),
  CASHFREE_APP_ID: z.string().optional(),
  CASHFREE_SECRET_KEY: z.string().optional(),
  /** Only if Cashfree gives a webhook secret separate from the API secret; otherwise the secret key signs webhooks. */
  CASHFREE_WEBHOOK_SECRET: z.string().optional(),
  CASHFREE_ENV: z.enum(['sandbox', 'production']).optional(),
  INBOUND_EMAIL_DOMAIN: z.string().optional(),
  INBOUND_WEBHOOK_SECRET: z.string().optional(),
  /**
   * 32 random bytes, base64, or a key ring "kid:base64,oldkid:base64" (first = current). Required in production
   * when inbound mail or Gmail is configured; without it (outside production) inbound mail is not accepted.
   */
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
  /** Optional HTTPS endpoint (India region) that receives redacted logs and audit rows as NDJSON (H4). */
  LOG_SINK_URL: optionalUrl,
  /** Bearer token for LOG_SINK_URL. */
  LOG_SINK_TOKEN: z.string().optional(),
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
  /** Native app origins (bearer-token sessions, CORS without credentials, consumer API only). */
  mobileAppOrigins: string[];
  androidCertFingerprints: string[];
  appleTeamId: string | null;
  publicBaseUrl: string | null;
  runScheduler: boolean;
  smtpUrl: string | null;
  smtpFrom: string | null;
  /** Trusted proxy hop count (0 = ignore X-Forwarded-For). */
  trustProxyHops: number;
  /** Admin console/API IP allowlist (IPs or CIDRs); empty = no restriction. */
  adminAllowedIps: string[];
  adminDist: string | null;
  appDist: string | null;
  /** Admin console sessions: 1 hour idle, 12 hours absolute. */
  sessionIdleMs: number;
  sessionMaxMs: number;
  /** Owner/admin changes need a TOTP check this recent on the session (re-authentication). */
  adminReauthMs: number;
  /** Consumer (due_acct) sessions: 30 days idle, 180 days absolute. */
  accountSessionIdleMs: number;
  accountSessionMaxMs: number;
  /** Razorpay credentials; null when any of the three is missing (checkout is then unavailable). */
  razorpay: { keyId: string; keySecret: string; webhookSecret: string } | null;
  /** Active payment gateway (BILLING_PROVIDER, default razorpay). */
  billingProvider: 'razorpay' | 'cashfree';
  /** Cashfree credentials; null unless CASHFREE_APP_ID and CASHFREE_SECRET_KEY are set. */
  cashfree: { appId: string; secretKey: string; webhookSecret: string; env: 'sandbox' | 'production' } | null;
  /** Forwarding-alias domain (e.g. inbox.example.com); intake is "live" only with this and the webhook secret. */
  inboundEmailDomain: string | null;
  inboundWebhookSecret: string | null;
  /** Key ring for data at rest (see intake/crypto.ts); null when DATA_ENCRYPTION_KEY is unset. */
  dataEncryptionKey: DataKeyRing | null;
  gmail: GmailConfig;
  sentryDsn: string | null;
  /** Log/audit shipping to an India-region store; null when LOG_SINK_URL is unset. */
  logSink: { url: string; token: string | null } | null;
  runQueueWorker: boolean;
  schedulerTickMs: number;
  monitor: MonitorOptions;
}

export function userAgentFor(publicBaseUrl: string | null): string {
  const host = publicBaseUrl ? new URL(publicBaseUrl).host : 'localhost';
  return `DueSourceMonitor/1.0 (+https://${host}/about-monitoring)`;
}


/** Parses "203.0.113.4, 198.51.100.0/24, 2001:db8::/32"; throws on an invalid entry (fail closed at boot). */
export function parseIpList(v: string | undefined): string[] {
  const items = (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of items) {
    const [addr, bits] = item.split('/');
    const fam = isIP(addr ?? '');
    const max = fam === 4 ? 32 : 128;
    if (!fam || (bits !== undefined && (!/^\d{1,3}$/.test(bits) || Number(bits) > max))) {
      throw new Error(`Invalid environment: ADMIN_ALLOWED_IPS entry "${item}" is not an IP address or CIDR range`);
    }
  }
  return items;
}

export const DEFAULT_MOBILE_APP_ORIGINS = ['capacitor://localhost', 'https://localhost'];

function parseMobileOrigins(v: string | undefined): string[] {
  if (v === undefined) return DEFAULT_MOBILE_APP_ORIGINS;
  return v
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment: ${msg}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const dataKeys = parseDataKeys(e.DATA_ENCRYPTION_KEY);
  const gmail = loadGmailConfig(e);
  const inboundDomain = e.INBOUND_EMAIL_DOMAIN?.trim() ? e.INBOUND_EMAIL_DOMAIN.trim().toLowerCase() : null;
  const inboundSecret = e.INBOUND_WEBHOOK_SECRET?.trim() ? e.INBOUND_WEBHOOK_SECRET.trim() : null;
  // M2: mail content is only ever held encrypted. Production refuses to start rather than store it in clear;
  // elsewhere inbound mail is simply not accepted without a key.
  // H3: synced backups are sealed with it too, so production never runs without it.
  if (isProduction && !dataKeys) {
    const needs = [
      inboundDomain || inboundSecret ? 'inbound email (INBOUND_EMAIL_DOMAIN / INBOUND_WEBHOOK_SECRET)' : null,
      gmail.mode !== 'not_configured' ? 'Gmail' : null,
      'backup and sync',
    ].filter(Boolean);
    throw new Error(`Invalid environment: DATA_ENCRYPTION_KEY is required in production (${needs.join(', ')})`);
  }
  const inboundLive = Boolean(inboundDomain && inboundSecret && dataKeys);
  if (e.LOG_SINK_URL && !/^https:\/\//i.test(e.LOG_SINK_URL) && isProduction) {
    throw new Error('Invalid environment: LOG_SINK_URL must be an https:// URL');
  }
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
    mobileAppOrigins: parseMobileOrigins(e.MOBILE_APP_ORIGINS),
    androidCertFingerprints: (e.ANDROID_SHA256_CERT_FINGERPRINTS ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(s)),
    appleTeamId: /^[A-Z0-9]{10}$/.test((e.APPLE_TEAM_ID ?? '').trim().toUpperCase()) ? e.APPLE_TEAM_ID!.trim().toUpperCase() : null,
    publicBaseUrl: (e.PUBLIC_BASE_URL ?? e.RENDER_EXTERNAL_URL)?.replace(/\/$/, '') ?? null,
    runScheduler: e.RUN_SCHEDULER ?? false,
    smtpUrl: e.SMTP_URL?.trim() ? e.SMTP_URL.trim() : null,
    smtpFrom: e.SMTP_FROM?.trim() ? e.SMTP_FROM.trim() : null,
    trustProxyHops: e.TRUST_PROXY_HOPS ?? (isProduction ? 1 : 0),
    adminAllowedIps: parseIpList(e.ADMIN_ALLOWED_IPS),
    adminDist: e.ADMIN_DIST ?? null,
    appDist: e.APP_DIST ?? null,
    sessionIdleMs: 60 * 60 * 1000,
    sessionMaxMs: 12 * 60 * 60 * 1000,
    adminReauthMs: 10 * 60 * 1000,
    accountSessionIdleMs: 30 * 24 * 60 * 60 * 1000,
    accountSessionMaxMs: 180 * 24 * 60 * 60 * 1000,
    razorpay:
      e.RAZORPAY_KEY_ID?.trim() && e.RAZORPAY_KEY_SECRET?.trim() && e.RAZORPAY_WEBHOOK_SECRET?.trim()
        ? { keyId: e.RAZORPAY_KEY_ID.trim(), keySecret: e.RAZORPAY_KEY_SECRET.trim(), webhookSecret: e.RAZORPAY_WEBHOOK_SECRET.trim() }
        : null,
    billingProvider: e.BILLING_PROVIDER ?? 'razorpay',
    cashfree:
      e.CASHFREE_APP_ID?.trim() && e.CASHFREE_SECRET_KEY?.trim()
        ? {
            appId: e.CASHFREE_APP_ID.trim(),
            secretKey: e.CASHFREE_SECRET_KEY.trim(),
            webhookSecret: e.CASHFREE_WEBHOOK_SECRET?.trim() || e.CASHFREE_SECRET_KEY.trim(),
            env: e.CASHFREE_ENV ?? 'sandbox',
          }
        : null,
    inboundEmailDomain: inboundLive ? inboundDomain : null,
    inboundWebhookSecret: inboundLive ? inboundSecret : null,
    dataEncryptionKey: dataKeys,
    gmail,
    sentryDsn: e.SENTRY_DSN?.trim() ? e.SENTRY_DSN.trim() : null,
    logSink: e.LOG_SINK_URL ? { url: e.LOG_SINK_URL, token: e.LOG_SINK_TOKEN?.trim() || null } : null,
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
