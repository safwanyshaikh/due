import { addMinutes } from '../clock.js';
import { many } from '../db.js';
import { withTransaction } from '../db.js';
import { metrics } from '../observability/metrics.js';
import type { JobContext } from '../queue/index.js';
import { getSettings } from '../settings.js';
import { consumerAudit } from './context.js';
import { requestDeletion } from './deletion.js';

/**
 * Dormant-account retention (DPDP storage limitation). An account with no sign-in and no sync for
 * `retention.dormant_months` (default 24, minimum 12) is warned by email 30 days and again 7 days before deletion,
 * then deleted through the normal account-deletion job. Rules:
 *  - activity = the latest of sign-up, last sign-in, any session use, and the last synced backup;
 *  - no email service configured: nothing is sent and nothing is deleted (an account is never deleted unwarned);
 *  - deletion needs the 7-day warning to have been sent at least 7 days ago (a delayed job never shortens the notice);
 *  - an account with a live paid plan or active subscription is never deleted;
 *  - any later sign-in or sync voids earlier warnings.
 */
export const DORMANT_STAGES = [30, 7] as const;
const DAY_MS = 86_400_000;

interface Candidate {
  id: string;
  email: string;
  activity: Date;
  due: Date;
}

export function dormantEmail(stage: number, deletionOn: Date, supportEmail: string | null) {
  const when = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' }).format(deletionOn);
  return {
    subject: `Your Due account will be deleted in ${stage} days unless you sign in`,
    text: [
      `You have not signed in to Due, or synced your data, for a long time.`,
      ``,
      `To keep your data to a minimum, we delete accounts that stay unused. Yours is due to be deleted on or after ${when} (IST), together with its synced backup, reminders and settings. Data stored only on your own device is not affected.`,
      ``,
      `To keep your account, just sign in to Due once (or sync from the app) before then. Nothing else is needed.`,
      `If you want it deleted sooner, sign in and use Account > Your account data > Delete my account.`,
      supportEmail ? `Questions: ${supportEmail}` : '',
    ]
      .filter((l, i, a) => l !== '' || a[i - 1] !== '')
      .join('\n'),
  };
}

/** `account.dormant_sweep`: voids stale warnings, sends due warnings, queues deletions. Safe to re-run. */
export async function dormantSweep(job: JobContext): Promise<void> {
  const { pool, clock, mailer, config, log } = job.deps;
  const now = clock();
  const settings = await getSettings(pool);
  const months = settings.retention.dormant_months;

  // Activity can only move forward; warnings for an older activity no longer apply.
  const rows = await many<{ id: string; email: string; activity: Date }>(
    pool,
    `SELECT a.id, a.email,
            GREATEST(a.created_at, a.last_login_at,
                     (SELECT max(s.last_seen_at) FROM consumer_sessions s WHERE s.account_id = a.id),
                     (SELECT d.updated_at FROM account_data d WHERE d.account_id = a.id AND d.version > 0)) AS activity
       FROM consumer_accounts a WHERE a.status = 'active'`,
  );
  const stats = { warned30: 0, warned7: 0, deletions: 0, skippedPaid: 0, voided: 0 };
  const candidates: Candidate[] = [];
  for (const r of rows) {
    const due = new Date(r.activity);
    due.setUTCMonth(due.getUTCMonth() + months);
    if (due.getTime() - 30 * DAY_MS > now.getTime()) continue;
    candidates.push({ id: r.id, email: r.email, activity: r.activity, due });
  }
  // Notices for accounts that are active again (or whose activity changed) are voided.
  const voided = await pool.query(
    `DELETE FROM dormant_notices n USING consumer_accounts a
      WHERE a.id = n.account_id AND n.last_activity_at < GREATEST(a.created_at, a.last_login_at,
        (SELECT max(s.last_seen_at) FROM consumer_sessions s WHERE s.account_id = a.id),
        (SELECT d.updated_at FROM account_data d WHERE d.account_id = a.id AND d.version > 0))`,
  );
  stats.voided = voided.rowCount ?? 0;

  for (const c of candidates) {
    const paid = await pool.query(
      `SELECT 1 FROM entitlements e WHERE e.account_id = $1 AND e.plan <> 'free' AND e.status IN ('active','cancelled')
          AND (e.current_period_end IS NULL OR e.current_period_end > $2)
        UNION ALL SELECT 1 FROM billing_subscriptions b WHERE b.account_id = $1 AND b.status = 'active' LIMIT 1`,
      [c.id, now],
    );
    if (paid.rowCount) {
      stats.skippedPaid++;
      continue;
    }
    if (!mailer) continue; // no email service: no warning can be sent, so nothing is deleted
    const sent = new Map(
      (await many<{ stage: number; sent_at: Date }>(pool, 'SELECT stage, sent_at FROM dormant_notices WHERE account_id = $1 AND last_activity_at = $2', [c.id, c.activity])).map((n) => [n.stage, n.sent_at]),
    );
    const stage = now.getTime() >= c.due.getTime() - 7 * DAY_MS ? 7 : 30;
    if (!sent.has(stage)) {
      const mail = dormantEmail(stage, c.due, settings.business.support_email);
      try {
        await mailer.send([c.email], mail.subject, mail.text);
      } catch (err) {
        log.warn({ err, stage }, 'dormant warning not sent');
        continue;
      }
      await pool.query(
        `INSERT INTO dormant_notices (account_id, stage, last_activity_at, sent_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (account_id, stage) DO UPDATE SET last_activity_at = EXCLUDED.last_activity_at, sent_at = EXCLUDED.sent_at`,
        [c.id, stage, c.activity, now],
      );
      if (stage === 7) stats.warned7++;
      else stats.warned30++;
      continue;
    }
    const warnedAt = sent.get(7);
    if (warnedAt && now.getTime() >= c.due.getTime() && now.getTime() >= addMinutes(warnedAt, 7 * 1440).getTime()) {
      await withTransaction(pool, async (q) => {
        await consumerAudit(q, c.id, 'account.dormant_deletion', 'account', c.id, null, { months }, now);
        await requestDeletion(q, config.sessionSecret, c.id, now, null);
      });
      stats.deletions++;
      metrics.inc('account.dormant_deleted');
    }
  }
  log.info({ ...stats, months }, 'dormant account sweep finished');
}
