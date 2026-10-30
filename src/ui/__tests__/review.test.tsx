// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderApp, stubNetwork } from './harness';
import { addImportItems, importItemFromText } from '../../lib/imports';
import { emptyData } from '../../lib/data';
import { addDays, todayInTz } from '../../lib/dates';

beforeEach(stubNetwork);
afterEach(cleanup);

function iso(d: string) {
  const [y, m, day] = d.split('-');
  return `${day}/${m}/${y}`;
}

describe('review flows', () => {
  it('pasted text: redacts, shows a review card, saves only on Confirm', async () => {
    renderApp({ hash: '#/upload' });
    const due = addDays(todayInTz(), 10);
    fireEvent.change(screen.getByLabelText('Bill, letter or receipt text'), {
      target: {
        value: `Netflix renewal. Amount: Rs. 649. Next billing date: ${iso(due)}. Card 4111 1111 1111 1111`,
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Organise this text' }));
    const card = await screen.findByRole('article', { name: /Review/ });
    expect(card.textContent).toMatch(/₹649/);
    expect(document.body.textContent).toMatch(/Masked before reading: 1 card number/);
    expect(document.body.textContent).not.toMatch(/4111 1111 1111 1111/);
    expect(localStorage.getItem('payables-planner:v1') ?? '').not.toMatch(/Netflix/);
    fireEvent.click(within(card).getByRole('button', { name: 'Confirm and save' }));
    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(localStorage.getItem('payables-planner:v1')).toMatch(/Netflix/);
  });

  it('queue: Ignore is undoable and Approve creates the obligation', async () => {
    const now = new Date().toISOString();
    const due = addDays(todayInTz(), 12);
    let data = emptyData();
    const a = importItemFromText(data, {
      kind: 'forwarded_email',
      text: `Your Spotify plan renews on ${iso(due)}. Amount ₹119.`,
      receivedAt: now,
    });
    data = addImportItems(data, [a], { now }).data;
    renderApp({ data, hash: '#/import' });
    const card = await screen.findByRole('article', { name: /Review/ });
    expect(within(card).getByText('Raw source and provenance')).toBeTruthy();
    fireEvent.click(within(card).getByRole('button', { name: 'Ignore' }));
    expect(screen.queryByRole('article', { name: /Review/ })).toBeNull();
    fireEvent.click(within(screen.getByTestId('toast')).getByRole('button', { name: 'Undo' }));
    const again = await screen.findByRole('article', { name: /Review/ });
    fireEvent.click(within(again).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('article', { name: /Review/ })).toBeNull());
    expect(localStorage.getItem('payables-planner:v1')).toMatch(/"provider":"Spotify/);
  });
});
