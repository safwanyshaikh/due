import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db.js';
import { one, withTransaction } from '../db.js';
import { revokeAllForAccount } from '../gmail/service.js';
import { AppError, notFound, parse } from '../http/errors.js';
import { metrics } from '../observability/metrics.js';
import { enqueue, PermanentJobError, type JobContext } from '../queue/index.js';
import { hmacSha256, randomToken, safeEqual } from '../util.js';
import { consumerAudit } from './context.js';

/**
 * Asynchronous account deletion. DELETE /api/account disables the account and its sessions immediately, records a
 * deletion request and enqueues `account.delete`; the job removes data step by step and records progress, which
 * GET /api/account/deletion-status reports (with the status token returned at request time, since the session ends).
 */

export const DELETION_STEPS = [
  'sessions',
  'households',
  'forwarding_aliases',
  'inbound_messages',
  'intake_events',
  'gmail_and_identities',
  'reminders_and_notifications',
  'sign_in_links_and_invites',
  'audit_trail',
  'account_record',
] as const;
export type DeletionStep = (typeof DELETION_STEPS)[number];

/** Records that are kept after deletion, and why (shown to the person). */
export const RETENTION_EXCEPTIONS = [
  {
    record: 'Payment and invoice records (Razorpay subscription ids, plan, amounts, dates)',
    reason: 'Kept for 8 years where tax and accounting law requires it (GST / Companies Act); unlinked from your email and account.',
  },
  {
    record: 'A deletion tombstone (account id and date, no personal data)',
    reason: 'Lets operators prove the deletion happened.',
  },
  {
    record: 'Encrypted database backups',
    reason: 'Expire on the backup retention schedule (at most 30 days); deleted data is not restored into the live service.',
  },
];

export function hashStatusToken(secret: string, token: string): string {
  return hmacSha256(secret, `deletion-status:${token}`);
}

interface RequestRow {
  id: string;
  account_id: string | null;
  status_token_hash: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  steps: { step: DeletionStep; doneAt: string }[];
  job_id: string | null;
  requested_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  error_code: string | null;
}

/** Creates the request, disables the account and its sessions, and enqueues the job (inside the caller's transaction). */
export async function requestDeletion(
  c: Queryable,
  secret: string,
  accountId: string,
  now: Date,
  correlationId: string | null,
): Promise<{ requestId: string; statusToken: string; jobId: string }> {
  const token = randomToken(24);
  const req = (await one<{ id: string }>(
    c,
    `INSERT INTO deletion_requests (account_id, status_token_hash, status, requested_at) VALUES ($1,$2,'queued',$3) RETURNING id`,
    [accountId, hashStatusToken(secret, token), now],
  ))!;
  await c.query(`UPDATE consumer_accounts SET status = 'deleting' WHERE id = $1`, [accountId]);
  await c.query('UPDATE consumer_sessions SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL', [accountId, now]);
  const job = await enqueue(c, {
    type: 'account.delete',
    payload: { requestId: req.id },
    accountId,
    idempotencyKey: `account.delete:${req.id}`,
    maxAttempts: 8,
    correlationId,
    now,
  });
  await c.query('UPDATE deletion_requests SET job_id = $2 WHERE id = $1', [req.id, job.id]);
  await consumerAudit(c, accountId, 'account.deletion_requested', 'account', accountId, null, { requestId: req.id }, now);
  return { requestId: req.id, statusToken: token, jobId: job.id };
}

async function runStep(q: Queryable, step: DeletionStep, accountId: string, email: string, now: Date): Promise<void> {
  switch (step) {
    case 'sessions':
      await q.query('DELETE FROM consumer_sessions WHERE account_id = $1', [accountId]);
      return;
    case 'households':
      await q.query('DELETE FROM households WHERE owner_account_id = $1', [accountId]);
      await q.query('DELETE FROM household_members WHERE account_id = $1', [accountId]);
      return;
    case 'forwarding_aliases':
      // Aliases become tombstones (never re-issued).
      await q.query(`UPDATE intake_aliases SET status = 'rotated', account_id = NULL, updated_at = $2 WHERE account_id = $1`, [accountId, now]);
      return;
    case 'inbound_messages':
      await q.query('DELETE FROM inbound_messages WHERE account_id = $1', [accountId]);
      return;
    case 'intake_events':
      await q.query('DELETE FROM offer_matches WHERE account_id = $1', [accountId]);
      await q.query('DELETE FROM user_events WHERE account_id = $1', [accountId]);
      return;
    case 'gmail_and_identities':
      // Tokens were revoked just before this step; deleting identities removes connections and seen-message records.
      await q.query('DELETE FROM email_identities WHERE account_id = $1', [accountId]);
      return;
    case 'reminders_and_notifications':
      await q.query('DELETE FROM reminder_deliveries WHERE account_id = $1', [accountId]);
      await q.query('DELETE FROM reminder_schedule WHERE account_id = $1', [accountId]);
      await q.query('DELETE FROM notification_preferences WHERE account_id = $1', [accountId]);
      await q.query('DELETE FROM upload_counters WHERE account_id = $1', [accountId]);
      return;
    case 'sign_in_links_and_invites':
      await q.query('DELETE FROM magic_links WHERE email = $1', [email]);
      await q.query('DELETE FROM household_invites WHERE email = $1', [email]);
      return;
    case 'audit_trail':
      await q.query('DELETE FROM consumer_audit WHERE account_id = $1', [accountId]);
      await q.query('DELETE FROM consent_records WHERE account_id = $1', [accountId]);
      return;
    case 'account_record':
      await q.query('DELETE FROM consumer_accounts WHERE id = $1', [accountId]);
      // Queue rows keep no link to the deleted account (payloads only ever held ids).
      await q.query('UPDATE jobs_queue SET account_id = NULL WHERE account_id = $1', [accountId]);
      return;
  }
}

/** Handler for `account.delete` { requestId }. Each step commits on its own, so a retry resumes where it stopped. */
export async function deleteAccountJob(job: JobContext): Promise<void> {
  const { pool, clock } = job.deps;
  const requestId = String(job.payload.requestId ?? '');
  const req = await one<RequestRow>(pool, 'SELECT * FROM deletion_requests WHERE id = $1', [requestId]);
  if (!req) throw new PermanentJobError('deletion_request_missing', 'Deletion request not found');
  if (req.status === 'completed') return;
  const accountId = req.account_id;
  await pool.query(`UPDATE deletion_requests SET status = 'running', started_at = COALESCE(started_at, $2), error_code = NULL WHERE id = $1`, [requestId, clock()]);
  const acct = accountId ? await one<{ email: string }>(pool, 'SELECT email FROM consumer_accounts WHERE id = $1', [accountId]) : null;
  const done = new Set(req.steps.map((s) => s.step));
  try {
    for (const step of DELETION_STEPS) {
      if (done.has(step)) continue;
      if (acct && accountId) {
        if (step === 'gmail_and_identities') {
          // Revoke Google tokens (and stop future reads) before the identity rows go.
          await revokeAllForAccount({ pool, config: job.deps.config, clock, log: job.log }, accountId);
        }
        await withTransaction(pool, async (c) => {
          await runStep(c, step, accountId, acct.email, clock());
          await c.query(`UPDATE deletion_requests SET steps = steps || $2::jsonb WHERE id = $1`, [requestId, JSON.stringify([{ step, doneAt: clock().toISOString() }])]);
        });
      } else {
        // The account row is already gone (an earlier attempt finished it): record the remaining steps as done.
        await pool.query(`UPDATE deletion_requests SET steps = steps || $2::jsonb WHERE id = $1`, [requestId, JSON.stringify([{ step, doneAt: clock().toISOString() }])]);
      }
    }
  } catch (err) {
    await pool.query(`UPDATE deletion_requests SET error_code = $2 WHERE id = $1`, [requestId, (err as { code?: string }).code ?? 'step_failed']);
    if (job.attempt >= job.maxAttempts) await pool.query(`UPDATE deletion_requests SET status = 'failed' WHERE id = $1`, [requestId]);
    throw err;
  }
  const now = clock();
  await withTransaction(pool, async (c) => {
    await c.query(`UPDATE deletion_requests SET status = 'completed', completed_at = $2, account_id = NULL WHERE id = $1`, [requestId, now]);
    // Tombstone without personal data so operators can see a deletion happened.
    await consumerAudit(c, null, 'account.deleted', 'account', accountId, null, { requestId }, now);
  });
  metrics.inc('account.deleted');
}

export function deletionView(r: RequestRow) {
  const done = new Set(r.steps.map((s) => s.step));
  return {
    requestId: r.id,
    status: r.status,
    progress: Math.round((done.size / DELETION_STEPS.length) * 100),
    steps: DELETION_STEPS.map((step) => ({ step, done: done.has(step), doneAt: r.steps.find((s) => s.step === step)?.doneAt ?? null })),
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    errorCode: r.error_code,
    retentionExceptions: RETENTION_EXCEPTIONS,
  };
}

/** GET /api/account/deletion-status: by ?requestId=&token= (works after the session ended) or for the signed-in account. */
export async function deletionRoutes(app: FastifyInstance): Promise<void> {
  const { pool, config } = app.deps;
  app.get('/api/account/deletion-status', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const q = parse(z.object({ requestId: z.string().uuid().optional(), token: z.string().min(16).max(200).optional() }), req.query);
    let row: RequestRow | null;
    if (q.requestId && q.token) {
      row = await one<RequestRow>(pool, 'SELECT * FROM deletion_requests WHERE id = $1', [q.requestId]);
      if (row && !safeEqual(row.status_token_hash, hashStatusToken(config.sessionSecret, q.token))) row = null;
      if (!row) throw notFound('Deletion request not found');
    } else if (req.account) {
      row = await one<RequestRow>(pool, 'SELECT * FROM deletion_requests WHERE account_id = $1 ORDER BY requested_at DESC LIMIT 1', [req.account.id]);
      if (!row) return { requestId: null, status: 'none', progress: 0, steps: [], retentionExceptions: RETENTION_EXCEPTIONS };
    } else {
      throw new AppError(401, 'unauthorized', 'Sign in, or pass the requestId and token returned when deletion was requested');
    }
    return deletionView(row);
  });
}
