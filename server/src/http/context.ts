import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Mailer } from '../alerts.js';
import type { AuditActor } from '../audit.js';
import { hasRole, type Role } from '../auth/roles.js';
import type { AuthUser } from '../auth/sessions.js';
import type { Clock } from '../clock.js';
import type { AppConfig } from '../config.js';
import type { Pool } from '../db.js';
import type { MonitorContext } from '../monitor/engine.js';
import type { MonitorRuntime } from '../monitor/runtime.js';
import { AppError, forbidden, unauthorized } from './errors.js';

export interface AppDeps {
  pool: Pool;
  config: AppConfig;
  clock: Clock;
  mailer: Mailer | null;
  runtime: MonitorRuntime;
  monitor: MonitorContext;
  /** Network access for payment-provider calls; tests inject a mock. Defaults to global fetch (resolved per call). */
  fetchImpl?: typeof fetch;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    user: AuthUser | null;
    sessionIdHash: string | null;
    /** When the admin session last passed a TOTP check. */
    sessionMfaAt: Date | null;
  }
}

export function actorOf(req: FastifyRequest): AuditActor {
  return { userId: req.user?.id ?? null, ip: req.ip ?? null };
}

export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/**
 * preHandler factory: requires a session with at least `role`. Changes that need the admin or owner role
 * (anything but GET/HEAD) also need a fresh second-factor check on this session (see requireFreshMfa).
 */
export function requireRole(role: Role) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const u = currentUser(req);
    if (!hasRole(u.role, role)) throw forbidden();
    if ((role === 'admin' || role === 'owner') && req.method !== 'GET' && req.method !== 'HEAD') assertFreshMfa(req);
  };
}

/** Throws 403 reauth_required unless the session passed a TOTP check within config.adminReauthMs. */
export function assertFreshMfa(req: FastifyRequest): void {
  currentUser(req);
  const { clock, config } = req.server.deps;
  const at = req.sessionMfaAt;
  if (!at || clock().getTime() - at.getTime() > config.adminReauthMs) {
    throw new AppError(403, 'reauth_required', 'Confirm it is you: enter a code from your authenticator app.');
  }
}

/** preHandler: fresh second-factor check (any role). */
export async function requireFreshMfa(req: FastifyRequest): Promise<void> {
  assertFreshMfa(req);
}
