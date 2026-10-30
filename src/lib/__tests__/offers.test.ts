import { describe, expect, it } from 'vitest';
import { computeStatus, isRecommendable, isStale, isVerificationPending } from '../offers/status';
import {
  cancellationOwner,
  completeness,
  entitlementFor,
  evaluateEligibility,
  matchSummary,
} from '../offers/eligibility';
import { appendObservation, fingerprint, historyFor } from '../offers/observations';
import {
  airtel699Prime,
  airtelMonthlyCashback,
  googleAiTrial,
  jioAiCloud,
} from '../offers/calculator';
import { isSafeHttpUrl } from '../offers/sources';
import {
  CATALOG_CACHE_KEY,
  catalogUrl,
  fetchCatalog,
  formatIST,
  loadCatalogCache,
  normaliseOffer,
  normaliseOffers,
  parseCatalogPayload,
  saveCatalogCache,
} from '../offers/api';
import {
  PrivateEventStore,
  PublicObservationCache,
  canSurfaceAsBenefit,
  deleteAllIntake,
  organisePastedMessage,
  processForwarded,
  purgeRaw,
  relayAddress,
  setEventState,
  verifyForwardingToken,
} from '../offers/relay';
import { emptyRelay } from '../offers/relay';
import { addOfferReminder, blankService } from '../offers/services';
import { emptyData } from '../data';
import type { OfferRecord, RelayState, UserServiceRecord } from '../offers/types';

const TODAY = '2026-10-30';

// Test fixtures in the contract shape of GET /api/public/catalog. Test-only; never shipped.
const src = (url: string, category: string) => ({
  url,
  label: `${category} page`,
  category,
  lastCheckedAt: '2026-10-30T04:00:00.000Z',
  status: 'active',
});
const raw = (o: Record<string, unknown>) => ({
  provider: 'Test',
  product_family: 'Family',
  benefit_type: 'recurring_entitlement',
  benefit_value: {},
  terms_status: 'active',
  page_status: 'visible',
  confidence: 'high',
  notes: [],
  verification_status: 'verified',
  observed_at: '2026-10-30T04:00:00.000Z',
  last_confirmed_at: '2026-10-30T04:00:00.000Z',
  sources: [src('https://provider.test/plans', 'pricing')],
  ...o,
});
const FIXTURE = [
  raw({
    id: 'fx-plan',
    provider: 'google',
    name: 'Plan',
    price_inr: 399,
    billing_period: 'monthly',
  }),
  raw({
    id: 'fx-conflict',
    provider: 'jio',
    name: 'Conflicting offer',
    terms_status: 'unavailable',
    sources: [
      src('https://provider.test/offer', 'official_site'),
      src('https://provider.test/t', 'terms'),
    ],
  }),
  raw({
    id: 'fx-press',
    provider: 'airtel',
    name: 'Press-only offer',
    page_status: 'unknown',
    sources: [src('https://provider.test/press', 'press')],
  }),
  raw({
    id: 'fx-expired',
    provider: 'amazon',
    name: 'Past campaign',
    official_end_at: '2026-05-31',
    terms_status: 'expired',
    page_status: 'unknown',
  }),
  raw({
    id: 'fx-recharge-prime',
    provider: 'Airtel',
    name: 'Recharge with Prime',
    sku_or_plan_code: '699',
    product_family: 'Airtel prepaid',
    benefit_type: 'bundle',
    price_inr: 699,
    eligibility: [
      {
        kind: 'service_type',
        description: 'Prepaid number',
        verification: 'user_input',
        field: 'serviceType',
        expected: 'prepaid',
      },
      {
        kind: 'existing_subscription',
        description: 'Existing Prime members may not be eligible',
        verification: 'user_input',
        field: 'existingSubscription',
        expected: false,
      },
      { kind: 'address_circle', description: 'Circle availability', verification: 'provider_only' },
    ],
  }),
  raw({ id: 'vi-movies-tv', provider: 'vi', name: 'Vi Movies & TV', benefit_type: 'bundle' }),
  raw({
    id: 'fx-pending',
    provider: 'jio',
    name: 'Research-derived',
    verification_status: 'research_snapshot',
  }),
  raw({ id: 'fx-rejected', provider: 'jio', name: 'Rejected', verification_status: 'rejected' }),
];
const catalog = normaliseOffers(FIXTURE, TODAY);
const get = (id: string) => catalog.find((o) => o.offerId === id)!;
const base = (o: Partial<OfferRecord>): Omit<OfferRecord, 'computedStatus'> => {
  const { computedStatus: _c, ...rest } = { ...get('fx-plan'), ...o };
  void _c;
  return rest;
};
const svc = (o: Partial<UserServiceRecord>): UserServiceRecord => ({
  ...blankService('airtel', TODAY),
  ...o,
});

describe('status rules', () => {
  it('active offer with no expiry date is active_verify, never an invented expiry', () => {
    expect(get('fx-plan').computedStatus).toBe('active_verify');
    expect(get('fx-plan').officialEndAt).toBeUndefined();
  });
  it('official end date in the past is expired', () => {
    expect(computeStatus(base({ officialEndAt: '2026-10-01' }), TODAY)).toBe('expired');
  });
  it('visible landing page with unavailable terms is never active', () => {
    expect(computeStatus(base({ pageStatus: 'visible', termsStatus: 'unavailable' }), TODAY)).toBe(
      'conflicting',
    );
    expect(computeStatus(base({ pageStatus: 'unknown', termsStatus: 'unavailable' }), TODAY)).toBe(
      'expired',
    );
    expect(computeStatus(base({ pageStatus: 'visible', termsStatus: 'unknown' }), TODAY)).toBe(
      'unknown',
    );
  });
  it('visible landing page + unavailable terms is shown as conflicting', () => {
    expect(get('fx-conflict').computedStatus).toBe('conflicting');
    expect(isRecommendable(get('fx-conflict').computedStatus)).toBe(false);
  });
  it('a press release alone is not a current offer', () => {
    expect(get('fx-press').computedStatus).toBe('unknown');
  });
  it('a past campaign stays in history but is not active', () => {
    const o = get('fx-expired');
    expect(o.computedStatus).toBe('expired');
    expect(catalog).toContain(o);
  });
  it('expired and conflicting records never appear in the default list', () => {
    const list = catalog.filter((o) => isRecommendable(o.computedStatus));
    expect(
      list.some((o) => o.computedStatus === 'expired' || o.computedStatus === 'conflicting'),
    ).toBe(false);
    expect(list.length).toBeGreaterThan(2);
  });
  it('freshness: stale after the cadence window', () => {
    expect(isStale({ lastConfirmedAt: '2026-10-30', cadence: 'weekly' }, '2026-11-05')).toBe(false);
    expect(isStale({ lastConfirmedAt: '2026-10-30', cadence: 'weekly' }, '2026-11-10')).toBe(true);
  });
});

describe('catalog API client', () => {
  it('maps the contract shape and keeps source attribution', () => {
    const o = get('fx-recharge-prime');
    expect(o.provider).toBe('airtel');
    expect(o.price).toBe(699);
    expect(o.sources[0]).toMatchObject({
      url: 'https://provider.test/plans',
      category: 'pricing',
      kind: 'plan_page',
      lastCheckedAt: '2026-10-30T04:00:00.000Z',
    });
    expect(o.eligibility).toHaveLength(3);
  });
  it('drops rejected and malformed records and never invents values', () => {
    expect(catalog.some((o) => o.offerId === 'fx-rejected')).toBe(false);
    expect(normaliseOffer({ id: 'x' }, TODAY)).toBeNull();
    expect(normaliseOffer('nope', TODAY)).toBeNull();
    const bare = normaliseOffer({ id: 'b', name: 'Bare', provider: 'X' }, TODAY)!;
    expect(bare.price).toBeUndefined();
    expect(bare.lastConfirmedAt).toBeNull();
    expect(bare.observedAt).toBeNull();
    expect(bare.verificationStatus).toBe('pending');
    expect(bare.benefitType).toBe('other');
    expect(bare.sources).toEqual([]);
  });
  it('labels research_snapshot and pending records as verification pending', () => {
    expect(isVerificationPending(get('fx-pending'))).toBe(true);
    expect(isVerificationPending(get('fx-plan'))).toBe(false);
  });
  it('drops unsafe source links', () => {
    const o = normaliseOffer(
      raw({ id: 'u', name: 'U', sources: [{ url: 'javascript:alert(1)', category: 'terms' }] }),
      TODAY,
    )!;
    expect(o.sources).toEqual([]);
    expect(isSafeHttpUrl('https://a.test/x')).toBe(true);
    expect(isSafeHttpUrl('not a url')).toBe(false);
  });
  it('a passed official end date is expired even if the server says active', () => {
    const o = normaliseOffer(
      raw({ id: 'e', name: 'E', computed_status: 'active', official_end_at: '2026-10-01' }),
      TODAY,
    )!;
    expect(o.computedStatus).toBe('expired');
  });
  it('validates the envelope', () => {
    expect(parseCatalogPayload({ generatedAt: '2026-10-30T00:00:00Z', offers: [] })).toEqual({
      generatedAt: '2026-10-30T00:00:00Z',
      offers: [],
    });
    expect(parseCatalogPayload({ offers: [] })).toBeNull();
    expect(parseCatalogPayload({ generatedAt: 'x', offers: [] })).toBeNull();
    expect(parseCatalogPayload([])).toBeNull();
  });
  it('builds the URL from the API base', () => {
    expect(catalogUrl('')).toBe('/api/public/catalog');
    expect(catalogUrl('https://api.example.test/')).toBe(
      'https://api.example.test/api/public/catalog',
    );
  });
  it('fetches with GET, no credentials, and returns the payload', async () => {
    const calls: [string, { method: string; credentials: string }][] = [];
    const r = await fetchCatalog({
      base: 'https://api.example.test',
      now: () => '2026-10-30T10:00:00.000Z',
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        return {
          ok: true,
          status: 200,
          json: async () => ({ generatedAt: '2026-10-30T09:00:00Z', offers: FIXTURE }),
        };
      },
    });
    expect(calls[0][0]).toBe('https://api.example.test/api/public/catalog');
    expect(calls[0][1]).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(r.ok && r.data.generatedAt).toBe('2026-10-30T09:00:00Z');
    expect(r.ok && r.data.fetchedAt).toBe('2026-10-30T10:00:00.000Z');
  });
  it('reports HTTP, invalid-body, network and timeout failures', async () => {
    const http = await fetchCatalog({
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    expect(!http.ok && http.error).toMatchObject({ kind: 'http', status: 503 });
    const bad = await fetchCatalog({
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ hello: 1 }) }),
    });
    expect(!bad.ok && bad.error.kind).toBe('invalid');
    const net = await fetchCatalog({
      fetchImpl: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(!net.ok && net.error.kind).toBe('network');
    const slow = await fetchCatalog({
      timeoutMs: 10,
      fetchImpl: (_u, init) =>
        new Promise((_, reject) =>
          init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    });
    expect(!slow.ok && slow.error.kind).toBe('timeout');
  });
  it('caches the last good response with its generatedAt', () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    expect(loadCatalogCache(fake)).toBeNull();
    const c = {
      generatedAt: '2026-10-30T09:00:00Z',
      fetchedAt: '2026-10-30T10:00:00Z',
      offers: FIXTURE,
    };
    expect(saveCatalogCache(c, fake)).toBe(true);
    expect(store.has(CATALOG_CACHE_KEY)).toBe(true);
    expect(loadCatalogCache(fake)).toEqual(c);
    store.set(CATALOG_CACHE_KEY, '{broken');
    expect(loadCatalogCache(fake)).toBeNull();
    expect(
      loadCatalogCache({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBeNull();
  });
  it('an empty catalog stays empty', () => {
    expect(normaliseOffers([], TODAY)).toEqual([]);
  });
  it('formats times in IST', () => {
    expect(formatIST('2026-10-30T09:30:00Z')).toMatch(/30 Oct 2026.*3:00.*pm IST/i);
    expect(formatIST('bad')).toBe('unknown time');
  });
});

describe('eligibility and scenarios', () => {
  it('existing Prime user on Airtel ₹699 gets a may-not-qualify warning and no value', () => {
    const items = evaluateEligibility(
      get('fx-recharge-prime'),
      svc({ serviceType: 'prepaid', existingSubscription: true }),
    );
    expect(matchSummary(items)).toBe('may_not_qualify');
    const r = airtel699Prime({
      existingPrime: true,
      avoidedPrimeCostPaise: 30000,
      documentedPricePaise: 69900,
    });
    expect(r.estimatedValuePaise).toBe(0);
    expect(r.warnings.join()).toMatch(/may not be eligible/);
  });
  it('a full match is still only "may qualify", with provider-only checks left', () => {
    const items = evaluateEligibility(
      get('fx-recharge-prime'),
      svc({ serviceType: 'prepaid', existingSubscription: false }),
    );
    expect(matchSummary(items)).toBe('may_qualify');
    expect(items.some((i) => i.state === 'provider_only')).toBe(true);
  });
  it('missing fields are reported, not guessed', () => {
    const s = svc({ serviceType: 'prepaid' });
    expect(matchSummary(evaluateEligibility(get('fx-recharge-prime'), s))).toBe('needs_details');
    expect(completeness(s, [get('fx-recharge-prime')]).missing).toEqual([
      'Existing Prime members may not be eligible',
    ]);
  });
  it('Airtel wallet and UPI cashback cannot be combined; used reward shows ₹0', () => {
    const both = airtelMonthlyCashback({
      variants: ['wallet', 'upi'],
      rewardPaise: 5000,
      alreadyUsedThisMonth: false,
    });
    expect(both.warnings.join()).toMatch(/cannot be combined/);
    expect(both.estimatedValuePaise).toBe(5000);
    expect(
      airtelMonthlyCashback({ variants: ['upi'], rewardPaise: 5000, alreadyUsedThisMonth: true })
        .estimatedValuePaise,
    ).toBe(0);
  });
  it('Vi keeps the user-selected OTT count and shows a caveat', () => {
    const e = entitlementFor(get('vi-movies-tv'), svc({ provider: 'vi', selectedOttCount: 7 }));
    expect(e.value).toContain('7 OTT apps');
    expect(e.caveat).toBeTruthy();
  });
  it('JioAICloud: free for Jio, trial end from documented months for non-Jio', () => {
    const t = { trialMonths: 3, storageGb: 50 };
    expect(jioAiCloud({ numberType: 'jio', trialStart: null, ...t }).reminderDate).toBeUndefined();
    expect(jioAiCloud({ numberType: 'non_jio', trialStart: '2026-11-30', ...t }).reminderDate).toBe(
      '2027-02-28',
    );
  });
  it('JioAICloud without documented trial terms invents no length', () => {
    const r = jioAiCloud({
      numberType: 'non_jio',
      trialStart: '2026-11-30',
      trialMonths: null,
      storageGb: null,
    });
    expect(r.reminderDate).toBeUndefined();
    expect(r.lines[0].label).toMatch(/Not available from Due’s monitoring service/);
  });
  it('Google trial shows paid renewal and a decide-by date', () => {
    const r = googleAiTrial({ plan: 'pro', trialEnd: '2026-12-01', documentedPricePaise: 195000 });
    expect(r.lines.some((l) => l.paise === 195000)).toBe(true);
    expect(r.reminderDate).toBe('2026-12-01');
  });
  it('calculator uses no bundled price when the monitoring service has none', () => {
    const g = googleAiTrial({ plan: 'pro', trialEnd: null, documentedPricePaise: null });
    expect(g.lines.every((l) => l.kind !== 'documented')).toBe(true);
    const a = airtel699Prime({
      existingPrime: false,
      avoidedPrimeCostPaise: null,
      documentedPricePaise: null,
    });
    expect(a.lines.some((l) => l.kind === 'documented')).toBe(false);
  });
  it('partner-billed Google plan routes to the partner, not Google’s cancellation screen', () => {
    expect(
      cancellationOwner({ provider: 'google', billedThrough: 'partner', partnerName: 'Airtel' }),
    ).toMatch(/Airtel/);
    expect(
      cancellationOwner({ provider: 'google', billedThrough: 'partner', partnerName: 'Airtel' }),
    ).not.toMatch(/Google One/);
    expect(cancellationOwner({ provider: 'google', billedThrough: 'direct' })).toMatch(/Google/);
  });
});

describe('observations and refresh', () => {
  it('is append-only and detects changes by fingerprint', () => {
    const o = {
      offerId: 'x',
      sourceUrl: 'https://www.jio.com/a',
      sourceKind: 'terms' as const,
      observedAt: TODAY,
    };
    let list = appendObservation([], { ...o, fact: 'terms=active' });
    const first = list[0];
    list = appendObservation(list, { ...o, fact: 'terms=active' });
    list = appendObservation(list, { ...o, fact: 'terms=unavailable' });
    expect(list.map((x) => x.changeType)).toEqual(['new', 'unchanged', 'changed']);
    expect(list[0]).toBe(first);
    expect(historyFor(list, 'x').length).toBe(3);
    expect(fingerprint(' A  b ')).toBe(fingerprint('a b'));
  });
});

describe('reminders and data safety', () => {
  it('a reminder stores a date and label only', () => {
    const d = addOfferReminder(emptyData(), 'svc1', 'Trial ends', '2026-12-01');
    expect(Object.keys(d.offerReminders[0]).sort()).toEqual(['date', 'id', 'label', 'refId']);
  });
  it('service records have no credential fields', () => {
    const keys = Object.keys(svc({ planName: 'x', numberType: 'jio', paymentRail: 'upi' })).join(
      ' ',
    );
    expect(keys).not.toMatch(/password|otp|cvv|card_?number|pin|aadhaar|kyc|sim|bank/i);
  });
});

describe('Due Relay', () => {
  const connected: RelayState = {
    status: 'connected',
    token: 'abc234',
    retentionDays: 7,
    events: [],
  };
  const msg = {
    messageId: 'm1',
    to: relayAddress('abc234'),
    from: 'alerts@airtel.in',
    subject: 'Your Airtel prepaid recharge of ₹699 is successful',
    body: 'Includes 56 days of Amazon Prime. Valid till 25 Dec 2026.',
    receivedAt: '2026-10-30T10:00:00.000Z',
  };
  it('verifies the forwarding token and paused state', () => {
    expect(verifyForwardingToken(msg.to, connected)).toBe(true);
    expect(verifyForwardingToken('u_other@inbox.due.app', connected)).toBe(false);
    expect(
      processForwarded(msg, { ...connected, status: 'paused' }, catalog, msg.receivedAt),
    ).toEqual({ ok: false, reason: 'paused' });
    expect(
      processForwarded({ ...msg, to: 'u_zzz@inbox.due.app' }, connected, catalog, msg.receivedAt),
    ).toEqual({ ok: false, reason: 'bad_token' });
  });
  it('extracts a candidate that stays unconfirmed, and deduplicates', () => {
    const r = processForwarded(msg, connected, catalog, msg.receivedAt);
    if (!r.ok) throw new Error('expected ok');
    expect(r.event.state).toBe('needs_confirmation');
    expect(r.event.candidate.amountPaise).toBe(69900);
    expect(r.event.candidate.provider).toBe('airtel');
    expect(r.event.matchedOfferIds).toContain('fx-recharge-prime');
    expect(r.event.verification).toBe('source_supported');
    const withEv = { ...connected, events: [r.event] };
    expect(processForwarded(msg, withEv, catalog, msg.receivedAt)).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    expect(processForwarded({ ...msg, messageId: 'm2' }, withEv, catalog, msg.receivedAt)).toEqual({
      ok: false,
      reason: 'duplicate',
    });
  });
  it('uncertain messages are marked could-not-identify', () => {
    const r = processForwarded(
      { ...msg, messageId: 'm3', subject: 'hello', body: 'see you soon' },
      connected,
      catalog,
      msg.receivedAt,
    );
    expect(r.ok && r.event.state).toBe('could_not_identify');
  });
  it('an unconfirmed candidate can never surface as a benefit', () => {
    const r = processForwarded(msg, connected, catalog, msg.receivedAt);
    if (!r.ok) throw new Error('expected ok');
    expect(canSurfaceAsBenefit(r.event, catalog)).toBe(false);
    const st = setEventState({ ...connected, events: [r.event] }, r.event.id, 'saved');
    expect(canSurfaceAsBenefit(st.events[0], catalog)).toBe(true);
  });
  it('raw text is purged after retention and intake can be deleted', () => {
    const r = processForwarded(msg, connected, catalog, msg.receivedAt);
    if (!r.ok) throw new Error('expected ok');
    const st = { ...connected, events: [r.event] };
    expect(purgeRaw(st, '2026-11-01T00:00:00.000Z').events[0].rawExcerpt).not.toBeNull();
    expect(purgeRaw(st, '2026-11-07T00:00:00.000Z').events[0].rawExcerpt).toBeNull();
    expect(deleteAllIntake(st).events).toEqual([]);
  });
  it('organises a pasted message locally without any forwarding address', () => {
    const local = emptyRelay();
    const r = organisePastedMessage(`${msg.subject}\n${msg.body}`, local, catalog, msg.receivedAt);
    if (!r.ok) throw new Error('expected ok');
    expect(local.status).toBe('not_connected');
    expect(r.event.state).toBe('needs_confirmation');
    expect(r.event.verification).not.toBe('user_confirmed');
    const again = organisePastedMessage(
      `${msg.subject}\n${msg.body}`,
      { ...local, events: [r.event] },
      catalog,
      msg.receivedAt,
    );
    expect(again).toEqual({ ok: false, reason: 'duplicate' });
  });
  it('reuses the public observation across users but keeps events private', () => {
    const pub = new PublicObservationCache();
    expect(pub.record('airtel-699-prime campaign', ['airtel-699-prime'], TODAY).reused).toBe(false);
    expect(pub.record('Airtel-699-prime  campaign', ['airtel-699-prime'], TODAY).reused).toBe(true);
    expect(pub.size()).toBe(1);
    const priv = new PrivateEventStore();
    const r = processForwarded(msg, connected, catalog, msg.receivedAt);
    if (!r.ok) throw new Error('expected ok');
    priv.add('userA', r.event);
    expect(priv.list('userA').length).toBe(1);
    expect(priv.list('userB')).toEqual([]);
  });
});
