import { describe, expect, it } from 'vitest';
import { emptyData, setStatus } from '../data';
import { addImportItems, approveImportItem, importItemFromText } from '../imports';
import {
  acknowledgeChanges,
  createObligation,
  markPaid,
  markReviewed,
  recordExternalChange,
  setObligationStatus,
} from '../mutations';
import { rules } from '../recurrence';
import { monthlySummary, retentionAlerts, weeklyDigest } from '../retention';
import type { AppData } from '../types';
import { ctx, NOW, TODAY } from './helpers';

function seed(): { data: AppData; a: string; b: string } {
  let d = createObligation(
    emptyData(),
    {
      type: 'subscription',
      provider: 'Netflix',
      amountPaise: 64900,
      rule: rules.monthly('2026-11-02'),
    },
    ctx(),
  ).data;
  d = createObligation(
    d,
    {
      type: 'subscription',
      provider: 'Spotify',
      amountPaise: null,
      rule: rules.trialToPaid('2026-11-04', 11900),
    },
    ctx(),
  ).data;
  return { data: d, a: d.commitments[0].id, b: d.commitments[1].id };
}

describe('weekly digest', () => {
  it('summarises the next 7 days', () => {
    const { data } = seed();
    const w = weeklyDigest(data, TODAY)!;
    expect(w.items.map((i) => i.name)).toEqual(['Netflix', 'Spotify']);
    expect(w.totalPaise).toBe(64900 + 11900);
    expect(w.text).toBe('2 items due this week, ₹768. 1 thing to review.');
  });
  it('is null when there is nothing to say', () => {
    expect(weeklyDigest(emptyData(), TODAY)).toBeNull();
  });
});

describe('retention alerts', () => {
  it('trial expiry and amount change from real state only', () => {
    const { data, a } = seed();
    const d = recordExternalChange(
      data,
      a,
      { field: 'amount', to: 79900 },
      { kind: 'statement', label: 'Statement import', importedAt: NOW },
      ctx(),
    ).data;
    expect(
      retentionAlerts(d, TODAY)
        .map((x) => x.kind)
        .sort(),
    ).toEqual(['amount_change', 'trial_expiry']);
    expect(retentionAlerts(emptyData(), TODAY)).toEqual([]);
  });
});

describe('monthly summary', () => {
  it('is null without user events (no invented numbers)', () => {
    expect(monthlySummary(seed().data, 2026, 11)).toBeNull();
  });
  it('covered from paid events, avoided surprises from caught changes, saved only from confirmed cancellations', () => {
    const { data, a, b } = seed();
    const nov = (t: string) => ({ now: `2026-11-${t}T05:00:00.000Z`, today: `2026-11-${t}` });
    let d = markPaid(data, a, nov('02')).data;
    d = markReviewed(d, b, nov('03')).data;
    d = recordExternalChange(
      d,
      a,
      { field: 'amount', to: 79900 },
      { kind: 'statement', label: 'Statement import', importedAt: NOW },
      nov('05'),
    ).data;
    d = acknowledgeChanges(d, a, { now: '2026-11-05T06:00:00.000Z' }).data;
    // a matched import approval also counts as a caught change
    const it = importItemFromText(d, {
      kind: 'forwarded_email',
      text: 'Netflix\nAmount charged ₹799\nNext billing date 02 Dec 2026',
      receivedAt: '2026-11-06T00:00:00.000Z',
    });
    d = addImportItems(d, [it], nov('06')).data;
    d = approveImportItem(d, it.item.id, nov('06')).data;
    // "cancel pending" is not a saving; confirmed cancellation with a known amount is
    d = setObligationStatus(d, b, 'cancel_pending', nov('07')).data;
    const s1 = monthlySummary(d, 2026, 11)!;
    expect(s1.savedPaise).toBe(0);
    d = setObligationStatus(d, a, 'cancelled_confirmed_by_user', nov('08')).data;
    const s = monthlySummary(d, 2026, 11)!;
    expect(s).toMatchObject({
      month: '2026-11',
      coveredCount: 1,
      coveredPaise: 64900,
      reviewedCount: 1,
      avoidedSurprises: 2,
      savedPaise: 79900,
      savedItems: ['Netflix'],
    });
    expect(s.text).toBe(
      'You covered 1 payment (₹649). 2 changes caught before the date. ₹799 per charge no longer due after you cancelled Netflix.',
    );
    expect(monthlySummary(d, 2026, 10)).toBeNull();
  });
  it('an undone cancellation is not counted; legacy action log cancellations are', () => {
    const { data, a } = seed();
    const r = setObligationStatus(data, a, 'cancelled_confirmed_by_user', {
      now: '2026-11-08T00:00:00.000Z',
    });
    expect(monthlySummary(r.undo(), 2026, 11)).toBeNull();
    const legacy = setStatus(data, a, 'cancelled_confirmed_by_user');
    const month = new Date().toISOString().slice(0, 7).split('-').map(Number);
    expect(monthlySummary(legacy, month[0], month[1])?.savedPaise).toBe(64900);
  });
});
