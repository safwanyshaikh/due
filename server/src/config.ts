import { z } from 'zod';

const boolish = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const EnvSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(10000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  ADMIN_SETUP_TOKEN: z.string().optional(),
  PUBLIC_APP_ORIGIN: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  /** Set automatically by Render; used when PUBLIC_BASE_URL is not given. */
  RENDER_EXTERNAL_URL: z.string().url().optional(),
  RUN_SCHEDULER: boolish,
  SMTP_URL: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  TRUST_PROXY: boolish,
  ADMIN_DIST: z.string().optional(),
  APP_DIST: z.string().optional(),
});

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
  schedulerTickMs: number;
  monitor: MonitorOptions;
}

export function userAgentFor(publicBaseUrl: string | null): string {
  const host = publicBaseUrl ? new URL(publicBaseUrl).host : 'localhost';
  return `DueSourceMonitor/1.0 (+https://${host}/about-monitoring)`;
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
