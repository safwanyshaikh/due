import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createAlert } from '../../alerts.js';
import { writeAudit } from '../../audit.js';
import { addMinutes } from '../../clock.js';
import { many, one, withTransaction } from '../../db.js';
import { actorOf, currentUser, requireRole } from '../../http/context.js';
import { AppError, conflict, forbidden, notFound, parse } from '../../http/errors.js';
import { getLegal } from '../../legal/index.js';
import { normaliseKeys } from '../../util.js';

/** Most accounts one notice may address. */
export const BREACH_BATCH_MAX = 1000;
/** Most breach emails sent in 24 hours across all notices (a runaway or abused notice cannot mass-mail). */
export const BREACH_DAILY_CAP = 5000;

/**
 * Breach notices to affected accounts (DPDP Rules 2025 r.7(1)), hardened against misuse as a phishing channel
 * (round-2 finding M-B):
 * 1. They need an **open incident record** (`POST /incident/records`).
 * 2. An admin creates a **draft**. The email is a **fixed template**; the admin only fills short plain-text
 *    placeholders, which may not contain links, web or e-mail addresses, phone numbers or markup.
 * 3. Every owner gets an alert (in-app and by email) when a draft is created and when it is sent.
 * 4. An **owner other than the author** approves it (with a fresh 2-step code); only then is it sent.
 * 5. Each account gets its own email; at most BREACH_DAILY_CAP emails a day in total. Audit-logged with counts only.
 */
const REF = z.string().trim().regex(/^[A-Za-z0-9._-]{3,64}$/, 'Use letters, digits, dot, dash or underscore');

/** Plain text only: no links, domains, e-mail addresses, phone numbers or markup. */
export function placeholderProblem(v: string): string | null {
  if (/[<>[\]{}`\\]/.test(v)) return 'No markup or brackets';
  if (/(https?:|www\.|:\/\/|\bbit\.ly\b)/i.test(v)) return 'No links';
  if (/\b[a-z0-9-]+\.(com|in|net|org|io|co|app|me|ai|dev|xyz|info|link|ly|site|online|top|click|support|help)\b/i.test(v)) return 'No web addresses';
  if (/@/.test(v)) return 'No e-mail addresses';
  if (/(?:\d[\s-]?){7,}/.test(v)) return 'No phone or account numbers';
  return null;
}
const placeholder = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .superRefine((v, ctx) => {
      const p = placeholderProblem(v);
      if (p) ctx.addIssue({ code: 'custom', message: p });
    });

export const NoticeFields = z
  .object({
    /** e.g. "24 November 2026" */
    discoveredOn: placeholder(6, 40),
    whatHappened: placeholder(20, 400),
    dataAffected: placeholder(5, 300),
    whatWeDid: placeholder(10, 400),
    whatYouCanDo: placeholder(10, 400),
  })
  .strict();
export type NoticeFields = z.infer<typeof NoticeFields>;

export function noticeSubject(ref: string): string {
  return `Important: a security incident affecting your Due account (${ref})`;
}

export function noticeText(ref: string, f: NoticeFields, contact: string[]): string {
  return (
    `On ${f.discoveredOn} we found a security incident at Due.\n\n` +
    `What happened: ${f.whatHappened}\n\n` +
    `Your data that was affected: ${f.dataAffected}\n\n` +
    `What we have done: ${f.whatWeDid}\n\n` +
    `What you can do: ${f.whatYouCanDo}\n\n` +
    `Reference: ${ref}\n${contact.join('\n')}\n\n` +
    `This notice is sent to each affected account individually. It contains no links. Open the Due app yourself to check your account. Due will never ask for your password, OTP or bank details by email.\n`
  );
}

async function ownerEmails(app: FastifyInstance): Promise<string[]> {
  return (await many<{ email: string }>(app.deps.pool, `SELECT email FROM users WHERE role = 'owner' AND status = 'active'`)).map((r) => r.email);
}

/** In-app alert plus an email to every owner (never only to the person acting). */
async function alertOwners(app: FastifyInstance, req: FastifyRequest, title: string, body: string): Promise<void> {
  await createAlert(app.deps.pool, { level: 'important', title, body, entityType: 'incident' }, null);
  const mailer = app.deps.mailer;
  if (!mailer) return;
  for (const to of await ownerEmails(app)) {
    try {
      await mailer.send([to], `[Due] ${title}`, `${body}\n\nReview it in the admin console (Incident). If you did not expect this, act now: revoke the author's sessions.`);
    } catch (err) {
      req.log.error({ err }, 'owner breach alert email failed');
    }
  }
}

export async function breachRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const admin = { preHandler: requireRole('admin') };
  const owner = { preHandler: requireRole('owner') };

  // ---- Incident records ----------------------------------------------------------------------------
  app.post('/incident/records', admin, async (req, reply) => {
    const body = parse(z.object({ incidentRef: REF, title: placeholder(5, 150) }).strict(), normaliseKeys(req.body));
    const now = clock();
    const row = await withTransaction(pool, async (c) => {
      if (await one(c, 'SELECT 1 AS x FROM incidents WHERE incident_ref = $1', [body.incidentRef])) throw conflict('An incident with this reference exists');
      const r = (await one<{ id: string }>(
        c,
        'INSERT INTO incidents (incident_ref, title, opened_by, opened_at) VALUES ($1,$2,$3,$4) RETURNING id',
        [body.incidentRef, body.title, currentUser(req).id, now],
      ))!;
      await writeAudit(c, actorOf(req), 'incident.opened', 'incident', body.incidentRef, null, { title: body.title });
      return r;
    });
    await alertOwners(app, req, `Incident ${body.incidentRef} opened`, `${currentUser(req).email} opened incident ${body.incidentRef}: ${body.title}`);
    return reply.code(201).send({ id: row.id, incidentRef: body.incidentRef, openedAt: now });
  });

  app.post('/incident/records/:ref/close', admin, async (req) => {
    const { ref } = parse(z.object({ ref: REF }), req.params);
    const r = await pool.query('UPDATE incidents SET closed_at = $2, closed_by = $3 WHERE incident_ref = $1 AND closed_at IS NULL', [ref, clock(), currentUser(req).id]);
    if (!r.rowCount) throw notFound('No open incident with this reference');
    await writeAudit(pool, actorOf(req), 'incident.closed', 'incident', ref, null, null);
    return { ok: true };
  });

  app.get('/incident/records', admin, async () => ({
    items: (
      await many<{ incident_ref: string; title: string; opened_at: Date; closed_at: Date | null }>(
        pool,
        'SELECT incident_ref, title, opened_at, closed_at FROM incidents ORDER BY opened_at DESC LIMIT 100',
      )
    ).map((r) => ({ incidentRef: r.incident_ref, title: r.title, openedAt: r.opened_at, closedAt: r.closed_at })),
  }));

  // ---- Notices: draft (admin) -> approve and send (another owner) ----------------------------------
  app.post('/incident/notices', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const body = parse(
      z.object({ incidentRef: REF, fields: NoticeFields, accountIds: z.array(z.string().uuid()).min(1).max(BREACH_BATCH_MAX) }).strict(),
      normaliseKeys(req.body),
    );
    const incident = await one(pool, 'SELECT 1 AS x FROM incidents WHERE incident_ref = $1 AND closed_at IS NULL', [body.incidentRef]);
    if (!incident) throw new AppError(409, 'incident_not_open', 'Open an incident record with this reference first.');
    const ids = [...new Set(body.accountIds)];
    const now = clock();
    const row = (await one<{ id: string }>(
      pool,
      `INSERT INTO breach_notices (incident_ref, fields, account_ids, created_by, created_at, status) VALUES ($1,$2,$3,$4,$5,'pending_approval') RETURNING id`,
      [body.incidentRef, JSON.stringify(body.fields), ids, currentUser(req).id, now],
    ))!;
    await writeAudit(pool, actorOf(req), 'incident.notice_drafted', 'breach_notice', row.id, null, { incidentRef: body.incidentRef, accounts: ids.length });
    await alertOwners(
      app,
      req,
      `Breach notice drafted for ${ids.length} account(s) (${body.incidentRef})`,
      `${currentUser(req).email} drafted a breach notice for incident ${body.incidentRef} to ${ids.length} account(s). It is sent only after another owner approves it.`,
    );
    return reply.code(201).send({ id: row.id, status: 'pending_approval', preview: { subject: noticeSubject(body.incidentRef), text: noticeText(body.incidentRef, body.fields, ['[contacts from Admin > Legal]']) } });
  });

  app.get('/incident/notices', admin, async () => ({
    items: (
      await many<{ id: string; incident_ref: string; status: string; created_at: Date; n: number; sent: number | null; failed: number | null }>(
        pool,
        `SELECT id, incident_ref, status, created_at, cardinality(account_ids) AS n, sent, failed FROM breach_notices ORDER BY created_at DESC LIMIT 100`,
      )
    ).map((r) => ({ id: r.id, incidentRef: r.incident_ref, status: r.status, createdAt: r.created_at, accounts: r.n, sent: r.sent, failed: r.failed })),
  }));

  app.post('/incident/notices/:id/approve', { ...owner, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const body = parse(z.object({ dryRun: z.boolean().optional() }).strict(), normaliseKeys(req.body ?? {}));
    const me = currentUser(req);
    const now = clock();
    const notice = await one<{ id: string; incident_ref: string; fields: NoticeFields; account_ids: string[]; created_by: string | null; status: string }>(
      pool,
      'SELECT id, incident_ref, fields, account_ids, created_by, status FROM breach_notices WHERE id = $1',
      [id],
    );
    if (!notice) throw notFound('Notice not found');
    if (notice.status !== 'pending_approval') throw conflict('This notice was already handled');
    if (notice.created_by === me.id) throw forbidden('Another owner must approve a notice you drafted');
    if (!(await one(pool, 'SELECT 1 AS x FROM incidents WHERE incident_ref = $1 AND closed_at IS NULL', [notice.incident_ref]))) {
      throw new AppError(409, 'incident_not_open', 'The incident record is closed.');
    }
    const mailer = app.deps.mailer;
    if (!mailer && !body.dryRun) throw new AppError(503, 'smtp_not_configured', 'SMTP_URL is not set, so no email can be sent.');
    const legal = await getLegal(pool);
    const contact = [
      legal['legal.grievance_officer_name'] && legal['legal.grievance_email']
        ? `Grievance Officer: ${legal['legal.grievance_officer_name']} <${legal['legal.grievance_email']}>`
        : null,
      legal['legal.incident_contact'] ? `Security contact: ${legal['legal.incident_contact']}` : null,
      legal['legal.entity_name'] ? `Data Fiduciary: ${legal['legal.entity_name']}` : null,
    ].filter((x): x is string => Boolean(x));
    if (!contact.length) throw new AppError(409, 'legal_incomplete', 'Fill in the grievance officer and incident contact (Legal page) first.');
    const accounts = await many<{ id: string; email: string }>(
      pool,
      `SELECT a.id, a.email FROM consumer_accounts a
        WHERE a.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM breach_notifications b WHERE b.account_id = a.id AND b.incident_ref = $2 AND b.status = 'sent')`,
      [notice.account_ids, notice.incident_ref],
    );
    const sentToday = (await one<{ n: number }>(pool, `SELECT count(*)::int AS n FROM breach_notifications WHERE status = 'sent' AND at > $1`, [addMinutes(now, -1440)]))!.n;
    if (sentToday + accounts.length > BREACH_DAILY_CAP) {
      throw new AppError(429, 'daily_cap', `At most ${BREACH_DAILY_CAP} breach emails can be sent in 24 hours (${sentToday} already sent).`);
    }
    if (body.dryRun) return { dryRun: true, wouldSend: accounts.length, sentToday };
    // Claim the notice first, so two approvals cannot both send.
    const claimed = await pool.query(`UPDATE breach_notices SET status = 'sending', approved_by = $2, approved_at = $3 WHERE id = $1 AND status = 'pending_approval'`, [id, me.id, now]);
    if (!claimed.rowCount) throw conflict('This notice was already handled');
    const subject = noticeSubject(notice.incident_ref);
    const text = noticeText(notice.incident_ref, notice.fields, contact);
    let sent = 0;
    let failed = 0;
    for (const a of accounts) {
      let status: 'sent' | 'failed' = 'sent';
      try {
        await mailer!.send([a.email], subject, text);
        sent++;
      } catch (err) {
        status = 'failed';
        failed++;
        req.log.error({ err }, 'breach notice email failed');
      }
      await pool.query('INSERT INTO breach_notifications (incident_ref, account_id, status, sent_by, at) VALUES ($1,$2,$3,$4,$5)', [
        notice.incident_ref,
        a.id,
        status,
        me.id,
        now,
      ]);
    }
    await pool.query(`UPDATE breach_notices SET status = 'sent', sent = $2, failed = $3 WHERE id = $1`, [id, sent, failed]);
    await writeAudit(pool, actorOf(req), 'incident.notify_accounts', 'incident', notice.incident_ref, null, { noticeId: id, requested: notice.account_ids.length, sent, failed });
    await alertOwners(app, req, `Breach notice sent (${notice.incident_ref})`, `${me.email} approved notice ${id}: ${sent} sent, ${failed} failed.`);
    return { sent, failed, alreadyNotified: notice.account_ids.length - accounts.length };
  });

  app.get('/incident/notifications', admin, async (req) => {
    const q = parse(z.object({ incidentRef: z.string().trim().max(64).optional() }), normaliseKeys(req.query));
    const rows = await many<{ incident_ref: string; status: string; n: number; first_at: Date; last_at: Date }>(
      pool,
      `SELECT incident_ref, status, count(*)::int AS n, min(at) AS first_at, max(at) AS last_at FROM breach_notifications
        WHERE ($1::text IS NULL OR incident_ref = $1) GROUP BY 1, 2 ORDER BY max(at) DESC LIMIT 200`,
      [q.incidentRef ?? null],
    );
    return { items: rows.map((r) => ({ incidentRef: r.incident_ref, status: r.status, count: r.n, firstAt: r.first_at, lastAt: r.last_at })) };
  });
}
