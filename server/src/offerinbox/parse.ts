/** Pure parsing of provider newsletter e-mail: authentication verdicts, link canonicalisation, offer candidates. */

export interface AuthVerdict {
  dkim: 'pass' | 'fail' | 'none';
  dkimDomain: string | null;
  spf: 'pass' | 'fail' | 'none';
}

const hv = (headers: Record<string, string>, name: string) => headers[name.toLowerCase()] ?? '';

/** Reads the receiving provider's verdict headers (Authentication-Results, Received-SPF, X-Mailgun-*). */
export function authFromHeaders(raw: Record<string, string>): AuthVerdict {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = v;
  const ar = hv(headers, 'authentication-results');
  let dkim: AuthVerdict['dkim'] = 'none';
  const arDkim = /\bdkim=(pass|fail|none|neutral|policy|temperror|permerror)/i.exec(ar)?.[1]?.toLowerCase();
  const mg = hv(headers, 'x-mailgun-dkim-check-result').trim().toLowerCase();
  const verdict = arDkim ?? mg;
  if (verdict) dkim = verdict === 'pass' ? 'pass' : verdict === 'none' ? 'none' : 'fail';
  const domain =
    /\bdkim=pass[^;]*?header\.(?:d|i)=@?([a-z0-9.-]+)/i.exec(ar)?.[1] ??
    /\bd=([a-z0-9.-]+)/i.exec(hv(headers, 'dkim-signature'))?.[1] ??
    null;
  let spf: AuthVerdict['spf'] = 'none';
  const spfRaw = (/\bspf=(\w+)/i.exec(ar)?.[1] ?? hv(headers, 'received-spf').trim().split(/\s/)[0] ?? hv(headers, 'x-mailgun-spf')).toLowerCase();
  const spfAlt = hv(headers, 'x-mailgun-spf').toLowerCase();
  const sv = spfRaw || spfAlt;
  if (sv) spf = sv === 'pass' ? 'pass' : sv === 'none' ? 'none' : 'fail';
  return { dkim, dkimDomain: domain ? domain.toLowerCase() : null, spf };
}

export const domainOf = (addr: string | null): string | null => (addr && addr.includes('@') ? addr.slice(addr.lastIndexOf('@') + 1).toLowerCase() : null);

export const isSameOrSub = (host: string, base: string) => host === base || host.endsWith(`.${base}`);

/** DKIM-verified sender: the signature passed and its domain is aligned (same or parent/child) with the From domain. */
export function dkimVerifiedDomain(auth: AuthVerdict, fromDomain: string | null): string | null {
  if (auth.dkim !== 'pass' || !auth.dkimDomain || !fromDomain) return null;
  return isSameOrSub(fromDomain, auth.dkimDomain) || isSameOrSub(auth.dkimDomain, fromDomain) ? fromDomain : null;
}

/* ---------- links ---------- */

const TRACKING_PARAM = /^(utm_.*|mc_.*|pk_.*|hsa_.*|_hs.*|ga_.*|gclid|gclsrc|fbclid|msclkid|yclid|igshid|mkt_tok|vero_.*|trk|trkid|sid|cid|clickid|click_id|ref|ref_src|campaign|cmpid|cmp|source|src|medium|affid|aff_id|email|e|em|uid|user|userid|user_id|token|auth|key|otp|sig|signature|rid|eid|cmid|_ga|spm|mid|ecid|elqtrack|sc_.*|wt_.*|s_.*|icid|ncid|trackid|tracking|tracking_id)$/i;
const REDIRECT_PARAM = /^(u|url|link|redirect|redirect_url|redirecturl|target|dest|destination|to|r)$/i;
const TRACKER_HOST = /^(click|clicks|links?|email|e|go|track|tracking|trk|mail|em\d*|u\d+|url\d*|ct\.sendgrid|sendgrid|r\.mail|t\.e)\./i;
const IGNORED_LINK = /(unsubscribe|optout|opt-out|preferences?|manage[-_]?(subscription|email)|view[-_]?(in[-_]?)?browser|privacy|mailto:|tel:|javascript:)/i;
const SOCIAL_HOST = /(^|\.)(facebook|twitter|x|instagram|linkedin|youtube|pinterest|whatsapp|t)\.(com|co|me)$|(^|\.)play\.google\.com$|(^|\.)apps\.apple\.com$/i;

/** Canonical landing URL: https, no tracking or identity params, no fragment, sorted params. Null when not a usable URL. */
export function canonicalUrl(raw: string, depth = 0): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim().replace(/&amp;/g, '&'));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  // Click-tracking wrappers: use the embedded target if there is one; an opaque wrapper is dropped (never followed).
  const embedded = [...u.searchParams.keys()].find((k) => REDIRECT_PARAM.test(k) && /^https?:/i.test(u.searchParams.get(k) ?? ''));
  if (embedded && depth < 3) return canonicalUrl(u.searchParams.get(embedded)!, depth + 1);
  if (TRACKER_HOST.test(u.hostname)) return null;
  u.protocol = 'https:';
  u.hash = '';
  u.username = '';
  u.password = '';
  if (u.port === '443' || u.port === '80') u.port = '';
  u.hostname = u.hostname.toLowerCase();
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k) && !REDIRECT_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  const out = u.toString();
  return out.length <= 500 ? out : null;
}

export interface LinkResult {
  /** Canonical landing URLs on the provider's own domains (first = best). */
  landing: string[];
  /** Number of tracking pixels / wrapper links removed. */
  stripped: number;
}

/** Collects landing links from the HTML (or plain text) body. Tracking pixels (images) are never links. */
export function extractLinks(html: string | null, text: string, providerDomains: string[]): LinkResult {
  const hrefs: string[] = [];
  let stripped = 0;
  if (html) {
    stripped += (html.match(/<img\b[^>]*>/gi) ?? []).filter((t) => /(width|height)=["']?[01](px)?["']?[\s/>]|pixel|beacon|\/open\b|track/i.test(t)).length;
    for (const m of html.matchAll(/<a\b[^>]*?href\s*=\s*["']([^"']+)["']/gi)) hrefs.push(m[1]!);
  }
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/g)) hrefs.push(m[0].replace(/[.,;]+$/, ''));
  const seen = new Set<string>();
  const landing: string[] = [];
  for (const h of hrefs) {
    if (IGNORED_LINK.test(h)) continue;
    const c = canonicalUrl(h);
    if (!c) {
      stripped++;
      continue;
    }
    const host = new URL(c).hostname;
    if (SOCIAL_HOST.test(host)) continue;
    if (c !== h) stripped++;
    if (!providerDomains.some((d) => isSameOrSub(host, d))) continue;
    if (!seen.has(c)) {
      seen.add(c);
      landing.push(c);
    }
  }
  // Deeper paths are more specific landing pages than the bare domain.
  landing.sort((a, b) => new URL(b).pathname.length - new URL(a).pathname.length);
  return { landing: landing.slice(0, 5), stripped };
}

/* ---------- candidates ---------- */

export interface Candidate {
  kind: 'plan' | 'discount' | 'cashback' | 'free' | 'price';
  planName: string | null;
  priceInr: number | null;
  billingPeriod: 'monthly' | 'quarterly' | 'annual' | 'none' | null;
  validityDays: number | null;
  discountPct: number | null;
  cashback: boolean;
  free: boolean;
  validUntil: string | null;
  promoCodes: { code: string; possiblyPersonal: true }[];
  /** Redacted one-line evidence (no links, e-mails or phone numbers). */
  excerpt: string;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const PRICE_RE = /(?:₹|\bRs\.?|\bINR)\s?(\d[\d,]*(?:\.\d{1,2})?)/gi;
const PCT_RE = /(\d{1,3})\s?%\s*(?:off|discount|cash\s?back|instant)|(?:flat|upto|up\s?to|extra)\s*(\d{1,3})\s?%/i;
const FREE_RE = /\bfree\b(?!\s+to\b)/i;
const NOT_FREE_RE = /(toll[-\s]?free|feel free|free to)/i;
const CODE_RE = /\b(?:promo(?:\s?code)?|coupon(?:\s?code)?|code|use)\s*[:-]?\s*([A-Z][A-Z0-9]{3,19})\b/g;
const PLAN_WORDS = '(?:plan|pack|recharge|membership|pass|card|subscription|prepaid|postpaid|bundle|offer)';

const PERSONAL_RE = [
  /\byour (?:account|plan|number|mobile|card|credit limit|usage|balance|due|bill|statement|unique|personal|personalised|personalized|exclusive coupon|coupon|code|reward points)\b/i,
  /\bjust for you\b|\bonly for you\b|\bexclusively for you\b|\bpre[-\s]?approved\b|\bpersonali[sz]ed\b|\bselected for you\b|\bvalid for you\b/i,
  /\b(?:xx+|\*{2,})\s?\d{3,4}\b/i,
  /(?:\+91[\s-]?)?\b[6-9]\d{9}\b/,
];
const GENERIC_NAMES = /^(there|customer|user|friend|subscriber|member|valued|all|everyone|reader|team|guest)$/i;

/** Personalised mail (a name greeting, "your account/plan/code", masked card or phone numbers) is research only. */
export function isPersonalised(subject: string | null, text: string): boolean {
  const hay = `${subject ?? ''}\n${text}`;
  if (PERSONAL_RE.some((r) => r.test(hay))) return true;
  const g = /^\s*(?:hi|hello|dear|hey)[,\s]+([A-Za-z]+)/im.exec(text);
  return Boolean(g && !GENERIC_NAMES.test(g[1]!));
}

export function redact(line: string): string {
  return line
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[removed]')
    .replace(/(?:\+91[\s-]?)?\b[6-9]\d{9}\b/g, '[removed]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** Finds a date in "valid till 30 Nov 2026", "30/11/2026", "30th November". Dates without a year are the next occurrence. */
export function findDate(line: string, now: Date): string | null {
  const iso = (y: number, m: number, d: number) => {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  };
  let m = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3})[a-z]*\.?,?[\s-]+(\d{4}|\d{2})\b/.exec(line);
  if (m && MONTHS[m[2]!.toLowerCase()]) return iso(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), MONTHS[m[2]!.toLowerCase()]!, Number(m[1]));
  m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(line);
  if (m) return iso(m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]), Number(m[2]), Number(m[1]));
  m = /\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3})[a-z]*\b/.exec(line);
  if (m && MONTHS[m[2]!.toLowerCase()]) {
    const mo = MONTHS[m[2]!.toLowerCase()]!;
    const y = now.getUTCFullYear();
    const d = iso(y, mo, Number(m[1]));
    return d && d < new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10) ? iso(y + 1, mo, Number(m[1])) : d;
  }
  return null;
}

function planName(line: string): string | null {
  const m =
    new RegExp(`((?:[A-Z][\\w+]*|\\d+G)(?:\\s+(?:[A-Z][\\w+]*|\\d+G|One|Pro|Plus|Max)){0,3})\\s+(?:(?:₹|Rs\\.?)\\s?[\\d,]+\\s+)?${PLAN_WORDS}\\b`).exec(line) ??
    /\b([A-Z][\w+]*(?:\s+[A-Z][\w+]*){0,2})\s+(?=(?:at|for|@|starting|just|only|from)\s+(?:₹|Rs|INR))/.exec(line) ??
    /\b(?:get|try|join|subscribe to)\s+([A-Z][\w+]*(?:\s+[A-Z][\w+]*){0,2})\b/.exec(line);
  const name = m?.[1]?.trim().replace(/^(?:Get|Try|Join|Buy|Avail|Grab|Enjoy|Upgrade|Recharge|Save|Subscribe|Switch)\s+(?=[A-Z])/, '');
  if (!name || /^(Get|Flat|Upto|Up|Save|Free|Offer|The|Our|New|This|Your|Valid|Use|Pay|Enjoy|Hurry|Limited)$/i.test(name)) return null;
  return name.slice(0, 60);
}

function periodOf(line: string): { period: Candidate['billingPeriod']; days: number | null } {
  const days = /\b(\d{1,3})\s*days?\b/i.exec(line);
  const d = days ? Number(days[1]) : null;
  if (/(?:\/|\bper\s|\ba\s|\bevery\s)\s?(?:month|mo)\b|\bmonthly\b/i.test(line)) return { period: 'monthly', days: d };
  if (/(?:\/|\bper\s|\ba\s|\bevery\s)\s?(?:year|yr)\b|\byearly\b|\bannual(?:ly)?\b/i.test(line)) return { period: 'annual', days: d };
  if (/\bquarterly\b|\bper quarter\b/i.test(line)) return { period: 'quarterly', days: d };
  if (d && d >= 7) return { period: 'none', days: d };
  return { period: null, days: d };
}

/** Extracts offer candidates, one per line that carries a price, a percentage, cashback or a free benefit. */
export function extractCandidates(text: string, now: Date): Candidate[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 8 && l.length <= 600);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length && out.length < 10; i++) {
    const line = lines[i]!;
    const prices = [...line.matchAll(PRICE_RE)].map((m) => Number(m[1]!.replace(/,/g, ''))).filter((n) => Number.isFinite(n) && n > 0 && n <= 10_000_000);
    const pct = PCT_RE.exec(line);
    const cashback = /cash\s?back/i.test(line);
    const freeIn = (t: string) => FREE_RE.test(t) && !NOT_FREE_RE.test(t) && /\b(trial|month|days?|delivery|data|subscription|access|membership|upgrade|for|with)\b/i.test(t);
    const free = freeIn(line) || (prices.length > 0 && freeIn(lines[i + 1] ?? ''));
    if (prices.length === 0 && !pct && !cashback && !free) continue;
    const ctx = [line, lines[i + 1] ?? '', lines[i + 2] ?? ''].join(' ');
    let validUntil: string | null = null;
    for (const v of ctx.matchAll(/\b(?:valid|offer|ends?|expires?|till|until|upto|up to|before|by)\b[^.]{0,40}/gi)) {
      validUntil = findDate(v[0], now);
      if (validUntil) break;
    }
    const { period, days } = periodOf(ctx);
    const price = prices.length ? Math.min(...prices) : null;
    const promoCodes = [...new Set([...ctx.matchAll(CODE_RE)].map((m) => m[1]!).filter((c) => /\d/.test(c) || c === c.toUpperCase()))].slice(0, 3).map((code) => ({ code, possiblyPersonal: true as const }));
    const plan = planName(line);
    const kind: Candidate['kind'] = price !== null && (plan || period || days) ? 'plan' : pct ? 'discount' : cashback ? 'cashback' : free ? 'free' : 'price';
    const key = `${kind}|${price}|${pct?.[1] ?? pct?.[2] ?? ''}|${cashback}|${free}`;
    if (seen.has(key)) {
      const prev = out.find((o) => `${o.kind}|${o.priceInr}|${o.discountPct ?? ''}|${o.cashback}|${o.free}` === key);
      if (prev && !prev.planName && plan) prev.planName = plan;
      continue;
    }
    seen.add(key);
    out.push({
      kind,
      planName: plan,
      priceInr: price,
      billingPeriod: period,
      validityDays: days,
      discountPct: pct ? Number(pct[1] ?? pct[2]) : null,
      cashback,
      free,
      validUntil,
      promoCodes,
      excerpt: redact(line),
    });
  }
  return out;
}
