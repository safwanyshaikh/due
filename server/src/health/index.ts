import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import type { AppConfig } from '../config.js';
import type { Queryable } from '../db.js';
import { one } from '../db.js';
import { actorOf, currentUser, requireRole } from '../http/context.js';
import { parse } from '../http/errors.js';
import { errorReporter } from '../observability/errorReporter.js';
import { metrics } from '../observability/metrics.js';
import { queueStats } from '../queue/index.js';

export type IntegrationState = 'ok' | 'not_configured' | 'degraded' | 'error';
export interface IntegrationEntry {
  status: IntegrationState;
  detail: string;
}
export type PublicMode = 'live' | 'test_mode' | 'verification_pending' | 'not_configured';

export const INCIDENT_KEY = 'incident.current';
export const IncidentSchema = z
  .object({
    level: z.enum(['info', 'minor', 'major', 'critical']),
    message: z.string().trim().min(1).max(500),
  })
  .strict();
export interface Incident {
  level: 'info' | 'minor' | 'major' | 'critical';
  message: string;
  updatedAt: string;
}

export async function getIncident(q: Queryable): Promise<Incident | null> {
  const row = await one<{ value: unknown }>(q, 'SELECT value FROM settings WHERE key = $1', [INCIDENT_KEY]);
  const v = row?.value as Partial<Incident> | null | undefined;
  if (!v || typeof v !== 'object' || !v.level || !v.message) return null;
  return { level: v.level, message: v.message, updatedAt: String(v.updatedAt ?? '') };
}

const TEST_SMTP = /(mailtrap|ethereal|mailhog|mailpit|smtp4dev|localhost|127\.0\.0\.1)/i;

/** Honest per-integration modes the app uses to label features (GET /api/public/status). */
export function publicModes(config: AppConfig, hasMailer: boolean): { smtp: PublicMode; inbound: PublicMode; gmail: PublicMode; billing: PublicMode } {
  const smtp: PublicMode = !hasMailer || !config.smtpUrl ? 'not_configured' : TEST_SMTP.test(config.smtpUrl) ? 'test_mode' : 'live';
  const inbound: PublicMode = config.inboundEmailDomain && config.inboundWebhookSecret ? 'live' : 'not_configured';
  const gmail: PublicMode = config.gmail?.mode ?? 'not_configured';
  const billing: PublicMode = !config.razorpay ? 'not_configured' : config.razorpay.keyId.startsWith('rzp_test_') ? 'test_mode' : 'live';
  return { smtp, inbound, gmail, billing };
}

async function count(q: Queryable, sql: string, params: unknown[]): Promise<number> {
  try {
    return Number((await q.query<{ n: number }>(sql, params)).rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/** One entry per integration for the protected admin view; a missing optional integration is not_configured. */
export async function checkIntegrations(app: FastifyInstance): Promise<Record<string, IntegrationEntry>> {
  const { pool, config, clock, mailer } = app.deps;
  const now = clock();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const out: Record<string, IntegrationEntry> = {};

  const t0 = performance.now();
  let dbOk = true;
  try {
    await pool.query('SELECT 1');
    out.db = { status: 'ok', detail: `Connected (${Math.round(performance.now() - t0)} ms)` };
  } catch (err) {
    dbOk = false;
    out.db = { status: 'error', detail: `Database unreachable: ${(err as Error).name}` };
  }

  if (dbOk) {
    const q = await queueStats(pool, now);
    if (!q.heartbeatFresh) {
      out.queue = {
        status: 'error',
        detail: q.lastHeartbeatAt ? `No worker heartbeat since ${q.lastHeartbeatAt.toISOString()}` : 'No queue worker has ever reported (is the due-worker service running?)',
      };
    } else if (q.deadLast24h > 0 || (q.oldestDueSeconds ?? 0) > 600) {
      out.queue = { status: 'degraded', detail: `${q.deadLast24h} dead job(s) in 24h; oldest due job waiting ${q.oldestDueSeconds ?? 0}s` };
    } else {
      out.queue = { status: 'ok', detail: `${q.workers.length} worker(s); ${q.counts.queued} queued, ${q.counts.running} running` };
    }
  } else {
    out.queue = { status: 'error', detail: 'Database unreachable' };
  }

  out.encryption = config.dataEncryptionKey
    ? { status: 'ok', detail: 'DATA_ENCRYPTION_KEY set: raw intake content is encrypted at rest (AES-256-GCM)' }
    : { status: 'not_configured', detail: 'DATA_ENCRYPTION_KEY not set: raw content is never stored (structured fields only)' };

  const modes = publicModes(config, Boolean(mailer));
  if (modes.smtp === 'not_configured') {
    out.smtp = { status: 'not_configured', detail: 'SMTP_URL not set: sign-in links, invites and email reminders are unavailable' };
  } else {
    const failed = await count(pool, `SELECT count(*)::int AS n FROM reminder_deliveries WHERE status = 'failed' AND created_at > $1`, [dayAgo]);
    const sent = await count(pool, `SELECT count(*)::int AS n FROM reminder_deliveries WHERE status = 'sent' AND created_at > $1`, [dayAgo]);
    out.smtp =
      failed >= 3 && failed > sent
        ? { status: 'degraded', detail: `${failed} failed vs ${sent} sent reminder emails in 24h` }
        : { status: 'ok', detail: `${modes.smtp === 'test_mode' ? 'Test SMTP server' : 'Configured'}; ${sent} reminder email(s) accepted in 24h` };
  }

  if (modes.inbound === 'not_configured') {
    out.inbound = { status: 'not_configured', detail: 'INBOUND_EMAIL_DOMAIN and INBOUND_WEBHOOK_SECRET are required for forwarding' };
  } else {
    const failed = await count(pool, `SELECT count(*)::int AS n FROM inbound_messages WHERE status = 'failed' AND received_at > $1`, [dayAgo]);
    out.inbound = failed
      ? { status: 'degraded', detail: `${failed} inbound message(s) failed to parse in 24h` }
      : { status: 'ok', detail: `Forwarding live on ${config.inboundEmailDomain}` };
  }

  const g = config.gmail;
  out.gmail_oauth =
    !g || g.mode === 'not_configured'
      ? { status: 'not_configured', detail: g?.missing?.length ? `Missing: ${g.missing.join(', ')}` : 'Google OAuth is not configured' }
      : { status: 'ok', detail: `Mode: ${g.mode}` };

  out.ocr_storage = {
    status: 'not_configured',
    detail: `No OCR provider configured: documents are read from extracted/pasted text only. Raw content storage: ${config.dataEncryptionKey ? 'encrypted' : 'disabled'}`,
  };

  if (!config.razorpay) {
    out.billing = { status: 'not_configured', detail: 'Razorpay keys not set: checkout returns payments_unavailable' };
  } else {
    const failures = metrics.counter('billing.webhook', { outcome: 'invalid_signature' }) + metrics.counter('billing.webhook', { outcome: 'error' });
    out.billing = failures
      ? { status: 'degraded', detail: `${failures} rejected/failed webhook(s) since start (${modes.billing})` }
      : { status: 'ok', detail: `Razorpay ${modes.billing === 'test_mode' ? 'test mode' : 'live'}` };
  }

  const rep = errorReporter();
  out.error_tracking = rep.configured
    ? { status: rep.failed > 0 && rep.sent === 0 ? 'degraded' : 'ok', detail: `SENTRY_DSN set; ${rep.sent} sent, ${rep.failed} failed since start` }
    : { status: 'not_configured', detail: 'SENTRY_DSN not set: errors are logged only' };

  return out;
}

/** /health/live, /health/ready and GET /api/public/status (no auth). */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const { pool, config, clock, mailer } = app.deps;

  app.get('/health/live', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { ok: true };
  });

  app.get('/health/ready', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    let db = false;
    let queue = false;
    let queueDetail = 'database unreachable';
    try {
      await pool.query('SELECT 1');
      db = true;
      const q = await queueStats(pool, clock());
      queue = q.heartbeatFresh;
      queueDetail = queue ? 'worker heartbeat fresh' : 'no worker heartbeat in the last 2 minutes';
    } catch {
      /* reported below */
    }
    const ok = db && queue;
    return reply.code(ok ? 200 : 503).send({ ok, checks: { db: db ? 'ok' : 'error', queue: queue ? 'ok' : 'error' }, detail: { queue: queueDetail } });
  });

  app.get('/api/public/status', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=30');
    const incident: Incident | null = await getIncident(pool).catch(() => null);
    return { incident, integrations: publicModes(config, Boolean(mailer)) };
  });
}

/** Admin: GET /api/admin/health/integrations and PATCH /api/admin/incident (under the /api/admin prefix). */
export async function healthAdminRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;

  app.get('/health/integrations', async () => {
    const integrations = await checkIntegrations(app);
    const queueDetail: unknown = await queueStats(pool, clock()).catch(() => null);
    // Each integration is a top-level entry (contract); `integrations` repeats them as one map for UIs.
    return { ...integrations, integrations, checkedAt: clock().toISOString(), queueStats: queueDetail, metrics: metrics.snapshot() };
  });

  app.get('/incident', async () => ({ incident: await getIncident(pool) }));

  app.patch('/incident', { preHandler: requireRole('admin') }, async (req) => {
    const body = parse(z.union([IncidentSchema, z.object({ clear: z.literal(true) }).strict(), z.null()]), req.body ?? null);
    const before = await getIncident(pool);
    const next: Incident | null = body && 'level' in body ? { ...body, updatedAt: clock().toISOString() } : null;
    await pool.query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [INCIDENT_KEY, JSON.stringify(next), currentUser(req).id, clock()],
    );
    await writeAudit(pool, actorOf(req), next ? 'incident.set' : 'incident.cleared', 'setting', INCIDENT_KEY, before, next);
    return { incident: next };
  });
}
