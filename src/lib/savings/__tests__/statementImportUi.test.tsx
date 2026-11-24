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
});
