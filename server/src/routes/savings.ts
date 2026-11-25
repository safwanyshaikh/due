import type { FastifyInstance } from 'fastify';
import { parse } from '../http/errors.js';
import { addReport, buildCatalog, changesSince, community, queueResearch } from '../savings/repo.js';
import { changesQuery, communityQuery, reportBody, researchBody } from '../savings/schemas.js';

/** Public, anonymous savings endpoints: no session, no account id, no personal amounts are stored. */
export async function savingsPublicRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;

  app.get('/api/public/savings/catalog', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');
    return buildCatalog(pool, clock());
  });

  // Which catalog entries changed since the version the device holds. Carries no user data in either direction.
  app.get('/api/public/savings/catalog/changes', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = parse(changesQuery, req.query);
    reply.header('Cache-Control', 'public, max-age=60');
    return changesSince(pool, q.since, clock());
  });

  app.post('/api/public/savings/research', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = parse(researchBody, req.body);
    reply.header('Cache-Control', 'no-store');
    return queueResearch(pool, b, clock());
  });

  app.post('/api/public/savings/report', { config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async (req, reply) => {
    const b = parse(reportBody, req.body);
    await addReport(pool, b, clock());
    return reply.code(204).send();
  });

  app.get('/api/public/savings/community', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = parse(communityQuery, req.query);
    reply.header('Cache-Control', 'public, max-age=300');
    return community(pool, q.cityPack);
  });
}
