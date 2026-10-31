import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../db.js';
import { one } from '../db.js';
import { AppError } from '../http/errors.js';
import { consumerAudit, currentAccount, entitlementOf, requireAccount } from './context.js';

/** Free and guest document uploads per calendar month (Asia/Kolkata); Plus is unlimited. */
export const FREE_UPLOADS_PER_MONTH = 5;

export function uploadMonth(now: Date): string {
  // Months roll over at midnight India time.
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 7);
}

/** First instant of the current upload month (midnight Asia/Kolkata on the 1st). */
export function uploadMonthStart(now: Date): Date {
  return new Date(`${uploadMonth(now)}-01T00:00:00+05:30`);
}

export const uploadLimitReached = (month: string) =>
  new AppError(402, 'premium_required', `Free and guest use includes ${FREE_UPLOADS_PER_MONTH} document uploads a month. Plus has unlimited uploads; pasting text and manual entry stay free.`, {
    feature: 'document_upload',
    limit: FREE_UPLOADS_PER_MONTH,
    used: FREE_UPLOADS_PER_MONTH,
    month,
  });

/**
 * Counts one document upload for an account (conditional increment: concurrent requests can never push a Free
 * account past the limit). Returns the new count, or null when a Free account has used its monthly allowance.
 */
export async function takeAccountUpload(q: Queryable, accountId: string, unlimited: boolean, now: Date): Promise<number | null> {
  const r = await one<{ count: number }>(
    q,
    `INSERT INTO upload_counters (account_id, month, count, updated_at) VALUES ($1,$2,1,$3)
     ON CONFLICT (account_id, month) DO UPDATE SET count = upload_counters.count + 1, updated_at = EXCLUDED.updated_at
       WHERE $4 OR upload_counters.count < $5
     RETURNING count`,
    [accountId, uploadMonth(now), now, unlimited, FREE_UPLOADS_PER_MONTH],
  );
  return r?.count ?? null;
}

/**
 * Guest (temporary intake session) allowance: documents submitted by the session this month. Locks the session row
 * so concurrent submissions are serialised; call inside the transaction that inserts the document.
 */
export async function guestUploadsUsed(q: Queryable, tempSessionId: string, now: Date): Promise<number> {
  await q.query('SELECT id FROM intake_temp_sessions WHERE id = $1 FOR UPDATE', [tempSessionId]);
  const r = await one<{ n: number }>(
    q,
    `SELECT count(*)::int AS n FROM user_events WHERE temp_session_id = $1 AND intake_type = 'document' AND created_at >= $2`,
    [tempSessionId, uploadMonthStart(now)],
  );
  return r?.n ?? 0;
}

export async function uploadsUsed(q: Queryable, accountId: string, now: Date): Promise<number> {
  const r = await one<{ count: number }>(q, 'SELECT count FROM upload_counters WHERE account_id = $1 AND month = $2', [accountId, uploadMonth(now)]);
  return r?.count ?? 0;
}

/**
 * GET returns this month's usage; POST counts one upload before the client processes a document and answers
 * 402 premium_required once a Free account has used its monthly allowance.
 */
export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const view = (used: number, unlimited: boolean, now: Date) => ({
    month: uploadMonth(now),
    used,
    limit: unlimited ? null : FREE_UPLOADS_PER_MONTH,
    remaining: unlimited ? null : Math.max(0, FREE_UPLOADS_PER_MONTH - used),
    unlimited,
  });

  app.get('/api/account/uploads/count', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const now = clock();
    const ent = await entitlementOf(req);
    return view(await uploadsUsed(pool, a.id, now), ent.plan !== 'free', now);
  });

  app.post('/api/account/uploads/count', { preHandler: requireAccount, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const a = currentAccount(req);
    const now = clock();
    const ent = await entitlementOf(req);
    const unlimited = ent.plan !== 'free';
    const month = uploadMonth(now);
    const count = await takeAccountUpload(pool, a.id, unlimited, now);
    if (count === null) throw uploadLimitReached(month);
    const r = { count };
    await consumerAudit(pool, a.id, 'uploads.counted', 'upload_counters', month, null, { count: r.count }, now);
    return view(r.count, unlimited, now);
  });
}
