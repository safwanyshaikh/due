/**
 * Client for Due's public savings endpoints (relative paths on Due's own API, no credentials).
 * Sends no user data except, on request: a cleaned provider label + category (research) and an
 * opt-in anonymous rounded saving (report). Every call fails soft: offline returns null/false
 * or the cached catalog.
 */
import { apiBase } from '../offers/api';
import { researchLabel } from './research';
import { COMMUNITY_THRESHOLD } from './types';
import type { CityPack, ResearchNeed, SavingsCatalog, SavingsModule, ValueKind } from './types';

export const SAVINGS_CATALOG_PATH = '/api/public/savings/catalog';
export const SAVINGS_RESEARCH_PATH = '/api/public/savings/research';
export const SAVINGS_REPORT_PATH = '/api/public/savings/report';
export const SAVINGS_COMMUNITY_PATH = '/api/public/savings/community';
export const SAVINGS_CATALOG_CACHE_KEY = 'due:savings-catalog-cache:v1';
export const SAVINGS_TIMEOUT_MS = 10_000;

interface ResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
type RequestInitLike = {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  signal: AbortSignal;
  credentials: 'omit';
  body?: string;
};
export type SavingsFetchLike = (input: string, init: RequestInitLike) => Promise<ResponseLike>;

export interface ApiOpts {
  base?: string;
  fetchImpl?: SavingsFetchLike;
  timeoutMs?: number;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => string;
}

function join(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path}`;
}

async function call(
  path: string,
  method: 'GET' | 'POST',
  body: unknown,
  opts: ApiOpts,
): Promise<ResponseLike | null> {
  const doFetch: SavingsFetchLike | undefined =
    opts.fetchImpl ??
    (typeof fetch === 'function' ? (fetch as unknown as SavingsFetchLike) : undefined);
  if (!doFetch) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? SAVINGS_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return await doFetch(join(opts.base ?? apiBase(), path), {
      method,
      headers,
      signal: ctrl.signal,
      credentials: 'omit',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function jsonOf(res: ResponseLike | null): Promise<unknown> {
  if (!res || !res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const KINDS: ValueKind[] = [
  'membership_breakeven',
  'period_switch',
  'overlap',
  'commute_pass',
  'debt_rate',
  'loan_switch',
  'price_change',
  'trial_end',
];

function validModule(m: unknown): m is SavingsModule {
  if (!isObj(m)) return false;
  const d = m.detect;
  return (
    typeof m.id === 'string' &&
    (m.status === 'verified' || m.status === 'research') &&
    isObj(d) &&
    Array.isArray(d.merchantAliases) &&
    Array.isArray(d.keywords) &&
    isObj(m.rules) &&
    KINDS.includes(m.valueKind as ValueKind) &&
    typeof m.product === 'string' &&
    Array.isArray(m.sources)
  );
}

function validPack(p: unknown): p is CityPack {
  return (
    isObj(p) &&
    typeof p.id === 'string' &&
    (p.status === 'verified' || p.status === 'research') &&
    Array.isArray(p.passes) &&
    Array.isArray(p.localities) &&
    isObj(p.typicalFareInr)
  );
}

/** Validates a catalog payload. Malformed or retired entries are dropped; a bad envelope is null. */
export function parseSavingsCatalog(body: unknown): SavingsCatalog | null {
  if (!isObj(body) || typeof body.version !== 'string' || !Array.isArray(body.modules)) return null;
  const modules = body.modules.filter(validModule).map((m) => ({
    ...m,
    detect: {
      ...m.detect,
      senderDomains: Array.isArray(m.detect.senderDomains) ? m.detect.senderDomains : [],
    },
  }));
  const cityPacks = Array.isArray(body.cityPacks)
    ? body.cityPacks.filter(validPack).map((p) => ({
        ...p,
        passes: p.passes.filter(
          (x) =>
            isObj(x) &&
            typeof x.id === 'string' &&
            Array.isArray(x.coverage) &&
            x.status !== 'retired',
        ),
      }))
    : [];
  return {
    version: body.version,
    generatedAt: typeof body.generatedAt === 'string' ? body.generatedAt : '',
    modules,
    cityPacks,
  };
}

/* ---------- catalog + cache ---------- */

export interface SavingsCatalogCache {
  fetchedAt: string;
  catalog: SavingsCatalog;
}

export interface SavingsCatalogResult {
  /** True when a catalog is available (fresh or cached). */
  ok: boolean;
  catalog: SavingsCatalog | null;
  /** 'network' = fresh; 'cache' = last good copy (offline or server error); 'none' = nothing yet. */
  source: 'network' | 'cache' | 'none';
  fetchedAt: string | null;
}

function safeLocal(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadSavingsCatalogCache(
  storage: Pick<Storage, 'getItem'> | null = safeLocal(),
): SavingsCatalogCache | null {
  try {
    const raw = storage?.getItem(SAVINGS_CATALOG_CACHE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!isObj(v) || typeof v.fetchedAt !== 'string') return null;
    const catalog = parseSavingsCatalog(v.catalog);
    return catalog ? { fetchedAt: v.fetchedAt, catalog } : null;
  } catch {
    return null;
  }
}

export function saveSavingsCatalogCache(
  c: SavingsCatalogCache,
  storage: Pick<Storage, 'setItem'> | null = safeLocal(),
): boolean {
  try {
    storage?.setItem(SAVINGS_CATALOG_CACHE_KEY, JSON.stringify(c));
    return !!storage;
  } catch {
    return false;
  }
}

/** GET the public savings catalog; on any failure returns the cached copy (or none). */
export async function fetchSavingsCatalog(opts: ApiOpts = {}): Promise<SavingsCatalogResult> {
  const storage = opts.storage === undefined ? safeLocal() : opts.storage;
  const catalog = parseSavingsCatalog(
    await jsonOf(await call(SAVINGS_CATALOG_PATH, 'GET', undefined, opts)),
  );
  if (catalog) {
    const fetchedAt = (opts.now ?? (() => new Date().toISOString()))();
    saveSavingsCatalogCache({ fetchedAt, catalog }, storage);
    return { ok: true, catalog, source: 'network', fetchedAt };
  }
  const cached = loadSavingsCatalogCache(storage);
  return cached
    ? { ok: true, catalog: cached.catalog, source: 'cache', fetchedAt: cached.fetchedAt }
    : { ok: false, catalog: null, source: 'none', fetchedAt: null };
}

/* ---------- research ---------- */

export interface ResearchResponse {
  status: 'queued' | 'known';
  moduleId?: string;
}

/** Sends one anonymous research request (label re-cleaned here). null when offline or refused. */
export async function postResearch(
  need: Pick<ResearchNeed, 'providerLabel' | 'category'> & { cityPack?: string | null },
  cityPackArg: string | null = null,
  opts: ApiOpts = {},
): Promise<ResearchResponse | null> {
  const cityPack = cityPackArg ?? need.cityPack ?? null;
  const providerLabel = researchLabel(need.providerLabel);
  if (!providerLabel) return null;
  const body: Record<string, string> = { providerLabel, category: need.category };
  if (cityPack) body.cityPack = cityPack;
  const v = await jsonOf(await call(SAVINGS_RESEARCH_PATH, 'POST', body, opts));
  if (!isObj(v) || (v.status !== 'queued' && v.status !== 'known')) return null;
  return typeof v.moduleId === 'string'
    ? { status: v.status, moduleId: v.moduleId }
    : { status: v.status };
}

/* ---------- reports ---------- */

export interface SavingsReport {
  moveKind: ValueKind;
  moduleId?: string | null;
  cityPack?: string | null;
  savedMonthlyInr: number;
}

/** Rounded to the nearest ₹10 within 1..100000, or null when out of range. */
export function roundReportInr(n: number): number | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  const r = Math.round(n / 10) * 10;
  return r >= 1 && r <= 100_000 ? r : null;
}

/** Posts an opt-in anonymous saving report. Returns true on 204/2xx, false otherwise. */
export async function postReport(report: SavingsReport, opts: ApiOpts = {}): Promise<boolean> {
  const saved = roundReportInr(report.savedMonthlyInr);
  if (saved === null || !KINDS.includes(report.moveKind)) return false;
  const body: Record<string, string | number> = {
    moveKind: report.moveKind,
    savedMonthlyInr: saved,
  };
  if (report.moduleId) body.moduleId = report.moduleId;
  if (report.cityPack) body.cityPack = report.cityPack;
  const res = await call(SAVINGS_REPORT_PATH, 'POST', body, opts);
  return !!res && res.ok;
}

/* ---------- community ---------- */

export interface CommunityItem {
  moveKind: ValueKind;
  moduleId: string | null;
  label: string;
  reports: number;
  medianSavedMonthlyInr: number;
}

export interface CommunityResponse {
  threshold: number;
  items: CommunityItem[];
}

/** Community block data. Items below the threshold are dropped here too (never padded). */
export async function fetchCommunity(
  cityPack: string | null = null,
  opts: ApiOpts = {},
): Promise<CommunityResponse | null> {
  const q = cityPack ? `?cityPack=${encodeURIComponent(cityPack)}` : '';
  const v = await jsonOf(await call(`${SAVINGS_COMMUNITY_PATH}${q}`, 'GET', undefined, opts));
  if (!isObj(v) || !Array.isArray(v.items)) return null;
  const threshold = Math.max(
    COMMUNITY_THRESHOLD,
    typeof v.threshold === 'number' && Number.isFinite(v.threshold) ? v.threshold : 0,
  );
  const items = v.items
    .filter(
      (i): i is CommunityItem =>
        isObj(i) &&
        KINDS.includes(i.moveKind as ValueKind) &&
        typeof i.label === 'string' &&
        typeof i.reports === 'number' &&
        typeof i.medianSavedMonthlyInr === 'number' &&
        i.reports >= threshold,
    )
    .map((i) => ({ ...i, moduleId: typeof i.moduleId === 'string' ? i.moduleId : null }));
  return { threshold, items };
}
