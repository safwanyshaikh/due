import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { consumerAudit, currentAccount, requireAccount, requireFeature } from '../consumer/context.js';
import { many } from '../db.js';
import { registerGmailJobs } from '../gmail/index.js';
import {
  completeCallback,
  disconnectIdentity,
  enqueueScan,
  GMAIL_FEATURE,
  gmailStatus,
  requireGmailConfigured,
  startConnect,
} from '../gmail/service.js';
import { notFound, parse } from '../http/errors.js';
import { getOwnedIdentity } from '../identities/service.js';
import { camelAll, normaliseKeys } from '../util.js';

/** Read-only Gmail connection (OAuth authorization code + PKCE) and on-demand scans. */
export async function gmailRoutes(app: FastifyInstance): Promise<void> {
  const { pool, config, clock } = app.deps;
  const deps = { pool, config, clock, log: app.log };
  // The web process may also run the queue worker; registering here is idempotent.
  registerGmailJobs();

  // Honest server-wide mode: not_configured | test_mode | verification_pending | live.
  app.get('/api/account/gmail/status', async () => gmailStatus(config));

  app.post('/api/account/gmail/connect', { preHandler: requireAccount, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const a = currentAccount(req);
    requireGmailConfigured(config);
    await requireFeature(GMAIL_FEATURE)(req, reply);
    const body = parse(z.object({ consentVersion: z.string().trim().min(1).max(64) }).strict(), normaliseKeys(req.body));
    const r = await startConnect(deps, a.id, body.consentVersion);
    await consumerAudit(pool, a.id, 'gmail.connect_started', 'gmail', null, null, { consentVersion: body.consentVersion }, clock());
    return { authorizeUrl: r.authorizeUrl, expiresAt: r.expiresAt };
  });

  // Google redirects the browser here. Always answers with a redirect to the app; never echoes the code or state.
  app.get('/api/account/gmail/callback', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const r = await completeCallback(deps, req.account?.id ?? null, { state: str(q.state), code: str(q.code), error: str(q.error) });
    reply.header('Cache-Control', 'no-store');
    if (r.ok) {
      await consumerAudit(pool, req.account!.id, 'gmail.connected', 'email_identity', r.identityId, null, null, clock());
      return reply.redirect(`/?gmail=connected&identity=${encodeURIComponent(r.identityId)}`, 302);
    }
    req.log.info({ reason: r.reason }, 'gmail callback rejected');
    return reply.redirect(`/?gmail=error&reason=${encodeURIComponent(r.reason)}`, 302);
  });

  app.post(
    '/api/account/gmail/:identityId/scan',
    { preHandler: requireFeature(GMAIL_FEATURE), config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const a = currentAccount(req);
      requireGmailConfigured(config);
      const { identityId } = req.params as { identityId: string };
      const r = await enqueueScan(deps, a.id, identityId, 'manual');
      return reply.code(202).send({ ok: true, runId: r.runId, jobId: r.jobId });
    },
  );

  app.get('/api/account/gmail/:identityId/scans', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const { identityId } = req.params as { identityId: string };
    const ident = await getOwnedIdentity(pool, a.id, identityId);
    if (!ident || ident.kind !== 'gmail') throw notFound('Gmail identity not found');
    const rows = await many(
      pool,
      `SELECT id, trigger, status, requested_at, started_at, finished_at, messages_listed, messages_new, events_created, duplicates,
              attachments_skipped, error_code FROM gmail_scan_runs WHERE identity_id = $1 ORDER BY requested_at DESC LIMIT 20`,
      [identityId],
    );
    return { items: camelAll(rows) };
  });

  // Disconnect never requires a paid plan: a user can always revoke access.
  app.post('/api/account/gmail/:identityId/disconnect', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const { identityId } = req.params as { identityId: string };
    const body = parse(z.object({ deleteImported: z.boolean().default(false) }).strict(), normaliseKeys(req.body ?? {}));
    const ident = await getOwnedIdentity(pool, a.id, identityId);
    if (!ident || ident.kind !== 'gmail') throw notFound('Gmail identity not found');
    const r = await disconnectIdentity(deps, a.id, identityId, { deleteImported: body.deleteImported });
    await consumerAudit(pool, a.id, 'gmail.disconnected', 'email_identity', identityId, null, { deleteImported: body.deleteImported, revoked: r.revoked }, clock());
    return {
      ok: true,
      revoked: r.revoked,
      deleted: r.deleted,
      ...(r.revoked ? {} : { manualRevokeUrl: 'https://myaccount.google.com/permissions' }),
    };
  });
}
