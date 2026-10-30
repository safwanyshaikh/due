import { describe, expect, it } from 'vitest';
import { emptyData, upsertCommitment, blankCommitment } from '../data';
import { downgradeToV1, migrateData, migrateV1toV2 } from '../migrate';
import { loadData, saveData, STORAGE_KEY } from '../storage';
import { mirrorsOf, reconcileObligation, upgradeCommitment } from '../provenance';
import { occurrences } from '../schedule';
import type { AppDataV1, CommitmentV1 } from '../types';

function v1Commitment(over: Partial<CommitmentV1> = {}): CommitmentV1 {
  return {
    id: 'mine',
    type: 'subscription',
    provider: 'NETFLIX.COM',
    nickname: 'Movies',
    amountPaise: 64900,
    currency: 'INR',
    frequency: 'monthly',
    intervalMonths: null,
    nextDue: '2026-11-05',
    dueConfidence: 'confirmed',
    amountConfidence: 'estimate',
    remainingOccurrences: null,
    rail: 'upi_autopay',
    accountNickname: 'Main',
    ownerLabel: 'Asha',
    importance: 'optional',
    notes: 'Family plan',
    lastConfirmed: '2026-10-01',
    reminder: { enabled: true, offsets: [3, 1] },
    status: 'active',
    billingEmailLabelId: null,
    subscription: { trialEnd: null, helpUrl: 'https://help.example' },
    source: 'manual',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  };
}

function v1Data(commitments: CommitmentV1[]): AppDataV1 {
  const {
    audit: _a,
    importQueue: _i,
    userEvents: _u,
    duplicateDecisions: _d,
    reminderStates: _r,
    ...rest
  } = emptyData();
  void [_a, _i, _u, _d, _r];
  return { ...rest, version: 1, commitments };
}

describe('data version 2 migration', () => {
  const csv = v1Commitment({
    id: 'csv',
    provider: 'Bharti Airtel',
    source: 'csv_import',
    amountConfidence: 'unknown',
    amountPaise: null,
    frequency: 'custom_months',
    intervalMonths: 2,
    remainingOccurrences: 4,
  });
  const v1 = v1Data([v1Commitment(), csv]);

  it('converts confidence and source into tracked provenance', () => {
    const d = migrateV1toV2(v1);
    expect(d.version).toBe(2);
    const [a, b] = d.commitments;
    expect(a.amount).toMatchObject({
      value: 64900,
      confidence: 'estimated',
      source: { kind: 'manual' },
    });
    expect(a.date).toMatchObject({ value: '2026-11-05', confidence: 'confirmed' });
    expect(a.rule).toEqual({ kind: 'monthly', start: '2026-11-05', dayOfMonth: 5 });
    expect(a.canonicalProvider).toBe('netflix');
    expect(b.amount).toMatchObject({
      value: null,
      confidence: 'imported',
      source: { kind: 'csv', label: 'CSV import', importedAt: csv.createdAt },
    });
    expect(b.rule).toEqual({
      kind: 'custom_months',
      start: '2026-11-05',
      intervalMonths: 2,
      count: 4,
    });
    expect(b.canonicalProvider).toBe('airtel');
    expect(d.audit).toEqual([]);
    expect(d.importQueue).toEqual([]);
    expect(d.reminderStates).toEqual([]);
  });

  it('is lossless: every v1 field is preserved and a downgrade round-trips exactly', () => {
    const d = migrateV1toV2(structuredClone(v1));
    for (const [i, c] of v1.commitments.entries()) {
      for (const [k, v] of Object.entries(c))
        expect((d.commitments[i] as unknown as Record<string, unknown>)[k]).toEqual(v);
    }
    expect(downgradeToV1(d)).toEqual(v1);
  });

  it('loads v1 data from storage, preserves user records and is idempotent', () => {
    const store = new Map([[STORAGE_KEY, JSON.stringify(v1)]]);
    const s = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    const once = loadData(s)!;
    expect(once.version).toBe(2);
    expect(once.commitments.map((c) => c.id)).toEqual(['mine', 'csv']);
    expect(once.commitments[0].notes).toBe('Family plan');
    saveData(once, s);
    const twice = loadData(s)!;
    expect(twice).toEqual(once);
    expect(migrateData(twice)).toEqual(twice);
  });

  it('migrated schedules produce the same occurrences as v1', () => {
    const d = migrateV1toV2(v1);
    expect(
      occurrences(d.commitments[1], { start: '2026-11-01', end: '2027-12-31' }).map((o) => o.date),
    ).toEqual(['2026-11-05', '2027-01-05', '2027-03-05', '2027-05-05']);
  });

  it('rejects unknown versions', () => {
    expect(loadData({ getItem: () => JSON.stringify({ version: 3, commitments: [] }) })).toBeNull();
  });
});

describe('legacy edits are reconciled into v2 fields', () => {
  it('an older form editing amount/date/frequency rebuilds tracked fields', () => {
    const blank = blankCommitment('bill', '2026-01-01');
    const edited = {
      ...blank,
      provider: 'Electricity',
      amountPaise: 120000,
      amountConfidence: 'confirmed' as const,
      nextDue: '2026-11-30',
      frequency: 'quarterly' as const,
    };
    const d = upsertCommitment(emptyData(), edited);
    const c = d.commitments[0];
    expect(c.amount).toMatchObject({ value: 120000, confidence: 'confirmed' });
    expect(c.rule).toEqual({ kind: 'quarterly', start: '2026-11-30' });
    expect(c.date.value).toBe('2026-11-30');
    expect(mirrorsOf(c).nextDue).toBe('2026-11-30');
  });
  it('a consistent record is returned unchanged', () => {
    const c = upgradeCommitment(v1Commitment());
    expect(reconcileObligation(c)).toBe(c);
  });
  it('v2-only rules survive unrelated legacy edits', () => {
    const c = upgradeCommitment(v1Commitment());
    const weekly = {
      ...c,
      rule: { kind: 'weekday' as const, start: '2026-11-06', weekday: 5 as const, everyWeeks: 1 },
    };
    const consistent = { ...weekly, ...mirrorsOf(weekly) };
    const renamed = reconcileObligation({ ...consistent, nickname: 'Renamed' });
    expect(renamed.rule.kind).toBe('weekday');
  });
});
