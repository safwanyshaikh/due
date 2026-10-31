import { addMinutes } from '../clock.js';
import { reconcileBilling } from '../consumer/billing-reconcile.js';
import { consentWithdrawn } from '../consumer/consents.js';
import { deleteAccountJob } from '../consumer/deletion.js';
import { deliverReminder, reconcileReminders } from '../consumer/notifications.js';
import { one, withTransaction } from '../db.js';
import { decryptText, encryptText } from '../intake/crypto.js';
import { ingest, MAX_EVENTS_PER_DAY, ownerWhere, runIntakePurge, type Owner } from '../intake/service.js';
import { metrics } from '../observability/metrics.js';
import { PermanentJobError, registerHandler, type JobContext } from './index.js';

/** Minimal forwarded message kept until `inbound.parse` runs (sealed when DATA_ENCRYPTION_KEY is set). */
export interface SealedInbound {
  subject: string | null;
  text: string;
}

export function sealInbound(key: Buffer | null, m: SealedInbound): string {
  const json = JSON.stringify(m);
  return key ? encryptText(key, json) : `plain:${json}`;
}

export function openInbound(key: Buffer | null, stored: string): SealedInbound {
  if (stored.startsWith('plain:')) return JSON.parse(stored.slice(6)) as SealedInbound;
  if (!key) throw new PermanentJobError('encryption_key_missing', 'The message was sealed with DATA_ENCRYPTION_KEY, which is no longer configured');
  return JSON.parse(decryptText(key, stored)) as SealedInbound;
}

interface InboundRow {
  id: string;
  alias_id: string | null;
  account_id: string | null;
  message_id_hash: string | null;
  sender_domain: string | null;
  body: string | null;
  status: string;
}

/** `inbound.parse` { inboundMessageId }: parses the stored message into a review candidate, then wipes the body. */
export async function parseInbound(job: JobContext): Promise<void> {
  const { pool, clock, config } = job.deps;
  const id = String(job.payload.inboundMessageId ?? '');
  const outcome = await withTransaction(pool, async (c) => {
    const m = await one<InboundRow>(c, 'SELECT * FROM inbound_messages WHERE id = $1 FOR UPDATE', [id]);
    if (!m || m.status !== 'received') return 'skipped';
    const now = clock();
    const finish = async (status: string, errorCode: string | null, eventId: string | null = null) => {
      await c.query(
        `UPDATE inbound_messages SET status = $2, error_code = $3, user_event_id = $4, body = NULL, subject = NULL, processed_at = $5 WHERE id = $1`,
        [m.id, status, errorCode, eventId, now],
      );
      return status;
    };
    if (!m.account_id || !m.body) return finish('rejected', 'no_owner');
    if (await consentWithdrawn(c, m.account_id, 'forwarding')) return finish('rejected', 'consent_withdrawn');
    const owner: Owner = { kind: 'account', id: m.account_id };
    const recent = (
      await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_events WHERE ${ownerWhere(owner, 1)} AND created_at > $2`, [owner.id, addMinutes(now, -1440)])
    ).rows[0]!.n;
    if (recent >= MAX_EVENTS_PER_DAY) return finish('rejected', 'quota_exceeded');
    const msg = openInbound(config.dataEncryptionKey, m.body);
    const r = await ingest(
      c,
      {
        owner,
        aliasId: m.alias_id,
        intakeType: 'forwarded_email',
        text: msg.text,
        subject: msg.subject,
        envelopeSenderDomain: m.sender_domain,
        messageIdHash: m.message_id_hash,
      },
      config.dataEncryptionKey,
      now,
    );
    return finish(r.duplicate ? 'duplicate' : 'processed', null, r.event.id);
  });
  metrics.inc('inbound.parse', { outcome });
}

/** `retention.purge`: raw intake text past retention, expired guest sessions, leftover inbound bodies, old queue rows. */
export async function retentionPurge(job: JobContext): Promise<void> {
  const { pool, clock, log } = job.deps;
  const now = clock();
  const intake = await runIntakePurge({ pool, clock });
  const inbound = await pool.query(
    `UPDATE inbound_messages SET body = NULL, subject = NULL, status = CASE WHEN status = 'received' THEN 'failed' ELSE status END,
            error_code = CASE WHEN status = 'received' THEN 'expired_unprocessed' ELSE error_code END
      WHERE body IS NOT NULL AND received_at < $1`,
    [addMinutes(now, -1440)],
  );
  const inboundRows = await pool.query('DELETE FROM inbound_messages WHERE received_at < $1', [addMinutes(now, -30 * 1440)]);
  const jobs = await pool.query(`DELETE FROM jobs_queue WHERE status = 'succeeded' AND finished_at < $1`, [addMinutes(now, -30 * 1440)]);
  const deadJobs = await pool.query(`DELETE FROM jobs_queue WHERE status = 'dead' AND finished_at < $1`, [addMinutes(now, -90 * 1440)]);
  const beats = await pool.query('DELETE FROM queue_heartbeats WHERE beat_at < $1', [addMinutes(now, -1440)]);
  const reconcile = await pool.query('DELETE FROM reminder_reconcile_runs WHERE run_at < $1', [addMinutes(now, -90 * 1440)]);
  const deletions = await pool.query(`DELETE FROM deletion_requests WHERE status = 'completed' AND completed_at < $1`, [addMinutes(now, -90 * 1440)]);
  log.info(
    {
      ...intake,
      inbound_bodies_expired: inbound.rowCount ?? 0,
      inbound_rows_deleted: inboundRows.rowCount ?? 0,
      queue_rows_deleted: (jobs.rowCount ?? 0) + (deadJobs.rowCount ?? 0),
      heartbeats_deleted: beats.rowCount ?? 0,
      reconcile_runs_deleted: reconcile.rowCount ?? 0,
      deletion_requests_deleted: deletions.rowCount ?? 0,
    },
    'retention purge finished',
  );
}

let registered = false;

/** Registers Agent A's job types. Idempotent; called by buildApp and the worker. */
export function registerPlatformHandlers(): void {
  if (registered) return;
  registered = true;
  registerHandler('inbound.parse', parseInbound);
  registerHandler('reminder.deliver', deliverReminder);
  registerHandler('reminder.reconcile', reconcileReminders);
  registerHandler('retention.purge', retentionPurge);
  registerHandler('account.delete', deleteAccountJob);
  registerHandler('billing.reconcile', reconcileBilling);
}
