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
import { forbidden, unauthorized } from './errors.js';

export interface AppDeps {
  pool: Pool;
  config: AppConfig;
  clock: Clock;
  mailer: Mailer | null;
  runtime: MonitorRuntime;
  monitor: MonitorContext;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
  interface FastifyRequest {
    user: AuthUser | null;
    sessionIdHash: string | null;
  }
}

export function actorOf(req: FastifyRequest): AuditActor {
  return { userId: req.user?.id ?? null, ip: req.ip ?? null };
}

export function currentUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** preHandler factory: requires a session with at least `role`. */
export function requireRole(role: Role) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const u = currentUser(req);
    if (!hasRole(u.role, role)) throw forbidden();
  };
}
