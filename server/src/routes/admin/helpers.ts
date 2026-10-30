import { z } from 'zod';
import type { Queryable } from '../../db.js';
import { badRequest } from '../../http/errors.js';
import { toSnake } from '../../util.js';

export const paging = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const uuidParam = z.object({ id: z.string().uuid() });
export const numericIdParam = z.object({ id: z.coerce.number().int().positive() });

export const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');

/** Builds "col = $n" pairs for a validated partial body (camelCase keys → snake_case columns). */
export function buildSet(
  patch: Record<string, unknown>,
  startIndex = 1,
  extra: Record<string, unknown> = {},
): { sql: string; values: unknown[] } {
  const entries = Object.entries({ ...patch, ...extra }).filter(([, v]) => v !== undefined);
  if (entries.length === 0) throw badRequest('No fields to update');
  const values: unknown[] = [];
  const parts = entries.map(([k, v], i) => {
    values.push(v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v);
    return `${toSnake(k)} = $${startIndex + i}`;
  });
  return { sql: parts.join(', '), values };
}

export async function count(q: Queryable, sql: string, params: unknown[] = []): Promise<number> {
  const r = await q.query<{ n: number }>(sql, params);
  return Number(r.rows[0]?.n ?? 0);
}
