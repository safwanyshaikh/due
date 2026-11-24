import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorOf, requireRole } from '../../http/context.js';
import { badRequest, notFound, parse } from '../../http/errors.js';
import {
  createModule, getModule, getPack, listModules, listPacks, listResearch, retireModule, updateModule, updateResearch, upsertPack, verifyModule,
} from '../../savings/repo.js';
import {
  cityPackInputSchema, moduleInputSchema, modulePatchSchema, MODULE_STATUSES, RESEARCH_STATUSES, researchPatch, slug,
} from '../../savings/schemas.js';
import type { SavingsModule } from '../../savings/types.js';

const idParam = z.object({ id: slug });
const numId = z.object({ id: z.coerce.number().int().positive() });

export async function savingsAdminRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock } = app.deps;
  const editor = { preHandler: requireRole('editor') };

  app.get('/savings/modules', async (req) => {
    const q = parse(z.object({ status: z.enum(MODULE_STATUSES).optional() }), req.query);
    const items = await listModules(pool, q.status);
    return { items, total: items.length };
  });

  app.get('/savings/modules/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const m = await getModule(pool, id);
    if (!m) throw notFound('Module not found');
    return m;
  });

  app.post('/savings/modules', editor, async (req, reply) => {
    const b = parse(moduleInputSchema, req.body);
    return reply.code(201).send(await createModule(pool, actorOf(req), b, clock()));
  });

  app.put('/savings/modules/:id', editor, async (req) => {
    const { id } = parse(idParam, req.params);
    const b = parse(moduleInputSchema, req.body);
    if (b.id !== id) throw badRequest('Module id in the body must match the URL');
    return updateModule(pool, actorOf(req), id, b, clock());
  });

  // Partial update: merged onto the stored module, then validated as a whole.
  app.patch('/savings/modules/:id', editor, async (req) => {
    const { id } = parse(idParam, req.params);
    const patch = parse(modulePatchSchema, req.body);
    if (patch.id !== undefined && patch.id !== id) throw badRequest('Module id cannot change');
    const cur = await getModule(pool, id);
    if (!cur) throw notFound('Module not found');
    const { version: _v, updatedAt: _u, ...base } = cur as SavingsModule;
    const merged = parse(moduleInputSchema, { ...base, ...patch, id });
    return updateModule(pool, actorOf(req), id, merged, clock());
  });

  app.post('/savings/modules/:id/verify', editor, async (req) => {
    const { id } = parse(idParam, req.params);
    return verifyModule(pool, actorOf(req), id, clock());
  });
  app.post('/savings/modules/:id/retire', editor, async (req) => {
    const { id } = parse(idParam, req.params);
    return retireModule(pool, actorOf(req), id, clock());
  });

  app.get('/savings/city-packs', async (req) => {
    const q = parse(z.object({ status: z.enum(MODULE_STATUSES).optional() }), req.query);
    const items = await listPacks(pool, q.status);
    return { items, total: items.length };
  });
  app.get('/savings/city-packs/:id', async (req) => {
    const { id } = parse(idParam, req.params);
    const p = await getPack(pool, id);
    if (!p) throw notFound('City pack not found');
    return p;
  });
  app.put('/savings/city-packs/:id', editor, async (req, reply) => {
    const { id } = parse(idParam, req.params);
    const body = parse(cityPackInputSchema, req.body);
    const { pack, created } = await upsertPack(pool, actorOf(req), id, body, clock());
    return reply.code(created ? 201 : 200).send(pack);
  });

  app.get('/savings/research', async (req) => {
    const q = parse(z.object({ status: z.enum(RESEARCH_STATUSES).optional() }), req.query);
    const items = await listResearch(pool, q.status);
    return { items, total: items.length };
  });
  app.patch('/savings/research/:id', editor, async (req) => {
    const { id } = parse(numId, req.params);
    const patch = parse(
      researchPatch,
      req.body,
    );
    return updateResearch(pool, actorOf(req), id, patch);
  });
}
