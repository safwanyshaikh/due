import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Consumer app policy: the admin policy plus exactly what on-device photo text recognition (tesseract.js, served from
 * our own origin under /ocr/) needs: 'wasm-unsafe-eval' so its WebAssembly core can be compiled (this does not allow
 * JavaScript eval), and a same-origin worker (the worker script is loaded by URL, not from a blob).
 */
export const APP_CSP = ADMIN_CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'");

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Policy for a request path: strict API policy, the admin SPA policy, or the consumer app policy. */
export function cspFor(path: string): string {
  if (path === '/api' || path.startsWith('/api/')) return API_CSP;
  if (path === '/admin' || path.startsWith('/admin/')) return ADMIN_CSP;
  return APP_CSP;
}

/** API areas the native app may call cross-origin (all others stay same-origin only). */
const MOBILE_CREDENTIALED_PREFIXES = ['/api/account', '/api/intake', '/api/telemetry'];
const MOBILE_PUBLIC_PREFIXES = ['/api/public', '/api/health'];
/** Public endpoints that take a JSON body (no credentials): offer matching keeps the provider and price out of URLs. */
const MOBILE_PUBLIC_POST = ['/api/public/offers/match'];
const MOBILE_ALLOWED_HEADERS = 'Authorization, Content-Type, X-Requested-With, Accept';

const underPrefix = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/** True when the request's Origin is one of the configured native-app origins. */
export function isMobileOrigin(origin: string | undefined, mobileOrigins: readonly string[]): boolean {
  return origin !== undefined && mobileOrigins.includes(origin);
}

/** The bearer token in `Authorization: Bearer <token>`, or null. */
export function bearerToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== 'string') return null;
  const m = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(h);
  return m ? m[1]! : null;
}

/**
 * CORS for the native app, deliberately narrow: only the configured Capacitor origins, only the consumer
 * API (GET-only for /api/public and /api/health), and never `Access-Control-Allow-Credentials`. The native
 * app authenticates with a bearer token, so no cookie is ever sent or accepted cross-origin. Admin, auth,
 * billing and inbound routes get no CORS headers for any origin.
 */
export function registerMobileCors(app: FastifyInstance, mobileOrigins: readonly string[]): void {
  if (mobileOrigins.length === 0) return;
  const methodsFor = (path: string): string | null =>
    MOBILE_CREDENTIALED_PREFIXES.some((p) => underPrefix(path, p))
      ? 'GET, POST, PUT, PATCH, DELETE'
      : MOBILE_PUBLIC_POST.includes(path)
        ? 'GET, POST'
        : MOBILE_PUBLIC_PREFIXES.some((p) => underPrefix(path, p))
          ? 'GET'
          : null;

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.method !== 'OPTIONS') return;
    const origin = req.headers.origin;
    if (!isMobileOrigin(origin, mobileOrigins)) return;
    const methods = methodsFor(req.url.split('?')[0]!);
    const asked = req.headers['access-control-request-method'];
    if (!methods || typeof asked !== 'string' || !methods.split(', ').includes(asked.toUpperCase())) return;
    return reply
      .code(204)
      .header('Access-Control-Allow-Origin', origin!)
      .header('Access-Control-Allow-Methods', methods)
      .header('Access-Control-Allow-Headers', MOBILE_ALLOWED_HEADERS)
      .header('Access-Control-Max-Age', '600')
      .header('Vary', 'Origin')
      .send();
  });

  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    const origin = req.headers.origin;
    if (!isMobileOrigin(origin, mobileOrigins) || reply.hasHeader('Access-Control-Allow-Origin')) return payload;
    const methods = methodsFor(req.url.split('?')[0]!);
    if (!methods) return payload;
    if (req.method === 'OPTIONS') return payload;
    reply.header('Access-Control-Allow-Origin', origin!);
    reply.header('Vary', 'Origin');
    return payload;
  });
}

function requestOrigin(req: FastifyRequest): string {
  return `${req.protocol}://${req.host}`;
}

/** Path prefix -> required X-Requested-With value for mutating requests. */
const CSRF_PREFIXES: [string, string][] = [
  ['/api/admin', 'due-admin'],
  ['/api/auth', 'due-admin'],
  ['/api/account', 'due-app'],
  ['/api/intake', 'due-app'],
];

/**
 * CSRF guard for /api/auth and /api/admin mutations (X-Requested-With: due-admin) and consumer
 * /api/account + /api/intake mutations (X-Requested-With: due-app). The header
 * (cannot be sent cross-site without a CORS preflight, which we never grant) and, when the
 * browser sends Origin, it must be this server's own origin.
 */
export function registerCsrfGuard(
  app: FastifyInstance,
  publicBaseUrl: string | null,
  mobileOrigins: readonly string[] = [],
): void {
  const allowed = new Set<string>();
  if (publicBaseUrl) allowed.add(new URL(publicBaseUrl).origin);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (!MUTATING.has(req.method)) return;
    const path = req.url.split('?')[0]!;
    const rule = CSRF_PREFIXES.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`));
    if (!rule) return;
    if (req.headers['x-requested-with'] !== rule[1]) {
      throw new AppError(403, 'csrf_rejected', 'Missing or invalid X-Requested-With header');
    }
    const origin = req.headers.origin;
    if (origin !== undefined) {
      // Native-app origins are accepted only on the consumer API (never admin) and are bearer-only: the auth
      // hook ignores cookies for them, so there is no ambient credential for a forged request to ride on.
      const mobileOk = rule[1] === 'due-app' && isMobileOrigin(origin, mobileOrigins);
      const ok = allowed.has(origin) || origin === requestOrigin(req) || mobileOk;
      if (!ok) throw new AppError(403, 'csrf_rejected', 'Cross-origin request rejected');
    }
  });
}

export function registerSecurityHeaders(app: FastifyInstance, isProduction: boolean): void {
  app.addHook('onSend', async (req: FastifyRequest, reply: FastifyReply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    // L7: two years, subdomains, preload-list eligible (submit the domain at hstspreload.org once it is stable).
    if (isProduction) reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    const path = req.url.split('?')[0]!;
    // Admin SPA and the consumer app are both self-contained; API responses get the strict policy.
    // L7: in production pages never load anything over plain HTTP (not in development, which runs on http://localhost).
    const policy = cspFor(path);
    reply.header('Content-Security-Policy', isProduction && !policy.startsWith("default-src 'none'") ? `${policy}; upgrade-insecure-requests` : policy);
    if (path.startsWith('/api/public')) {
      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    }
    const privatePath = ['/api/admin', '/api/auth', '/api/account', '/api/intake', '/api/billing', '/api/inbound'].some((p) => path.startsWith(p));
    if (privatePath && !reply.hasHeader('Cache-Control')) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
}
