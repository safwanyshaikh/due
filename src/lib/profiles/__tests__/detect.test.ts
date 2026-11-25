import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StatementLine } from '../../savings/types';
import { parseLoanStatement, parseStatementText } from '../../savings';
import { coApplicantEntities } from '../../savings/loanSummary';
import { emptyData } from '../../data';
import {
  entityCandidates,
  entityTypeFromName,
  openQuestions,
  organisationIn,
  recordDecision,
  addProfile,
} from '..';

const bank = (
  date: string,
  narration: string,
  amountInr: number,
  extra: Partial<StatementLine> = {},
) =>
  ({ date, narration, amountInr, source: 'bank', lineKind: 'purchase', ...extra }) as StatementLine;

/** Synthetic bank lines: two firms that repeat, a person who repeats, one-offs and noise. */
const LINES: StatementLine[] = [
  bank('2026-08-03', 'NEFT CR-YESB0000001-PARTYCO INDUSTRIAL-REF100', -45000, {
    lineKind: 'credit',
  }),
  bank('2026-09-03', 'NEFT CR-YESB0000001-PARTYCO INDUSTRIAL-REF200', -38000, {
    lineKind: 'credit',
  }),
  bank('2026-10-03', 'NEFT CR-YESB0000001-PARTYCO INDUSTRIAL-REF300', -41000, {
    lineKind: 'credit',
  }),
  bank('2026-08-10', 'IMPS/P2A/600000001/ABC ENTERPRISES LLP/HDFC0000001', 12000),
  bank('2026-09-10', 'IMPS/P2A/600000002/ABC ENTERPRISES LLP/HDFC0000001', 12500),
  bank('2026-08-05', 'NEFT/N0000001/RAVI KUMAR/SBIN0000001', 5000),
  bank('2026-09-05', 'NEFT/N0000002/RAVI KUMAR/SBIN0000001', 5000),
  bank('2026-10-05', 'NEFT/N0000003/RAVI KUMAR/SBIN0000001', 5000),
  bank('2026-08-07', 'UPI/DR/700000001/RAVI K/okaxis/UPI', 300, { lineKind: 'p2p' }),
  bank('2026-09-07', 'UPI/DR/700000002/RAVI K/okaxis/UPI', 300, { lineKind: 'p2p' }),
  // A one-off payment to a firm: not "regular".
  bank('2026-09-12', 'RTGS/UTR0001/ACME TRADERS/ICIC0000001', 90000),
  // Lenders, payment companies and known subscriptions are never asked about.
  bank('2026-08-15', 'NEFTO-PAYEE123 FINANCE LIMITED 000000', 14000),
  bank('2026-09-15', 'NEFTO-PAYEE123 FINANCE LIMITED 000000', 14000),
  bank('2026-08-20', 'Paid to SBI cards and Payment services Pvt Ltd', 11300),
  bank('2026-09-20', 'Paid to SBI cards and Payment services Pvt Ltd', 11300),
  bank('2026-08-21', 'UPI-AUTOPAY NETFLIX ENTERTAINMENT SERVICES INDIA LLP', 649),
  bank('2026-09-21', 'UPI-AUTOPAY NETFLIX ENTERTAINMENT SERVICES INDIA LLP', 649),
  // The holder's own transfers and bank charges are never asked about.
  bank('2026-08-25', 'IMPS/P2A/9/ACME ACADEMY/0001', 2000, { selfTransfer: true }),
  bank('2026-09-25', 'IMPS/P2A/9/ACME ACADEMY/0001', 2000, { selfTransfer: true }),
  bank('2026-08-28', 'NEFT CHARGES ACME INTERNATIONAL', 5.9, { lineKind: 'fee' }),
  bank('2026-09-28', 'NEFT CHARGES ACME INTERNATIONAL', 5.9, { lineKind: 'fee' }),
];

describe('organisationIn', () => {
  it('reads the organisation out of common Indian narrations', () => {
    expect(organisationIn('NEFT CR-YESB0000001-PARTYCO INDUSTRIAL-REF100')).toBe(
      'PARTYCO INDUSTRIAL',
    );
    expect(organisationIn('IMPS/P2A/600000001/ABC ENTERPRISES LLP/HDFC0000001')).toBe(
      'ABC ENTERPRISES LLP',
    );
    expect(organisationIn('BY TRANSFER-NEFT*HDFC0000001*N123*ACME TRADERS & CO')).toBe(
      'ACME TRADERS & CO',
    );
    expect(organisationIn('Received from ACME INTERNATIONAL PVT LTD')).toBe(
      'ACME INTERNATIONAL PVT LTD',
    );
    expect(
      organisationIn(
        'WDL TFR SBIY00000/M/ Transfer to Family or 0000000 OF PARTYCO INDUSTRIAL TRAIN AT 00343 TESTBR',
      ),
    ).toBe('PARTYCO INDUSTRIAL TRAIN');
  });
  it('finds a marker split by a statement line break', () => {
    expect(organisationIn('IMPSAB/000000 6/PARTYENTER PRISES/000000')).toBe('PARTYENTER PRISES');
  });
  it('does not flag people', () => {
    expect(organisationIn('NEFT/N0000001/RAVI KUMAR/SBIN0000001')).toBeNull();
    expect(organisationIn('UPI/DR/700000001/RAVI K/okaxis/UPI')).toBeNull();
    expect(organisationIn('Paid to RAVI KUMAR')).toBeNull();
  });
  it('does not flag banks, lenders or payment companies', () => {
    expect(organisationIn('NEFTO-PAYEE123 FINANCE LIMITED 000000')).toBeNull();
    expect(organisationIn('Paid to SBI cards and Payment services Pvt Ltd')).toBeNull();
    expect(organisationIn('ACH D- BAJAJ FINANCE LTD-00001')).toBeNull();
  });
});

describe('entityCandidates', () => {
  const qs = entityCandidates(LINES);

  it('asks about repeating organisation names, received money first', () => {
    expect(qs.map((q) => q.name)).toEqual(['PARTYCO INDUSTRIAL', 'ABC ENTERPRISES LLP']);
    expect(qs[0]).toMatchObject({
      reason: 'regular_payments',
      occurrences: 3,
      direction: 'received',
      nameSays: null,
    });
    expect(qs[1]).toMatchObject({ occurrences: 2, direction: 'paid', nameSays: 'llp' });
  });

  it('never flags people, one-offs, own transfers, fees, lenders or known subscriptions', () => {
    const names = qs.map((q) => q.name).join(' | ');
    expect(names).not.toMatch(/RAVI/);
    expect(names).not.toMatch(/ACME TRADERS|FINANCE|SBI|NETFLIX|ACADEMY|INTERNATIONAL/);
  });

  it('returns questions only: names and counts, no amounts', () => {
    for (const q of qs) {
      expect(Object.keys(q).sort()).toEqual(
        ['direction', 'key', 'name', 'nameSays', 'occurrences', 'reason'].sort(),
      );
    }
  });

  it('ignores card purchases at shops that are companies', () => {
    const card = [1, 2, 3].map((i) => ({
      ...bank(`2026-0${i + 6}-10`, 'UPI-ACME RETAIL PVT LTD', 1130),
      source: 'card' as const,
    }));
    expect(entityCandidates(card)).toEqual([]);
  });

  it('asks about an organisation co-applicant on a loan first, once', () => {
    const loans = [
      { coApplicantEntities: ['ABC ENTERPRISES LLP'] },
      { coApplicantEntities: ['ABC ENTERPRISES LLP'] },
    ];
    const withLoan = entityCandidates(LINES, loans);
    expect(withLoan[0]).toMatchObject({
      name: 'ABC ENTERPRISES LLP',
      reason: 'loan_co_applicant',
      direction: null,
      nameSays: 'llp',
    });
    expect(withLoan.filter((q) => q.key === withLoan[0].key)).toHaveLength(1);
  });

  it('caps the number of questions from one import', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      [1, 2].map((m) =>
        bank(`2026-0${m + 7}-0${i + 1}`, `NEFT/N1/FIRM${'ABCDEFGH'[i]} TRADERS/X`, 100),
      ),
    ).flat();
    expect(entityCandidates(many)).toHaveLength(5);
  });
});

describe('pasted statement text', () => {
  it('asks about a firm that pays in every month; not about people or subscriptions', () => {
    const text = [
      '03/08/2026  NEFT CR-YESB0000001-PARTYCO INDUSTRIAL-REF100  45,000.00 Cr',
      '03/09/2026  NEFT CR-YESB0000001-PARTYCO INDUSTRIAL-REF200  38,000.00 Cr',
      '05/08/2026  NEFT/N0000001/RAVI KUMAR/SBIN0000001  5,000.00 Dr',
      '05/09/2026  NEFT/N0000002/RAVI KUMAR/SBIN0000001  5,000.00 Dr',
      '06/09/2026  REFUND ACME TRADERS  500.00 Cr',
      '06/10/2026  REFUND ACME TRADERS  500.00 Cr',
      '05/10/2026  UPI-AUTOPAY NETFLIX  649.00 Dr',
      '05/11/2026  UPI-AUTOPAY NETFLIX  649.00 Dr',
    ].join('\n');
    const qs = entityCandidates(parseStatementText(text, 'bank'));
    expect(qs.map((q) => [q.name, q.direction])).toEqual([['PARTYCO INDUSTRIAL', 'received']]);
  });
});

describe('entityTypeFromName', () => {
  it('reads only what the name says', () => {
    expect(entityTypeFromName('ABC ENTERPRISES LLP')).toBe('llp');
    expect(entityTypeFromName('ACME INDIA PVT LTD')).toBe('private_limited');
    expect(entityTypeFromName('ACME (OPC) PRIVATE LIMITED')).toBe('opc');
    expect(entityTypeFromName('RAVI KUMAR HUF')).toBe('huf');
    expect(entityTypeFromName('PARTYCO INDUSTRIAL')).toBeNull();
  });
});

describe('openQuestions', () => {
  it('skips names with a profile and names already answered; asks "later" ones again', () => {
    const qs = entityCandidates(LINES);
    let d = emptyData();
    expect(openQuestions(d, qs)).toHaveLength(2);
    d = addProfile(
      d,
      {
        name: 'Partyco Industrial',
        entityType: 'partnership',
        role: 'partner',
        gstRegistered: null,
      },
      '2026-11-01T00:00:00.000Z',
    ).data;
    expect(openQuestions(d, qs).map((q) => q.name)).toEqual(['ABC ENTERPRISES LLP']);
    const later = recordDecision(d, {
      key: qs[1].key,
      name: qs[1].name,
      reason: 'regular_payments',
      answer: 'later',
      at: '2026-11-01T00:00:00.000Z',
    });
    expect(openQuestions(later, qs)).toHaveLength(1);
    const notMine = recordDecision(d, {
      key: qs[1].key,
      name: qs[1].name,
      reason: 'regular_payments',
      answer: 'not_mine',
      at: '2026-11-01T00:00:00.000Z',
    });
    expect(openQuestions(notMine, qs)).toEqual([]);
  });
});

describe('loan co-applicants', () => {
  it('keeps organisation co-applicants and drops people', () => {
    expect(
      coApplicantEntities(
        'Co-Applicant Name(s): ABC ENTERPRISES LLP, RAVI KUMAR   Place of Supply',
      ),
    ).toEqual(['ABC ENTERPRISES LLP']);
    expect(coApplicantEntities('Co-Applicant Name(s): CO APPLICANT')).toEqual([]);
  });

  it('reads them from a loan statement (synthetic edit of the fixture)', () => {
    const t = readFileSync(
      join(__dirname, '../../savings/__tests__/fixtures/ltf-home-loan-soa.txt'),
      'utf8',
    );
    expect(parseLoanStatement(t)?.coApplicantEntities).toBeUndefined();
    const edited = t.replace(
      'Co-Applicant Name(s): CO APPLICANT',
      'Co-Applicant Name(s): ABC ENTERPRISES LLP',
    );
    const s = parseLoanStatement(edited)!;
    expect(s.coApplicantEntities).toEqual(['ABC ENTERPRISES LLP']);
    expect(entityCandidates([], [s])[0]).toMatchObject({ reason: 'loan_co_applicant' });
  });
});

describe('real statement fixtures', () => {
  it('asks nothing about the people and lenders in the bank fixtures', () => {
    for (const f of ['union-bank-savings.txt', 'sbi-savings.txt', 'gpay-statement.txt']) {
      const t = readFileSync(join(__dirname, '../../savings/__tests__/fixtures', f), 'utf8');
      const qs = entityCandidates(parseStatementText(t, 'bank'));
      for (const q of qs) {
        expect(q.name).not.toMatch(/FINANCE|BANK|CARDS|PAYEE\d|TEST USER/i);
      }
    }
  });
});
