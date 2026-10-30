// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { RuleEditor, evaluateDraft } from '../components/RuleEditor';
import { defaultDraft, type RuleDraft } from '../lib/ruleDraft';
import { FREE_ENTITLEMENT } from '../../lib/plans';
import { nextOccurrences } from '../../lib/recurrence';

let latest: RuleDraft | null = null;
function Harness() {
  const [d, setD] = useState(() => defaultDraft('2026-11-06'));
  const onChange = (next: RuleDraft) => {
    latest = next;
    setD(next);
  };
  return (
    <RuleEditor draft={d} onChange={onChange} today="2026-10-30" entitlement={FREE_ENTITLEMENT} />
  );
}

describe('RuleEditor', () => {
  it('the first payment lands on the date the user picks (day of month follows the date)', () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Next due date'), { target: { value: '2026-11-24' } });
    expect(latest!.dayOfMonth).toBe('24');
    const rule = evaluateDraft(latest!, FREE_ENTITLEMENT).rule!;
    expect(nextOccurrences(rule, '2026-10-30', 2).map((o) => o.date)).toEqual([
      '2026-11-24',
      '2026-12-24',
    ]);
  });
});
