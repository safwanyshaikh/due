import { describe, expect, it } from 'vitest';
import { emptyData } from '../../lib/data';
import { createObligation } from '../../lib/mutations';
import { rules } from '../../lib/recurrence';
import { todayInTz, addDays } from '../../lib/dates';
import { serverReminders } from '../account/AccountContext';

describe('sync reminder upload', () => {
  it('keeps every item within the server limits (title ≤ 200 chars)', () => {
    const base = emptyData();
    const data = { ...base, settings: { ...base.settings, deliveryChannel: 'email' as const } };
    const due = addDays(todayInTz(), 5);
    const r = createObligation(
      data,
      { type: 'bill', provider: 'P'.repeat(250), amountPaise: 10000, rule: rules.monthly(due) },
      { now: new Date().toISOString() },
    );
    const items = serverReminders(r.data);
    expect(items.length).toBeGreaterThan(0);
    for (const it of items) expect(it.title.length).toBeLessThanOrEqual(200);
  });
});
