import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeAudit, type AuditActor } from '../audit.js';
import { many, one, withTransaction, type Pool, type Queryable } from '../db.js';
import { AppError, conflict, notFound } from '../http/errors.js';
import { canonicalJson, sha256 } from '../util.js';
import { cityPackSeedSchema, moduleSeedSchema, roundSaved } from './schemas.js';
import { COMMUNITY_THRESHOLD, VERIFY_MAX_AGE_DAYS, type CityPack, type SavingsCatalog, type SavingsModule, type ValueKind } from './types.js';

const DAY_MS = 86_400_000;

interface DataRow {
  id: string;
  version?: number;
  status: string;
  data: Record<string, unknown>;
  updated_at: Date;
}

function toModule(r: DataRow): SavingsModule {
  return { ...(r.data as unknown as SavingsModule), id: r.id, version: r.version ?? 1, status: r.status as SavingsModule['status'], updatedAt: r.updated_at.toISOString() };
}
function toPack(r: DataRow): CityPack {
  return { ...(r.data as unknown as CityPack), id: r.id, status: r.status as CityPack['status'], updatedAt: r.updated_at.toISOString() };
}

/* ---------- verification rule ---------- */

/** A module may be `verified` only with an official source whose page was checked within the last 30 days. */
export function hasFreshOfficialSource(m: Pick<SavingsModule, 'sources'>, now: Date): boolean {
  return m.sources.some((s) => {
    if (s.kind !== 'official' || !s.lastVerifiedAt) return false;
    const t = Date.parse(s.lastVerifiedAt);
    return Number.isFinite(t) && t <= now.getTime() + DAY_MS && now.getTime() - t <= VERIFY_MAX_AGE_DAYS * DAY_MS;
  });
}

export const unverifiable = () =>
  new AppError(422, 'verification_required', `Verification needs an official source checked within the last ${VERIFY_MAX_AGE_DAYS} days (set its last verified date after checking the page).`);

/* ---------- modules ---------- */

export async function listModules(q: Queryable, status?: string): Promise<SavingsModule[]> {
  const rows = await many<DataRow>(q, `SELECT * FROM savings_modules WHERE ($1::text IS NULL OR status = $1) ORDER BY id`, [status ?? null]);
  return rows.map(toModule);
}

export async function getModule(q: Queryable, id: string): Promise<SavingsModule | null> {
  const r = await one<DataRow>(q, 'SELECT * FROM savings_modules WHERE id = $1', [id]);
  return r ? toModule(r) : null;
}

function stored(m: Omit<SavingsModule, 'version' | 'updatedAt'>): string {
  const { id: _id, ...rest } = m;
  return JSON.stringify(rest);
}

export async function createModule(pool: Pool, actor: AuditActor, input: Omit<SavingsModule, 'version' | 'updatedAt'>, now: Date): Promise<SavingsModule> {
  if (input.status === 'verified') throw new AppError(422, 'verification_required', 'Create modules as research, then verify them.');
  return withTransaction(pool, async (c) => {
    if (await one(c, 'SELECT id FROM savings_modules WHERE id = $1', [input.id])) throw conflict('Module id already exists');
    const prev = await catalogVersion(c, now);
    const r = await one<DataRow>(
      c,
      `INSERT INTO savings_modules (id, version, status, data, updated_at) VALUES ($1, 1, $2, $3, $4) RETURNING *`,
      [input.id, input.status, stored(input), now],
    );
    const m = toModule(r!);
    await writeAudit(c, actor, 'savings.module.create', 'savings_module', m.id, null, m);
    await recordChange(c, 'module', m.id, 'new', `New: ${m.product} (${m.provider})`, prev, now);
    return m;
  });
}

/** Replaces a module (version +1). Status changes to `verified` only via verifyModule; a verified module must stay verifiable. */
export async function updateModule(pool: Pool, actor: AuditActor, id: string, input: Omit<SavingsModule, 'version' | 'updatedAt'>, now: Date): Promise<SavingsModule> {
  return withTransaction(pool, async (c) => {
    const cur = await one<DataRow>(c, 'SELECT * FROM savings_modules WHERE id = $1 FOR UPDATE', [id]);
    if (!cur) throw notFound('Module not found');
    const prev = await catalogVersion(c, now);
    const before = toModule(cur);
    if (input.status === 'verified' && before.status !== 'verified') throw new AppError(422, 'verification_required', 'Use the verify action to mark a module verified.');
    if (input.status === 'verified' && !hasFreshOfficialSource(input, now)) throw unverifiable();
    const r = await one<DataRow>(
      c,
      `UPDATE savings_modules SET version = version + 1, status = $2, data = $3, updated_at = $4 WHERE id = $1 RETURNING *`,
      [id, input.status, stored({ ...input, id }), now],
    );
    const m = toModule(r!);
    await writeAudit(c, actor, 'savings.module.update', 'savings_module', id, before, m);
    await recordChange(c, 'module', id, 'updated', `Updated: ${m.product} (${m.provider})`, prev, now);
    return m;
  });
}

async function setStatus(pool: Pool, actor: AuditActor, id: string, status: 'verified' | 'retired', action: string, now: Date): Promise<SavingsModule> {
  return withTransaction(pool, async (c) => {
    const cur = await one<DataRow>(c, 'SELECT * FROM savings_modules WHERE id = $1 FOR UPDATE', [id]);
    if (!cur) throw notFound('Module not found');
    const prev = await catalogVersion(c, now);
    const before = toModule(cur);
    if (status === 'verified' && !hasFreshOfficialSource(before, now)) throw unverifiable();
    if (before.status === status) return before;
    const r = await one<DataRow>(
      c,
      `UPDATE savings_modules SET version = version + 1, status = $2, data = jsonb_set(data, '{status}', to_jsonb($2::text)), updated_at = $3 WHERE id = $1 RETURNING *`,
      [id, status, now],
    );
    const m = toModule(r!);
    await writeAudit(c, actor, action, 'savings_module', id, before, m);
    await recordChange(c, 'module', id, status === 'verified' ? 'verified' : 'retired', `${status === 'verified' ? 'Verified' : 'Retired'}: ${m.product} (${m.provider})`, prev, now);
    return m;
  });
}
export const verifyModule = (pool: Pool, actor: AuditActor, id: string, now: Date) => setStatus(pool, actor, id, 'verified', 'savings.module.verify', now);
export const retireModule = (pool: Pool, actor: AuditActor, id: string, now: Date) => setStatus(pool, actor, id, 'retired', 'savings.module.retire', now);

/* ---------- city packs ---------- */

export async function listPacks(q: Queryable, status?: string): Promise<CityPack[]> {
  const rows = await many<DataRow>(q, `SELECT * FROM city_packs WHERE ($1::text IS NULL OR status = $1) ORDER BY id`, [status ?? null]);
  return rows.map(toPack);
}
export async function getPack(q: Queryable, id: string): Promise<CityPack | null> {
  const r = await one<DataRow>(q, 'SELECT * FROM city_packs WHERE id = $1', [id]);
  return r ? toPack(r) : null;
}
export async function upsertPack(pool: Pool, actor: AuditActor, id: string, input: Omit<CityPack, 'id' | 'updatedAt'>, now: Date): Promise<{ pack: CityPack; created: boolean }> {
  return withTransaction(pool, async (c) => {
    const prev = await catalogVersion(c, now);
    const beforeRow = await one<DataRow>(c, 'SELECT * FROM city_packs WHERE id = $1 FOR UPDATE', [id]);
    const before = beforeRow ? toPack(beforeRow) : null;
    const r = await one<DataRow>(
      c,
      `INSERT INTO city_packs (id, status, data, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = EXCLUDED.updated_at RETURNING *`,
      [id, input.status, JSON.stringify(input), now],
    );
    const pack = toPack(r!);
    await writeAudit(c, actor, before ? 'savings.city_pack.update' : 'savings.city_pack.create', 'city_pack', id, before, pack);
    await recordChange(c, 'city_pack', id, before ? 'updated' : 'new', `City pack ${before ? 'updated' : 'added'}: ${pack.name}`, prev, now);
    return { pack, created: !before };
  });
}

/* ---------- change log (public: GET /api/public/savings/catalog/changes) ---------- */

/** Records a catalog change with the catalog version AFTER it, so a device holding that version can ask what came next. */
export async function recordChange(c: Queryable, entity: 'module' | 'city_pack', entityId: string, kind: 'new' | 'updated' | 'verified' | 'retired', summary: string, prevVersion: string, now: Date): Promise<void> {
  const version = (await buildCatalog(c, now)).version;
  await c.query(
    `INSERT INTO savings_changes (entity, entity_id, kind, summary, prev_version, catalog_version, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [entity, entityId, kind, summary.slice(0, 200), prevVersion, version, now],
  );
}

/** Catalog version as of now; call before a write so the change log can link "before" and "after". */
export const catalogVersion = async (q: Queryable, now: Date): Promise<string> => (await buildCatalog(q, now)).version;

export interface CatalogChange {
  entity: 'module' | 'city_pack';
  id: string;
  kind: string;
  summary: string;
  changedAt: string;
}

/** Changes after the state `since` (a catalog version). An unknown `since` returns the last 14 days with reset = true. */
export async function changesSince(q: Queryable, since: string | undefined, now: Date): Promise<{ version: string; since: string | null; reset: boolean; changes: CatalogChange[]; moduleIds: string[] }> {
  const version = (await buildCatalog(q, now)).version;
  let afterId = 0;
  let reset = false;
  if (since === version) return { version, since, reset: false, changes: [], moduleIds: [] };
  const after = since ? await one<{ id: number }>(q, 'SELECT max(id) AS id FROM savings_changes WHERE catalog_version = $1', [since]) : null;
  const before = since ? await one<{ id: number }>(q, 'SELECT min(id) AS id FROM savings_changes WHERE prev_version = $1', [since]) : null;
  if (after?.id) afterId = after.id;
  else if (before?.id) afterId = before.id - 1;
  else reset = true;
  const rows = await many<{ id: number; entity: 'module' | 'city_pack'; entity_id: string; kind: string; summary: string; changed_at: Date }>(
    q,
    `SELECT * FROM savings_changes WHERE id > $1 AND ($2::boolean = false OR changed_at > $3) ORDER BY id DESC LIMIT 500`,
    [afterId, reset, new Date(now.getTime() - 14 * DAY_MS)],
  );
  const seen = new Set<string>();
  const changes: CatalogChange[] = [];
  for (const r of rows) {
    const key = `${r.entity}:${r.entity_id}`;
    if (seen.has(key)) continue; // newest change per entity wins
    seen.add(key);
    changes.push({ entity: r.entity, id: r.entity_id, kind: r.kind, summary: r.summary, changedAt: r.changed_at.toISOString() });
  }
  return { version, since: since ?? null, reset, changes: changes.slice(0, 100), moduleIds: changes.filter((c) => c.entity === 'module').map((c) => c.id).slice(0, 100) };
}

/* ---------- catalog ---------- */

export async function buildCatalog(q: Queryable, now: Date): Promise<SavingsCatalog> {
  const [mods, packs] = await Promise.all([
    many<DataRow>(q, `SELECT * FROM savings_modules WHERE status IN ('verified','research') ORDER BY id`),
    many<DataRow>(q, `SELECT * FROM city_packs WHERE status IN ('verified','research') ORDER BY id`),
  ]);
  const modules = mods.map(toModule);
  // Retired passes are never published, even inside a live pack.
  const cityPacks = packs.map(toPack).map((p) => ({ ...p, passes: p.passes.filter((x) => x.status !== 'retired') }));
  const version = sha256(canonicalJson({ modules, cityPacks })).slice(0, 16);
  return { version, generatedAt: now.toISOString(), modules, cityPacks };
}

/* ---------- research queue ---------- */

export interface ResearchRow {
  id: number;
  providerLabel: string;
  category: string;
  cityPack: string | null;
  requestCount: number;
  firstSeen: string;
  lastSeen: string;
  status: string;
  moduleId: string | null;
}
interface ResearchDb {
  id: number; provider_label: string; category: string; city_pack: string | null; request_count: number;
  first_seen: Date; last_seen: Date; status: string; module_id: string | null;
}
const toResearch = (r: ResearchDb): ResearchRow => ({
  id: r.id, providerLabel: r.provider_label, category: r.category, cityPack: r.city_pack, requestCount: r.request_count,
  firstSeen: r.first_seen.toISOString(), lastSeen: r.last_seen.toISOString(), status: r.status, moduleId: r.module_id,
});

/** Finds a non-retired module that already covers this provider label. */
export async function findKnownModule(q: Queryable, label: string): Promise<string | null> {
  const r = await one<{ id: string }>(
    q,
    `SELECT id FROM savings_modules
      WHERE status <> 'retired'
        AND (lower(data->>'provider') = $1 OR lower(data->>'product') = $1
             OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(data->'detect'->'merchantAliases', '[]'::jsonb)) a WHERE lower(a) = $1))
      ORDER BY id LIMIT 1`,
    [label.toLowerCase()],
  );
  return r?.id ?? null;
}

export async function queueResearch(
  q: Queryable,
  input: { providerLabel: string; category: string; cityPack?: string },
  now: Date,
): Promise<{ status: 'queued' | 'known'; moduleId?: string }> {
  const label = input.providerLabel.trim().replace(/\s+/g, ' ');
  const known = await findKnownModule(q, label);
  if (known) return { status: 'known', moduleId: known };
  const r = await one<ResearchDb>(
    q,
    `INSERT INTO research_requests (provider_label, category, city_pack, first_seen, last_seen) VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT (lower(provider_label), category)
     DO UPDATE SET request_count = research_requests.request_count + 1, last_seen = EXCLUDED.last_seen,
                   city_pack = COALESCE(research_requests.city_pack, EXCLUDED.city_pack)
     RETURNING *`,
    [label, input.category, input.cityPack ?? null, now],
  );
  if (r?.module_id) return { status: 'known', moduleId: r.module_id };
  return { status: 'queued' };
}

export async function listResearch(q: Queryable, status?: string): Promise<ResearchRow[]> {
  const rows = await many<ResearchDb>(
    q,
    `SELECT * FROM research_requests WHERE ($1::text IS NULL OR status = $1) ORDER BY request_count DESC, last_seen DESC, id LIMIT 500`,
    [status ?? null],
  );
  return rows.map(toResearch);
}

export async function updateResearch(
  pool: Pool,
  actor: AuditActor,
  id: number,
  patch: { status?: string; moduleId?: string | null },
): Promise<ResearchRow> {
  return withTransaction(pool, async (c) => {
    const cur = await one<ResearchDb>(c, 'SELECT * FROM research_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!cur) throw notFound('Research request not found');
    if (patch.moduleId && !(await one(c, 'SELECT id FROM savings_modules WHERE id = $1', [patch.moduleId]))) throw notFound('Module not found');
    const r = await one<ResearchDb>(
      c,
      `UPDATE research_requests SET status = $2, module_id = $3 WHERE id = $1 RETURNING *`,
      [id, patch.status ?? cur.status, patch.moduleId === undefined ? cur.module_id : patch.moduleId],
    );
    await writeAudit(c, actor, 'savings.research.update', 'research_request', id, toResearch(cur), toResearch(r!));
    return toResearch(r!);
  });
}

/* ---------- reports & community ---------- */

export async function addReport(
  q: Queryable,
  input: { moveKind: ValueKind; moduleId?: string; cityPack?: string; savedMonthlyInr: number },
  now: Date,
): Promise<void> {
  await q.query(
    `INSERT INTO savings_reports (move_kind, module_id, city_pack, saved_monthly_inr, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [input.moveKind, input.moduleId ?? null, input.cityPack ?? null, roundSaved(input.savedMonthlyInr), now],
  );
}

export interface CommunityItem {
  moveKind: string;
  moduleId: string | null;
  label: string;
  reports: number;
  medianSavedMonthlyInr: number;
}

/** Only groups with at least COMMUNITY_THRESHOLD real reports are returned; smaller groups are never revealed. */
export async function community(q: Queryable, cityPack?: string): Promise<{ threshold: number; items: CommunityItem[] }> {
  const rows = await many<{ move_kind: string; module_id: string | null; reports: number; median: number; product: string | null }>(
    q,
    `SELECT r.move_kind, r.module_id, count(*)::int AS reports,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY r.saved_monthly_inr)::float8 AS median,
            max(m.data->>'product') AS product
       FROM savings_reports r LEFT JOIN savings_modules m ON m.id = r.module_id
      WHERE ($1::text IS NULL OR r.city_pack = $1)
      GROUP BY r.move_kind, r.module_id
     HAVING count(*) >= $2
      ORDER BY count(*) DESC, r.move_kind, r.module_id NULLS LAST`,
    [cityPack ?? null, COMMUNITY_THRESHOLD],
  );
  return {
    threshold: COMMUNITY_THRESHOLD,
    items: rows.map((r) => ({
      moveKind: r.move_kind,
      moduleId: r.module_id,
      label: r.product ?? r.move_kind.replace(/_/g, ' '),
      reports: r.reports,
      medianSavedMonthlyInr: roundSaved(r.median),
    })),
  };
}

/* ---------- seed ---------- */

export interface SavingsSeedResult {
  file: string | null;
  modulesInserted: number;
  packsInserted: number;
  skipped: string[];
}

const seedFile = z.object({ modules: z.array(z.unknown()).default([]), cityPacks: z.array(z.unknown()).default([]) }).passthrough();

/**
 * Loads savings-data.json into EMPTY tables only (never overwrites admin edits). Invalid entries are skipped and
 * reported; a missing file is a no-op. Seed modules claiming `verified` without a fresh official source are
 * stored as `research`.
 */
export async function seedSavings(pool: Pool, file: string, now: Date): Promise<SavingsSeedResult> {
  const out: SavingsSeedResult = { file: null, modulesInserted: 0, packsInserted: 0, skipped: [] };
  if (!existsSync(file)) return out;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    out.skipped.push(`Unreadable seed file: ${(err as Error).message}`);
    return out;
  }
  const parsed = seedFile.safeParse(json);
  if (!parsed.success) {
    out.skipped.push('Seed file must be an object with modules and cityPacks arrays');
    return out;
  }
  out.file = file;
  await withTransaction(pool, async (c) => {
    await c.query('LOCK TABLE savings_modules, city_packs IN SHARE ROW EXCLUSIVE MODE');
    if (((await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM savings_modules'))?.n ?? 0) === 0) {
      for (const [i, raw] of parsed.data.modules.entries()) {
        const m = moduleSeedSchema.safeParse(raw);
        if (!m.success) {
          out.skipped.push(`modules[${i}] ${String((raw as { id?: unknown })?.id ?? '')}: ${m.error.issues[0]?.path.join('.')} ${m.error.issues[0]?.message}`);
          continue;
        }
        const { version, updatedAt: _u, ...mod } = m.data;
        let status = mod.status;
        if (status === 'verified' && !hasFreshOfficialSource(mod, now)) {
          status = 'research';
          out.skipped.push(`modules[${i}] ${mod.id}: stored as research (no official source checked within ${VERIFY_MAX_AGE_DAYS} days)`);
        }
        const r = await c.query(
          `INSERT INTO savings_modules (id, version, status, data, updated_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
          [mod.id, version ?? 1, status, stored({ ...mod, status }), now],
        );
        out.modulesInserted += r.rowCount ?? 0;
      }
    }
    if (((await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM city_packs'))?.n ?? 0) === 0) {
      for (const [i, raw] of parsed.data.cityPacks.entries()) {
        const p = cityPackSeedSchema.safeParse(raw);
        if (!p.success) {
          out.skipped.push(`cityPacks[${i}] ${String((raw as { id?: unknown })?.id ?? '')}: ${p.error.issues[0]?.path.join('.')} ${p.error.issues[0]?.message}`);
          continue;
        }
        const { id, updatedAt: _u, ...pack } = p.data;
        const r = await c.query(`INSERT INTO city_packs (id, status, data, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [id, pack.status, JSON.stringify(pack), now]);
        out.packsInserted += r.rowCount ?? 0;
      }
    }
  });
  return out;
}
