import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit.js';
import { many } from '../../db.js';
import { actorOf } from '../../http/context.js';

interface ExportRow {
  record_id: string;
  record_type: string;
  title: string | null;
  url: string | null;
  summary: string | null;
  published_at: Date | null;
  first_seen_at: Date;
  last_seen_at: Date;
  current_version: number;
  verification_status: string;
  company_name: string;
  company_slug: string;
  source_url: string | null;
  source_label: string | null;
  source_category: string | null;
  source_is_official: boolean | null;
  extraction_method: string | null;
  retrieved_at: Date | null;
}

export const EXPORT_COLUMNS: (keyof ExportRow)[] = [
  'record_id', 'record_type', 'title', 'url', 'summary', 'published_at', 'first_seen_at', 'last_seen_at',
  'current_version', 'verification_status', 'company_name', 'company_slug', 'source_url', 'source_label',
  'source_category', 'source_is_official', 'extraction_method', 'retrieved_at',
];

async function exportRows(app: FastifyInstance): Promise<ExportRow[]> {
  return many<ExportRow>(
    app.deps.pool,
    `SELECT r.id AS record_id, r.record_type, r.title, r.url, r.summary, r.published_at, r.first_seen_at, r.last_seen_at,
            r.current_version, r.verification_status, c.name AS company_name, c.slug AS company_slug,
            s.url AS source_url, s.label AS source_label, s.source_category, s.is_official AS source_is_official,
            s.extraction_method,
            (SELECT sn.fetched_at FROM record_versions v JOIN snapshots sn ON sn.id = v.snapshot_id
              WHERE v.record_id = r.id ORDER BY v.version DESC LIMIT 1) AS retrieved_at
       FROM records r JOIN companies c ON c.id = r.company_id LEFT JOIN sources s ON s.id = r.source_id
      WHERE r.verification_status IN ('approved','pending')
      ORDER BY c.name, r.last_seen_at DESC`,
  );
}

/** RFC 4180 quoting plus spreadsheet formula-injection protection. */
export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const ATTRIBUTION =
  'Each record is attributed to the public source it was extracted from (source_url, retrieved_at, extraction_method). Pending records are not yet verified by a reviewer.';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.get('/export/records.csv', async (req, reply) => {
    const rows = await exportRows(app);
    await writeAudit(app.deps.pool, actorOf(req), 'export.records_csv', 'export', null, null, { count: rows.length });
    const lines = [EXPORT_COLUMNS.join(','), ...rows.map((r) => EXPORT_COLUMNS.map((c) => csvCell(r[c])).join(','))];
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="due-records-${app.deps.clock().toISOString().slice(0, 10)}.csv"`);
    return `${lines.join('\r\n')}\r\n`;
  });

  app.get('/export/records.json', async (req, reply) => {
    const rows = await exportRows(app);
    await writeAudit(app.deps.pool, actorOf(req), 'export.records_json', 'export', null, null, { count: rows.length });
    reply.header('Content-Disposition', `attachment; filename="due-records-${app.deps.clock().toISOString().slice(0, 10)}.json"`);
    return {
      generatedAt: app.deps.clock().toISOString(),
      attribution: ATTRIBUTION,
      records: rows.map((r) => ({
        id: r.record_id,
        type: r.record_type,
        title: r.title,
        url: r.url,
        summary: r.summary,
        publishedAt: r.published_at,
        firstSeenAt: r.first_seen_at,
        lastSeenAt: r.last_seen_at,
        version: r.current_version,
        verificationStatus: r.verification_status,
        company: { name: r.company_name, slug: r.company_slug },
        source: {
          url: r.source_url,
          label: r.source_label,
          category: r.source_category,
          isOfficial: r.source_is_official,
          extractionMethod: r.extraction_method,
          retrievedAt: r.retrieved_at,
        },
      })),
    };
  });
}
