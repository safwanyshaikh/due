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
  matchModule,
  emptyIfNull,
  parseCardStatementSummary,
  parseJioFiberBill,
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
    expect(r2.data.commitments[0]).toMatchObject({ amountPaise: 679130, nextDue: '2026-12-05' });
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
