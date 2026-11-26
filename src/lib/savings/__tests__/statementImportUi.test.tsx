// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { emptyData } from '../../data';
import { STORAGE_KEY } from '../../storage';
import type { AppData } from '../../types';
import { renderApp } from '../../../ui/__tests__/harness';

const fx = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as AppData;

beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = vi.fn(async () => {
    throw new TypeError('offline in tests');
  }) as unknown as typeof fetch;
  window.scrollTo = () => undefined;
});
afterEach(cleanup);

describe('statement import: summary step', () => {
  it('shows the card summary and adds the card bill with the summary saved', async () => {
    renderApp({ data: emptyData(), hash: '#/savings-import' });
    fireEvent.change(screen.getByLabelText('Or paste statement text'), {
      target: { value: fx('sbi-card-b-2026-09.txt') },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find repeat payments' }));
    const card = await screen.findByTestId('sv-card-summary');
    expect(card.textContent).toContain('5 Oct 2026');
    expect(card.textContent).toContain('₹3,52,153');
    expect(card.textContent).toContain('₹24,115');
    expect(card.textContent).toContain('₹15,387');
    fireEvent.click(within(card).getByRole('button', { name: "Add this card's bill" }));
    await waitFor(() => expect(stored().commitments).toHaveLength(1));
    const d = stored();
    expect(d.commitments[0]).toMatchObject({
      type: 'credit_card',
      nextDue: '2026-10-05',
      amountPaise: 35215320,
    });
    expect(d.savings.statements?.[0]).toMatchObject({
      totalDue: 352153.2,
      obligationId: d.commitments[0].id,
    });
  });

  it("shows a loan summary and adds the loan's EMI", async () => {
    renderApp({ data: emptyData(), hash: '#/savings-import' });
    fireEvent.change(screen.getByLabelText('Or paste statement text'), {
      target: { value: fx('ltf-home-loan-soa.txt') },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find repeat payments' }));
    const loan = await screen.findByTestId('sv-loan-summary');
    expect(loan.textContent).toContain('₹1,11,036');
    expect(loan.textContent).toContain('8.4% a year');
    fireEvent.click(within(loan).getByRole('button', { name: "Add this loan's EMI" }));
    await waitFor(() => expect(stored().commitments).toHaveLength(1));
    expect(stored().commitments[0]).toMatchObject({ type: 'emi', rail: 'bank_mandate' });
    expect(stored().savings.loans?.[0].obligationId).toBe(stored().commitments[0].id);
  });

  it('saves a bank statement summary for Savings', async () => {
    renderApp({ data: emptyData(), hash: '#/savings-import' });
    fireEvent.change(screen.getByLabelText('Or paste statement text'), {
      target: { value: fx('union-bank-savings.txt') },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find repeat payments' }));
    const bank = await screen.findByTestId('sv-bank-summary');
    expect(bank.textContent).toContain('15 (₹8,000 in bank charges)');
    fireEvent.click(within(bank).getByRole('button', { name: 'Use this statement for Savings' }));
    await waitFor(() => expect(stored().savings.banks?.[0].bank).toBe('Union Bank of India'));
  });

  const paste = async (file: string, testId: string) => {
    renderApp({ data: emptyData(), hash: '#/savings-import' });
    fireEvent.change(screen.getByLabelText('Or paste statement text'), {
      target: { value: fx(file) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find repeat payments' }));
    return screen.findByTestId(testId);
  };

  it('Jio Postpaid bill: summary card and "Add this bill"', async () => {
    const card = await paste('jio-postpaid-bill.txt', 'sv-telecom-summary');
    expect(card.textContent).toContain('Jio Postpaid bill');
    expect(card.textContent).toContain('399 - Prime');
    expect(card.textContent).toContain('₹1,032');
    expect(card.textContent).toContain('16 Oct 2026');
    fireEvent.click(within(card).getByRole('button', { name: 'Add this bill' }));
    await waitFor(() => expect(stored().commitments).toHaveLength(1));
    const d = stored();
    expect(d.commitments[0]).toMatchObject({
      type: 'bill',
      provider: 'Jio',
      nickname: 'Jio Postpaid',
      amountPaise: 103162,
      nextDue: '2026-10-16',
      frequency: 'monthly',
    });
    expect(d.savings.telecom?.[0]).toMatchObject({
      service: 'postpaid',
      obligationId: d.commitments[0].id,
    });
  });

  it('JioFiber bill: plan and bundled OTT apps in plain words', async () => {
    const card = await paste('jio-fiber-bill.txt', 'sv-telecom-summary');
    expect(card.textContent).toContain('JioFiber bill');
    expect(card.textContent).toContain('399+200(13 OTT)');
    expect(card.textContent).toContain('13 paid OTT apps (list not printed)');
    expect(card.textContent).toContain('12 Nov 2026');
    fireEvent.click(within(card).getByRole('button', { name: 'Add this bill' }));
    await waitFor(() =>
      expect(stored().commitments[0]).toMatchObject({ nickname: 'JioFiber', amountPaise: 75600 }),
    );
  });

  it('Google Pay statement: saved for Savings, no obligation', async () => {
    const card = await paste('gpay-statement.txt', 'sv-upi-summary');
    expect(card.textContent).toContain('Google Pay statement');
    expect(card.textContent).toContain('₹15,041');
    fireEvent.click(within(card).getByRole('button', { name: 'Use this statement for Savings' }));
    await waitFor(() =>
      expect(stored().savings.upi?.[0].creditCardSpend[0].totalInr).toBe(15040.59),
    );
    expect(stored().commitments).toHaveLength(0);
  });

  it('Gold loan OD: summary card and "Add this loan"', async () => {
    const card = await paste('sbi-gold-loan-od.txt', 'sv-gold-summary');
    expect(card.textContent).toContain('₹9,60,000');
    expect(card.textContent).toContain('₹8,12,584');
    expect(card.textContent).toContain('9.7% a year');
    expect(card.textContent).toContain('₹7,612');
    fireEvent.click(within(card).getByRole('button', { name: 'Add this loan' }));
    await waitFor(() => expect(stored().commitments).toHaveLength(1));
    const d = stored();
    expect(d.commitments[0]).toMatchObject({
      type: 'other_loan',
      amountPaise: 761185,
      loan: { interestRatePct: 9.7, principalPaise: 81258401, loanType: 'Gold Loan OD' },
    });
    expect(d.commitments[0].rule.kind).toBe('end_of_month');
    expect(d.savings.loans?.[0]).toMatchObject({
      productKind: 'gold_loan_od',
      obligationId: d.commitments[0].id,
    });
  });

  it('importing the same statement twice does not duplicate the repeat payments', async () => {
    const run = async () => {
      cleanup();
      renderApp({ data: stored() ?? emptyData(), hash: '#/savings-import' });
      fireEvent.change(screen.getByLabelText('Or paste statement text'), {
        target: { value: fx('union-bank-savings.txt') },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Find repeat payments' }));
      fireEvent.click(await screen.findByRole('button', { name: /^Add \d+ selected$/ }));
    };
    await run();
    await waitFor(() => expect(stored()?.commitments.length).toBeGreaterThan(0));
    const before = stored();
    const first = before.commitments.length;
    await run();
    await waitFor(() => expect(screen.getByText(/already in your list/)).toBeTruthy());
    expect((stored() ?? before).commitments).toHaveLength(first);
  });

  it('refuses a huge paste with a plain message instead of freezing', async () => {
    renderApp({ data: emptyData(), hash: '#/savings-import' });
    fireEvent.change(screen.getByLabelText('Or paste statement text'), {
      target: { value: '05/11/2026  UPI-AUTOPAY NETFLIX  649.00 Dr\n'.repeat(30_000) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find repeat payments' }));
    expect(await screen.findByText(/too long to read at once/)).toBeTruthy();
  });
});
