import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { buildPublicCatalog } from '../catalog.js';

const CACHE_MS = 5 * 60 * 1000;

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock, config } = app.deps;
  const allowed = new Set(config.publicAppOrigins);
  await app.register(cors, {
    origin: (origin, cb) => cb(null, origin !== undefined && allowed.has(origin)),
    methods: ['GET'],
    credentials: false,
    maxAge: 600,
  });

  let cache: { at: number; body: unknown } | null = null;
  app.get('/api/public/catalog', async (_req, reply) => {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      cache = { at: Date.now(), body: await buildPublicCatalog(pool, clock()) };
    }
    reply.header('Cache-Control', 'public, max-age=300');
    return cache.body;
  });

  app.get('/api/health', async (_req, reply) => {
    let db: boolean;
    let lastRunAt: Date | null = null;
    try {
      const r = await pool.query<{ last: Date | null }>('SELECT max(last_run_at) AS last FROM jobs');
      db = true;
      lastRunAt = r.rows[0]?.last ?? null;
    } catch {
      db = false;
    }
    reply.header('Cache-Control', 'no-store');
    return reply.code(db ? 200 : 503).send({ ok: db, db, scheduler: { lastRunAt, enabledOnThisInstance: config.runScheduler } });
  });
}
