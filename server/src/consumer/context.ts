import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Queryable } from '../db.js';
import { AppError } from '../http/errors.js';
import { computeEntitlement, type Entitlement, type Feature } from './entitlements.js';
import type { ConsumerAccount } from './sessions.js';

declare module 'fastify' {
  interface FastifyRequest {
    account: ConsumerAccount | null;
    accountSessionHash: string | null;
    accountSessionPublicId: string | null;
    /** Raw JSON request body text (used for webhook signature verification). */
    rawBody: string | null;
    entitlement: Entitlement | null;
  }
}

export const accountRequired = () => new AppError(401, 'unauthorized', 'Sign in to use this feature');

export function currentAccount(req: FastifyRequest): ConsumerAccount {
  if (!req.account) throw accountRequired();
  return req.account;
}

export async function entitlementOf(req: FastifyRequest): Promise<Entitlement> {
  if (req.entitlement) return req.entitlement;
  const acct = currentAccount(req);
  req.entitlement = await computeEntitlement(req.server.deps.pool, acct.id, req.server.deps.clock());
  return req.entitlement;
}

export const premiumRequired = (feature: Feature) =>
  new AppError(402, 'premium_required', 'This feature needs a premium plan', { feature });

/** preHandler factory: requires a signed-in account whose server-side entitlement includes `feature`. */
export function requireFeature(feature: Feature) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const ent = await entitlementOf(req);
    if (!ent.features.includes(feature)) throw premiumRequired(feature);
  };
}

/** preHandler: requires a signed-in consumer account. */
export async function requireAccount(req: FastifyRequest): Promise<void> {
  currentAccount(req);
}

export async function consumerAudit(
  q: Queryable,
  accountId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
  at: Date,
): Promise<void> {
  await q.query(
    `INSERT INTO consumer_audit (account_id, action, entity, entity_id, before, after, at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      accountId,
      action,
      entity,
      entityId,
      before === null || before === undefined ? null : JSON.stringify(before),
      after === null || after === undefined ? null : JSON.stringify(after),
      at,
    ],
  );
}
