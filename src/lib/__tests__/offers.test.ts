import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../offers/catalog';
import { computeStatus, isRecommendable, isStale } from '../offers/status';
import {
  cancellationOwner,
  completeness,
  entitlementFor,
  evaluateEligibility,
  matchSummary,
} from '../offers/eligibility';
import { appendObservation, fingerprint, historyFor } from '../offers/observations';
import { runRefresh, snapshotAdapter } from '../offers/refresh';
import {
  airtel699Prime,
  airtelMonthlyCashback,
  googleAiTrial,
  jioAiCloud,
} from '../offers/calculator';
import { isOfficialUrl } from '../offers/sources';
import {
  PrivateEventStore,
  PublicObservationCache,
  canSurfaceAsBenefit,
  deleteAllIntake,
  processForwarded,
  purgeRaw,
  relayAddress,
  setEventState,
  verifyForwardingToken,
} from '../offers/relay';
import { addOfferReminder, blankService } from '../offers/services';
import { emptyData } from '../data';
import type { OfferRecord, RelayState, UserServiceRecord } from '../offers/types';

const TODAY = '2026-10-30';
const catalog = buildCatalog(TODAY);
const get = (id: string) => catalog.find((o) => o.offerId === id)!;
const base = (o: Partial<OfferRecord>): Omit<OfferRecord, 'computedStatus'> => {
  const { computedStatus: _c, ...rest } = { ...get('google-ai-plus'), ...o };
  void _c;
  return rest;
};
const svc = (o: Partial<UserServiceRecord>): UserServiceRecord => ({
  ...blankService('airtel', TODAY),
  ...o,
});

describe('status rules', () => {
  it('active offer with no expiry date is active_verify, never an invented expiry', () => {
    expect(get('google-ai-plus').computedStatus).toBe('active_verify');
    expect(get('google-ai-plus').officialEndAt).toBeUndefined();
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
  it('Jio Gemini landing page + unavailable terms is shown as conflicting', () => {
    expect(get('jio-gemini-ai-pro').computedStatus).toBe('conflicting');
    expect(isRecommendable(get('jio-gemini-ai-pro').computedStatus)).toBe(false);
  });
  it('a press release alone is not a current offer', () => {
    expect(get('airtel-adobe-express-12m').computedStatus).toBe('unknown');
    expect(get('airtel-postpaid-partners').computedStatus).toBe('unknown');
  });
  it('historical Amazon Apr–May 2026 cashback stays in history but is not active', () => {
    const o = get('amazon-pay-cashback-apr-may-2026');
    expect(o.computedStatus).toBe('expired');
    expect(catalog).toContain(o);
  });
  it('expired and conflicting records never appear in the default list', () => {
    const list = catalog.filter((o) => isRecommendable(o.computedStatus));
    expect(
      list.some((o) => o.computedStatus === 'expired' || o.computedStatus === 'conflicting'),
    ).toBe(false);
    expect(list.length).toBeGreaterThan(5);
  });
  it('freshness: stale after the cadence window', () => {
    expect(isStale({ lastConfirmedAt: '2026-10-30', cadence: 'weekly' }, '2026-11-05')).toBe(false);
    expect(isStale({ lastConfirmedAt: '2026-10-30', cadence: 'weekly' }, '2026-11-10')).toBe(true);
  });
});

describe('catalog evidence', () => {
  it('every record has official source URLs, observed-at, status and confidence', () => {
    for (const o of catalog) {
      expect(o.sourceUrls.length).toBeGreaterThan(0);
      expect(o.sourceUrls.every(isOfficialUrl)).toBe(true);
      expect(o.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(o.computedStatus).toBeTruthy();
      expect(['high', 'medium', 'low']).toContain(o.confidence);
    }
  });
  it('covers Jio, Airtel, Vi, Amazon, Google, Google Pay, RuPay and Paytm records', () => {
    const fams = catalog.map((o) => `${o.provider}:${o.productFamily}`).join('|');
    for (const p of [
      'jio:',
      'airtel:',
      'vi:',
      'amazon:',
      'google:',
      'Google Pay',
      'RuPay',
      'UPI Autopay',
    ])
      expect(fams).toContain(p);
  });
  it('rejects non-official domains', () => {
    expect(isOfficialUrl('https://www.jio.com/x')).toBe(true);
    expect(isOfficialUrl('https://jio.com.evil.example/x')).toBe(false);
    expect(isOfficialUrl('not a url')).toBe(false);
  });
});

describe('eligibility and scenarios', () => {
  it('existing Prime user on Airtel ₹699 gets a may-not-qualify warning and no value', () => {
    const items = evaluateEligibility(
      get('airtel-699-prime'),
      svc({ serviceType: 'prepaid', existingSubscription: true }),
    );
    expect(matchSummary(items)).toBe('may_not_qualify');
    const r = airtel699Prime({ existingPrime: true, avoidedPrimeCostPaise: 30000 });
    expect(r.estimatedValuePaise).toBe(0);
    expect(r.warnings.join()).toMatch(/may not be eligible/);
  });
  it('a full match is still only "may qualify", with provider-only checks left', () => {
    const items = evaluateEligibility(
      get('airtel-699-prime'),
      svc({ serviceType: 'prepaid', existingSubscription: false }),
    );
    expect(matchSummary(items)).toBe('may_qualify');
    expect(items.some((i) => i.state === 'provider_only')).toBe(true);
  });
  it('missing fields are reported, not guessed', () => {
    const s = svc({ serviceType: 'prepaid' });
    expect(matchSummary(evaluateEligibility(get('airtel-699-prime'), s))).toBe('needs_details');
    expect(completeness(s, [get('airtel-699-prime')]).missing).toEqual([
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
  it('JioAICloud: free for Jio, 3-month trial end for non-Jio', () => {
    expect(jioAiCloud({ numberType: 'jio', trialStart: null }).reminderDate).toBeUndefined();
    expect(jioAiCloud({ numberType: 'non_jio', trialStart: '2026-11-30' }).reminderDate).toBe(
      '2027-02-28',
    );
  });
  it('Google trial shows paid renewal and a decide-by date', () => {
    const r = googleAiTrial({ plan: 'pro', trialEnd: '2026-12-01' });
    expect(r.lines.some((l) => l.paise === 195000)).toBe(true);
    expect(r.reminderDate).toBe('2026-12-01');
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
  it('refresh keeps old observations and reports the check time', async () => {
    const r1 = await runRefresh([snapshotAdapter(catalog, 'jio', TODAY)], [], TODAY);
    const r2 = await runRefresh(
      [snapshotAdapter(catalog, 'jio', TODAY)],
      r1.observations,
      '2026-10-31',
    );
    expect(r2.observations.length).toBe(r1.observations.length * 2);
    expect(r2.changed).toBe(0);
    expect(r2.checkedAt).toBe('2026-10-31');
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
    expect(r.event.matchedOfferIds).toContain('airtel-699-prime');
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
