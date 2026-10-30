import { describe, expect, it } from 'vitest';
import {
  buildUserEvent,
  confidenceBand,
  dateHits,
  exportStructuredRecord,
  extractFromDocumentText,
  fingerprintText,
  organiseSharedSms,
  parseIndianAmount,
} from '../intake';
import { luhnValid, redactSensitive } from '../sensitive';

// Synthetic texts written for these tests only. Numbers are made up; the card number is a
// standard Luhn-valid test number.
const SANCTION = `ABC Housing Finance Ltd
Loan Sanction Letter
Date: 12/10/2026
Dear Applicant,
We are pleased to sanction your home loan.
Loan Amount: Rs. 25,00,000
Rate of Interest 8.75% p.a. (floating)
Tenure 240 months
EMI of ₹22,093 payable on the 5th of every month
First EMI date: 05-Dec-2026
Loan Account No: 001234567890
PAN: ABCPE1234F`;

const CARD_STATEMENT = `Credit Card Statement
Card number 4111 1111 1111 1111
Statement Date 15/10/2026
Total Amount Due ₹18,450.75
Minimum Amount Due ₹923.00
Payment Due Date 04/11/2026`;

const SCHOOL = `Green Valley School
Term Fee Notice - Academic Year 2026-27
Tuition fee for Term 2: INR 42,000
Last date for payment: 15 November 2026
Receipt No: GVS-2026-0412`;

const RECHARGE = `Thank you for recharging with Jio!
Recharge of ₹349 successful on 28-Oct-2026
Plan validity till 27-Nov-2026
Benefits: 2GB/day, Unlimited calls, JioHotstar Mobile
Order ID: JIO98765XYZ`;

const INVOICE = `Your Spotify Premium invoice
Invoice No: INV-55821
Amount charged: Rs 119.00
Paid on 12 Oct 2026
Next billing date: Nov 12, 2026
Billed monthly. Manage: https://www.spotify.com/account.`;

const TRIAL = `Welcome to YouTube Premium. Your free trial ends 12 Nov 2026.
After that you will be charged ₹149/month.`;

describe('redactSensitive', () => {
  it('masks Aadhaar, PAN, Luhn-valid cards, CVV, UPI PIN, OTP, passwords, IFSC and account numbers', () => {
    const raw = [
      'Aadhaar 2345 6789 0123 and 234567890123',
      'PAN ABCPE1234F',
      'Card 4111-1111-1111-1111 CVV: 123',
      'UPI PIN is 4321',
      'Your OTP 845123',
      'Net banking password: hunter2',
      'IFSC HDFC0001234 A/c No. 50100123456781',
      'Order 9876543210988 is not a card',
    ].join('\n');
    const r = redactSensitive(raw);
    for (const leaked of [
      '2345 6789 0123',
      '234567890123',
      'ABCPE1234F',
      '4111-1111-1111-1111',
      ' 123\n',
      'is 4321',
      '845123',
      'hunter2',
      'HDFC0001234',
      '50100123456781',
    ])
      expect(r.text).not.toContain(leaked);
    expect(r.text).toContain('9876543210988'); // not Luhn-valid: left alone
    const kinds = Object.fromEntries(r.redactions.map((x) => [x.kind, x.count]));
    expect(kinds).toMatchObject({
      aadhaar: 2,
      pan: 1,
      card_number: 1,
      cvv: 1,
      upi_pin: 1,
      otp: 1,
      password: 1,
      ifsc: 1,
      bank_account: 1,
    });
  });
  it('luhn', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
  });
  it('leaves ordinary bill text alone', () => {
    const r = redactSensitive('Amount due ₹1,950 by 05/11/2026');
    expect(r.redactions).toEqual([]);
    expect(r.text).toBe('Amount due ₹1,950 by 05/11/2026');
  });
});

describe('Indian formats', () => {
  it('amounts with lakh/crore and Indian grouping', () => {
    expect(parseIndianAmount('5,00,000')).toBe(50000000);
    expect(parseIndianAmount('5', 'lakh')).toBe(50000000);
    expect(parseIndianAmount('1.2', 'crore')).toBe(1200000000);
    expect(parseIndianAmount('1,950.50')).toBe(195050);
    expect(extractFromDocumentText('Loan amount 5 lakh').fields.amount?.value).toBe(50000000);
  });
  it('dates: dd/mm/yyyy, dd-MMM-yyyy, d Month yyyy, MMM d, yyyy, ISO, 2-digit years', () => {
    expect(
      dateHits(
        'due 05/11/2026, 05-Dec-2026, 15 November 2026, Nov 12, 2026, 2026-12-31, 07-Jan-27',
      ).map((h) => h.value),
    ).toEqual(['2026-11-05', '2026-12-05', '2026-11-15', '2026-11-12', '2026-12-31', '2027-01-07']);
    expect(dateHits('31/02/2026')).toEqual([]);
  });
});

describe('extractFromDocumentText', () => {
  it('loan sanction letter: provider, type, amount, EMI, rate, tenure, first EMI date; identifiers never returned', () => {
    const x = extractFromDocumentText(SANCTION);
    const f = x.fields;
    expect(f.provider?.value).toBe('ABC Housing Finance Ltd');
    expect(f.commitmentType?.value).toBe('emi');
    expect(f.amount?.value).toBe(250000000);
    expect(f.emi?.value).toBe(2209300);
    expect(f.interestRate?.value).toBe(8.75);
    expect(f.tenureMonths?.value).toBe(240);
    expect(f.currency?.value).toBe('INR');
    expect(f.dueDate?.value).toBe('2026-12-05');
    expect(f.renewalDate).toBeUndefined();
    expect(f.trialEnd).toBeUndefined();
    const json = JSON.stringify(x.fields);
    expect(json).not.toContain('ABCPE1234F');
    expect(json).not.toContain('001234567890');
    expect(x.redactedText).not.toContain('ABCPE1234F');
    expect(f.emi!.snippet).toMatch(/EMI of ₹22,093/);
    expect(x.redactedText.slice(f.emi!.start, f.emi!.end)).toContain('22,093');
  });
  it('card statement: total due over minimum due, due date; card number masked', () => {
    const x = extractFromDocumentText(CARD_STATEMENT);
    expect(x.documentKind).toBe('card_statement');
    expect(x.fields.commitmentType?.value).toBe('credit_card');
    expect(x.fields.amount?.value).toBe(1845075);
    expect(x.fields.dueDate?.value).toBe('2026-11-04');
    expect(x.redactedText).not.toContain('4111');
    expect(x.redactions).toEqual([{ kind: 'card_number', count: 1 }]);
  });
  it('school fee notice', () => {
    const f = extractFromDocumentText(SCHOOL).fields;
    expect(f.commitmentType?.value).toBe('school_fee');
    expect(f.provider?.value).toBe('Green Valley School');
    expect(f.amount?.value).toBe(4200000);
    expect(f.dueDate?.value).toBe('2026-11-15');
    expect(f.referenceLabel?.value).toBe('Receipt No GVS-2026-0412');
  });
  it('recharge receipt: provider, amount, validity as renewal, benefit', () => {
    const f = extractFromDocumentText(RECHARGE).fields;
    expect(f.provider?.value).toBe('Jio');
    expect(f.amount?.value).toBe(34900);
    expect(f.renewalDate?.value).toBe('2026-11-27');
    expect(f.benefit?.value).toBe('2GB/day, Unlimited calls, JioHotstar Mobile');
    expect(f.referenceLabel?.value).toBe('Order ID JIO98765XYZ');
  });
  it('subscription invoice: paid date, next billing, cycle, link', () => {
    const f = extractFromDocumentText(INVOICE).fields;
    expect(f.provider?.value).toBe('Spotify');
    expect(f.commitmentType?.value).toBe('subscription');
    expect(f.amount?.value).toBe(11900);
    expect(f.paidDate?.value).toBe('2026-10-12');
    expect(f.renewalDate?.value).toBe('2026-11-12');
    expect(f.billingCycle?.value).toBe('monthly');
    expect(f.link?.value).toBe('https://www.spotify.com/account');
  });
  it('trial end', () => {
    const f = extractFromDocumentText(TRIAL).fields;
    expect(f.trialEnd?.value).toBe('2026-11-12');
    expect(f.amount?.value).toBe(14900);
    expect(f.provider?.value).toBe('YouTube Premium');
  });
  it('unknown fields are absent, never guessed', () => {
    const f = extractFromDocumentText(
      'Hello, see you on 12/11/2026. Costs were ₹100 and ₹250.',
    ).fields;
    expect(f.amount).toBeUndefined();
    expect(f.dueDate).toBeUndefined();
    expect(f.provider).toBeUndefined();
    expect(f.commitmentType).toBeUndefined();
    expect(extractFromDocumentText('').fields).toEqual({});
  });
  it('a hint can set the document kind', () => {
    expect(
      extractFromDocumentText('Amount payable ₹500', { kind: 'school_fee' }).fields.commitmentType
        ?.value,
    ).toBe('school_fee');
  });
});

describe('organiseSharedSms', () => {
  it('extracts amount, due date, provider and reference from one SMS', () => {
    const r = organiseSharedSms(
      'VM-AIRTEL: Your Airtel postpaid bill of Rs.1,178.82 for Ref No 9988776 is due on 05-Nov-26. Ignore if paid.',
    );
    expect(r.provider?.value).toBe('Airtel');
    expect(r.amount?.value).toBe(117882);
    expect(r.dueDate?.value).toBe('2026-11-05');
    expect(r.reference?.value).toBe('Ref No 9988776');
  });
  it('never returns an OTP from an SMS', () => {
    const r = organiseSharedSms('Your OTP is 556677 for a payment of Rs 499');
    expect(JSON.stringify(r)).not.toContain('556677');
    expect(r.amount?.value).toBe(49900);
  });
});

describe('UserEvent and export', () => {
  it('builds a private event with confidences, fingerprint and retention; unreadable when empty', () => {
    const x = extractFromDocumentText(INVOICE);
    const ev = buildUserEvent(x, {
      id: 'ue1',
      intakeType: 'forwarded_email',
      createdAt: '2026-10-30T00:00:00.000Z',
      sourceDomain: 'Spotify.com',
      retentionDays: 3,
    });
    expect(ev.reviewStatus).toBe('needs_review');
    expect(ev.extractedFields.amount).toBe(11900);
    expect(ev.confidence.amount).toBeGreaterThan(0.8);
    expect(ev.sourceDomain).toBe('spotify.com');
    expect(ev.rawRetentionUntil).toBe('2026-11-02T00:00:00.000Z');
    expect(ev.messageFingerprint).toBe(fingerprintText(x.redactedText));
    expect(fingerprintText('A  b')).toBe(fingerprintText('a b'));
    expect(
      buildUserEvent(extractFromDocumentText('hello'), {
        id: 'u2',
        intakeType: 'document',
        createdAt: '2026-10-30T00:00:00.000Z',
      }).reviewStatus,
    ).toBe('unreadable');
  });
  it('exports a structured record with fields and confidence but no raw text', () => {
    const x = extractFromDocumentText(SANCTION);
    const ev = buildUserEvent(x, {
      id: 'ue1',
      intakeType: 'document',
      createdAt: '2026-10-30T00:00:00.000Z',
      fileName: 'sanction.pdf',
    });
    const out = JSON.parse(
      exportStructuredRecord(
        { ...ev, reviewStatus: 'confirmed' },
        { exportedAt: '2026-10-30T01:00:00.000Z', obligationId: 'c1' },
      ),
    );
    expect(out.format).toBe('due.structured-record/v1');
    expect(out.fields.emi).toEqual({ value: 2209300, confidence: 0.9 });
    expect(out.obligationId).toBe('c1');
    expect(JSON.stringify(out)).not.toMatch(/Dear Applicant|ABCPE1234F|001234567890/);
  });
  it('confidence bands', () => {
    expect([undefined, 0.3, 0.6, 0.9].map(confidenceBand)).toEqual([
      'missing',
      'low',
      'medium',
      'high',
    ]);
  });
});
