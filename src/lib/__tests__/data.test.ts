import { describe, expect, it } from 'vitest';
import {
  deleteAllData,
  deleteCommitment,
  deleteLabel,
  exportCSV,
  exportJSON,
  importCandidates,
  emptyData,
  setStatementLink,
  upsertCommitment,
  upsertLabel,
  withdrawIntegration,
} from '../data';
import { DROP_BUNDLED_EXAMPLES } from '../migrate';
import { blankService } from '../offers/services';
import type { AppData } from '../types';
import { cashForecast } from '../totals';
import { monthPeriod } from '../dates';
import { previewCSV, parseCSV, CSV_TEMPLATE } from '../csv';
import { findDuplicates, suggestStatementLinks } from '../duplicates';
import { looksSensitive } from '../sensitive';
import { validateCommitment } from '../validate';
import { clearStorage, loadData, saveData, STORAGE_KEY } from '../storage';
import { ALL_ADAPTERS, IntegrationDisabledError } from '../adapters';
import { mk, dataWith } from './helpers';

// A household entered by the user. Test fixture only.
function household(): AppData {
  const card = mk({
    id: 'card',
    type: 'credit_card',
    frequency: 'one_time',
    amountPaise: 1500000,
    nextDue: '2026-11-13',
  });
  const stream = mk({
    id: 'stream',
    type: 'subscription',
    amountPaise: 49900,
    nextDue: '2026-11-02',
  });
  const emi = mk({ id: 'emi', type: 'emi', amountPaise: 325000, nextDue: '2026-11-04' });
  const school = mk({
    id: 'school',
    type: 'school_fee',
    frequency: 'quarterly',
    amountPaise: 1200000,
    nextDue: '2026-11-19',
  });
  let d = dataWith(card, stream, emi, school);
  d = setStatementLink(d, 'stream', 'card');
  d.seasons.push({
    id: 'season',
    name: 'Cricket season',
    start: '2026-12-01',
    end: '2027-01-15',
    linkedCommitmentIds: ['stream'],
    considerLeadDays: 7,
    reviewLeadDays: 3,
    restartDate: null,
  });
  return d;
}

describe('first launch', () => {
  it('starts empty: no commitments, services, seasons or relay messages', () => {
    expect(loadData({ getItem: () => null })).toBeNull();
    const d = emptyData();
    expect(d.commitments).toEqual([]);
    expect(d.services).toEqual([]);
    expect(d.seasons).toEqual([]);
    expect(d.relay.events).toEqual([]);
    expect(d.relay.status).toBe('not_connected');
    expect(d.relay.token).toBeNull();
    expect(d.migrations).toContain(DROP_BUNDLED_EXAMPLES);
  });
  it('a linked subscription is not double counted', () => {
    const data = household();
    const f = cashForecast(data, { start: '2026-10-30', end: '2026-12-31' });
    expect(f.items.some((i) => i.commitment.id === 'stream')).toBe(false);
    expect(validateCommitment(data.commitments[0])).toEqual([]);
  });
});

describe('legacy bundled-example migration', () => {
  const realCommitment = mk({ id: 'mine', provider: 'My broadband', amountPaise: 99900 });
  const realService = { ...blankService('jio', '2026-10-01'), id: 'svc_mine', label: 'My Jio' };
  const realSeason = {
    id: 'my_season',
    name: 'IPL',
    start: '2027-03-20',
    end: '2027-05-30',
    linkedCommitmentIds: ['mine', 'old_stream'],
    considerLeadDays: 7,
    reviewLeadDays: 3,
    restartDate: null,
  };
  const realEvent = {
    id: 'ev_real',
    messageId: 'local-1',
    fingerprint: 'abcd1234',
    receivedAt: '2026-10-20T00:00:00.000Z',
    subject: 'My bill',
    classification: 'utility',
    candidate: {
      provider: null,
      service: null,
      amountPaise: null,
      currency: null,
      date: null,
      trialEnd: null,
      benefit: null,
      senderDomain: null,
      links: [],
    },
    matchedOfferIds: [],
    verification: 'unverified',
    state: 'needs_confirmation',
    parserVersion: 'generic-0.1',
    confidence: 'low',
    extractedAt: '2026-10-20T00:00:00.000Z',
    rawExcerpt: null,
    rawPurgeAfter: '2026-10-27T00:00:00.000Z',
  };
  // Shape written by earlier builds: flagged example records next to the user's own records.
  const legacy = {
    ...emptyData(),
    migrations: undefined,
    commitments: [
      { ...mk({ id: 'old_card', type: 'credit_card' }), isSample: true },
      { ...mk({ id: 'old_stream', type: 'subscription' }), isSample: true },
      realCommitment,
    ],
    links: [
      {
        id: 'l1',
        parentId: 'old_card',
        componentId: 'old_stream',
        relation: 'included_in_statement',
        confirmedByUser: true,
      },
    ],
    seasons: [{ ...realSeason, id: 'old_season', isSample: true }, realSeason],
    services: [{ ...realService, id: 'old_svc', isSample: true }, realService],
    actionLog: [
      {
        id: 'a1',
        commitmentId: 'old_card',
        action: 'x',
        confirmationSource: 'user_entered',
        at: '2026-10-01',
      },
      {
        id: 'a2',
        commitmentId: 'mine',
        action: 'y',
        confirmationSource: 'user_entered',
        at: '2026-10-02',
      },
    ],
    relay: {
      status: 'connected',
      token: 'abc234',
      retentionDays: 7,
      events: [{ ...realEvent, id: 'old_ev', fingerprint: 'old', isSample: true }, realEvent],
    },
    offerObservations: [{ id: 'x:1' }],
    offersLastChecked: '2026-10-30T00:00:00.000Z',
  };
  const storeWith = (v: unknown) => {
    const store = new Map<string, string>([[STORAGE_KEY, JSON.stringify(v)]]);
    return {
      store,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, val: string) => void store.set(k, val),
    };
  };

  it('drops flagged records once and leaves real records untouched', () => {
    const d = loadData(storeWith(legacy))!;
    expect(d.commitments).toEqual([realCommitment]);
    expect(d.services).toEqual([realService]);
    expect(d.seasons).toEqual([{ ...realSeason, linkedCommitmentIds: ['mine'] }]);
    expect(d.links).toEqual([]);
    expect(d.actionLog.map((a) => a.id)).toEqual(['a2']);
    expect(d.relay.events).toEqual([realEvent]);
    expect(d.relay.status).toBe('not_connected');
    expect(d.relay.token).toBeNull();
    expect('offerObservations' in d).toBe(false);
    expect('offersLastChecked' in d).toBe(false);
    expect(JSON.stringify(d)).not.toContain('isSample');
    expect(d.migrations).toEqual([DROP_BUNDLED_EXAMPLES]);
  });
  it('is idempotent and does not run again after it has been applied', () => {
    const once = loadData(storeWith(legacy))!;
    const twice = loadData(storeWith(once))!;
    expect(twice).toEqual(once);
    // With the migration recorded, later data is passed through as-is.
    const later = { ...once, commitments: [...once.commitments, mk({ id: 'new' })] };
    expect(loadData(storeWith(later))!.commitments.map((c) => c.id)).toEqual(['mine', 'new']);
  });
  it('a real dataset with no flagged records keeps everything', () => {
    const real = { ...household(), migrations: undefined };
    const d = loadData(storeWith(real))!;
    expect(d.commitments).toEqual(real.commitments);
    expect(d.links).toEqual(real.links);
    expect(d.seasons).toEqual(real.seasons);
  });
});

describe('export, deletion, withdrawal', () => {
  const base = household();
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
  it('CSV export skips soft-deleted items and uses the effective next date', () => {
    const d = dataWith(
      mk({ id: 'm', provider: 'Monthly Co', nextDue: '2026-01-10', frequency: 'monthly' }),
      { ...mk({ id: 'gone', provider: 'Deleted Co' }), deletedAt: '2026-02-01T00:00:00.000Z' },
    );
    const csv = exportCSV(d, '2026-03-05');
    expect(csv).not.toContain('Deleted Co');
    expect(csv).toContain('2026-03-10');
    expect(csv).not.toContain('2026-01-10');
  });
  it('deleting a commitment removes its links, season refs and logs', () => {
    const d = deleteCommitment(base, 'stream');
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
