import type { SourceKind } from './types';

/** Maps the monitoring service's source categories onto the kinds used by the status rules. */
const CATEGORY_KIND: Record<string, SourceKind> = {
  official_site: 'landing_page',
  product_page: 'product_page',
  pricing: 'plan_page',
  terms: 'terms',
  press: 'press_release',
  news: 'press_release',
  help: 'help_page',
};

export function kindForCategory(category: string | undefined): SourceKind {
  return (category && CATEGORY_KIND[category]) || 'landing_page';
}

const SECONDARY = new Set(['news', 'social', 'secondary', 'rss']);

/** True for categories that are not the provider's own official pages. */
export function isSecondaryCategory(category: string | undefined): boolean {
  return !!category && SECONDARY.has(category);
}

export const CATEGORY_LABEL: Record<string, string> = {
  official_site: 'official site',
  product_page: 'product page',
  pricing: 'pricing',
  terms: 'terms',
  press: 'press release',
  news: 'news',
  rss: 'feed',
  help: 'help page',
  api: 'API',
  document: 'document',
  social: 'social',
  secondary: 'secondary source',
};

/** Only plain http(s) links are rendered; anything else (javascript:, data:, malformed) is dropped. */
export function isSafeHttpUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Monitoring status of a source, in plain words. "active" needs no note. */
export const SOURCE_STATUS_LABEL: Record<string, string> = {
  failing: 'recent checks failed',
  blocked_robots: 'not checked: the site does not allow automated checks',
  inaccessible: 'Source inaccessible',
  disabled: 'monitoring paused',
};
