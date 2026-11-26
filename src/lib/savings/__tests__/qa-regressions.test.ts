/** Regressions found in pre-beta QA: re-imports and mis-matched telecom bills. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataWith } from '../../__tests__/helpers';
import {
  addCardBill,
  addLoanEmi,
  addTelecomBill,
  computeMoves,
  detectRecurring,
  parseStatementText,
  matchModule,
  emptyIfNull,
  parseCardStatementSummary,
  parseJioFiberBill,
  parseJioPostpaidBill,
  parseLoanStatement,
} from './fixtureHelpers';
import { JIO, catalogWith } from './testCatalog';

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const NOW = '2026-11-24T05:00:00.000Z';
const TODAY = '2026-11-24';

describe('QA regressions', () => {
  it('an older card statement imported after a newer one does not move the due date back', () => {
    const newer = emptyIfNull(parseCardStatementSummary(fx('sbi-card-a-2026-11.txt')));
    const older = emptyIfNull(parseCardStatementSummary(fx('sbi-card-a-2026-09.txt')));
    const r1 = addCardBill(dataWith(), newer, { now: NOW });
    const r2 = addCardBill(r1.data, older, { now: NOW });
    expect(r2.data.commitments).toHaveLength(1);
    expect(r2.data.commitments[0]).toMatchObject({ amountPaise: 243582, nextDue: '2026-12-02' });
    expect(r2.data.savings.statements).toHaveLength(2);
  });

  it('two home loans from one lender stay two obligations', () => {
    const soa = emptyIfNull(parseLoanStatement(fx('ltf-home-loan-soa.txt')));
    const welcome = emptyIfNull(parseLoanStatement(fx('ltf-home-loan-welcome.txt')));
    expect(soa.loanTenureMonths).not.toBe(welcome.loanTenureMonths);
    const ctx = { now: NOW, today: TODAY };
    const r1 = addLoanEmi(dataWith(), soa, ctx);
    const r2 = addLoanEmi(r1.data, welcome, ctx);
    expect(r2.data.commitments).toHaveLength(2);
    expect(addLoanEmi(r2.data, soa, ctx).data.commitments).toHaveLength(2);
  });

  it('a JioFiber bill is never offered the prepaid "switch to the yearly plan" move', () => {
    const bill = emptyIfNull(parseJioFiberBill(fx('jio-fiber-bill.txt')));
    const r = addTelecomBill(dataWith(), bill, { now: NOW, today: TODAY });
    const out = computeMoves(r.data, catalogWith(JIO), NOW);
    expect(out.moves.filter((m) => m.kind === 'period_switch')).toEqual([]);
  });
});

describe('seed catalog matching', () => {
  const seed = JSON.parse(
    readFileSync(join(process.cwd(), 'server', 'src', 'seed', 'savings-data.json'), 'utf8'),
  );
  const catalog = { version: 'seed', generatedAt: NOW, modules: seed.modules, cityPacks: [] };

  it('a plain "Jio" recharge item is matched to prepaid, never to the postpaid module', () => {
    const ob = {
      ...addTelecomBill(dataWith(), emptyIfNull(parseJioFiberBill(fx('jio-fiber-bill.txt'))), {
        now: NOW,
        today: TODAY,
      }).data.commitments[0],
      provider: 'Jio',
      nickname: '',
      canonicalProvider: undefined,
    };
    expect(matchModule(ob, [...catalog.modules].reverse())?.module.id).toBe('jio-prepaid-in');
  });
});

describe('large pastes', () => {
  it('a 2 MB single-merchant paste is read in under 2 s and gives no absurd average', () => {
    let text = '';
    for (let i = 0; text.length < 2 * 1024 * 1024; i++) {
      const d = `${String(1 + (i % 28)).padStart(2, '0')}/${String(1 + (i % 12)).padStart(2, '0')}/2026`;
      text += `${d}  UPI-AUTOPAY NETFLIX  649.00 Dr\n`;
    }
    const t0 = Date.now();
    const found = detectRecurring(parseStatementText(text, 'bank'));
    expect(Date.now() - t0).toBeLessThan(2000);
    for (const c of found) expect(c.averageInr).toBeLessThan(100_000);
  });
});

describe('negative amounts', () => {
  const row = (d: string, a: string) => `${d}  UPI-AUTOPAY NETFLIX  ${a}\n`;
  it('a bare negative figure (no Dr/Cr) is skipped, not counted as a payment', () => {
    const lines = parseStatementText(
      row('05/09/2026', '-649.00') + row('05/10/2026', '-649.00') + row('05/11/2026', '649.00 Dr'),
      'bank',
    );
    expect(lines).toHaveLength(1);
    expect(detectRecurring(lines)).toEqual([]);
  });
  it('a hyphen separator before an amount is not a minus sign', () => {
    const lines = parseStatementText(row('05/11/2026', '- 649.00 Dr'), 'bank');
    expect(lines).toHaveLength(1);
  });
});

describe('Jio bills and duplicates', () => {
  it('JioFiber and Jio Postpaid are not offered as a possible duplicate', async () => {
    const { findDuplicateSuggestions } = await import('../../duplicates');
    const ctx = { now: NOW, today: TODAY };
    const fiber = emptyIfNull(parseJioFiberBill(fx('jio-fiber-bill.txt')));
    const post = emptyIfNull(parseJioPostpaidBill(fx('jio-postpaid-bill.txt')));
    const d1 = addTelecomBill(dataWith(), fiber, ctx).data;
    const d2 = addTelecomBill(d1, post, ctx).data;
    expect(d2.commitments).toHaveLength(2);
    expect(findDuplicateSuggestions(d2)).toEqual([]);
  });
});

describe('cards that share the last four digits', () => {
  it('stay separate when the credit limits differ, merge when they match', () => {
    const a = emptyIfNull(parseCardStatementSummary(fx('sbi-card-a-2026-10.txt')));
    const a2 = emptyIfNull(parseCardStatementSummary(fx('sbi-card-a-2026-11.txt')));
    const b = emptyIfNull(parseCardStatementSummary(fx('sbi-card-b-2026-09.txt')));
    expect(a.last4).toBe(b.last4);
    expect(a.creditLimit).not.toBe(b.creditLimit);
    const r1 = addCardBill(dataWith(), a, { now: NOW });
    const r2 = addCardBill(r1.data, b, { now: NOW });
    expect(r2.data.commitments).toHaveLength(2);
    expect(r2.data.savings.statements).toHaveLength(2);
    const r3 = addCardBill(r2.data, a2, { now: NOW });
    expect(r3.data.commitments).toHaveLength(2);
    expect(r3.obligationId).toBe(r1.obligationId);
  });
});
