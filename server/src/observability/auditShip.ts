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

const CURSOR_KEY = 'log_sink.cursor';
const BATCH = 1000;

export async function shipAuditRows(pool: Pool, sink: LogSinkOptions): Promise<Record<string, number>> {
  const cur = (await pool.query<{ value: Record<string, number> }>('SELECT value FROM settings WHERE key = $1', [CURSOR_KEY])).rows[0]?.value ?? {};
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    const from = Number(cur[t.table] ?? 0);
    const rows = (await pool.query(`SELECT ${t.cols} FROM ${t.table} WHERE id > $1 ORDER BY id LIMIT ${BATCH}`, [from])).rows as { id: string | number }[];
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

/** Ids, actions, timestamps and IPs are kept (they are the audit trail); payload values are redacted. */
function redactAuditRow(r: Record<string, unknown>): Record<string, unknown> {
  const { before, after, ...rest } = r;
  return { ...rest, before: before === null ? null : redactObject(before), after: after === null ? null : redactObject(after) };
}
