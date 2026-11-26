import { addMinutes } from '../clock.js';
import { reconcileBilling } from '../consumer/billing-reconcile.js';
import { hasConsent } from '../consumer/consents.js';
import { deleteAccountJob } from '../consumer/deletion.js';
import { deliverReminder, reconcileReminders } from '../consumer/notifications.js';
import { one, withTransaction } from '../db.js';
import { decryptText, encryptText, type DataKeyRing } from '../intake/crypto.js';
import { ingest, MAX_EVENTS_PER_DAY, ownerWhere, runIntakePurge, type Owner } from '../intake/service.js';
import { metrics } from '../observability/metrics.js';
import { shipAuditRows, shippedCursor } from '../observability/auditShip.js';
import { purgeOfferInbox } from '../offerinbox/service.js';
import { enqueue, PermanentJobError, registerHandler, type JobContext } from './index.js';
import { readVersionedDoc } from '../routes/account.js';

/** Minimal forwarded message kept until `inbound.parse` runs (always sealed with DATA_ENCRYPTION_KEY). */
export interface SealedInbound {
  subject: string | null;
  text: string;
}

export function sealInbound(key: DataKeyRing | null, m: SealedInbound, inboundId: string): string {
  // There is no plain-text fallback: inbound mail is not accepted without a key (see config.ts).
  if (!key) throw new Error('DATA_ENCRYPTION_KEY is required to hold inbound mail');
  return encryptText(key, JSON.stringify(m), `inbound_messages:${inboundId}`);
}

export function openInbound(key: DataKeyRing | null, stored: string, inboundId: string): SealedInbound {
  // Rows written before the plain-text writer was removed (wiped within 24 h anyway).
  if (stored.startsWith('plain:')) return JSON.parse(stored.slice(6)) as SealedInbound;
  if (!key) throw new PermanentJobError('encryption_key_missing', 'The message was sealed with DATA_ENCRYPTION_KEY, which is no longer configured');
  return JSON.parse(decryptText(key, stored, `inbound_messages:${inboundId}`)) as SealedInbound;
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
    if (!(await hasConsent(c, m.account_id, 'forwarding'))) return finish('rejected', 'consent_withdrawn');
    const owner: Owner = { kind: 'account', id: m.account_id };
    const recent = (
      await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_events WHERE ${ownerWhere(owner, 1)} AND created_at > $2`, [owner.id, addMinutes(now, -1440)])
    ).rows[0]!.n;
    if (recent >= MAX_EVENTS_PER_DAY) return finish('rejected', 'quota_exceeded');
    const msg = openInbound(config.dataEncryptionKey, m.body, m.id);
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
  const offerInbox = await purgeOfferInbox(pool, now);
  const jobs = await pool.query(`DELETE FROM jobs_queue WHERE status = 'succeeded' AND finished_at < $1`, [addMinutes(now, -30 * 1440)]);
  const deadJobs = await pool.query(`DELETE FROM jobs_queue WHERE status = 'dead' AND finished_at < $1`, [addMinutes(now, -90 * 1440)]);
  const beats = await pool.query('DELETE FROM queue_heartbeats WHERE beat_at < $1', [addMinutes(now, -1440)]);
  await pool.query('DELETE FROM webhook_replay_tokens WHERE seen_at < $1', [addMinutes(now, -1440)]);
  const reconcile = await pool.query('DELETE FROM reminder_reconcile_runs WHERE run_at < $1', [addMinutes(now, -90 * 1440)]);
  const deletions = await pool.query(`DELETE FROM deletion_requests WHERE status = 'completed' AND completed_at < $1`, [addMinutes(now, -90 * 1440)]);
  // H4: audit trails are kept for a year (and shipped to the India-region store), then removed (minimisation).
  const auditCutoff = addMinutes(now, -AUDIT_RETENTION_DAYS * 1440);
  // With a log sink, only rows already shipped are purged (a sink outage never loses audit history).
  const shipped = job.deps.config.logSink ? await shippedCursor(pool) : null;
  const upTo = (t: string) => (shipped ? Number(shipped[t] ?? 0) : Number.MAX_SAFE_INTEGER);
  const audit = await pool.query('DELETE FROM audit_log WHERE at < $1 AND id <= $2', [auditCutoff, upTo('audit_log')]);
  const consumerAuditRows = await pool.query('DELETE FROM consumer_audit WHERE at < $1 AND id <= $2', [auditCutoff, upTo('consumer_audit')]);
  // M3: usage analytics are kept at most 13 months.
  const telemetry = await pool.query('DELETE FROM telemetry_events WHERE at < $1', [addMinutes(now, -TELEMETRY_RETENTION_DAYS * 1440)]);
  log.info(
    {
      ...intake,
      inbound_bodies_expired: inbound.rowCount ?? 0,
      inbound_rows_deleted: inboundRows.rowCount ?? 0,
      offer_inbox_raw_wiped: offerInbox.rawWiped,
      queue_rows_deleted: (jobs.rowCount ?? 0) + (deadJobs.rowCount ?? 0),
      heartbeats_deleted: beats.rowCount ?? 0,
      reconcile_runs_deleted: reconcile.rowCount ?? 0,
      deletion_requests_deleted: deletions.rowCount ?? 0,
      audit_rows_deleted: (audit.rowCount ?? 0) + (consumerAuditRows.rowCount ?? 0),
      telemetry_events_deleted: telemetry.rowCount ?? 0,
    },
    'retention purge finished',
  );
}

/** Audit rows (admin and consumer) and admin login history: 365 days. */
export const AUDIT_RETENTION_DAYS = 365;
/** Usage analytics: 13 months. */
export const TELEMETRY_RETENTION_DAYS = 396;

/** `audit.ship`: new audit rows to LOG_SINK_URL (see observability/auditShip.ts). */
export async function auditShip(job: JobContext): Promise<void> {
  const { pool, config, log } = job.deps;
  if (!config.logSink) return;
  const r = await shipAuditRows(pool, { url: config.logSink.url, token: config.logSink.token, service: 'due-worker' }, job.deps.clock());
  if (Object.values(r).some((v) => v < 0)) throw new Error('log sink rejected an audit batch');
  log.info(r, 'audit rows shipped');
}

/**
 * `sync.seal_backfill` (M-E): seals every synced document still stored in plain JSON (or under an older key),
 * including dormant accounts that never sync again. Batches of 200 per table; re-enqueues itself until done.
 * Afterwards run VACUUM FULL on account_data and household_data and expire older backups (docs/production/E2E_SYNC_PLAN.md).
 */
export async function sealBackfill(job: JobContext): Promise<void> {
  const { pool, config, clock, log } = job.deps;
  const keys = config.dataEncryptionKey;
  if (!keys) return;
  const kidPrefix = `d1:${keys.current.kid}:`;
  let sealed = 0;
  let more = false;
  for (const [table, keyCol] of [['account_data', 'account_id'], ['household_data', 'household_id']] as const) {
    const rows = (
      await pool.query<{ id: string }>(
        `SELECT ${keyCol} AS id FROM ${table} WHERE version > 0 AND (data_enc IS NULL OR data_enc NOT LIKE $1) LIMIT 200`,
        [`${kidPrefix}%`],
      )
    ).rows;
    if (rows.length === 200) more = true;
    for (const r of rows) {
      await readVersionedDoc(pool, table, keyCol, r.id, keys);
      sealed++;
    }
  }
  // Raw intake text written before row binding (v1/v2, no AAD) is re-sealed as v3 bound to its row.
  const legacy = (
    await pool.query<{ id: string; raw_text: string }>(
      `SELECT id, raw_text FROM user_events WHERE raw_text IS NOT NULL AND raw_text NOT LIKE 'v3:%' LIMIT 500`,
    )
  ).rows;
  if (legacy.length === 500) more = true;
  for (const r of legacy) {
    let plain: string | null;
    try {
      plain = decryptText(keys, r.raw_text);
    } catch {
      plain = null;
    }
    // Unreadable legacy text is dropped (it would expire within 7 days anyway).
    await pool.query('UPDATE user_events SET raw_text = $2, raw_retention_until = CASE WHEN $2::text IS NULL THEN NULL ELSE raw_retention_until END WHERE id = $1 AND raw_text = $3', [
      r.id,
      plain === null ? null : encryptText(keys, plain, `user_events:${r.id}`),
      r.raw_text,
    ]);
    sealed++;
  }
  log.info({ sealed, more }, 'sync seal backfill batch');
  if (more) await enqueue(pool, { type: 'sync.seal_backfill', idempotencyKey: `sync.seal_backfill:${clock().toISOString()}`, now: clock() });
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
  registerHandler('audit.ship', auditShip);
  registerHandler('sync.seal_backfill', sealBackfill);
  registerHandler('account.delete', deleteAccountJob);
  registerHandler('billing.reconcile', reconcileBilling);
}
