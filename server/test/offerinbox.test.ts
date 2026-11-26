import type { FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from '../src/db.js';
import { authFromHeaders, canonicalUrl, dkimVerifiedDomain, extractCandidates, extractLinks, isPersonalised } from '../src/offerinbox/parse.js';
import { keepAttachments, purgeOfferInbox, seedProviderWatch } from '../src/offerinbox/service.js';
import { Client, drain, freshDb, loggedIn, makeApp, TestClock } from './helpers.js';

const NOW = new Date('2026-11-24T10:00:00Z');
const SECRET = 'inbound-secret-0123456789';
const ENV = { INBOUND_EMAIL_DOMAIN: 'inbox.due.test', INBOUND_WEBHOOK_SECRET: SECRET, DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
const RESEARCH = 'offers@inbox.due.test';
const basic = `Basic ${Buffer.from(`postmark:${SECRET}`).toString('base64')}`;

const JIO = [
  'Jio ₹299 plan is here',
  'Unlimited 5G with 28 days validity at just ₹299.',
  'Valid till 30 Nov 2026.',
  'Recharge now: https://click.jio.example.test/ls/click?upn=abc123opaque',
].join('\n');
const JIO_HTML =
  '<p>Jio ₹299 plan: Unlimited 5G, 28 days validity. Valid till 30 Nov 2026.</p>' +
  '<a href="https://www.jio.example.test/plans/299?utm_source=newsletter&utm_medium=email&gclid=zz&plan=prepaid#top">Recharge</a>' +
  '<a href="https://click.jio.example.test/redirect?url=https%3A%2F%2Fwww.jio.example.test%2Foffers%2F5g%3Futm_campaign%3Dx&sig=abc">Offers</a>' +
  '<a href="https://www.jio.example.test/unsubscribe?id=9">Unsubscribe</a><img src="https://t.jio.example.test/open.gif" width="1" height="1">';
const UBER = ['Get Uber One for ₹149/month.', 'Free for the first 30 days, then ₹149 per month. Use code SAVE50 at checkout.', 'Offer ends 15 Dec 2026.'].join('\n');
const CARD = ['Flat 10% off up to ₹500 on dining with Sample Card.', 'Valid until 31/12/2026. Terms apply.'].join('\n');
const PERSONAL = ['Hi Ravi,', 'Your exclusive coupon ZX81QW gives 20% off on your next recharge of ₹399.', 'Valid for you until 30 Nov 2026.'].join('\n');

function mail(opts: { from: string; subject: string; text: string; html?: string; dkim?: string; domain?: string; id: string; to?: string }) {
  const to = opts.to ?? RESEARCH;
  return {
    From: opts.from,
    FromFull: { Email: opts.from },
    To: to,
    ToFull: [{ Email: to }],
    OriginalRecipient: to,
    Subject: opts.subject,
    TextBody: opts.text,
    HtmlBody: opts.html ?? '',
    Headers: [
      { Name: 'Message-ID', Value: `<${opts.id}@mail.test>` },
      { Name: 'Authentication-Results', Value: `mx.test; dkim=${opts.dkim ?? 'pass'} header.d=${opts.domain ?? opts.from.split('@')[1]}; spf=pass` },
    ],
  };
}

let pool: Pool;
let app: FastifyInstance;
let clock: TestClock;
let editor: Client;
let admin: Client;

const send = (payload: object) => app.inject({ method: 'POST', url: '/api/inbound/email', payload, headers: { authorization: basic } });
const rows = async (sql: string, p: unknown[] = []) => (await pool.query(sql, p)).rows;

beforeAll(async () => {
  pool = await freshDb();
  clock = new TestClock(NOW);
  app = await makeApp(pool, { clock, env: ENV });
  editor = await loggedIn(app, pool, 'ed@example.test', 'editor');
  admin = await loggedIn(app, pool, 'ad@example.test', 'admin');
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE offer_inbox_messages, provider_watch, savings_modules, savings_changes, offer_review_queue, audit_log, jobs_queue, inbound_messages RESTART IDENTITY CASCADE');
  await pool.query('DELETE FROM offer_observations').catch(() => undefined);
  clock.set(NOW);
  expect((await admin.patch('/api/admin/settings', { key: 'offers.research_addresses', value: [RESEARCH] })).statusCode).toBe(200);
  for (const [slugName, name, category, domains] of [
    ['jio', 'Jio', 'telecom', ['jio.example.test']],
    ['uber', 'Uber', 'mobility', ['uber.example.test']],
  ] as const) {
    expect((await editor.post('/api/admin/offer-inbox/watch', { slug: slugName, displayName: name, category, senderDomains: domains })).statusCode).toBe(201);
  }
  expect((await editor.post('/api/admin/offer-inbox/watch', { slug: 'samplecard', displayName: 'Sample Card', category: 'card' })).statusCode).toBe(201);
});

describe('pure parsing', () => {
  it('strips tracking params, unwraps click trackers and drops opaque wrappers', () => {
    expect(canonicalUrl('http://WWW.Shop.test:443/p/?utm_source=a&b=2&a=1&gclid=x&fbclid=y&email=me%40x.com#frag')).toBe('https://www.shop.test/p?a=1&b=2');
    expect(canonicalUrl('https://click.shop.test/r?url=https%3A%2F%2Fshop.test%2Foffer%3Futm_campaign%3Dz&sig=1')).toBe('https://shop.test/offer');
    expect(canonicalUrl('https://click.shop.test/ls/click?upn=opaque')).toBeNull();
    expect(canonicalUrl('mailto:a@b.c')).toBeNull();
  });
  it('collects landing links on the provider domain only; pixels and unsubscribe links are ignored', () => {
    const l = extractLinks(JIO_HTML, 'x', ['jio.example.test']);
    expect(l.landing.sort()).toEqual(['https://www.jio.example.test/offers/5g', 'https://www.jio.example.test/plans/299?plan=prepaid'].sort());
    expect(l.stripped).toBeGreaterThan(0);
    expect(l.landing.join()).not.toMatch(/utm_|gclid|unsubscribe|open\.gif/);
  });
  it('reads provider verdict headers and requires an aligned signing domain', () => {
    const a = authFromHeaders({ 'Authentication-Results': 'mx; dkim=pass header.d=mail.jio.example.test; spf=pass' });
    expect(a).toEqual({ dkim: 'pass', dkimDomain: 'mail.jio.example.test', spf: 'pass' });
    expect(dkimVerifiedDomain(a, 'jio.example.test')).toBe('jio.example.test');
    expect(dkimVerifiedDomain(a, 'evil.test')).toBeNull();
    expect(dkimVerifiedDomain(authFromHeaders({ 'Authentication-Results': 'mx; dkim=fail header.d=jio.example.test' }), 'jio.example.test')).toBeNull();
    expect(authFromHeaders({ 'X-Mailgun-Dkim-Check-Result': 'Pass', 'DKIM-Signature': 'v=1; d=uber.example.test; s=x' }).dkimDomain).toBe('uber.example.test');
    expect(authFromHeaders({}).dkim).toBe('none');
  });
  it('extracts candidates from four synthetic emails', () => {
    const jio = extractCandidates(JIO, NOW);
    expect(jio[0]).toMatchObject({ kind: 'plan', priceInr: 299, validityDays: 28, billingPeriod: 'none', validUntil: '2026-11-30' });
    const uber = extractCandidates(UBER, NOW);
    expect(uber[0]).toMatchObject({ planName: 'Uber One', priceInr: 149, billingPeriod: 'monthly', free: true, validUntil: '2026-12-15' });
    expect(uber[0]!.promoCodes).toEqual([{ code: 'SAVE50', possiblyPersonal: true }]);
    const card = extractCandidates(CARD, NOW);
    expect(card[0]).toMatchObject({ kind: 'discount', discountPct: 10, validUntil: '2026-12-31' });
    expect(isPersonalised('x', JIO)).toBe(false);
    expect(isPersonalised('x', UBER)).toBe(false);
    expect(isPersonalised('x', CARD)).toBe(false);
    expect(isPersonalised('Offer', PERSONAL)).toBe(true);
    expect(isPersonalised('x', 'Hello there,\nGet 10% off.')).toBe(false);
  });
  it('keeps only PDFs and images under 5 MB', () => {
    const big = Buffer.alloc(6 * 1024 * 1024).toString('base64');
    const { kept, dropped } = keepAttachments([
      { name: 'a.pdf', contentType: 'application/pdf', size: 100, contentBase64: 'QQ==' },
      { name: 'b.png', contentType: 'image/png', size: 100, contentBase64: 'QQ==' },
      { name: 'c.zip', contentType: 'application/zip', size: 100, contentBase64: 'QQ==' },
      { name: 'd.pdf', contentType: 'application/pdf', size: 6 * 1024 * 1024, contentBase64: big },
    ]);
    expect(kept.map((a) => a.name)).toEqual(['a.pdf', 'b.png']);
    expect(dropped).toBe(2);
  });
});

describe('routing', () => {
  it('sends research-mailbox mail to the offer inbox (sealed), never to user intake', async () => {
    const r = await send(mail({ from: 'offers@jio.example.test', subject: 'Jio ₹299 plan', text: JIO, id: 'r1' }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, queued: true, research: true });
    expect(await rows('SELECT 1 FROM inbound_messages')).toHaveLength(0);
    expect(await rows('SELECT 1 FROM user_events')).toHaveLength(0);
    const m = (await rows('SELECT * FROM offer_inbox_messages'))[0];
    expect(m.raw_sealed.startsWith('v2:')).toBe(true);
    expect(m.raw_sealed).not.toContain('Unlimited 5G');
    expect((await rows(`SELECT type FROM jobs_queue`)).map((j) => j.type)).toEqual(['offers.inbox_parse']);
    // Same Message-ID is deduped.
    expect((await send(mail({ from: 'offers@jio.example.test', subject: 'Jio ₹299 plan', text: JIO, id: 'r1' }))).json().queued).toBe(false);
    // Other recipients still follow the user path (unknown alias here).
    const u = await send(mail({ from: 'a@b.test', subject: 'x', text: 'x', id: 'u1', to: 'someone@inbox.due.test' }));
    expect(u.statusCode).toBe(403);
    expect(await rows('SELECT 1 FROM offer_inbox_messages')).toHaveLength(1);
  });

  it('quarantines DKIM failures and misaligned senders: nothing parsed, nothing queued', async () => {
    await send(mail({ from: 'offers@jio.example.test', subject: 'Spoof', text: JIO, id: 'q1', dkim: 'fail' }));
    await send(mail({ from: 'offers@jio.example.test', subject: 'Misaligned', text: JIO, id: 'q2', domain: 'esp.example.net' }));
    await drain(app);
    const m = await rows('SELECT status, reason, candidates, provider_slug FROM offer_inbox_messages ORDER BY received_at, subject');
    expect(m.map((x) => [x.status, x.reason])).toEqual([['quarantined', 'dkim_domain_not_aligned'], ['quarantined', 'dkim_failed']]);
    expect(m.every((x) => x.candidates.length === 0 && x.provider_slug === null)).toBe(true);
    expect(await rows('SELECT 1 FROM offer_review_queue')).toHaveLength(0);
    expect((await rows('SELECT last_email_at FROM provider_watch WHERE slug = $1', ['jio']))[0].last_email_at).toBeNull();
  });
});

describe('pipeline: extraction, review, catalog', () => {
  async function deliverAll() {
    await send(mail({ from: 'offers@jio.example.test', subject: 'Jio ₹299 plan', text: JIO, html: JIO_HTML, id: 'e1' }));
    await send(mail({ from: 'hello@uber.example.test', subject: 'Uber One offer', text: UBER, id: 'e2' }));
    await send(mail({ from: 'deals@jio.example.test', subject: 'Recharge for you', text: PERSONAL, id: 'e4' }));
    await drain(app);
  }

  it('parses generic mail into review items; personalised mail is research only', async () => {
    await deliverAll();
    const msgs = await rows('SELECT * FROM offer_inbox_messages ORDER BY subject');
    const by = Object.fromEntries(msgs.map((m) => [m.subject, m]));
    expect(by['Jio ₹299 plan']).toMatchObject({ status: 'parsed', provider_slug: 'jio', personalised: false, reviews_queued: 1 });
    expect(by['Jio ₹299 plan'].landing_urls).toContain('https://www.jio.example.test/plans/299?plan=prepaid');
    expect(by['Jio ₹299 plan'].candidates[0]).toMatchObject({ priceInr: 299, validUntil: '2026-11-30' });
    expect(by['Recharge for you']).toMatchObject({ status: 'parsed', reason: 'personalised', personalised: true, reviews_queued: 0, landing_urls: [] });
    expect(JSON.stringify(by['Recharge for you'].candidates)).not.toMatch(/ZX81QW|Ravi/);
    expect(by['Uber One offer'].candidates[0].promoCodes[0]).toEqual({ code: 'SAVE50', possiblyPersonal: true });
    const q = await rows(`SELECT change_kind, proposed FROM offer_review_queue ORDER BY id`);
    expect(q).toHaveLength(2);
    expect(q.every((r) => r.change_kind === 'new_offer' && r.proposed.origin === 'newsletter')).toBe(true);
    expect(q.find((r) => r.proposed.provider === 'jio').proposed.evidence).toMatchObject({ sourceKind: 'newsletter', subject: 'Jio ₹299 plan' });
    expect(JSON.stringify(q.map((r) => r.proposed.source_urls))).not.toMatch(/utm_|click\./);
    expect((await rows('SELECT last_email_at FROM provider_watch WHERE slug = $1', ['jio']))[0].last_email_at).toBeTruthy();
  });

  it('approving a newsletter review creates a research module, bumps the catalog version and feeds the changes endpoint', async () => {
    const v0 = (await app.inject({ method: 'GET', url: '/api/public/savings/catalog' })).json().version;
    await deliverAll();
    const items = (await editor.get('/api/admin/review')).json().items as { id: number; proposed: { provider: string } }[];
    const uber = items.find((i) => i.proposed.provider === 'uber')!;
    const ok = await editor.post(`/api/admin/review/${uber.id}/approve`, {});
    expect(ok.statusCode).toBe(200);

    const cat = (await app.inject({ method: 'GET', url: '/api/public/savings/catalog' })).json();
    expect(cat.version).not.toBe(v0);
    const mod = cat.modules.find((m: { provider: string }) => m.provider === 'Uber');
    expect(mod).toMatchObject({ status: 'research', valueKind: 'price_change', legalRole: 'information' });
    expect(mod.rules.prices[0]).toMatchObject({ priceInr: 149, periodDays: 30 });
    expect(mod.sources[0]).toMatchObject({ kind: 'official', lastVerifiedAt: null });
    expect(JSON.stringify(mod)).not.toMatch(/SAVE50/);

    const ch = (await app.inject({ method: 'GET', url: `/api/public/savings/catalog/changes?since=${v0}` })).json();
    expect(ch.version).toBe(cat.version);
    expect(ch.reset).toBe(false);
    expect(ch.moduleIds).toEqual([mod.id]);
    expect(ch.changes[0]).toMatchObject({ entity: 'module', kind: 'new', summary: expect.stringContaining('Uber: Uber One ₹149') });
    // Up to date: nothing. Unknown version: reset with recent changes.
    expect((await app.inject({ method: 'GET', url: `/api/public/savings/catalog/changes?since=${cat.version}` })).json()).toMatchObject({ changes: [], reset: false });
    expect((await app.inject({ method: 'GET', url: '/api/public/savings/catalog/changes?since=deadbeef00' })).json()).toMatchObject({ reset: true });
    expect((await app.inject({ method: 'GET', url: '/api/public/savings/catalog/changes?since=NOT_HEX' })).statusCode).toBe(400);

    // Verification still needs an official page check.
    expect((await editor.post(`/api/admin/savings/modules/${mod.id}/verify`)).statusCode).toBe(422);
    const body = { ...mod, sources: [{ ...mod.sources[0], lastVerifiedAt: '2026-11-24T00:00:00Z' }] };
    delete body.version;
    delete body.updatedAt;
    expect((await editor.req('PUT', `/api/admin/savings/modules/${mod.id}`, body)).statusCode).toBe(200);
    expect((await editor.post(`/api/admin/savings/modules/${mod.id}/verify`)).statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: `/api/public/savings/catalog/changes?since=${cat.version}` })).json();
    expect(after.changes).toHaveLength(1);
    expect(after.changes[0].kind).toBe('verified');
  });

  it('a card offer from a provider without sender domains waits as an unmatched sender until one click attaches the domain', async () => {
    await send(mail({ from: 'offers@card.example.test', subject: 'Card dining offer', text: CARD, id: 'c1' }));
    await drain(app);
    expect((await rows('SELECT reason FROM offer_inbox_messages'))[0].reason).toBe('unmatched_sender');
    const un = (await editor.get('/api/admin/offer-inbox/unmatched')).json();
    expect(un.items).toMatchObject([{ domain: 'card.example.test', messages: 1 }]);
    expect((await editor.post('/api/admin/offer-inbox/unmatched/attach', { domain: 'card.example.test', providerSlug: 'nope' })).statusCode).toBe(404);
    expect((await editor.post('/api/admin/offer-inbox/unmatched/attach', { domain: 'jio.example.test', providerSlug: 'samplecard' })).statusCode).toBe(409);
    const at = await editor.post('/api/admin/offer-inbox/unmatched/attach', { domain: 'card.example.test', providerSlug: 'samplecard' });
    expect(at.json()).toMatchObject({ requeued: 1 });
    await drain(app);
    expect((await rows('SELECT status, provider_slug, reviews_queued FROM offer_inbox_messages'))[0]).toMatchObject({ status: 'parsed', provider_slug: 'samplecard', reviews_queued: 1 });
    expect((await editor.get('/api/admin/offer-inbox/unmatched')).json().items).toEqual([]);
    const msgs = (await editor.get('/api/admin/offer-inbox/messages?provider=samplecard')).json();
    expect(msgs.items[0]).toMatchObject({ providerName: 'Sample Card', subject: 'Card dining offer', status: 'parsed' });
    expect(msgs.items[0].candidates[0]).toMatchObject({ discountPct: 10 });
  });
});

describe('watchlist', () => {
  it('supports CRUD, mark subscribed and the 30-day stale filter; viewers cannot write', async () => {
    const viewer = await loggedIn(app, pool, 'v@example.test', 'viewer');
    expect((await viewer.post('/api/admin/offer-inbox/watch', { slug: 'x', displayName: 'X' })).statusCode).toBe(403);
    expect((await editor.post('/api/admin/offer-inbox/watch', { slug: 'jio', displayName: 'Dup' })).statusCode).toBe(409);
    const ms = await editor.post('/api/admin/offer-inbox/watch/jio/mark-subscribed', { researchAddress: RESEARCH });
    expect(ms.json()).toMatchObject({ status: 'subscribed', researchAddress: RESEARCH });
    await editor.post('/api/admin/offer-inbox/watch/uber/mark-subscribed', {});
    await pool.query(`UPDATE provider_watch SET last_email_at = $1 WHERE slug = 'jio'`, [new Date('2026-11-20T00:00:00Z')]);
    await pool.query(`UPDATE provider_watch SET last_email_at = $1 WHERE slug = 'uber'`, [new Date('2026-09-01T00:00:00Z')]);
    const stale = (await viewer.get('/api/admin/offer-inbox/watch?stale=true')).json();
    expect(stale.items.map((i: { slug: string }) => i.slug)).toEqual(['uber']);
    expect((await editor.patch('/api/admin/offer-inbox/watch/uber', { senderDomains: ['Uber.Example.Test', 'mail.uber.example.test'], notes: 'n' })).json().senderDomains).toEqual(['uber.example.test', 'mail.uber.example.test']);
    expect((await editor.del('/api/admin/offer-inbox/watch/samplecard')).statusCode).toBe(204);
    expect((await editor.del('/api/admin/offer-inbox/watch/samplecard')).statusCode).toBe(404);
  });
});

describe('seed and retention', () => {
  it('seeds provider_watch once into an empty table as pending and skips bad rows', async () => {
    await pool.query('TRUNCATE provider_watch CASCADE');
    const file = resolve(import.meta.dirname, 'fixtures/provider-watch-seed.json');
    const r = await seedProviderWatch(pool, file, NOW);
    expect(r.inserted).toBe(3);
    expect(r.skipped).toHaveLength(1);
    expect((await rows('SELECT DISTINCT status FROM provider_watch')).map((x) => x.status)).toEqual(['pending']);
    await pool.query(`UPDATE provider_watch SET display_name = 'Edited' WHERE slug = 'jio'`);
    expect((await seedProviderWatch(pool, file, NOW)).inserted).toBe(0);
    expect((await rows(`SELECT display_name FROM provider_watch WHERE slug = 'jio'`))[0].display_name).toBe('Edited');
    expect(await seedProviderWatch(pool, resolve(import.meta.dirname, 'fixtures/nope.json'), NOW)).toEqual({ inserted: 0, skipped: [] });
  });

  it('loads the researched watchlist file', async () => {
    await pool.query('TRUNCATE provider_watch CASCADE');
    const r = await seedProviderWatch(pool, resolve(import.meta.dirname, '../src/seed/provider-watchlist.json'), NOW);
    expect(r.inserted).toBeGreaterThan(100);
    expect(r.skipped).toEqual([]);
  });

  it('wipes sealed raw mail after 90 days but keeps the parsed record', async () => {
    await send(mail({ from: 'offers@jio.example.test', subject: 'Old', text: JIO, id: 'old1' }));
    await drain(app);
    expect((await purgeOfferInbox(pool, new Date('2027-01-15T00:00:00Z'))).rawWiped).toBe(0);
    expect((await purgeOfferInbox(pool, new Date('2027-02-25T00:00:00Z'))).rawWiped).toBe(1);
    expect((await rows('SELECT raw_sealed, status FROM offer_inbox_messages'))[0]).toMatchObject({ raw_sealed: null, status: 'parsed' });
  });
});
