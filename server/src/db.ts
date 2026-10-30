import pg from 'pg';

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

// Return bigint columns (bigserial ids, counts) as JS numbers; values stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric -> number
pg.types.setTypeParser(1700, (v) => Number(v));
// date -> 'YYYY-MM-DD' string (no timezone shifting)
pg.types.setTypeParser(1082, (v) => v);

export function createPool(databaseUrl: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max, idleTimeoutMillis: 30_000 });
}

export async function withTransaction<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T = Record<string, unknown>>(
  q: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const r = await q.query(sql, params);
  return (r.rows[0] as T | undefined) ?? null;
}

export async function many<T = Record<string, unknown>>(
  q: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await q.query(sql, params);
  return r.rows as T[];
}
