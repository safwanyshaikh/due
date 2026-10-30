import { describe, expect, it } from 'vitest';
import { cashBreakdown, cashForecast, discretionaryRunRatePaise, runRate } from '../totals';
import { monthPeriod, yearPeriod } from '../dates';
import { occurrences, roughRemainingLoanPaise } from '../schedule';
import { dataWith, mk, setStatementLink } from './helpers';
import { setStatus } from '../data';

const NOV = monthPeriod(2026, 11);

describe('cash due vs run-rate', () => {
  it('counts annual charges only in the month they are due, but spreads them in run-rate', () => {
    const annual = mk({
      id: 'a',
      type: 'subscription',
      amountPaise: 120000,
      frequency: 'annual',
      nextDue: '2026-11-10',
    });
    const d = dataWith(annual);
    expect(cashForecast(d, NOV).totalPaise).toBe(120000);
    expect(cashForecast(d, monthPeriod(2026, 12)).totalPaise).toBe(0);
    expect(cashForecast(d, yearPeriod(2026)).totalPaise).toBe(120000);
    expect(runRate(d).totalPaise).toBe(10000);
  });
  it('quarterly plan: run-rate is amount / 3, cash due only in due months', () => {
    const q = mk({
      id: 'q',
      type: 'bill',
      amountPaise: 90000,
      frequency: 'quarterly',
      nextDue: '2026-11-15',
    });
    const d = dataWith(q);
    expect(runRate(d).totalPaise).toBe(30000);
    expect(cashForecast(d, yearPeriod(2027)).totalPaise).toBe(90000 * 4);
    expect(cashForecast(d, monthPeriod(2026, 12)).totalPaise).toBe(0);
  });
  it('monthly items add up across a year', () => {
    const m = mk({ id: 'm', amountPaise: 50000, frequency: 'monthly', nextDue: '2026-01-31' });
    expect(cashForecast(dataWith(m), yearPeriod(2026)).totalPaise).toBe(50000 * 12);
    const feb = occurrences(m, monthPeriod(2027, 2));
    expect(feb.map((o) => o.date)).toEqual(['2027-02-28']);
    expect(occurrences(m, monthPeriod(2028, 2)).map((o) => o.date)).toEqual(['2028-02-29']);
  });
  it('school term dues show actual scheduled amount, not a silent monthly bill', () => {
    const s = mk({
      id: 's',
      type: 'school_fee',
      amountPaise: 1200000,
      frequency: 'quarterly',
      nextDue: '2026-11-20',
      remainingOccurrences: 3,
    });
    const d = dataWith(s);
    expect(cashForecast(d, NOV).totalPaise).toBe(1200000);
    expect(cashForecast(d, monthPeriod(2026, 12)).totalPaise).toBe(0);
    expect(cashForecast(d, yearPeriod(2027)).totalPaise).toBe(2400000); // Feb and May 2027
  });
  it('EMI stops after remaining instalments and rough remaining total is labelled by caller', () => {
    const e = mk({
      id: 'e',
      type: 'emi',
      amountPaise: 325000,
      frequency: 'monthly',
      nextDue: '2026-11-05',
      remainingOccurrences: 3,
    });
    const d = dataWith(e);
    expect(cashForecast(d, yearPeriod(2026)).totalPaise).toBe(325000 * 2);
    expect(cashForecast(d, yearPeriod(2027)).totalPaise).toBe(325000);
    expect(roughRemainingLoanPaise(e)).toBe(975000);
    expect(roughRemainingLoanPaise({ ...e, remainingOccurrences: null })).toBeNull();
  });
  it('unknown amounts are flagged, never counted as zero or fabricated', () => {
    const card = mk({
      id: 'cc',
      type: 'credit_card',
      amountPaise: null,
      frequency: 'one_time',
      nextDue: '2026-11-12',
    });
    const f = cashForecast(dataWith(card), NOV);
    expect(f.totalPaise).toBe(0);
    expect(f.unknownAmountCount).toBe(1);
  });
  it('custom intervals and invalid custom intervals', () => {
    const c = mk({
      id: 'c',
      amountPaise: 100000,
      frequency: 'custom_months',
      intervalMonths: 2,
      nextDue: '2026-01-10',
    });
    expect(cashForecast(dataWith(c), yearPeriod(2026)).items.length).toBe(6);
    expect(runRate(dataWith(c)).totalPaise).toBe(50000);
    const bad = mk({
      id: 'b',
      amountPaise: 100,
      frequency: 'custom_months',
      intervalMonths: null,
      nextDue: '2026-01-10',
    });
    expect(occurrences(bad, yearPeriod(2026)).length).toBe(1); // treated as one-time
  });
});

describe('no double counting with credit-card statements', () => {
  const card = mk({
    id: 'card',
    type: 'credit_card',
    amountPaise: 1500000,
    frequency: 'one_time',
    nextDue: '2026-11-12',
    statement: {
      cardNickname: 'X',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      confirmedFromLatest: true,
    },
  });
  const stream = mk({
    id: 'stream',
    type: 'subscription',
    amountPaise: 200000,
    frequency: 'monthly',
    nextDue: '2026-10-20',
    importance: 'optional',
  });

  it('unlinked: both counted (what the warning is for)', () => {
    const d = dataWith(card, stream);
    expect(cashForecast(d, NOV).totalPaise).toBe(1500000 + 200000);
  });
  it('linked: statement counted once; ₹15,000 not ₹17,000', () => {
    const d = setStatementLink(dataWith(card, stream), 'stream', 'card');
    expect(cashForecast(d, NOV).totalPaise).toBe(1500000);
    expect(cashForecast(d, NOV).items.map((i) => i.commitment.id)).toEqual(['card']);
  });
  it('linked: subscription still visible in the breakdown and run-rate not doubled', () => {
    const d = setStatementLink(dataWith(card, stream), 'stream', 'card');
    const b = cashBreakdown(d, NOV);
    expect(b.totalPaise).toBe(1500000);
    // Statement period 1-31 Oct includes the 20 Oct renewal => 2000 in subscription, 13000 other card spend.
    expect(b.byType.subscription).toBe(200000);
    expect(b.byType.credit_card).toBe(1300000);
    expect(runRate(d).totalPaise).toBe(0); // card is one-time; component rides on the statement
    expect(discretionaryRunRatePaise(d)).toBe(200000); // still counted for the optional-spend cap
  });
  it('dangling or unconfirmed links do not hide cash', () => {
    let d = setStatementLink(dataWith(card, stream), 'stream', 'card');
    d = { ...d, links: d.links.map((l) => ({ ...l, confirmedByUser: false })) };
    expect(cashForecast(d, NOV).totalPaise).toBe(1700000);
    d = { ...setStatementLink(dataWith(card, stream), 'stream', 'ghost') };
    expect(cashForecast(d, NOV).totalPaise).toBe(1700000);
  });
  it('warns when linked items exceed the statement', () => {
    const big = { ...stream, amountPaise: 2000000 };
    const d = setStatementLink(dataWith(card, big), 'stream', 'card');
    expect(cashBreakdown(d, NOV).warnings.length).toBe(1);
    expect(cashForecast(d, NOV).totalPaise).toBe(1500000);
  });
  it('breakdown total equals cash total in a mixed month', () => {
    const emi = mk({ id: 'emi', type: 'emi', amountPaise: 325000, nextDue: '2026-11-05' });
    const d = setStatementLink(dataWith(card, stream, emi), 'stream', 'card');
    expect(cashBreakdown(d, NOV).totalPaise).toBe(cashForecast(d, NOV).totalPaise);
  });
});

describe('statuses in forecasts', () => {
  const sub = mk({ id: 's', type: 'subscription', amountPaise: 10000, nextDue: '2026-11-03' });
  it('planned pause/cancel still count until the user confirms', () => {
    for (const st of ['pause_planned', 'cancel_pending', 'review_needed'] as const) {
      expect(cashForecast(dataWith({ ...sub, status: st }), NOV).totalPaise).toBe(10000);
    }
  });
  it('confirmed pause/cancel drop out', () => {
    for (const st of ['pause_confirmed_by_user', 'cancelled_confirmed_by_user'] as const) {
      expect(cashForecast(dataWith({ ...sub, status: st }), NOV).totalPaise).toBe(0);
    }
  });
  it('setStatus logs user-entered source and never auto-confirms', () => {
    const d = setStatus(dataWith(sub), 's', 'pause_planned');
    expect(d.commitments[0].status).toBe('pause_planned');
    expect(d.actionLog[0].confirmationSource).toBe('user_entered');
  });
});
