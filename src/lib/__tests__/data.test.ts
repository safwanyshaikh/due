import { describe, expect, it } from 'vitest';
import {
  deleteAllData,
  deleteCommitment,
  deleteLabel,
  exportCSV,
  exportJSON,
  importCandidates,
  removeSampleData,
  setStatementLink,
  upsertCommitment,
  upsertLabel,
  withdrawIntegration,
} from '../data';
import { buildSampleData } from '../sample';
import { cashForecast } from '../totals';
import { monthPeriod } from '../dates';
import { previewCSV, parseCSV, CSV_TEMPLATE } from '../csv';
import { findDuplicates, suggestStatementLinks } from '../duplicates';
import { looksSensitive } from '../sensitive';
import { validateCommitment } from '../validate';
import { clearStorage, loadData, saveData, STORAGE_KEY } from '../storage';
import { ALL_ADAPTERS, IntegrationDisabledError } from '../adapters';
import { mk, dataWith } from './helpers';

describe('sample data', () => {
  const data = buildSampleData('2026-10-30');
  it('has the required demo records, all labelled sample', () => {
    expect(data.commitments.map((c) => c.type).sort()).toEqual([
      'credit_card',
      'emi',
      'school_fee',
      'subscription',
    ]);
    expect(data.seasons.length).toBe(1);
    expect(data.links.length).toBe(1);
    expect(data.commitments.every((c) => c.isSample && /\(demo\)/.test(c.nickname))).toBe(true);
  });
  it('does not double count the linked subscription', () => {
    const f = cashForecast(data, { start: '2026-10-30', end: '2026-12-31' });
    expect(f.items.some((i) => i.commitment.id === 'sample_stream')).toBe(false);
    expect(validateCommitment(data.commitments[0])).toEqual([]);
  });
  it('can be removed without touching real entries', () => {
    const real = mk({ id: 'real', provider: 'Mine' });
    const d = removeSampleData({ ...data, commitments: [...data.commitments, real] });
    expect(d.commitments.map((c) => c.id)).toEqual(['real']);
    expect(d.seasons).toEqual([]);
    expect(d.links).toEqual([]);
  });
});

describe('export, deletion, withdrawal', () => {
  const base = buildSampleData('2026-10-30');
  it('exports JSON and CSV (formula-safe)', () => {
    const j = JSON.parse(exportJSON(base));
    expect(j.data.commitments.length).toBe(4);
    const evil = upsertCommitment(
      base,
      mk({ id: 'x', provider: '=HYPERLINK("http://x")', nickname: '@a' }),
    );
    const csv = exportCSV(evil);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv.split('\n')[0]).toContain('amount_rupees');
  });
  it('deleting a commitment removes its links, season refs and logs', () => {
    const d = deleteCommitment(base, 'sample_stream');
    expect(d.links).toEqual([]);
    expect(d.seasons[0].linkedCommitmentIds).toEqual([]);
    expect(d.commitments.length).toBe(3);
  });
  it('deleting all data returns an empty dataset and clears storage', () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    expect(saveData(base, fake)).toBe(true);
    expect(loadData(fake)?.commitments.length).toBe(4);
    const empty = deleteAllData();
    clearStorage(fake);
    expect(store.has(STORAGE_KEY)).toBe(false);
    expect(empty.commitments).toEqual([]);
    expect(loadData(fake)).toBeNull();
  });
  it('storage failures do not throw', () => {
    const broken = {
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(saveData(base, broken)).toBe(false);
    expect(loadData({ getItem: () => '{bad json' })).toBeNull();
  });
  it('deleting a billing-email label keeps the commitment', () => {
    let d = upsertLabel(base, { id: 'L', label: 'home@example.com' });
    d = upsertCommitment(d, { ...d.commitments[0], billingEmailLabelId: 'L' });
    d = deleteLabel(d, 'L');
    expect(d.labels).toEqual([]);
    expect(d.commitments[0].billingEmailLabelId).toBeNull();
  });
  it('withdrawing an integration keeps manual entries', () => {
    expect(withdrawIntegration(base, 'whatsapp_business').commitments.length).toBe(4);
  });
});

describe('csv import', () => {
  const existing = [
    mk({ id: 'e', provider: 'Example Streaming', type: 'subscription', amountPaise: 49900 }),
  ];
  it('parses quotes, CRLF and BOM', () => {
    expect(parseCSV('﻿a,b\r\n"x, y","he said ""hi"""\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"'],
    ]);
  });
  it('previews valid rows, flags duplicates as suggestions, and saves nothing by itself', () => {
    const p = previewCSV(CSV_TEMPLATE, existing);
    expect(p.rows[0].errors).toEqual([]);
    expect(p.rows[0].duplicateOf.length).toBe(1);
    expect(p.rows[0].candidate?.amountPaise).toBe(49900);
  });
  it('reports row errors', () => {
    const p = previewCSV('type,provider,amount,next_due\nfoo,,abc,2026-13-40\n', []);
    expect(p.rows[0].candidate).toBeNull();
    expect(p.rows[0].errors.length).toBeGreaterThanOrEqual(3);
  });
  it('rejects files with sensitive columns or card-like values', () => {
    const a = previewCSV('type,provider,card_number\nbill,X,4111111111111111\n', []);
    expect(a.fileErrors[0]).toMatch(/never accept/);
    expect(a.rows).toEqual([]);
    const b = previewCSV(
      'type,provider,nickname,next_due\nbill,X,4111 1111 1111 1111,2026-11-01\n',
      [],
    );
    expect(b.rows[0].errors.join()).toMatch(/card or account number/);
  });
  it('ignores unknown columns and reports them', () => {
    const p = previewCSV('type,provider,next_due,extra\nbill,Water,2026-11-01,zzz\n', []);
    expect(p.ignoredColumns).toEqual(['extra']);
    expect(p.rows[0].errors).toEqual([]);
  });
  it('imports only the rows the user confirmed', () => {
    const p = previewCSV('type,provider,next_due\nbill,A,2026-11-01\nbill,B,2026-11-02\n', []);
    const chosen = [p.rows[1].candidate!];
    const d = importCandidates(dataWith(), chosen, '2026-10-30');
    expect(d.commitments.map((c) => c.provider)).toEqual(['B']);
    expect(d.commitments[0].source).toBe('csv_import');
  });
  it('imported credit-card rows are one-time statements', () => {
    const p = previewCSV(
      'type,provider,amount,frequency,next_due\ncredit_card,Card,5000,monthly,2026-11-12\n',
      [],
    );
    const d = importCandidates(dataWith(), [p.rows[0].candidate!], '2026-10-30');
    expect(d.commitments[0].frequency).toBe('one_time');
    expect(cashForecast(d, monthPeriod(2026, 11)).totalPaise).toBe(500000);
  });
});

describe('guards and suggestions', () => {
  it('detects card numbers, PAN and Aadhaar-like text', () => {
    expect(looksSensitive('card 4111 1111 1111 1111')).toBeTruthy();
    expect(looksSensitive('ABCDE1234F')).toBeTruthy();
    expect(looksSensitive('1234 5678 9012')).toBeTruthy();
    expect(looksSensitive('Rent for flat 12B, due on 5th')).toBeNull();
  });
  it('validates entries', () => {
    const bad = mk({ id: 'v', provider: '', nextDue: '2026-02-30', frequency: 'custom_months' });
    expect(validateCommitment(bad).length).toBeGreaterThanOrEqual(3);
    expect(validateCommitment({ ...mk({ id: 'v2' }), notes: 'pan ABCDE1234F' }).length).toBe(1);
    expect(
      validateCommitment({
        ...mk({ id: 'v3', type: 'subscription' }),
        subscription: { helpUrl: 'javascript:alert(1)' },
      }).length,
    ).toBe(1);
  });
  it('suggests duplicates and statement links but never merges', () => {
    const e = [mk({ id: 'a', provider: ' Netflix ', type: 'subscription', amountPaise: 100 })];
    expect(
      findDuplicates({ provider: 'netflix', type: 'subscription', amountPaise: 5 }, e).length,
    ).toBe(1);
    expect(
      findDuplicates({ id: 'a', provider: 'netflix', type: 'subscription', amountPaise: 5 }, e)
        .length,
    ).toBe(0);
    const card = mk({
      id: 'cc',
      type: 'credit_card',
      statement: { cardNickname: 'HDFC Red', confirmedFromLatest: true },
    });
    expect(
      suggestStatementLinks(
        { type: 'subscription', rail: 'credit_card', accountNickname: 'hdfc red' },
        [card],
      ).length,
    ).toBe(1);
    expect(
      suggestStatementLinks({ type: 'subscription', rail: 'upi_autopay', accountNickname: '' }, [
        card,
      ]).length,
    ).toBe(0);
  });
  it('link replacement keeps a component under one statement', () => {
    let d = dataWith(
      mk({ id: 'c1', type: 'credit_card' }),
      mk({ id: 'c2', type: 'credit_card' }),
      mk({ id: 's' }),
    );
    d = setStatementLink(d, 's', 'c1');
    d = setStatementLink(d, 's', 'c2');
    expect(d.links.length).toBe(1);
    expect(d.links[0].parentId).toBe('c2');
    expect(setStatementLink(d, 's', null).links).toEqual([]);
  });
});

describe('integrations stay disabled', () => {
  it('future adapters refuse to run; live ones are only manual and csv', async () => {
    const live = ALL_ADAPTERS.filter((a) => a.status === 'live').map((a) => a.id);
    expect(live).toEqual(['manual', 'csv']);
    for (const a of ALL_ADAPTERS.filter((a) => a.status === 'disabled')) {
      await expect(a.propose('anything')).rejects.toBeInstanceOf(IntegrationDisabledError);
    }
  });
});
