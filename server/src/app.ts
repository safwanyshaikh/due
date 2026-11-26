import { requestPath } from './http/paths.js';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Mailer } from './alerts.js';
import { resolveSession } from './auth/sessions.js';
import { cookieName } from './http/cookies.js';
import { BlockList, isIP } from 'node:net';
import { systemClock, type Clock } from './clock.js';
import type { AppConfig } from './config.js';
import type { Pool } from './db.js';
import type { AppDeps } from './http/context.js';
import { AppError } from './http/errors.js';
import { wellKnownRoutes } from './routes/wellKnown.js';
import { bearerToken, isMobileOrigin, registerCsrfGuard, registerMobileCors, registerSecurityHeaders } from './http/security.js';
import type { MonitorContext } from './monitor/engine.js';
import { MonitorRuntime } from './monitor/runtime.js';
import { SERVER_ROOT } from './paths.js';
import { resolveAccountSession } from './consumer/sessions.js';
import { accountRoutes } from './routes/account.js';
import { adminRoutes } from './routes/admin/index.js';
import { billingRoutes } from './routes/billing.js';
import { householdRoutes } from './routes/household.js';
import { inboundRoutes } from './routes/inbound.js';
import { gmailRoutes } from './routes/gmail.js';
import { identitiesRoutes } from './routes/identities.js';
import { intakeRoutes } from './routes/intake.js';
import { resolveTempSession } from './intake/service.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { authRoutes } from './routes/auth.js';
import { publicRoutes } from './routes/public.js';
import { savingsPublicRoutes } from './routes/savings.js';
import { deletionRoutes } from './consumer/deletion.js';
import { nominationRoutes } from './consumer/nomination.js';
import { notificationRoutes } from './consumer/notifications.js';
import { uploadRoutes } from './consumer/uploads.js';
import { healthRoutes } from './health/index.js';
import { legalRoutes } from './legal/index.js';
import { enterCorrelation, requestIdFrom } from './observability/context.js';
import { configureErrorReporter, errorReporter } from './observability/errorReporter.js';
import { metrics } from './observability/metrics.js';
import { baseLoggerOptions } from './observability/logging.js';
import { LogSink } from './observability/logSink.js';
import pino from 'pino';
import { registerPlatformHandlers } from './queue/handlers.js';
import { registerOfferHandlers } from './monitor/handlers.js';
import type { WorkerDeps } from './queue/index.js';

export interface BuildAppOptions {
  pool: Pool;
  config: AppConfig;
  clock?: Clock;
  mailer?: Mailer | null;
  runtime?: MonitorRuntime;
  /** Test hook: network access for payment-provider calls. */
  fetchImpl?: typeof fetch;
  logger?: FastifyServerOptions['logger'];
  /** Test hook: receives every registered route. */
  onRoute?: (route: { method: string | string[]; url: string }) => void;
}

/**
 * Query parameters that carry bearer secrets: magic-link tokens (`/api/account/verify?token=` and the app's
 * confirmation screen `/?account=confirm&token=`), household-invite tokens (`?household_invite=`), and the Google
 * OAuth authorization code and state on `/api/account/gmail/callback?code=&state=`; plus the provider, plan and price
 * of the legacy GET offer match (M5: what someone pays for is personal).
 */
const SECRET_QUERY = /([?&](?:token|household_invite|code|state|provider|price|planCode|serviceType)=)[^&#]*/gi;

/** Request URL as logged: secret query values are replaced so log readers cannot reuse them. */
export function redactUrl(url: string): string {
  return url.replace(SECRET_QUERY, '$1[redacted]');
}

/** Production logger: no cookies/auth headers, and no bearer tokens from query strings. */
export function loggerOptions(isProduction: boolean) {
  const base = baseLoggerOptions(isProduction);
  return {
    ...base,
    serializers: {
      ...base.serializers,
      req: (req: { method: string; url: string; host?: string; ip?: string }) => ({
        method: req.method,
        url: redactUrl(req.url),
        host: req.host,
        remoteAddress: req.ip,
      }),
    },
  };
}

/** Adds LOG_SINK_URL shipping (redacted lines, India-region store) next to stdout when configured. */
export function withLogSink<T extends object>(options: T, config: AppConfig, service: string): T | (T & { stream: pino.MultiStreamRes }) {
  if (!config.logSink) return options;
  const sink = new LogSink({ url: config.logSink.url, token: config.logSink.token, service });
  return { ...options, stream: pino.multistream([{ stream: process.stdout }, { stream: sink }]) };
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const { config, pool } = opts;
  const clock = opts.clock ?? systemClock;
  const app = Fastify({
    logger: opts.logger ?? withLogSink(loggerOptions(config.isProduction), config, 'due'),
    bodyLimit: 256 * 1024,
    // Trust exactly the platform proxy hop(s); X-Forwarded-For entries to the left of them are ignored.
    // (Hop i = 0 is the socket peer; with 1 hop, the client IP is the entry the platform proxy appended.)
    trustProxy: config.trustProxyHops > 0 ? trustHops(config.trustProxyHops) : false,
    routerOptions: { ignoreTrailingSlash: true },
    // Correlation id: a caller's x-request-id is reused only when it is a short opaque token.
    genReqId: (req) => requestIdFrom(req.headers['x-request-id']),
    requestIdLogLabel: 'requestId',
  });
  registerClientIp(app, config);
  if (config.sentryDsn && !errorReporter().configured) configureErrorReporter(config.sentryDsn, config.env);
  registerPlatformHandlers();
  registerOfferHandlers();

  app.addHook('onRequest', async (req, reply) => {
    enterCorrelation(req.id);
    reply.header('x-request-id', req.id);
  });
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    metrics.inc('http.requests', { status: `${Math.floor(reply.statusCode / 100)}xx` });
    metrics.timing('http.request_ms', reply.elapsedTime, { route: route.startsWith('/api/') || route.startsWith('/health') ? route : 'static' });
  });

  const runtime = opts.runtime ?? new MonitorRuntime(config.monitor);
  const monitor: MonitorContext = { pool, clock, mailer: opts.mailer ?? null, runtime, log: app.log };
  const deps: AppDeps = { pool, config, clock, mailer: opts.mailer ?? null, runtime, monitor, fetchImpl: opts.fetchImpl };
  app.decorate('deps', deps);
  if (opts.onRoute) {
    const cb = opts.onRoute;
    app.addHook('onRoute', (r) => cb({ method: r.method, url: r.url }));
  }
  app.decorateRequest('user', null);
  app.decorateRequest('sessionIdHash', null);
  app.decorateRequest('sessionMfaAt', null);
  app.decorateRequest('account', null);
  app.decorateRequest('accountSessionHash', null);
  app.decorateRequest('accountSessionPublicId', null);
  app.decorateRequest('accountSessionCreatedAt', null);
  app.decorateRequest('rawBody', null);
  app.decorateRequest('entitlement', null);
  app.decorateRequest('intakeSession', null);

  // Accept an empty body on JSON requests (e.g. "Run now" buttons); reject malformed JSON with 400.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    // Kept for webhook signature verification (HMAC over the exact bytes received).
    req.rawBody = text;
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = Object.assign(new Error('Malformed JSON body'), { statusCode: 400 });
      done(err, undefined);
    }
  });
  await app.register(cookie);
  // Coarse per-IP flood protection; the login limiter (per IP+email) lives in the login route.
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

  registerSecurityHeaders(app, config.isProduction);
  registerMobileCors(app, config.mobileAppOrigins);
  registerCsrfGuard(app, config.publicBaseUrl, config.mobileAppOrigins);

  // Optional IP allowlist for the admin console and admin API (ADMIN_ALLOWED_IPS). Others get a plain 404.
  const adminAllow = adminAllowList(config.adminAllowedIps);
  if (adminAllow) {
    app.addHook('onRequest', async (req, reply) => {
      const path = requestPath(req);
      if (!isAdminPath(path)) return;
      if (!ipAllowed(adminAllow, req.ip)) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
      }
    });
  }

  const adminCookie = cookieName('due_session', config.isProduction);
  const accountCookie = cookieName('due_acct', config.isProduction);
  const intakeCookie = cookieName('due_intake', config.isProduction);
  app.addHook('onRequest', async (req) => {
    const path = requestPath(req);
    if (!path.startsWith('/api/admin') && !path.startsWith('/api/auth')) return;
    const token = req.cookies[adminCookie];
    if (!token || token.length > 200) return;
    const s = await resolveSession(
      pool,
      { secret: config.sessionSecret, idleMs: config.sessionIdleMs, maxMs: config.sessionMaxMs },
      token,
      clock(),
    );
    if (s) {
      req.user = s.user;
      req.sessionIdHash = s.idHash;
      req.sessionMfaAt = s.mfaAt;
    }
  });

  // Consumer accounts (due_acct cookie) for /api/account, /api/intake and /api/telemetry.
  app.addHook('onRequest', async (req) => {
    const path = requestPath(req);
    if (!path.startsWith('/api/account') && !path.startsWith('/api/intake') && !path.startsWith('/api/telemetry')) return;
    // The native app (Capacitor origin) authenticates with a bearer token only: cookies are never read for it.
    const mobile = isMobileOrigin(req.headers.origin, config.mobileAppOrigins);
    const intakeToken = mobile ? undefined : req.cookies[intakeCookie];
    if (intakeToken && intakeToken.length <= 200 && !path.startsWith('/api/telemetry')) {
      req.intakeSession = await resolveTempSession(pool, config.sessionSecret, intakeToken, clock());
    }
    const token = mobile ? bearerToken(req) : req.cookies[accountCookie];
    if (!token || token.length > 200) return;
    const s = await resolveAccountSession(
      pool,
      { secret: config.sessionSecret, idleMs: config.accountSessionIdleMs, maxMs: config.accountSessionMaxMs },
      token,
      clock(),
    );
    if (s) {
      req.account = s.account;
      req.accountSessionHash = s.idHash;
      req.accountSessionPublicId = s.publicId;
      req.accountSessionCreatedAt = s.createdAt;
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const e = err as { statusCode?: number; code?: string; message: string; validation?: unknown };
    const status = e.statusCode && e.statusCode >= 400 && e.statusCode < 600 ? e.statusCode : 500;
    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      metrics.inc('http.errors_5xx');
      void errorReporter().capture(err, { correlation_id: req.id, route: req.routeOptions?.url ?? 'unmatched', method: req.method });
    }
    const code =
      status === 429 ? 'rate_limited' : status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : status >= 500 ? 'internal_error' : 'bad_request';
    return reply.code(status).send({ error: { code, message: status >= 500 ? 'Internal server error' : e.message } });
  });

  await app.register(wellKnownRoutes);
  await app.register(healthRoutes);
  await app.register(legalRoutes);
  await app.register(authRoutes);
  await app.register(publicRoutes);
  await app.register(savingsPublicRoutes);
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(accountRoutes);
  await app.register(householdRoutes);
  await app.register(billingRoutes);
  await app.register(telemetryRoutes);
  await app.register(intakeRoutes);
  await app.register(inboundRoutes);
  await app.register(notificationRoutes);
  await app.register(deletionRoutes);
  await app.register(nominationRoutes);
  await app.register(uploadRoutes);
  await app.register(identitiesRoutes);
  await app.register(gmailRoutes);

  const adminDist = config.adminDist ?? resolve(SERVER_ROOT, '../admin/dist');
  if (existsSync(resolve(adminDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: adminDist, prefix: '/admin/', index: ['index.html'], wildcard: true });
    app.log.info({ adminDist }, 'serving admin SPA');
  }

  // Consumer PWA (root build output) is served from the same origin, so it can call /api without CORS.
  const appDist = config.appDist ?? resolve(SERVER_ROOT, '../dist');
  const hasApp = existsSync(resolve(appDist, 'index.html'));
  if (hasApp) {
    await app.register(fastifyStatic, {
      root: appDist,
      prefix: '/',
      index: ['index.html'],
      wildcard: false,
      decorateReply: false,
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('sw.js') || filePath.endsWith('index.html')) res.header('Cache-Control', 'no-cache');
      },
    });
    app.log.info({ appDist }, 'serving consumer app');
  }

  app.setNotFoundHandler((req, reply) => {
    const path = requestPath(req);
    if (req.method === 'GET' && (path === '/admin' || path.startsWith('/admin/')) && existsSync(resolve(adminDist, 'index.html'))) {
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html', adminDist);
    }
    if (req.method === 'GET' && hasApp && !path.startsWith('/api')) {
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html', appDist);
    }
    return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
  });

  return app;
}

/**
 * M-F: evidence for TRUST_PROXY_HOPS. In production the first 20 requests after start log how many
 * X-Forwarded-For entries arrived (a count only, never addresses), so the hop setting can be checked against
 * the real proxy chain (docs/production/SECURITY.md, "Client IP"). With CLIENT_IP_HEADER set, a valid IP in that
 * header is the client IP; the hop derivation is used when it is missing or invalid.
 */
function registerClientIp(app: FastifyInstance, config: AppConfig): void {
  let observed = 0;
  app.addHook('onRequest', async (req) => {
    if (config.clientIpHeader) {
      const v = req.headers[config.clientIpHeader];
      const ip = typeof v === 'string' ? v.trim() : '';
      if (isIP(ip)) Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    }
    if (config.isProduction && observed < 20) {
      observed++;
      const xff = req.headers['x-forwarded-for'];
      const entries = typeof xff === 'string' ? xff.split(',').filter((x) => x.trim()).length : 0;
      req.log.info(
        { proxyChain: { xffEntries: entries, trustProxyHops: config.trustProxyHops, clientIpHeader: config.clientIpHeader, headerPresent: config.clientIpHeader ? Boolean(req.headers[config.clientIpHeader]) : null } },
        'proxy chain observed',
      );
    }
  });
}

/** proxy-addr trust function: the socket peer and the next hops-1 entries are proxies; everything left is not. */
export function trustHops(hops: number): (addr: string, i: number) => boolean {
  return (_addr, i) => i < hops;
}

function isAdminPath(path: string): boolean {
  const p = path.toLowerCase();
  return p === '/admin' || p.startsWith('/admin/') || p.startsWith('/api/admin') || p.startsWith('/api/auth');
}

function adminAllowList(entries: string[]): BlockList | null {
  if (!entries.length) return null;
  const list = new BlockList();
  for (const e of entries) {
    const [addr, bits] = e.split('/');
    const type = isIP(addr!) === 6 ? 'ipv6' : 'ipv4';
    if (bits === undefined) list.addAddress(addr!, type);
    else list.addSubnet(addr!, Number(bits), type);
  }
  return list;
}

function ipAllowed(list: BlockList, ip: string | undefined): boolean {
  if (!ip) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const addr = mapped ? mapped[1]! : ip;
  const fam = isIP(addr);
  if (!fam) return false;
  return list.check(addr, fam === 6 ? 'ipv6' : 'ipv4');
}

/** Dependencies for queue handlers, taken from a built app (tests and the in-process worker). */
export function workerDepsOf(app: FastifyInstance): WorkerDeps {
  const d = app.deps;
  return { pool: d.pool, config: d.config, clock: d.clock, mailer: d.mailer, log: app.log };
}
