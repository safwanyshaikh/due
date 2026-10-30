import { describe, expect, it } from 'vitest';
import { emptyData, setStatementLink } from '../data';
import { homeSummary, needsAttention, obligationView, obligationViews } from '../home';
import {
  createObligation,
  editNextDate,
  markPaid,
  recordExternalChange,
  setObligationStatus,
} from '../mutations';
import { rules } from '../recurrence';
import type { AppData } from '../types';
import { ctx, NOW, TODAY } from './helpers';

function add(
  data: AppData,
  provider: string,
  amountPaise: number | null,
  rule: ReturnType<typeof rules.monthly> | Parameters<typeof createObligation>[1]['rule'],
  type: Parameters<typeof createObligation>[1]['type'] = 'bill',
) {
  const r = createObligation(data, { type, provider, amountPaise, rule }, ctx());
  return { data: r.data, id: r.data.commitments[r.data.commitments.length - 1].id };
}

describe('homeSummary', () => {
  it('empty data: no next, gentle headline', () => {
    const h = homeSummary(emptyData(), TODAY, 'Asia/Kolkata');
    expect(h.next).toBeNull();
    expect(h.timeline).toEqual([]);
    expect(h.coveredMessage).toBeNull();
    expect(h.headline).toMatch(/Add your first/);
  });

  it('orders by date (not category), totals 7/30 days, timeline is the next 3 after the hero', () => {
    let d = emptyData();
    ({ data: d } = add(d, 'School', 1200000, rules.quarterly('2026-11-19'), 'school_fee'));
    ({ data: d } = add(d, 'Netflix', 64900, rules.monthly('2026-11-02'), 'subscription'));
    ({ data: d } = add(d, 'Home loan', 2500000, rules.monthly('2026-11-04'), 'emi'));
    ({ data: d } = add(d, 'Broadband', null, rules.monthly('2026-11-10')));
    ({ data: d } = add(d, 'Gym', 150000, rules.oneTime('2026-12-15')));
    const h = homeSummary(d, TODAY, 'Asia/Kolkata');
    expect(h.next?.providerName).toBe('Netflix');
    expect(h.next?.dateText).toBe('2 Nov 2026');
    expect(h.timeline.map((v) => v.nickname)).toEqual(['Home loan', 'Broadband', 'School']);
    expect(h.next7Total).toBe(64900 + 2500000);
    expect(h.next7.count).toBe(2);
    // 30 days: 30 Oct – 28 Nov
    expect(h.next30Total).toBe(64900 + 2500000 + 1200000);
    expect(h.next30.unknownAmountCount).toBe(1);
    expect(h.headline).toBe('Your next commitment is clear.');
    expect(h.coveredMessage).toBeNull();
  });

  it('keeps the card-statement no-double-count rule', () => {
    let d = emptyData();
    const cardAdded = add(d, 'HDFC card', 1500000, rules.oneTime('2026-11-03'), 'credit_card');
    d = cardAdded.data;
    const card = cardAdded.id;
    const subAdded = add(d, 'Netflix', 64900, rules.monthly('2026-11-02'), 'subscription');
    d = subAdded.data;
    const sub = subAdded.id;
    d = setStatementLink(d, sub, card);
    const h = homeSummary(d, TODAY);
    expect(h.next7Total).toBe(1500000);
    expect(h.next?.id).toBe(card);
    expect(obligationView(d, d.commitments[1], TODAY).why.matchLogic).toMatch(
      /not added to totals twice/,
    );
  });

  it('paid items drop out; covered message only when everything in 7 days is marked paid', () => {
    let d = emptyData();
    const idAdded = add(d, 'Netflix', 64900, rules.monthly('2026-11-02'), 'subscription');
    d = idAdded.data;
    const id = idAdded.id;
    expect(homeSummary(d, TODAY).coveredMessage).toBeNull();
    d = markPaid(d, id, ctx()).data;
    const h = homeSummary(d, TODAY);
    expect(h.next7Total).toBe(0);
    expect(h.coveredMessage).toBe('You’re covered for the next 7 days: ₹649 already marked paid.');
    expect(h.next?.date).toBe('2026-12-02');
  });

  it('nothing due in 7 days gives a calm message', () => {
    const { data } = add(emptyData(), 'Insurance', 900000, rules.annual('2027-03-01'));
    expect(homeSummary(data, TODAY).coveredMessage).toBe('Nothing due in the next 7 days.');
  });

  it('overdue one-time item comes first and is flagged', () => {
    let d = emptyData();
    ({ data: d } = add(d, 'Netflix', 64900, rules.monthly('2026-11-02'), 'subscription'));
    ({ data: d } = add(d, 'Plumber', 150000, rules.oneTime('2026-10-25')));
    const h = homeSummary(d, TODAY);
    expect(h.next?.nickname).toBe('Plumber');
    expect(h.next?.status).toBe('overdue');
    expect(h.needsAttention.map((a) => a.kind)).toContain('overdue_user_entered');
  });
});

describe('ObligationView', () => {
  it('exposes every required field and a Why explanation', () => {
    let d = emptyData();
    const idAdded = add(d, 'NETFLIX.COM', 64900, rules.monthly('2026-01-31'), 'subscription');
    d = idAdded.data;
    const id = idAdded.id;
    d = editNextDate(d, id, '2026-11-02', ctx()).data;
    const v = obligationView(d, d.commitments[0], TODAY, 'Asia/Kolkata');
    expect(v).toMatchObject({
      nickname: 'NETFLIX.COM',
      canonicalProvider: 'netflix',
      providerName: 'Netflix',
      amountPaise: 64900,
      currency: 'INR',
      amountText: '₹649',
      occurrenceDate: '2026-10-31',
      date: '2026-11-02',
      dateText: '2 Nov 2026',
      ruleText: 'Every month on the 31st (last day in shorter months)',
      amountConfidence: 'user_entered',
      dateConfidence: 'user_entered',
      sourceBadge: 'Entered by you',
      owner: 'You',
      reminderText: 'Reminds 7, 3, 1 days before · in app',
      status: 'upcoming',
      statusText: 'In 3 days',
      overridden: true,
    });
    expect(v.why.matchLogic).toMatch(/You added this item yourself/);
    expect(v.why.matchLogic).toMatch(/changed for this occurrence only/);
    expect(v.why.lastSyncOrImport).toBeNull();
    expect(v.why.confidence).toBe('Amount: entered by you. Date: entered by you.');
  });
  it('imported values show source badge and local import time', () => {
    let d = emptyData();
    const idAdded = add(d, 'Airtel', 49900, rules.monthly('2026-11-12'));
    d = idAdded.data;
    const id = idAdded.id;
    d = recordExternalChange(
      d,
      id,
      { field: 'amount', to: 59900 },
      { kind: 'statement', label: 'Statement import', importedAt: '2026-10-29T18:45:00.000Z' },
      ctx(),
    ).data;
    const v = obligationView(d, d.commitments[0], TODAY, 'Asia/Kolkata');
    expect(v.amountConfidence).toBe('imported');
    expect(v.sourceBadge).toBe('Statement import + Entered by you');
    expect(v.why.lastSyncOrImport).toBe('30 Oct 2026, 00:15');
  });
  it('obligationViews lists all, dated first', () => {
    let d = emptyData();
    ({ data: d } = add(d, 'Later', 1, rules.monthly('2026-12-01')));
    ({ data: d } = add(d, 'Undated', 1, rules.irregular()));
    ({ data: d } = add(d, 'Sooner', 1, rules.monthly('2026-11-01')));
    expect(obligationViews(d, TODAY).map((v) => v.nickname)).toEqual([
      'Sooner',
      'Later',
      'Undated',
    ]);
    expect(obligationViews(d, TODAY)[2].dateText).toBe('No date yet');
  });
});

describe('needsAttention', () => {
  it('flags amount/date changes, trials within 7 days, stale imports, unknown merchants, duplicates and pending imports', () => {
    let d = emptyData();
    const aAdded = add(d, 'Netflix', 64900, rules.monthly('2026-11-05'), 'subscription');
    d = aAdded.data;
    const a = aAdded.id;
    d = recordExternalChange(
      d,
      a,
      { field: 'amount', to: 79900 },
      { kind: 'email_forward', label: 'Forwarded email', importedAt: NOW },
      ctx(),
    ).data;
    ({ data: d } = add(d, 'Spotify', null, rules.trialToPaid('2026-11-04', 11900), 'subscription'));
    ({ data: d } = add(d, 'Spotify', null, rules.trialToPaid('2026-12-04', 11900), 'subscription'));
    const old = createObligation(
      d,
      {
        type: 'bill',
        provider: 'Mystery Co',
        amountPaise: 1000,
        rule: rules.monthly('2026-11-20'),
        source: { kind: 'csv', label: 'CSV import', importedAt: '2026-06-01T00:00:00.000Z' },
      },
      ctx(),
    );
    d = old.data;
    d = {
      ...d,
      importQueue: [
        {
          id: 'imp1',
          raw: { kind: 'receipt_text', text: 'x', receivedAt: NOW, ref: 'r' },
          extracted: {
            merchant: null,
            canonicalProvider: null,
            amountPaise: null,
            date: null,
            dateKind: null,
            link: null,
            commitmentType: null,
            cadence: null,
            confidencePerField: {},
          },
          status: 'pending',
        },
      ],
    };
    const kinds = needsAttention(d, TODAY).map((x) => x.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'amount_changed',
        'trial_ending',
        'stale_source',
        'unknown_merchant',
        'duplicate_suggestion',
        'import_pending',
      ]),
    );
    expect(kinds.filter((k) => k === 'trial_ending')).toHaveLength(1);
    const trial = needsAttention(d, TODAY).find((x) => x.kind === 'trial_ending')!;
    expect(trial.title).toBe('Spotify trial ends in 5 days');
    expect(trial.detail).toBe('4 Nov 2026, then ₹119. Decide whether to keep it.');
    expect(needsAttention(d, TODAY)[0].severity).toBe('important');
    expect(homeSummary(d, TODAY).needsAttention.length).toBe(kinds.length);
  });
  it('cancelled-confirmed items do not need attention', () => {
    let d = emptyData();
    const idAdded = add(d, 'Plumber', 1, rules.oneTime('2026-10-01'));
    d = idAdded.data;
    const id = idAdded.id;
    d = setObligationStatus(d, id, 'cancelled_confirmed_by_user', { now: NOW }).data;
    expect(needsAttention(d, TODAY)).toEqual([]);
  });
});
