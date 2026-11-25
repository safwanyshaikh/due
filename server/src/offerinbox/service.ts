import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';
import { writeAudit, type AuditActor } from '../audit.js';
import { many, one, withTransaction, type Pool, type PoolClient, type Queryable } from '../db.js';
import { decryptText, encryptText } from '../intake/crypto.js';
import { messageIdHashOf } from '../intake/service.js';
import { proposeChanges, type OfferRow } from '../monitor/offers.js';
import type { ObservationFields } from '../monitor/parser.js';
import { PermanentJobError, enqueue, type JobContext } from '../queue/index.js';
import type { InboundMessage } from '../routes/inbound.js';
import { catalogVersion, recordChange } from '../savings/repo.js';
import { canonicalJson, sha256, slugify } from '../util.js';
import { authFromHeaders, dkimVerifiedDomain, domainOf, extractCandidates, extractLinks, isPersonalised, isSameOrSub, type AuthVerdict, type Candidate } from './parse.js';

export const RAW_RETENTION_DAYS = 90;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const DAY_MS = 86_400_000;

interface RawMail {
  subject: string | null;
  from: string | null;
  text: string;
  html: string | null;
  attachments: { name: string; contentType: string; size: number; contentBase64: string }[];
  droppedAttachments: number;
}

const seal = (key: Buffer | null, v: unknown) => (key ? encryptText(key, JSON.stringify(v)) : `plain:${JSON.stringify(v)}`);
function unseal(key: Buffer | null, s: string): RawMail {
  if (s.startsWith('plain:')) return JSON.parse(s.slice(6)) as RawMail;
  if (!key) throw new PermanentJobError('encryption_key_missing', 'The message was sealed with DATA_ENCRYPTION_KEY, which is no longer configured');
  return JSON.parse(decryptText(key, s)) as RawMail;
}

/** Only PDFs and images under 5 MB are kept; everything else is dropped (and counted). */
export function keepAttachments(list: NonNullable<InboundMessage['attachments']>): { kept: RawMail['attachments']; dropped: number } {
  const kept: RawMail['attachments'] = [];
  let total = 0;
  for (const a of list) {
    const size = Math.max(a.size, Math.floor((a.contentBase64.length * 3) / 4));
    const okType = a.contentType === 'application/pdf' || /^image\/(png|jpe?g|gif|webp)$/.test(a.contentType);
    if (okType && size < MAX_ATTACHMENT_BYTES && total + size <= 2 * MAX_ATTACHMENT_BYTES) {
      kept.push({ ...a, size });
      total += size;
    }
  }
  return { kept, dropped: list.length - kept.length };
}

/** Webhook side: store the sealed raw mail and enqueue `offers.inbox_parse`. Nothing here touches user intake tables. */
export async function ingestResearchMail(
  pool: Pool,
  key: Buffer | null,
  msg: InboundMessage,
  recipient: string,
  now: Date,
  correlationId: string,
): Promise<{ duplicate: boolean; inboxMessageId: string | null; jobId: string | null }> {
  const auth = authFromHeaders(msg.headers ?? {});
  const { kept, dropped } = keepAttachments(msg.attachments ?? []);
  const raw: RawMail = { subject: msg.subject, from: msg.from, text: msg.text, html: msg.html ? msg.html.slice(0, 1_000_000) : null, attachments: kept, droppedAttachments: dropped };
  return withTransaction(pool, async (c) => {
    const ins = await c.query<{ id: string }>(
      `INSERT INTO offer_inbox_messages (message_id_hash, received_at, recipient, from_address, from_domain, subject, auth, raw_sealed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (message_id_hash) DO NOTHING RETURNING id`,
      [messageIdHashOf(msg.messageId), now, recipient, msg.from, domainOf(msg.from), msg.subject?.slice(0, 300) ?? null, JSON.stringify(auth), seal(key, raw)],
    );
    const row = ins.rows[0];
    if (!row) return { duplicate: true, inboxMessageId: null, jobId: null };
    const job = await enqueue(c, { type: 'offers.inbox_parse', payload: { inboxMessageId: row.id }, idempotencyKey: `offers.inbox_parse:${row.id}`, correlationId, now });
    return { duplicate: false, inboxMessageId: row.id, jobId: job.id };
  });
}

interface WatchRow {
  slug: string;
  display_name: string;
  sender_domains: string[];
  category: string;
  signup_url: string | null;
  status: string;
}

export async function matchProvider(q: Queryable, domain: string): Promise<WatchRow | null> {
  const rows = await many<WatchRow>(q, `SELECT * FROM provider_watch WHERE cardinality(sender_domains) > 0`);
  let best: { row: WatchRow; len: number } | null = null;
  for (const r of rows) for (const d of r.sender_domains) if (isSameOrSub(domain, d) && (!best || d.length > best.len)) best = { row: r, len: d.length };
  return best?.row ?? null;
}

interface InboxRow {
  id: string;
  received_at: Date;
  from_domain: string | null;
  subject: string | null;
  auth: AuthVerdict;
  status: string;
  raw_sealed: string | null;
}

/** `offers.inbox_parse` { inboxMessageId }: verify the sender, extract candidates, queue them for human review. */
export async function parseOfferInboxJob(job: JobContext): Promise<void> {
  const id = String(job.payload.inboxMessageId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new PermanentJobError('bad_payload', 'inboxMessageId is required');
  const { pool, clock, config } = job.deps;
  await withTransaction(pool, async (c) => {
    const m = await one<InboxRow>(c, 'SELECT * FROM offer_inbox_messages WHERE id = $1 FOR UPDATE', [id]);
    if (!m || m.status !== 'received') return;
    const now = clock();
    const finish = (status: 'parsed' | 'quarantined' | 'failed', reason: string | null, extra: { provider?: string | null; personalised?: boolean; landing?: string[]; candidates?: unknown[]; queued?: number } = {}) =>
      c.query(
        `UPDATE offer_inbox_messages SET status=$2, reason=$3, provider_slug=$4, personalised=$5, landing_urls=$6, candidates=$7, reviews_queued=$8, parsed_at=$9 WHERE id=$1`,
        [id, status, reason, extra.provider ?? null, extra.personalised ?? false, extra.landing ?? [], JSON.stringify(extra.candidates ?? []), extra.queued ?? 0, now],
      );
    if (!m.raw_sealed) return void (await finish('failed', 'raw_expired'));
    const verified = dkimVerifiedDomain(m.auth, m.from_domain);
    if (!verified) {
      // Unverified senders are stored for the admin to see and never parsed, queued or published.
      return void (await finish('quarantined', m.auth.dkim === 'pass' ? 'dkim_domain_not_aligned' : m.auth.dkim === 'none' ? 'dkim_missing' : 'dkim_failed'));
    }
    const provider = await matchProvider(c, verified);
    if (!provider) return void (await finish('quarantined', 'unmatched_sender'));

    const raw = unseal(config.dataEncryptionKey, m.raw_sealed);
    const text = raw.text.trim() ? raw.text : raw.html ? (await import('../routes/inbound.js')).htmlToText(raw.html) : '';
    const links = extractLinks(raw.html, text, provider.sender_domains);
    const personalised = isPersonalised(raw.subject, text);
    const candidates = extractCandidates(text, m.received_at);
    await c.query('UPDATE provider_watch SET last_email_at = GREATEST(COALESCE(last_email_at, $2), $2), updated_at = $3 WHERE slug = $1', [provider.slug, m.received_at, now]);
    if (personalised) {
      // Research only: kept without excerpts or codes, never queued for publication.
      return void (await finish('parsed', 'personalised', { provider: provider.slug, personalised: true, landing: [], candidates: candidates.map((x) => ({ ...x, excerpt: '', promoCodes: [] })) }));
    }
    const link = links.landing[0] ?? provider.signup_url ?? `https://${provider.sender_domains[0]}/`;
    let queued = 0;
    for (const cand of candidates) queued += await queueCandidate(c, provider, cand, { messageId: id, subject: raw.subject, receivedAt: m.received_at, link }, now);
    await finish('parsed', null, { provider: provider.slug, landing: links.landing, candidates, queued });
  });
}

const BENEFIT = (c: Candidate) =>
  c.kind === 'plan' ? (c.billingPeriod && c.billingPeriod !== 'none' ? 'recurring_entitlement' : 'bundle') : c.kind === 'discount' || c.kind === 'cashback' ? 'one_time_reward' : c.kind === 'free' ? 'trial' : 'bundle';

function candidateLabel(c: Candidate): string {
  return c.planName ?? (c.discountPct ? `${c.discountPct}% off` : c.cashback ? 'cashback' : c.free ? 'free benefit' : 'offer');
}

/** One-line public summary built from structured fields only (never raw mail text). */
export function summaryOf(display: string, p: { plan_name?: unknown; price?: unknown; discount_pct?: unknown; valid_until?: unknown; cashback?: unknown; free?: unknown }): string {
  const parts = [typeof p.plan_name === 'string' ? p.plan_name : 'offer'];
  if (typeof p.price === 'number') parts.push(`₹${p.price}`);
  if (typeof p.discount_pct === 'number') parts.push(`${p.discount_pct}% off`);
  if (p.cashback === true) parts.push('cashback');
  if (p.free === true) parts.push('free benefit');
  if (typeof p.valid_until === 'string') parts.push(`until ${p.valid_until}`);
  return `${display}: ${parts.join(' ')}`.slice(0, 190);
}

async function queueCandidate(
  c: PoolClient,
  provider: WatchRow,
  cand: Candidate,
  ctx: { messageId: string; subject: string | null; receivedAt: Date; link: string },
  now: Date,
): Promise<number> {
  const core = { kind: cand.kind, plan: cand.planName, price: cand.priceInr, period: cand.billingPeriod, pct: cand.discountPct, cashback: cand.cashback, free: cand.free };
  const offerId = `nl-${provider.slug}-${sha256(canonicalJson(core)).slice(0, 8)}`.slice(0, 100);
  const extra = {
    origin: 'newsletter',
    plan_name: cand.planName,
    discount_pct: cand.discountPct,
    cashback: cand.cashback,
    free: cand.free,
    validity_days: cand.validityDays,
    valid_until: cand.validUntil,
    evidence: { sourceKind: 'newsletter', subject: ctx.subject?.slice(0, 200) ?? null, excerpt: cand.excerpt, link: ctx.link, receivedAt: ctx.receivedAt.toISOString(), inboxMessageId: ctx.messageId, promoCodes: cand.promoCodes },
  };
  const existing = await one<OfferRow>(
    c,
    `SELECT * FROM offers WHERE id = $1 OR (provider = $2 AND $3::text IS NOT NULL AND lower(name) LIKE '%' || lower($3) || '%') ORDER BY (id = $1) DESC, id LIMIT 1`,
    [offerId, provider.slug, cand.planName],
  );
  const insertReview = async (offer: string | null, obs: number | null, kind: string, proposed: Record<string, unknown>, current: Record<string, unknown>) => {
    const { evidence: _e, ...core2 } = proposed;
    const r = await c.query(
      `INSERT INTO offer_review_queue (offer_id, observation_id, source_id, change_kind, proposed, current, proposed_hash, created_at)
       VALUES ($1,$2,NULL,$3,$4,$5,$6,$7) ON CONFLICT ((COALESCE(offer_id, '')), change_kind, proposed_hash) WHERE status = 'pending' DO NOTHING`,
      [offer, obs, kind, JSON.stringify(proposed), JSON.stringify(current), sha256(canonicalJson(core2)), now],
    );
    return r.rowCount ?? 0;
  };
  if (!existing) {
    const display = `${provider.display_name} ${candidateLabel(cand)}${cand.priceInr !== null ? ` ₹${cand.priceInr}` : ''}`.slice(0, 200);
    return insertReview(null, null, 'new_offer', {
      id: offerId,
      provider: provider.slug,
      product_family: cand.planName ?? candidateLabel(cand),
      name: display,
      benefit_type: BENEFIT(cand),
      price: cand.priceInr,
      billing_period: cand.billingPeriod,
      source_urls: [ctx.link],
      official_end: cand.validUntil,
      ...extra,
    }, {});
  }
  const fields: ObservationFields = {
    price: cand.priceInr,
    billing_period: cand.billingPeriod,
    benefit_value: Object.fromEntries(
      Object.entries({ discountPct: cand.discountPct, cashback: cand.cashback || null, free: cand.free || null, validityDays: cand.validityDays }).filter(([, v]) => v !== null),
    ),
    official_start: null,
    official_end: cand.validUntil,
    page_status: null,
    terms_status: null,
  };
  if (Object.keys(fields.benefit_value ?? {}).length === 0) fields.benefit_value = null;
  const fingerprint = sha256(canonicalJson(fields));
  const last = await one<{ fingerprint: string }>(c, `SELECT fingerprint FROM offer_observations WHERE offer_id = $1 AND origin = 'newsletter' ORDER BY id DESC LIMIT 1`, [existing.id]);
  if (last?.fingerprint === fingerprint) return 0;
  const obsId = (
    await one<{ id: number }>(
      c,
      `INSERT INTO offer_observations (offer_id, source_id, source_url, observed_at, parser_version, fingerprint, fields, origin)
       VALUES ($1,NULL,$2,$3,'newsletter-1',$4,$5,'newsletter') RETURNING id`,
      [existing.id, ctx.link, ctx.receivedAt, fingerprint, JSON.stringify(fields)],
    )
  )!.id;
  let n = 0;
  for (const ch of proposeChanges(existing, fields)) n += await insertReview(existing.id, obsId, ch.kind, { ...ch.proposed, ...extra }, ch.current);
  return n;
}

const SAVINGS_CATEGORY: Record<string, string> = {
  bank: 'card', card: 'card', loan: 'loan', broadband: 'utility', dth: 'utility', fuel: 'utility', utility: 'utility', insurance: 'other',
  ott: 'ott', telecom: 'telecom', music: 'music', cloud: 'cloud', mobility: 'mobility', food: 'food', shopping: 'shopping', grocery: 'shopping',
};

/**
 * Called inside decideReview when an approved item came from a newsletter. Creates or updates a savings module
 * (status research; an official-page check is still needed to verify) and logs the catalog change.
 */
export async function applyNewsletterApproval(c: PoolClient, proposed: Record<string, unknown>, offer: OfferRow, actor: AuditActor, now: Date): Promise<void> {
  if (proposed.origin !== 'newsletter') return;
  const watch = await one<WatchRow>(c, 'SELECT * FROM provider_watch WHERE slug = $1', [offer.provider]);
  if (!watch) return;
  if (typeof proposed.official_end === 'string' && !offer.official_end_at) await c.query('UPDATE offers SET official_end_at = $2 WHERE id = $1', [offer.id, proposed.official_end]);
  const ev = (proposed.evidence ?? {}) as { receivedAt?: string };
  const plan = typeof proposed.plan_name === 'string' ? proposed.plan_name : null;
  const product = plan ?? offer.name;
  const moduleId = slugify(`${watch.slug}-${product}`).slice(0, 80) || `${watch.slug}-offer`;
  const link = offer.source_urls[0] ?? watch.signup_url ?? null;
  const period = offer.billing_period;
  const periodDays = period === 'monthly' ? 30 : period === 'annual' ? 365 : period === 'quarterly' ? 90 : typeof proposed.validity_days === 'number' ? proposed.validity_days : null;
  const price = offer.price_inr === null ? null : Number(offer.price_inr);
  const note = `Reported in a provider email${ev.receivedAt ? ` on ${ev.receivedAt.slice(0, 10)}` : ''}. Check the provider's page before switching.`;
  const prev = await catalogVersion(c, now);
  const cur = await one<{ id: string; version: number; status: string; data: Record<string, unknown> }>(c, 'SELECT * FROM savings_modules WHERE id = $1 FOR UPDATE', [moduleId]);
  const summary = summaryOf(watch.display_name, { ...proposed, price, valid_until: proposed.valid_until ?? offer.official_end_at });
  const source = { url: link ?? `https://${watch.sender_domains[0] ?? 'example.invalid'}/`, label: `${watch.display_name} offer page`, kind: 'official', lastVerifiedAt: null };
  if (!cur) {
    const data = {
      status: 'research',
      detect: { merchantAliases: [watch.display_name], senderDomains: watch.sender_domains, keywords: plan ? [plan.toLowerCase()] : [] },
      provider: watch.display_name,
      product,
      category: SAVINGS_CATEGORY[watch.category] ?? 'other',
      country: 'IN',
      cityPack: null,
      rules: { ...(price !== null && periodDays ? { prices: [{ label: plan ?? 'Offer', priceInr: price, periodDays }] } : {}), conditions: [note] },
      valueKind: 'price_change',
      proof: { signal: 'user_confirmed', description: 'You confirm the change in your own account' },
      nudge: { trigger: 'on_detect', leadDays: 0 },
      legalRole: 'information',
      sources: [source],
      actionUrl: link,
      actionLabel: 'Open the offer page',
    };
    await c.query(`INSERT INTO savings_modules (id, version, status, data, updated_at) VALUES ($1,1,'research',$2,$3)`, [moduleId, JSON.stringify(data), now]);
    await writeAudit(c, actor, 'savings.module.newsletter_create', 'savings_module', moduleId, null, { id: moduleId, ...data });
    await recordChange(c, 'module', moduleId, 'new', summary, prev, now);
    return;
  }
  const data = structuredClone(cur.data) as Record<string, unknown> & { rules: { prices?: { label: string; priceInr: number | null; periodDays: number }[]; conditions?: string[] }; sources: { url: string }[] };
  data.rules ??= {};
  if (price !== null && periodDays) {
    const label = plan ?? 'Offer';
    const prices = (data.rules.prices ?? []).filter((p) => p.label !== label);
    data.rules.prices = [...prices, { label, priceInr: price, periodDays }];
  }
  data.rules.conditions = [...new Set([...(data.rules.conditions ?? []), note])].slice(-10);
  if (link && !data.sources.some((s) => s.url === link)) data.sources = [...data.sources, source as never].slice(0, 30);
  // A price learned from an e-mail is unverified again until the official page is re-checked.
  const status = cur.status === 'verified' && price !== null ? 'research' : cur.status;
  data.status = status;
  await c.query(`UPDATE savings_modules SET version = version + 1, status = $2, data = $3, updated_at = $4 WHERE id = $1`, [moduleId, status, JSON.stringify(data), now]);
  await writeAudit(c, actor, 'savings.module.newsletter_update', 'savings_module', moduleId, cur.data, data);
  await recordChange(c, 'module', moduleId, 'updated', summary, prev, now);
}

/* ---------- provider directory seed, retention ---------- */

const watchSeed = z.object({
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(40).default('other'),
  country: z.string().trim().length(2).default('IN'),
  senderDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)).default([]),
  signupUrl: z.string().url().nullable().optional(),
  appOnly: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

/** Fills an EMPTY provider_watch from the research list (status pending). Never overwrites admin edits. */
export async function seedProviderWatch(pool: Pool, file: string, now: Date): Promise<{ inserted: number; skipped: string[] }> {
  const out = { inserted: 0, skipped: [] as string[] };
  if (!existsSync(file)) return out;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    out.skipped.push(`Unreadable file: ${(err as Error).message}`);
    return out;
  }
  const list = Array.isArray(json) ? json : Array.isArray((json as { providers?: unknown })?.providers) ? (json as { providers: unknown[] }).providers : null;
  if (!list) {
    out.skipped.push('Expected an array of providers');
    return out;
  }
  await withTransaction(pool, async (c) => {
    await c.query('LOCK TABLE provider_watch IN SHARE ROW EXCLUSIVE MODE');
    if (((await one<{ n: number }>(c, 'SELECT count(*)::int AS n FROM provider_watch'))?.n ?? 0) > 0) return;
    for (const [i, raw] of list.entries()) {
      const p = watchSeed.safeParse(raw);
      if (!p.success) {
        out.skipped.push(`providers[${i}]: ${p.error.issues[0]?.path.join('.')} ${p.error.issues[0]?.message}`);
        continue;
      }
      const d = p.data;
      const r = await c.query(
        `INSERT INTO provider_watch (slug, display_name, sender_domains, category, country, signup_url, status, app_only, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9,$9) ON CONFLICT (slug) DO NOTHING`,
        [d.slug, d.name, [...new Set(d.senderDomains)], d.category, d.country.toUpperCase(), d.signupUrl ?? null, d.appOnly ?? false, d.notes ?? null, now],
      );
      out.inserted += r.rowCount ?? 0;
    }
  });
  return out;
}

/** Raw mail is wiped after 90 days (parsed metadata stays); rows go after 400 days. */
export async function purgeOfferInbox(q: Queryable, now: Date): Promise<{ rawWiped: number; rowsDeleted: number }> {
  const a = await q.query(`UPDATE offer_inbox_messages SET raw_sealed = NULL WHERE raw_sealed IS NOT NULL AND received_at < $1`, [new Date(now.getTime() - RAW_RETENTION_DAYS * DAY_MS)]);
  const b = await q.query(`DELETE FROM offer_inbox_messages WHERE received_at < $1`, [new Date(now.getTime() - 400 * DAY_MS)]);
  return { rawWiped: a.rowCount ?? 0, rowsDeleted: b.rowCount ?? 0 };
}
