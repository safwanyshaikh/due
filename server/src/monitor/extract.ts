import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { canonicalJson } from '../util.js';

export const MAX_TEXT_CHARS = 200_000;

export interface FeedItem {
  title: string;
  link: string;
  pubDate: string | null;
  summary: string;
}

export interface Extracted {
  title: string | null;
  /** Normalised text: this is what is hashed and stored in snapshots. */
  text: string;
  items?: FeedItem[];
}

const BLOCK = 'p,div,li,ul,ol,h1,h2,h3,h4,h5,h6,tr,td,th,table,section,article,main,aside,header,footer,blockquote,pre,dd,dt,dl,figcaption,br,hr';
const STRIP = 'script,style,noscript,template,nav,svg,iframe,object,embed,canvas,link,meta';

/** Collapses whitespace per line and drops empty lines, so cosmetic markup changes do not count as content changes. */
export function normaliseText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\s\u00a0\u200b]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function htmlToText(html: string): string {
  const $ = cheerio.load(`<div id="__root">${html}</div>`);
  $(STRIP).remove();
  $(BLOCK).each((_, el) => {
    $(el).append('\n');
  });
  return normaliseText($('#__root').text());
}

export function extractHtml(html: string, cssSelector?: string | null): Extracted {
  const $ = cheerio.load(html);
  const title = normaliseText($('title').first().text()) || null;
  $(STRIP).remove();
  let roots = cssSelector ? $(cssSelector) : $('body');
  if (roots.length === 0 && !cssSelector) roots = $.root();
  if (cssSelector && roots.length === 0) {
    throw new Error(`CSS selector matched nothing: ${cssSelector}`);
  }
  roots.find(BLOCK).each((_, el) => {
    $(el).append('\n');
  });
  const text = normaliseText(
    roots
      .map((_, el) => $(el).text())
      .get()
      .join('\n'),
  );
  return { title, text };
}

function textOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return textOf(o['#text']);
    if ('@_href' in o) return textOf(o['@_href']);
  }
  return '';
}

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function atomLink(v: unknown): string {
  const links = asArray(v as unknown[]);
  const alt =
    links.find((l) => typeof l === 'object' && l && (l as Record<string, unknown>)['@_rel'] === 'alternate') ??
    links.find((l) => typeof l === 'object' && l && !(l as Record<string, unknown>)['@_rel']) ??
    links[0];
  return textOf(alt);
}

function absolutise(link: string, baseUrl: string): string {
  if (!link) return '';
  try {
    return new URL(link, baseUrl).toString();
  } catch {
    return link;
  }
}

/** RSS 2.0, RSS 1.0 (RDF) and Atom. */
export function extractFeed(xml: string, baseUrl: string): Extracted {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: true,
    htmlEntities: true,
    trimValues: true,
  });
  const doc = parser.parse(xml) as Record<string, unknown>;
  let feedTitle: string;
  let raw: Record<string, unknown>[];
  let atom = false;
  if (doc.rss) {
    const ch = (doc.rss as Record<string, unknown>).channel as Record<string, unknown> | undefined;
    feedTitle = textOf(ch?.title);
    raw = asArray(ch?.item as Record<string, unknown>[]);
  } else if (doc.RDF) {
    const rdf = doc.RDF as Record<string, unknown>;
    feedTitle = textOf((rdf.channel as Record<string, unknown> | undefined)?.title);
    raw = asArray(rdf.item as Record<string, unknown>[]);
  } else if (doc.feed) {
    atom = true;
    const f = doc.feed as Record<string, unknown>;
    feedTitle = textOf(f.title);
    raw = asArray(f.entry as Record<string, unknown>[]);
  } else {
    throw new Error('Not an RSS or Atom feed');
  }
  const items: FeedItem[] = raw.map((it) => {
    const link = atom ? atomLink(it.link) : textOf(it.link) || textOf(it.guid);
    const abs = absolutise(link, baseUrl);
    const summaryRaw = textOf(it.description) || textOf(it.summary) || textOf(it.encoded) || textOf(it.content);
    const date = textOf(it.pubDate) || textOf(it.published) || textOf(it.updated) || textOf(it.date);
    const parsed = date ? new Date(date) : null;
    return {
      title: normaliseText(textOf(it.title)) || '(untitled)',
      link: abs,
      pubDate: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      summary: htmlToText(summaryRaw).slice(0, 2000),
    };
  });
  const text = items.map((i) => [i.title, i.link, i.pubDate ?? '', i.summary].join('\n')).join('\n\n');
  return { title: normaliseText(feedTitle) || null, text: normaliseText(text), items };
}

export function extractJson(body: string): Extracted {
  const value: unknown = JSON.parse(body);
  return { title: null, text: canonicalJson(value, 2) };
}

export function extractSitemap(xml: string): Extracted {
  const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, trimValues: true });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const set = (doc.urlset ?? doc.sitemapindex) as Record<string, unknown> | undefined;
  if (!set) throw new Error('Not a sitemap');
  const entries = asArray((set.url ?? set.sitemap) as Record<string, unknown>[]).map(
    (e) => `${textOf(e.loc)}${e.lastmod ? ` ${textOf(e.lastmod)}` : ''}`,
  );
  return { title: null, text: normaliseText(entries.join('\n')) };
}

export function extractContent(
  method: 'html_text' | 'rss' | 'json' | 'sitemap',
  body: string,
  baseUrl: string,
  cssSelector: string | null,
): Extracted {
  switch (method) {
    case 'html_text':
      return extractHtml(body, cssSelector);
    case 'rss':
      return extractFeed(body, baseUrl);
    case 'json':
      return extractJson(body);
    case 'sitemap':
      return extractSitemap(body);
  }
}
