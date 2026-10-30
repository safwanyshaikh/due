import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeAudit } from '../audit.js';
import { withTransaction, type Pool, type PoolClient } from '../db.js';
import { DEFAULT_SETTINGS, getSettings } from '../settings.js';
import { canonicalJson, sha256, slugify } from '../util.js';

const SOURCE_CATEGORIES = ['official_site', 'product_page', 'pricing', 'terms', 'press', 'news', 'rss', 'help', 'api', 'document', 'social', 'secondary'] as const;

const evidenceSchema = z
  .object({
    fetchedAt: z.string().nullable().optional(),
    status: z.string(),
    title: z.string().nullable().optional(),
    excerpt: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
  })
  .passthrough();

const sourceSchema = z
  .object({
    url: z.string().url(),
    label: z.string().min(1),
    sourceCategory: z.enum(SOURCE_CATEGORIES).catch('secondary'),
    isOfficial: z.boolean().default(false),
    extractionMethod: z.enum(['html_text', 'rss', 'json', 'sitemap']).catch('html_text'),
    cssSelector: z.string().nullable().optional(),
    priority: z.enum(['critical', 'regular', 'secondary']).catch('regular'),
    frequencyMinutes: z.number().int().min(15).optional(),
    evidence: evidenceSchema.nullable().optional(),
  })
  .passthrough();

const intelSchema = z.record(z.string(), z.unknown());

const vendorSchema = z
  .object({
    name: z.string().min(1),
    slug: z.string().optional(),
    kind: z.enum(['company', 'vendor']).catch('vendor'),
    officialWebsite: z.string().url().nullable().optional(),
    country: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    sources: z.array(sourceSchema).default([]),
    offerPatterns: z.array(intelSchema).optional(),
    partners: z.array(z.union([intelSchema, z.string()])).optional(),
  })
  .passthrough();

const registrySchema = z
  .object({ generatedAt: z.string().optional(), method: z.string().optional(), vendors: z.array(vendorSchema) })
  .passthrough();

export type Registry = z.infer<typeof registrySchema>;

export interface SeedStats {
  files: string[];
  companiesCreated: number;
  companiesExisting: number;
  sourcesCreated: number;
  sourcesExisting: number;
  intelCreated: number;
  offersCreated: number;
  offersExisting: number;
  warnings: string[];
}

export function emptyStats(): SeedStats {
  return { files: [], companiesCreated: 0, companiesExisting: 0, sourcesCreated: 0, sourcesExisting: 0, intelCreated: 0, offersCreated: 0, offersExisting: 0, warnings: [] };
}

export function parseRegistry(json: unknown): Registry {
  const r = registrySchema.safeParse(json);
  if (!r.success) throw new Error(`Invalid registry: ${r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return r.data;
}

export interface IntelItem {
  kind: 'offer_pattern' | 'partner';
  item: Record<string, unknown> | string;
  method: string;
}

export type MergedVendor = Registry['vendors'][number] & { slug: string; intel: IntelItem[] };

/** Merges vendors from several registry files by slug and dedupes their sources by URL. */
export function mergeRegistries(regs: Registry[]): MergedVendor[] {
  const bySlug = new Map<string, MergedVendor>();
  for (const reg of regs) {
    const method = reg.method ?? 'research_registry';
    for (const v of reg.vendors) {
      const slug = v.slug?.trim() || slugify(v.name);
      const intel: IntelItem[] = [
        ...(v.offerPatterns ?? []).map((item) => ({ kind: 'offer_pattern' as const, item, method })),
        ...(v.partners ?? []).map((item) => ({ kind: 'partner' as const, item: item as Record<string, unknown> | string, method })),
      ];
      const cur = bySlug.get(slug);
      if (!cur) {
        bySlug.set(slug, { ...v, slug, sources: [...v.sources], intel, offerPatterns: undefined, partners: undefined });
        continue;
      }
      cur.officialWebsite ??= v.officialWebsite;
      cur.country ??= v.country;
      cur.description ??= v.description;
      cur.category ??= v.category;
      const urls = new Set(cur.sources.map((s) => s.url));
      for (const s of v.sources) {
        if (!urls.has(s.url)) {
          urls.add(s.url);
          cur.sources.push(s);
        }
      }
      cur.intel.push(...intel);
    }
  }
  return [...bySlug.values()];
}

function evidenceState(ev: z.infer<typeof evidenceSchema> | null | undefined): {
  status: 'active' | 'inaccessible' | 'blocked_robots';
  lastSuccessAt: string | null;
  lastError: string | null;
} {
  if (!ev) return { status: 'active', lastSuccessAt: null, lastError: null };
  const fetchedAt = ev.fetchedAt && !Number.isNaN(Date.parse(ev.fetchedAt)) ? ev.fetchedAt : null;
  switch (ev.status) {
    case 'ok':
      return { status: 'active', lastSuccessAt: fetchedAt, lastError: null };
    case 'blocked_by_robots':
      return { status: 'blocked_robots', lastSuccessAt: null, lastError: ev.reason ?? 'Disallowed by robots.txt (research check)' };
    case 'js_only':
      return { status: 'inaccessible', lastSuccessAt: null, lastError: ev.reason ?? 'Page content requires JavaScript (research check)' };
    default:
      return { status: 'inaccessible', lastSuccessAt: null, lastError: ev.reason ?? `Research check status: ${ev.status}` };
  }
}

async function insertIntel(
  c: PoolClient,
  companyId: string,
  kind: 'offer_pattern' | 'partner',
  item: Record<string, unknown> | string,
  fileMethod: string,
): Promise<boolean> {
  const data = typeof item === 'string' ? { name: item } : item;
  const sourceUrl = typeof data.sourceUrl === 'string' ? data.sourceUrl : typeof data.source_url === 'string' ? data.source_url : null;
  const fetchedRaw = typeof data.fetchedAt === 'string' ? data.fetchedAt : null;
  const fetchedAt = fetchedRaw && !Number.isNaN(Date.parse(fetchedRaw)) ? fetchedRaw : null;
  const method = typeof data.method === 'string' ? data.method : fileMethod;
  const r = await c.query(
    `INSERT INTO vendor_intel (company_id, kind, data, source_url, fetched_at, method, data_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (company_id, kind, data_hash) DO NOTHING`,
    [companyId, kind, JSON.stringify(data), sourceUrl, fetchedAt, method, sha256(canonicalJson(data))],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Imports vendors/sources idempotently (companies by slug, sources by (company, url)).
 * Research evidence becomes the source's initial state only; excerpts are never stored as records.
 */
export async function importVendors(pool: Pool, vendors: MergedVendor[], stats: SeedStats): Promise<void> {
  const settings = await getSettings(pool).catch(() => DEFAULT_SETTINGS);
  await withTransaction(pool, async (c) => {
    for (const v of vendors) {
      const slug = v.slug;
      let categoryId: string | null = null;
      if (v.category) {
        categoryId = (
          await c.query<{ id: string }>(
            `INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
            [v.category],
          )
        ).rows[0]!.id;
      }
      const ins = await c.query<{ id: string }>(
        `INSERT INTO companies (kind, name, slug, official_website, description, country, category_id, verification_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'unverified') ON CONFLICT (slug) DO NOTHING RETURNING id`,
        [v.kind, v.name, slug, v.officialWebsite ?? null, v.description ?? null, v.country ?? null, categoryId],
      );
      let companyId: string;
      if (ins.rows[0]) {
        companyId = ins.rows[0].id;
        stats.companiesCreated++;
        await writeAudit(c, { userId: null, ip: null }, 'seed.company', 'company', companyId, null, { slug, name: v.name });
      } else {
        companyId = (await c.query<{ id: string }>('SELECT id FROM companies WHERE slug = $1', [slug])).rows[0]!.id;
        stats.companiesExisting++;
      }
      for (const s of v.sources) {
        const st = evidenceState(s.evidence);
        const freq = s.frequencyMinutes ?? settings.frequency_defaults[s.priority];
        const r = await c.query<{ id: string }>(
          `INSERT INTO sources (company_id, url, label, source_category, is_official, extraction_method, css_selector,
                                priority, frequency_minutes, enabled, status, last_success_at, last_checked_at, last_error, next_check_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,$11,$12,$13,now())
           ON CONFLICT (company_id, url) DO NOTHING RETURNING id`,
          [companyId, s.url, s.label, s.sourceCategory, s.isOfficial, s.extractionMethod, s.cssSelector ?? null,
            s.priority, freq, st.status, st.lastSuccessAt,
            s.evidence?.fetchedAt && !Number.isNaN(Date.parse(s.evidence.fetchedAt)) ? s.evidence.fetchedAt : null, st.lastError],
        );
        if (!r.rows[0]) {
          stats.sourcesExisting++;
          continue;
        }
        stats.sourcesCreated++;
        if (s.evidence?.status === 'ok' && st.lastSuccessAt) {
          await c.query(
            `INSERT INTO fetch_runs (source_id, started_at, finished_at, outcome, attempt, method, note)
             VALUES ($1,$2,$2,'unchanged',1,'research_webfetch',$3)`,
            [r.rows[0].id, st.lastSuccessAt, `Research check succeeded${s.evidence.title ? `: ${s.evidence.title.slice(0, 300)}` : ''}`],
          );
        }
      }
      for (const i of v.intel) if (await insertIntel(c, companyId, i.kind, i.item, i.method)) stats.intelCreated++;
    }
  });
}

const offerSeedSchema = z.object({
  id: z.string(),
  provider: z.string(),
  productFamily: z.string(),
  name: z.string(),
  benefitType: z.string(),
  priceInr: z.number().nullable(),
  billingPeriod: z.string().nullable(),
  benefitValue: z.record(z.string(), z.unknown()),
  sourceUrls: z.array(z.string().url()).min(1),
  officialEndAt: z.string().nullable(),
  termsStatus: z.string(),
  pageStatus: z.string(),
  computedStatus: z.string(),
  confidence: z.string(),
  notes: z.array(z.string()),
  verificationStatus: z.literal('research_snapshot'),
  observedAt: z.string(),
  lastConfirmedAt: z.string(),
  details: z.record(z.string(), z.unknown()),
});

/** Imports the research-snapshot offers (never overwrites an existing offer, so admin edits survive). */
export async function importOffers(pool: Pool, json: unknown, stats: SeedStats): Promise<void> {
  const doc = z.object({ offers: z.array(offerSeedSchema) }).parse(json);
  await withTransaction(pool, async (c) => {
    for (const o of doc.offers) {
      const ids = (await c.query<{ id: string }>('SELECT id FROM sources WHERE url = ANY($1)', [o.sourceUrls])).rows.map((r) => r.id);
      const r = await c.query(
        `INSERT INTO offers (id, provider, product_family, name, benefit_type, price_inr, billing_period, benefit_value,
                             source_ids, source_urls, official_end_at, terms_status, page_status, computed_status, confidence,
                             notes, details, verification_status, observed_at, last_confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (id) DO NOTHING`,
        [o.id, o.provider, o.productFamily, o.name, o.benefitType, o.priceInr, o.billingPeriod, JSON.stringify(o.benefitValue),
          ids, o.sourceUrls, o.officialEndAt, o.termsStatus, o.pageStatus, o.computedStatus, o.confidence, o.notes,
          JSON.stringify(o.details), o.verificationStatus, o.observedAt, o.lastConfirmedAt],
      );
      if ((r.rowCount ?? 0) > 0) stats.offersCreated++;
      else {
        stats.offersExisting++;
        // Link sources that were imported after the offer.
        await c.query(`UPDATE offers SET source_ids = $2 WHERE id = $1 AND cardinality(source_ids) = 0 AND cardinality($2::uuid[]) > 0`, [o.id, ids]);
      }
    }
  });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** seed:registry entry: both registry files (either may be missing) plus the offers snapshot. */
export async function seedAll(pool: Pool, files: { registries: string[]; offers: string | null }): Promise<SeedStats> {
  const stats = emptyStats();
  const regs: Registry[] = [];
  for (const f of files.registries) {
    if (!existsSync(f)) {
      stats.warnings.push(`Skipped missing registry file ${f}`);
      continue;
    }
    regs.push(parseRegistry(readJson(f)));
    stats.files.push(f);
  }
  if (regs.length) {
    await importVendors(pool, mergeRegistries(regs), stats);
  }
  if (files.offers) {
    if (existsSync(files.offers)) {
      await importOffers(pool, readJson(files.offers), stats);
      stats.files.push(files.offers);
    } else {
      stats.warnings.push(`Skipped missing offers file ${files.offers}`);
    }
  }
  return stats;
}
