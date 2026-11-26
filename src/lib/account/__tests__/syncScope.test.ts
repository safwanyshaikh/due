import { describe, expect, it } from 'vitest';
import { emptyData } from '../../data';
import type { AppData } from '../../types';
import { mergeLocalDetail, syncPayload } from '../syncScope';

function withStatements(): AppData {
  const d = emptyData();
  return {
    ...d,
    savings: {
      ...d.savings,
      banks: [
        {
          bank: 'Sample Bank',
          periodFrom: '2026-10-01',
          periodTo: '2026-10-31',
          failedAutoDebits: [{ month: '2026-10', count: 1, chargesInr: 590 }],
          morningBalances: [{ date: '2026-10-01', balanceInr: 4321 }],
          priceSteps: [],
          smaSweeps: [{ date: '2026-10-05', amountInr: 1200 }],
          recurring: [{ key: 'x' } as never],
        },
      ],
      upi: [{ app: 'Sample Pay', periodFrom: null, periodTo: null, creditCardSpend: [], recurring: [{ key: 'y' } as never] }],
    },
  };
}

describe('sync scope (H3 minimum)', () => {
  it('keeps daily balances, SMA sweeps and recurring lines off the server unless opted in', () => {
    const local = withStatements();
    const out = syncPayload(local, false);
    const json = JSON.stringify(out);
    expect(json).not.toContain('4321');
    expect(json).not.toContain('smaSweeps');
    expect(json).not.toContain('recurring');
    // The summary still syncs.
    expect(out.savings.banks![0]!.failedAutoDebits).toEqual([{ month: '2026-10', count: 1, chargesInr: 590 }]);
    // The local copy is untouched.
    expect(local.savings.banks![0]!.morningBalances).toHaveLength(1);
    expect(syncPayload(local, true)).toBe(local);
  });

  it('adopting a server copy keeps the detail that stayed on this device', () => {
    const local = withStatements();
    const server = syncPayload(local, false);
    const merged = mergeLocalDetail(server, local);
    expect(merged.savings.banks![0]!.morningBalances).toEqual([{ date: '2026-10-01', balanceInr: 4321 }]);
    expect(merged.savings.banks![0]!.smaSweeps).toHaveLength(1);
    expect(merged.savings.upi![0]!.recurring).toHaveLength(1);
  });
});
