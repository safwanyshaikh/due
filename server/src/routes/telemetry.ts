import type { FastifyInstance } from 'fastify';
import { TelemetryBatch, unknownEventNames } from '../consumer/telemetry.js';
import { AppError, parse } from '../http/errors.js';

const MAX_SKEW_MS = 7 * 24 * 60 * 60 * 1000;

/** Allow-listed, PII-free product telemetry. No cookie needed; linked to an account only when signed in. */
export async function telemetryRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  app.post('/api/telemetry', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const batch = parse(TelemetryBatch, req.body);
    const unknown = unknownEventNames(batch);
    if (unknown.length) throw new AppError(400, 'unknown_event', 'Unknown telemetry event name', { names: unknown });
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
