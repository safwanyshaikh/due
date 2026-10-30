import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { writeAudit } from '../../audit.js';
import { many, one, withTransaction } from '../../db.js';
import { actorOf, requireRole } from '../../http/context.js';
import { conflict, notFound, parse } from '../../http/errors.js';
import { camel, camelAll } from '../../util.js';
import { buildSet, uuidParam } from './helpers.js';

const body = z.object({ name: z.string().trim().min(1).max(120), description: z.string().max(2000).nullable().optional() }).strict();

export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  const { pool } = app.deps;
  const admin = { preHandler: requireRole('admin') };
  const unique = (err: unknown) => {
    if ((err as { code?: string }).code === '23505') throw conflict('A category with that name exists');
    throw err;
  };

  app.get('/categories', async () => {
    const rows = await many(
      pool,
      `SELECT cat.*, (SELECT count(*) FROM companies c WHERE c.category_id = cat.id) AS company_count
         FROM categories cat ORDER BY name`,
    );
    return { items: camelAll(rows), total: rows.length };
  });

  app.post('/categories', admin, async (req, reply) => {
    const b = parse(body, req.body);
    const row = await withTransaction(pool, async (c) => {
      const r = await one(c, 'INSERT INTO categories (name, description) VALUES ($1,$2) RETURNING *', [b.name, b.description ?? null]);
      await writeAudit(c, actorOf(req), 'category.create', 'category', r!.id as string, null, r);
      return r!;
    }).catch(unique);
    return reply.code(201).send(camel(row));
  });

  app.patch('/categories/:id', admin, async (req) => {
    const { id } = parse(uuidParam, req.params);
    const b = parse(body.partial(), req.body);
    const row = await withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM categories WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Category not found');
      const set = buildSet(b, 2);
      const after = await one(c, `UPDATE categories SET ${set.sql} WHERE id = $1 RETURNING *`, [id, ...set.values]);
      await writeAudit(c, actorOf(req), 'category.update', 'category', id, before, after);
      return after!;
    }).catch(unique);
    return camel(row);
  });

  app.delete('/categories/:id', admin, async (req) => {
    const { id } = parse(uuidParam, req.params);
    await withTransaction(pool, async (c) => {
      const before = await one(c, 'SELECT * FROM categories WHERE id = $1 FOR UPDATE', [id]);
      if (!before) throw notFound('Category not found');
      await c.query('DELETE FROM categories WHERE id = $1', [id]);
      await writeAudit(c, actorOf(req), 'category.delete', 'category', id, before, null);
    });
    return { ok: true };
  });
}
