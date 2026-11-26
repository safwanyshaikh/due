import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { many, one } from '../../db.js';
import { actorOf, currentUser, requireRole } from '../../http/context.js';
import { AppError, parse } from '../../http/errors.js';
import { getLegal } from '../../legal/index.js';
import { normaliseKeys } from '../../util.js';

/** Most accounts one call may notify; larger incidents are sent in batches (the call is idempotent per account). */
export const BREACH_BATCH_MAX = 1000;

const Body = z
  .object({
    /** Internal reference, e.g. "INC-2026-11-01". Shown in the email and used to skip accounts already notified. */
    incidentRef: z.string().trim().regex(/^[A-Za-z0-9._-]{3,64}$/, 'Use letters, digits, dot, dash or underscore'),
    subject: z.string().trim().min(5).max(150),
    /** Plain text: what happened, what data, what we did, what the person can do (see INCIDENT_RESPONSE.md). */
    message: z.string().trim().min(50).max(8000),
    accountIds: z.array(z.string().uuid()).min(1).max(BREACH_BATCH_MAX),
    /** true: count only, nothing sent. */
    dryRun: z.boolean().optional(),
  })
  .strict();

/**
 * DPDP Rules 2025 r.7(1): tell each affected Data Principal about a personal data breach without delay.
 * Admin and owner only, with a fresh 2-step check (requireRole('admin') on a POST), rate-limited, audit-logged.
 * Each account gets its own email (never a shared To/CC list); the footer adds the grievance and incident
 * contacts from the legal settings. Only counts and account ids are stored, never the addresses.
 */
export async function breachRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const admin = { preHandler: requireRole('admin') };

  app.post('/incident/notify-accounts', { ...admin, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req) => {
    const body = parse(Body, normaliseKeys(req.body));
    const mailer = app.deps.mailer;
    if (!mailer && !body.dryRun) throw new AppError(503, 'smtp_not_configured', 'SMTP_URL is not set, so no email can be sent.');
    const legal = await getLegal(pool);
    const contact = [
      legal['legal.grievance_officer_name'] && legal['legal.grievance_email']
        ? `Grievance Officer: ${legal['legal.grievance_officer_name']} <${legal['legal.grievance_email']}>`
        : null,
      legal['legal.incident_contact'] ? `Security contact: ${legal['legal.incident_contact']}` : null,
      legal['legal.entity_name'] ? `Data Fiduciary: ${legal['legal.entity_name']}` : null,
    ].filter(Boolean);
    if (!contact.length && !body.dryRun) {
      throw new AppError(409, 'legal_incomplete', 'Fill in the grievance officer and incident contact (Legal page) first: the notice must say whom to contact.');
    }
    const ids = [...new Set(body.accountIds)];
    const accounts = await many<{ id: string; email: string }>(
      pool,
      `SELECT a.id, a.email FROM consumer_accounts a
        WHERE a.id = ANY($1::uuid[])
          AND NOT EXISTS (SELECT 1 FROM breach_notifications b WHERE b.account_id = a.id AND b.incident_ref = $2 AND b.status = 'sent')`,
      [ids, body.incidentRef],
    );
    const already = (await one<{ n: number }>(
      pool,
      `SELECT count(DISTINCT account_id)::int AS n FROM breach_notifications WHERE incident_ref = $1 AND status = 'sent' AND account_id = ANY($2::uuid[])`,
      [body.incidentRef, ids],
    ))!.n;
    const unknown = ids.length - accounts.length - already;
    if (body.dryRun) return { dryRun: true, wouldSend: accounts.length, alreadyNotified: already, unknownAccounts: unknown };

    const text =
      `${body.message}\n\n` +
      `Reference: ${body.incidentRef}\n` +
      `${contact.join('\n')}\n\n` +
      `This notice is sent to each affected account individually. Due will never ask for your password, OTP or bank details by email.\n`;
    let sent = 0;
    let failed = 0;
    const now = clock();
    for (const a of accounts) {
      let status: 'sent' | 'failed' = 'sent';
      try {
        await mailer!.send([a.email], body.subject, text);
        sent++;
      } catch (err) {
        status = 'failed';
        failed++;
        req.log.error({ err }, 'breach notice email failed');
      }
      await pool.query('INSERT INTO breach_notifications (incident_ref, account_id, status, sent_by, at) VALUES ($1,$2,$3,$4,$5)', [
        body.incidentRef,
        a.id,
        status,
        currentUser(req).id,
        now,
      ]);
    }
    await writeAudit(pool, actorOf(req), 'incident.notify_accounts', 'incident', body.incidentRef, null, {
      subject: body.subject,
      requested: ids.length,
      sent,
      failed,
      alreadyNotified: already,
      unknownAccounts: unknown,
    });
    return { sent, failed, alreadyNotified: already, unknownAccounts: unknown };
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
