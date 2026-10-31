import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createAlert } from '../alerts.js';
import type { Clock } from '../clock.js';
import type { Pool, PoolClient, Queryable } from '../db.js';
import { many, one } from '../db.js';
import { AppError, parse } from '../http/errors.js';
import { metrics } from '../observability/metrics.js';
import { redactText } from '../observability/redact.js';
import { enqueue, type JobContext } from '../queue/index.js';
import { camelAll, hmacSha256, normaliseKeys, safeEqual } from '../util.js';
import { consentState, recordConsentV2 } from './consents.js';
import { consumerAudit, currentAccount, requireAccount } from './context.js';
import { computeEntitlement } from './entitlements.js';
import { inQuietHours, isValidTimeZone, localMinutes } from './reminders.js';

/**
 * Reminder/notification reliability: per-user per-channel preferences, a delivery record for every outcome,
 * signed unsubscribe links, duplicate suppression, quiet hours/time zone/snooze, explicit channel consent, and a
 * daily reconciliation that surfaces missed deliveries in Admin. A reminder is only ever marked sent after the
 * SMTP server accepted the message.
 */

export const CHANNELS = ['email', 'push'] as const;
export type Channel = (typeof CHANNELS)[number];
const CONSENT_FOR: Record<Channel, 'reminders_email' | 'reminders_push'> = {
  email: 'reminders_email',
  push: 'reminders_push',
};

export const STALE_MS = 48 * 60 * 60 * 1000;
export const DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;
export const MISSED_AFTER_MS = 2 * 60 * 60 * 1000;
export const REQUEUE_STUCK_MS = 30 * 60 * 1000;
export const REMINDER_MAX_ATTEMPTS = 4;

// ---- Unsubscribe tokens ----------------------------------------------------------------------------

/** Signed, non-expiring token naming one account and channel. It can only turn that channel off. */
export function unsubscribeToken(secret: string, accountId: string, channel: Channel): string {
  const body = Buffer.from(`${accountId}.${channel}`).toString('base64url');
  return `${body}.${hmacSha256(secret, `unsubscribe:${accountId}:${channel}`).slice(0, 40)}`;
}

export function verifyUnsubscribeToken(
  secret: string,
  token: string,
): { accountId: string; channel: Channel } | null {
  const m = /^([A-Za-z0-9_-]{10,120})\.([0-9a-f]{40})$/.exec(token);
  if (!m) return null;
  const [accountId, channel] = Buffer.from(m[1]!, 'base64url').toString('utf8').split('.');
  if (!accountId || !/^[0-9a-f-]{36}$/.test(accountId) || !CHANNELS.includes(channel as Channel))
    return null;
  const expected = unsubscribeToken(secret, accountId, channel as Channel);
  return safeEqual(token, expected) ? { accountId, channel: channel as Channel } : null;
}

// ---- Preferences -----------------------------------------------------------------------------------

interface PrefRow {
  channel: Channel;
  enabled: boolean;
  timezone: string;
  quiet_start: string | null;
  quiet_end: string | null;
  snooze_until: Date | null;
  disabled_via: string | null;
  updated_at: Date;
}

export async function getPreference(
  q: Queryable,
  accountId: string,
  channel: Channel,
): Promise<PrefRow> {
  const row = await one<PrefRow>(
    q,
    'SELECT * FROM notification_preferences WHERE account_id = $1 AND channel = $2',
    [accountId, channel],
  );
  return (
    row ?? {
      channel,
      enabled: true,
      timezone: 'Asia/Kolkata',
      quiet_start: null,
      quiet_end: null,
      snooze_until: null,
      disabled_via: null,
      updated_at: new Date(0),
    }
  );
}

export async function preferencesView(q: Queryable, accountId: string) {
  const out = [];
  for (const channel of CHANNELS) {
    const p = await getPreference(q, accountId, channel);
    const c = await consentState(q, accountId, CONSENT_FOR[channel]);
    out.push({
      channel,
      enabled: p.enabled,
      timezone: p.timezone,
      quietHours: p.quiet_start && p.quiet_end ? { start: p.quiet_start, end: p.quiet_end } : null,
      snoozeUntil: p.snooze_until,
      disabledVia: p.disabled_via,
      consent: c.state,
      consentPolicyVersion: c.policyVersion,
      available: channel === 'email',
    });
  }
  return out;
}

export async function setPreference(
  q: Queryable,
  accountId: string,
  channel: Channel,
  patch: {
    enabled?: boolean;
    timezone?: string;
    quietHours?: { start: string; end: string } | null;
    snoozeUntil?: Date | null;
    disabledVia?: string | null;
  },
  now: Date,
): Promise<void> {
  const cur = await getPreference(q, accountId, channel);
  const quiet =
    patch.quietHours === undefined
      ? { start: cur.quiet_start, end: cur.quiet_end }
      : (patch.quietHours ?? { start: null, end: null });
  await q.query(
    `INSERT INTO notification_preferences (account_id, channel, enabled, timezone, quiet_start, quiet_end, snooze_until, disabled_via, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (account_id, channel) DO UPDATE SET enabled = EXCLUDED.enabled, timezone = EXCLUDED.timezone, quiet_start = EXCLUDED.quiet_start,
       quiet_end = EXCLUDED.quiet_end, snooze_until = EXCLUDED.snooze_until, disabled_via = EXCLUDED.disabled_via, updated_at = EXCLUDED.updated_at`,
    [
      accountId,
      channel,
      patch.enabled ?? cur.enabled,
      patch.timezone ?? cur.timezone,
      quiet.start,
      quiet.end,
      patch.snoozeUntil === undefined ? cur.snooze_until : patch.snoozeUntil,
      patch.enabled === true
        ? null
        : patch.disabledVia === undefined
          ? cur.disabled_via
          : patch.disabledVia,
      now,
    ],
  );
}

// ---- Scheduling: due reminders -> reminder.deliver jobs --------------------------------------------

/**
 * The 'consumer_reminders' scheduler entry: enqueues one reminder.deliver job per due, open reminder.
 * A reminder already queued is not enqueued again unless its job has been stuck for 30 minutes.
 */
export async function enqueueDueReminders(
  ctx: { pool: Pool; clock: Clock },
  config: Record<string, unknown>,
): Promise<Record<string, number>> {
  const batch = Math.min(Math.max(Number(config.batch_size ?? 200) || 200, 1), 1000);
  const now = ctx.clock();
  const rows = await many<{ id: number; account_id: string; queue_round: number }>(
    ctx.pool,
    `UPDATE reminder_schedule r SET queue_round = r.queue_round + 1, queued_at = $1
      WHERE r.id IN (
        SELECT id FROM reminder_schedule
         WHERE closed_at IS NULL AND COALESCE(deliver_after, remind_at) <= $1
           AND (queued_at IS NULL OR queued_at < $1::timestamptz - make_interval(secs => $3))
         ORDER BY remind_at LIMIT $2 FOR UPDATE SKIP LOCKED)
      RETURNING r.id, r.account_id, r.queue_round`,
    [now, batch, REQUEUE_STUCK_MS / 1000],
  );
  let enqueued = 0;
  for (const r of rows) {
    const j = await enqueue(ctx.pool, {
      type: 'reminder.deliver',
      payload: { reminderId: r.id },
      accountId: r.account_id,
      idempotencyKey: `reminder.deliver:${r.id}:${r.queue_round}`,
      maxAttempts: REMINDER_MAX_ATTEMPTS,
      now,
    });
    if (!j.deduped) enqueued++;
  }
  return { due: rows.length, enqueued };
}

// ---- Delivery --------------------------------------------------------------------------------------

interface DeliverRow {
  id: number;
  account_id: string;
  obligation_ref: string;
  title: string;
  due_date: string;
  remind_at: Date;
  channel: Channel;
  timezone: string;
  quiet_start: string | null;
  quiet_end: string | null;
  attempts: number;
  closed_at: Date | null;
  email: string;
  status: string;
}

function humanDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      });
}

/** Subject never names the provider or an amount; the body has no amounts and links back into the app. */
export function reminderEmail(
  base: string,
  secret: string,
  r: { account_id: string; obligation_ref: string; title: string; due_date: string },
) {
  const due = humanDate(r.due_date);
  const deepLink = `${base}/?open=reminder&ref=${encodeURIComponent(r.obligation_ref)}`;
  const unsubscribe = `${base}/api/notifications/unsubscribe?token=${unsubscribeToken(secret, r.account_id, 'email')}`;
  const subject = `Reminder from Due: an item is due on ${due}`;
  const text =
    `You asked Due to remind you about "${r.title}", due on ${due}.\n\n` +
    `Open it in Due (sign-in required): ${deepLink}\n\n` +
    `Change, snooze or turn off reminders in the Due app under Settings > Notifications.\n` +
    `Stop all email reminders: ${unsubscribe}\n`;
  return { subject, text, unsubscribe };
}

/** Minutes until the quiet window [start, end) ends, at local time in tz. */
function minutesUntilQuietEnds(at: Date, tz: string, end: string): number {
  const endMin = Number(end.slice(0, 2)) * 60 + Number(end.slice(3, 5));
  const d = (endMin - localMinutes(at, tz) + 1440) % 1440;
  return d === 0 ? 1440 : d;
}

type Outcome =
  | {
      kind: 'closed';
      status: 'sent' | 'failed' | 'unavailable' | 'suppressed';
      reason: string | null;
    }
  | { kind: 'deferred'; until: Date; reason: string }
  | { kind: 'retry'; error: Error }
  | { kind: 'skip' };

async function recordDelivery(
  c: PoolClient,
  r: DeliverRow,
  job: JobContext,
  status: 'sent' | 'failed' | 'unavailable' | 'suppressed' | 'sending',
  reason: string | null,
  messageId: string | null,
  now: Date,
): Promise<number> {
  const row = await c.query<{ id: number }>(
    `INSERT INTO reminder_deliveries (account_id, obligation_ref, channel, scheduled_for, status, provider_message_id, error, failure_reason,
        reminder_id, job_id, retry_count, due_date, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
    [
      r.account_id,
      r.obligation_ref,
      r.channel,
      r.remind_at,
      status,
      messageId,
      reason,
      r.id,
      job.id,
      Math.max(0, job.attempt - 1),
      r.due_date,
      now,
    ],
  );
  return row.rows[0]!.id;
}

async function close(
  c: PoolClient,
  r: DeliverRow,
  status: 'sent' | 'failed' | 'unavailable' | 'suppressed',
  now: Date,
): Promise<void> {
  await c.query(
    `UPDATE reminder_schedule SET closed_at = $2, final_status = $3, attempts = attempts + 1, queued_at = NULL,
            delivered_at = CASE WHEN $3 = 'sent' THEN $2::timestamptz ELSE delivered_at END WHERE id = $1`,
    [r.id, now, status],
  );
}

/** Handler for `reminder.deliver` { reminderId }. */
export async function deliverReminder(job: JobContext): Promise<void> {
  const { pool, clock, mailer, config } = job.deps;
  const reminderId = Number(job.payload.reminderId);
  if (!Number.isInteger(reminderId)) return;
  const client = await pool.connect();
  let outcome: Outcome;
  try {
    await client.query('BEGIN');
    // The row lock makes concurrent jobs for the same reminder (e.g. a requeued round) deliver at most once.
    const r = await one<DeliverRow>(
      client,
      `SELECT r.*, a.email, a.status FROM reminder_schedule r JOIN consumer_accounts a ON a.id = r.account_id
        WHERE r.id = $1 FOR UPDATE OF r SKIP LOCKED`,
      [reminderId],
    );
    if (!r || r.closed_at) {
      await client.query('COMMIT');
      return;
    }
    const now = clock();
    const finalUnavailable = async (reason: string): Promise<Outcome> => {
      await recordDelivery(client, r, job, 'unavailable', reason, null, now);
      await close(client, r, 'unavailable', now);
      return { kind: 'closed', status: 'unavailable', reason };
    };
    outcome = await (async (): Promise<Outcome> => {
      if (now.getTime() - r.remind_at.getTime() > STALE_MS)
        return finalUnavailable(
          'stale: the reminder time passed more than 48 hours before delivery was possible',
        );
      if (r.status !== 'active') return finalUnavailable('account_disabled');
      if (r.channel === 'push')
        return finalUnavailable(
          'push_not_configured: push delivery is not available on this server',
        );
      const ent = await computeEntitlement(client, r.account_id, now);
      if (!ent.features.includes('reminder_email'))
        return finalUnavailable('premium_required: email reminders need a premium plan');
      const consent = await consentState(client, r.account_id, CONSENT_FOR[r.channel]);
      if (consent.state === 'revoked') return finalUnavailable('consent_withdrawn');
      if (consent.state === 'none')
        return finalUnavailable('consent_required: email reminders need explicit consent');
      const pref = await getPreference(client, r.account_id, r.channel);
      if (!pref.enabled)
        return finalUnavailable(
          `channel_disabled${pref.disabled_via ? `: ${pref.disabled_via}` : ''}`,
        );
      if (!mailer)
        return finalUnavailable('email_unavailable: SMTP is not configured on this server');
      if (!config.publicBaseUrl)
        return finalUnavailable(
          'email_unavailable: PUBLIC_BASE_URL is not configured (links cannot be built)',
        );
      if (pref.snooze_until && pref.snooze_until.getTime() > now.getTime())
        return { kind: 'deferred', until: pref.snooze_until, reason: 'snoozed' };
      const qs = r.quiet_start ?? pref.quiet_start;
      const qe = r.quiet_end ?? pref.quiet_end;
      const tz = r.quiet_start ? r.timezone : pref.timezone;
      if (qs && qe && inQuietHours(now, tz, qs, qe)) {
        return {
          kind: 'deferred',
          until: new Date(now.getTime() + minutesUntilQuietEnds(now, tz, qe) * 60_000),
          reason: 'quiet_hours',
        };
      }
      const dup = await one(
        client,
        `SELECT 1 AS x FROM reminder_deliveries WHERE account_id = $1 AND obligation_ref = $2 AND channel = $3 AND status = 'sent' AND created_at > $4 LIMIT 1`,
        [r.account_id, r.obligation_ref, r.channel, new Date(now.getTime() - DUPLICATE_WINDOW_MS)],
      );
      if (dup) {
        await recordDelivery(
          client,
          r,
          job,
          'suppressed',
          'duplicate: a reminder for this item was sent in the last 12 hours',
          null,
          now,
        );
        await close(client, r, 'suppressed', now);
        return { kind: 'closed', status: 'suppressed', reason: 'duplicate' };
      }
      // A 'sending' row left by a crashed attempt: SMTP acceptance was never recorded, so it is not 'sent'.
      await client.query(
        `UPDATE reminder_deliveries SET status = 'failed', failure_reason = 'interrupted: the worker stopped during sending', error = 'interrupted', updated_at = $2
          WHERE reminder_id = $1 AND status = 'sending'`,
        [r.id, now],
      );
      const deliveryId = await recordDelivery(client, r, job, 'sending', null, null, now);
      const mail = reminderEmail(config.publicBaseUrl, config.sessionSecret, r);
      try {
        const info = await mailer.send([r.email], mail.subject, mail.text, {
          headers: {
            'List-Unsubscribe': `<${mail.unsubscribe}>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
          },
        });
        await client.query(
          `UPDATE reminder_deliveries SET status = 'sent', provider_message_id = $2, updated_at = $3 WHERE id = $1`,
          [deliveryId, info?.messageId ?? null, now],
        );
        await close(client, r, 'sent', now);
        return { kind: 'closed', status: 'sent', reason: null };
      } catch (err) {
        const reason = redactText((err as Error).message ?? 'send failed', 300);
        await client.query(
          `UPDATE reminder_deliveries SET status = 'failed', failure_reason = $2, error = $2, updated_at = $3 WHERE id = $1`,
          [deliveryId, reason, now],
        );
        if (job.attempt >= job.maxAttempts) {
          await close(client, r, 'failed', now);
          return { kind: 'closed', status: 'failed', reason };
        }
        await client.query('UPDATE reminder_schedule SET attempts = attempts + 1 WHERE id = $1', [
          r.id,
        ]);
        return {
          kind: 'retry',
          error: Object.assign(new Error(`smtp_failed: ${reason}`), { code: 'smtp_failed' }),
        };
      }
    })();
    if (outcome.kind === 'deferred') {
      await client.query(
        'UPDATE reminder_schedule SET deliver_after = $2, queued_at = NULL WHERE id = $1',
        [r.id, outcome.until],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  if (outcome.kind === 'closed') {
    metrics.inc('notifications.delivery', { channel: 'email', status: outcome.status });
    if (outcome.status === 'failed')
      throw Object.assign(new Error(`reminder delivery failed: ${outcome.reason}`), {
        code: 'smtp_failed',
      });
  } else if (outcome.kind === 'deferred') {
    metrics.inc('notifications.deferred', { reason: outcome.reason });
  } else if (outcome.kind === 'retry') {
    metrics.inc('notifications.delivery', { channel: 'email', status: 'retry' });
    throw outcome.error;
  }
}

// ---- Daily reconciliation --------------------------------------------------------------------------

export async function reconcileReminders(job: JobContext): Promise<void> {
  const { pool, clock, mailer, log } = job.deps;
  const now = clock();
  const missed = await many<{
    id: number;
    account_id: string;
    remind_at: Date;
    queued_at: Date | null;
  }>(
    pool,
    `SELECT id, account_id, remind_at, queued_at FROM reminder_schedule
      WHERE closed_at IS NULL AND COALESCE(deliver_after, remind_at) < $1 ORDER BY remind_at LIMIT 500`,
    [new Date(now.getTime() - MISSED_AFTER_MS)],
  );
  const failed = await many<{ id: number; account_id: string; final_status: string }>(
    pool,
    `SELECT id, account_id, final_status FROM reminder_schedule WHERE final_status = 'failed' AND closed_at > $1 ORDER BY closed_at DESC LIMIT 500`,
    [new Date(now.getTime() - 86_400_000)],
  );
  const details = [
    ...missed.map((m) => ({
      reminderId: m.id,
      accountId: m.account_id,
      reason: m.queued_at ? 'queued_not_delivered' : 'not_queued',
    })),
    ...failed.map((f) => ({
      reminderId: f.id,
      accountId: f.account_id,
      reason: 'delivery_failed',
    })),
  ];
  await pool.query(
    'INSERT INTO reminder_reconcile_runs (run_at, missed, failed, details) VALUES ($1,$2,$3,$4)',
    [now, missed.length, failed.length, JSON.stringify(details)],
  );
  // Self-heal: missed reminders are released so the next scheduler tick queues them again (stale ones close as unavailable).
  if (missed.length)
    await pool.query('UPDATE reminder_schedule SET queued_at = NULL WHERE id = ANY($1::bigint[])', [
      missed.map((m) => m.id),
    ]);
  metrics.inc('notifications.reconcile_missed', undefined, missed.length);
  if (missed.length || failed.length) {
    await createAlert(
      pool,
      {
        level: 'important',
        title: `Reminder reconciliation: ${missed.length} missed, ${failed.length} failed in 24h`,
        body: 'Open Admin > Health > Notifications for the affected reminder ids. Missed reminders were re-queued automatically.',
        entityType: 'reminder_reconcile',
      },
      mailer,
      log,
    );
  }
}

// ---- Routes ----------------------------------------------------------------------------------------

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)');

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock, config } = app.deps;

  app.get(
    '/api/account/notifications/preferences',
    { preHandler: requireAccount },
    async (req) => ({
      items: await preferencesView(pool, currentAccount(req).id),
    }),
  );

  app.put('/api/account/notifications/preferences', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const body = parse(
      z
        .object({
          channel: z.enum(CHANNELS),
          enabled: z.boolean().optional(),
          timezone: z.string().max(64).refine(isValidTimeZone, 'Unknown IANA time zone').optional(),
          quietHours: z.object({ start: hhmm, end: hhmm }).strict().nullable().optional(),
          snoozeUntil: z.string().datetime({ offset: true }).nullable().optional(),
          /** Policy version of the consent text shown when the person turned the channel on. */
          consentVersion: z.string().trim().min(1).max(60).optional(),
        })
        .strict(),
      normaliseKeys(req.body),
    );
    const now = clock();
    const purpose = CONSENT_FOR[body.channel];
    const consent = await consentState(pool, a.id, purpose);
    if (body.enabled === true && consent.state !== 'granted' && !body.consentVersion) {
      throw new AppError(
        400,
        'consent_required',
        `Turning on ${body.channel} reminders needs explicit consent (send consentVersion)`,
        { purpose },
      );
    }
    if (body.enabled === true && body.consentVersion && consent.state !== 'granted') {
      await recordConsentV2(
        pool,
        { accountId: a.id },
        {
          purpose,
          granted: true,
          policyVersion: body.consentVersion,
          scope: { channel: body.channel },
        },
        now,
      );
    }
    await setPreference(
      pool,
      a.id,
      body.channel,
      {
        enabled: body.enabled,
        timezone: body.timezone,
        quietHours: body.quietHours,
        snoozeUntil:
          body.snoozeUntil === undefined
            ? undefined
            : body.snoozeUntil === null
              ? null
              : new Date(body.snoozeUntil),
        disabledVia: body.enabled === false ? 'settings' : undefined,
      },
      now,
    );
    await consumerAudit(
      pool,
      a.id,
      'notifications.preferences',
      'notification_preferences',
      body.channel,
      null,
      { ...body, consentVersion: undefined },
      now,
    );
    return { items: await preferencesView(pool, a.id) };
  });

  /**
   * One-click unsubscribe from an e-mailed link (GET) or a mail client's List-Unsubscribe-Post (POST).
   * The signed token only ever turns a channel off.
   */
  const unsubscribe = async (token: string) => {
    const v = verifyUnsubscribeToken(config.sessionSecret, token);
    if (!v) return null;
    const exists = await one(pool, 'SELECT 1 AS x FROM consumer_accounts WHERE id = $1', [
      v.accountId,
    ]);
    if (!exists) return null;
    const now = clock();
    await setPreference(
      pool,
      v.accountId,
      v.channel,
      { enabled: false, disabledVia: 'unsubscribe_link' },
      now,
    );
    await consumerAudit(
      pool,
      v.accountId,
      'notifications.unsubscribed',
      'notification_preferences',
      v.channel,
      null,
      { via: 'link' },
      now,
    );
    metrics.inc('notifications.unsubscribed', { channel: v.channel });
    return v;
  };
  const tokenQuery = z.object({ token: z.string().max(300) });

  // Opening the e-mailed link only shows a confirmation page: link scanners that prefetch URLs must not
  // switch reminders off. The change happens on POST (the page's button, or a mail client's RFC 8058
  // List-Unsubscribe-Post one-click request).
  app.get(
    '/api/notifications/unsubscribe',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('Referrer-Policy', 'no-referrer');
      const q = tokenQuery.safeParse(req.query);
      const v = q.success ? verifyUnsubscribeToken(config.sessionSecret, q.data.token) : null;
      if (!v || !q.success) return reply.redirect('/?notifications=unsubscribe-invalid', 303);
      const action = `/api/notifications/unsubscribe?token=${encodeURIComponent(q.data.token)}`;
      const label = v.channel === 'email' ? 'email reminders' : `${v.channel} reminders`;
      reply.type('text/html; charset=utf-8');
      return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Stop reminders · Due</title></head><body>' +
        `<h1>Stop ${label}?</h1><p>Due will stop sending you ${label}. You can turn them back on in Settings at any time.</p>` +
        `<form method="post" action="${action}" enctype="text/plain"><button type="submit">Stop ${label}</button></form>` +
        '<p><a href="/">Keep them and go back to Due</a></p></body></html>'
      );
    },
  );

  await app.register(async (scoped) => {
    // Mail clients send RFC 8058 one-click as urlencoded; the body is ignored, the token is in the URL.
    scoped.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );
    scoped.post(
      '/api/notifications/unsubscribe',
      { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
      async (req, reply) => {
        reply.header('Cache-Control', 'no-store');
        const q = tokenQuery.safeParse(req.query);
        const v = q.success ? await unsubscribe(q.data.token) : null;
        const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
        if (!v) {
          if (wantsHtml) return reply.redirect('/?notifications=unsubscribe-invalid', 303);
          return reply
            .code(400)
            .send({
              error: { code: 'invalid_token', message: 'This unsubscribe link is invalid' },
            });
        }
        if (wantsHtml)
          return reply.redirect(`/?notifications=unsubscribed&channel=${v.channel}`, 303);
        return { ok: true, channel: v.channel, enabled: false };
      },
    );
  });
}

/** Admin (under /api/admin): reconciliation results and live missed/failed reminders (ids only, no content). */
export async function notificationAdminRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  app.get('/notifications/reconcile', async () => {
    const now = clock();
    const runs = await many(
      pool,
      'SELECT id, run_at, missed, failed, details FROM reminder_reconcile_runs ORDER BY id DESC LIMIT 14',
    );
    const missedNow = await many(
      pool,
      `SELECT id AS reminder_id, account_id, channel, remind_at, deliver_after, queued_at, attempts FROM reminder_schedule
        WHERE closed_at IS NULL AND COALESCE(deliver_after, remind_at) < $1 ORDER BY remind_at LIMIT 200`,
      [new Date(now.getTime() - MISSED_AFTER_MS)],
    );
    const recentFailures = await many(
      pool,
      `SELECT id, reminder_id, account_id, channel, status, failure_reason, retry_count, provider_message_id, created_at
         FROM reminder_deliveries WHERE status IN ('failed','unavailable','suppressed') AND created_at > $1 ORDER BY id DESC LIMIT 200`,
      [new Date(now.getTime() - 7 * 86_400_000)],
    );
    const counts = await many(
      pool,
      `SELECT status, count(*)::int AS n FROM reminder_deliveries WHERE created_at > $1 GROUP BY status ORDER BY status`,
      [new Date(now.getTime() - 86_400_000)],
    );
    return {
      runs: camelAll(runs),
      missedNow: camelAll(missedNow),
      recentFailures: camelAll(recentFailures),
      last24h: Object.fromEntries(counts.map((c) => [c.status as string, c.n])),
    };
  });
}
