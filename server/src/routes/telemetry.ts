import type { FastifyInstance } from 'fastify';
import { TelemetryBatch, unknownEventNames } from '../consumer/telemetry.js';
import { hasConsent } from '../consumer/consents.js';
import { AppError, parse } from '../http/errors.js';

const MAX_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Allow-listed, PII-free product telemetry, opt-in only. No cookie needed; linked to an account only when signed in
 * with the 'analytics' consent. Deleted with the account and after 13 months (retention.purge).
 */
export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  app.post('/api/telemetry', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const batch = parse(TelemetryBatch, req.body);
    const unknown = unknownEventNames(batch);
    if (unknown.length) throw new AppError(400, 'unknown_event', 'Unknown telemetry event name', { names: unknown });
    // M3: analytics are opt-in. The device must state its opt-in, and a signed-in account also needs its
    // recorded 'analytics' consent; otherwise nothing is stored.
    if (batch.optedIn !== true) throw new AppError(403, 'consent_required', 'Usage analytics are off on this device');
    if (req.account && !(await hasConsent(pool, req.account.id, 'analytics'))) {
      throw new AppError(403, 'consent_required', 'Usage analytics need your consent (Account > Consents)');
    }
    const now = clock();
    for (const e of batch.events) {
      const at = e.at ? new Date(e.at) : now;
      const ok = at.getTime() <= now.getTime() + 60_000 && now.getTime() - at.getTime() <= MAX_SKEW_MS;
      await pool.query('INSERT INTO telemetry_events (account_id, anon_id, name, props, at) VALUES ($1,$2,$3,$4,$5)', [
        req.account?.id ?? null,
        batch.anonId,
        e.name,
        JSON.stringify(e.props),
        ok ? at : now,
      ]);
    }
    return reply.code(202).send({ accepted: batch.events.length });
  });
}
