// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { dataWithOne, renderApp, stubNetwork } from './harness';

beforeEach(stubNetwork);
afterEach(cleanup);

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, summary';

describe('Home', () => {
  it('renders the six first-viewport blocks in order, hero before timeline, no category tile', () => {
    const { container } = renderApp({ data: dataWithOne() });
    const order = Array.from(container.querySelectorAll('[data-block]')).map((e) =>
      e.getAttribute('data-block'),
    );
    expect(order).toEqual(['topbar', 'header', 'hero', 'strip', 'timeline', 'actions']);
    expect(container.querySelector('.ctile')).toBeNull();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
      /Your next commitment is clear\.|Nothing due|covered/,
    );
  });

  it('keyboard focus order reaches Review, Snooze, Edit, Add due item, Import in order', () => {
    const { container } = renderApp({ data: dataWithOne() });
    const names = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).map((el) =>
      (el.getAttribute('aria-label') ?? el.textContent ?? '').trim(),
    );
    const idx = [
      /^Review Netflix/,
      /^Snooze Netflix/,
      /^Edit Netflix/,
      /Add due item/,
      /^Import$/,
    ].map((re) => names.findIndex((n) => re.test(n)));
    idx.forEach((i) => expect(i).toBeGreaterThanOrEqual(0));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    // No positive tabindex reorders the page.
    expect(
      container.querySelector('[tabindex]:not([tabindex="-1"]):not([tabindex="0"])'),
    ).toBeNull();
  });

  it('every button has an accessible name', () => {
    renderApp({ data: dataWithOne() });
    for (const b of screen.getAllByRole('button'))
      expect((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).not.toBe('');
  });

  it('shows the landing with the value-first CTA when there is no data', () => {
    renderApp();
    const ctas = screen.getAllByRole('link').map((a) => a.textContent);
    const i = ctas.indexOf('See my next due date');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(ctas.indexOf('Continue with email')).toBeGreaterThan(i);
    expect(ctas.indexOf('Use without an account')).toBeGreaterThan(i);
  });

  it('Mark reviewed from the review sheet shows an Undo toast that restores the item', async () => {
    renderApp({ data: dataWithOne() });
    const hero = document.querySelector('[data-block="hero"]') as HTMLElement;
    fireEvent.click(within(hero).getByRole('button', { name: /^Review Netflix/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark reviewed' }));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/Reviewed Netflix/);
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByTestId('toast').textContent).toMatch(/Undone/));
    const after = document.querySelector('[data-block="hero"]') as HTMLElement;
    expect(after.textContent).not.toMatch(/Reviewed$/);
  });
});
