import { describe, expect, it } from 'vitest';
import { describeRule, RULE_KINDS, validateRule } from '../../lib/recurrence';
import { canUseRule, FREE_ENTITLEMENT } from '../../lib/plans';
import { buildRule, defaultDraft, draftFromRule } from '../lib/ruleDraft';

describe('rule drafts (edit form)', () => {
  it('builds a valid, describable rule for every recurrence kind and round-trips it', () => {
    for (const kind of RULE_KINDS) {
      const d = { ...defaultDraft('2027-01-31'), kind };
      const rule = buildRule(d, kind === 'trial_to_paid' ? 19_500 : null);
      expect(rule, kind).not.toBeNull();
      expect(validateRule(rule!), kind).toEqual([]);
      expect(describeRule(rule!).length, kind).toBeGreaterThan(5);
      expect(
        buildRule(draftFromRule(rule!, '2027-01-31'), kind === 'trial_to_paid' ? 19_500 : null),
      ).toEqual(rule);
    }
  });

  it('advanced rules are not available on Free (display mirror of the server gate)', () => {
    const weekday = buildRule({
      ...defaultDraft('2026-11-06'),
      kind: 'weekday',
      nth: -1,
      weekday: 5,
    })!;
    expect(describeRule(weekday)).toBe('Last Friday of every month');
    expect(canUseRule(FREE_ENTITLEMENT, weekday)).toBe(false);
    expect(canUseRule(FREE_ENTITLEMENT, buildRule(defaultDraft('2026-11-06'))!)).toBe(true);
  });
});
