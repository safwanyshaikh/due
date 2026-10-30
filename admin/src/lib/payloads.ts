/**
 * Request body builders. Kept in one place so field naming can be adjusted
 * to the server's zod schemas without touching screens. Bodies use the
 * camelCase style the contract uses for setup/dashboard (setupToken,
 * companyId, activeSources); jobs PATCH uses `interval_minutes` exactly as
 * written in the contract.
 */
import type { CompanyKind } from './types';

export interface CompanyInput {
  kind: CompanyKind;
  name: string;
  officialWebsite: string;
  country: string;
  categoryId: string;
  description: string;
  monitoringEnabled: boolean;
}

export function companyPayload(c: CompanyInput) {
  return {
    kind: c.kind,
    name: c.name.trim(),
    officialWebsite: c.officialWebsite.trim() || null,
    country: c.country.trim() || null,
    categoryId: c.categoryId || null,
    description: c.description.trim() || null,
    monitoringEnabled: c.monitoringEnabled,
  };
}

export interface SourceInput {
  companyId: string;
  url: string;
  label: string;
  sourceCategory: string;
  isOfficial: boolean;
  extractionMethod: string;
  cssSelector: string;
  priority: string;
  frequencyMinutes: number;
  enabled: boolean;
}

export function sourcePayload(s: SourceInput) {
  return {
    companyId: s.companyId,
    url: s.url.trim(),
    label: s.label.trim() || null,
    sourceCategory: s.sourceCategory,
    isOfficial: s.isOfficial,
    extractionMethod: s.extractionMethod,
    cssSelector: s.cssSelector.trim() || null,
    priority: s.priority,
    frequencyMinutes: s.frequencyMinutes,
    enabled: s.enabled,
  };
}

export function jobPayload(p: { enabled?: boolean; intervalMinutes?: number }) {
  const out: Record<string, unknown> = {};
  if (p.enabled !== undefined) out.enabled = p.enabled;
  if (p.intervalMinutes !== undefined) out.interval_minutes = p.intervalMinutes;
  return out;
}

/** Finds a one-time link in a users POST / reset-link response. */
export function extractLink(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const o = data as Record<string, unknown>;
  for (const k of ['setupLink', 'resetLink', 'link', 'url', 'setupUrl', 'resetUrl']) {
    if (typeof o[k] === 'string') return o[k] as string;
  }
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') {
      const nested = extractLink(v);
      if (nested) return nested;
    }
  }
  return null;
}
