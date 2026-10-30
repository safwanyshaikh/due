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

const API_CSP = "default-src 'none'; frame-ancestors 'none'";

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
export function registerCsrfGuard(app: FastifyInstance, publicBaseUrl: string | null): void {
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
      const ok = allowed.has(origin) || origin === requestOrigin(req);
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
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (isProduction) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const path = req.url.split('?')[0]!;
    // Admin SPA and the consumer app are both self-contained; API responses get the strict policy.
    reply.header('Content-Security-Policy', path.startsWith('/api') ? API_CSP : ADMIN_CSP);
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
