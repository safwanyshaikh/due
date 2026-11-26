import type { Pool } from '../db.js';
import { postNdjson, type LogSinkOptions } from './logSink.js';
import { redactObject } from './redact.js';

/**
 * `audit.ship`: copies new audit_log, consumer_audit and login_events rows to LOG_SINK_URL (India-region,
 * write-once store), so a year of security audit history survives even if the primary database is lost or
 * tampered with. A per-table cursor (settings `log_sink.cursor`) makes it incremental; a failed POST leaves the
 * cursor where it was, so the rows are sent again on the next run. Values are redacted before they leave.
 */
const TABLES = [
  { table: 'audit_log', cols: 'id, actor_user_id, action, entity_type, entity_id, before, after, ip, at' },
  { table: 'consumer_audit', cols: 'id, account_id, action, entity, entity_id, before, after, at' },
  { table: 'login_events', cols: 'id, user_id, success, reason, ip, user_agent, at' },
] as const;

export const CURSOR_KEY = 'log_sink.cursor';
const BATCH = 1000;
/**
 * Only rows older than this are shipped. Ids come from sequences, so a row can commit after one with a higher id;
 * waiting until every transaction that could hold a lower id has finished means the cursor never skips a row.
 */
export const SHIP_SETTLE_MS = 5 * 60 * 1000;

/** Shipped-up-to id per table (purging is limited to shipped rows while a sink is configured). */
export async function shippedCursor(pool: Pool): Promise<Record<string, number>> {
  return (await pool.query<{ value: Record<string, number> }>('SELECT value FROM settings WHERE key = $1', [CURSOR_KEY])).rows[0]?.value ?? {};
}

export async function shipAuditRows(pool: Pool, sink: LogSinkOptions, now: Date = new Date()): Promise<Record<string, number>> {
  const cur = await shippedCursor(pool);
  const settled = new Date(now.getTime() - SHIP_SETTLE_MS);
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const from = Number(cur[t.table] ?? 0);
    const rows = (await pool.query(`SELECT ${t.cols} FROM ${t.table} WHERE id > $1 AND at < $2 ORDER BY id LIMIT ${BATCH}`, [from, settled])).rows as { id: string | number }[];
    if (!rows.length) {
      out[t.table] = 0;
      continue;
    }
    const lines = rows.map((r) => JSON.stringify({ table: t.table, row: redactAuditRow(r as Record<string, unknown>) }));
    const ok = await postNdjson(sink, 'audit', lines);
    if (!ok) {
      out[t.table] = -1;
      continue;
    }
    cur[t.table] = Number(rows[rows.length - 1]!.id);
    out[t.table] = rows.length;
  }
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [CURSOR_KEY, JSON.stringify(cur)],
  );
  return out;
}

/** Keys whose values are names or free text a person chose (household names, titles, labels): never shipped. */
const NAME_KEYS = /^(name|display_?name|label|title|nickname|provider|notes?|household|household_?name|invited_?email|subject|description)$/i;

function dropNames(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(v)) return v.map((x) => dropNames(x, depth + 1));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, NAME_KEYS.test(k) ? '[redacted]' : dropNames(x, depth + 1)]));
  }
  return v;
}

/** Ids, actions, timestamps and IPs are kept (they are the audit trail); payload values are redacted. */
export function redactAuditRow(r: Record<string, unknown>): Record<string, unknown> {
  const { before, after, ...rest } = r;
  const red = (x: unknown) => (x === null || x === undefined ? null : redactObject(dropNames(x)));
  return { ...rest, ...('user_agent' in rest ? { user_agent: rest.user_agent ? String(rest.user_agent).slice(0, 120) : null } : {}), before: red(before), after: red(after) };
}
