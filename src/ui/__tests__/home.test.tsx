// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { dataWithOne, renderApp, stubNetwork } from './harness';

beforeEach(stubNetwork);
afterEach(cleanup);

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, summary';
const TILE_ORDER = [
  'subscription',
  'emi',
  'credit_card',
  'other_loan',
  'bill',
  'school_fee',
  'offers',
  'seasons',
];
const TILE_NAMES = [
  'Subscriptions',
  'EMIs',
  'Credit cards',
  'Other loans',
  'Bills & essentials',
  'School fees',
  'Due & Offers',
  'Seasonal plans',
];

describe('Home', () => {
  it('shows header, greeting, one summary card, then the eight tiles in launch order', () => {
    const { container } = renderApp({ data: dataWithOne() });
    const order = Array.from(container.querySelectorAll('[data-block]')).map((e) =>
      e.getAttribute('data-block'),
    );
    expect(order.slice(0, 4)).toEqual(['topbar', 'header', 'summary', 'tiles']);
    expect(container.querySelectorAll('[data-block="summary"]')).toHaveLength(1);
    const tiles = Array.from(container.querySelectorAll<HTMLElement>('[data-tile]'));
    expect(tiles.map((t) => t.dataset.tile)).toEqual(TILE_ORDER);
    expect(tiles.map((t) => t.querySelector('.htile-name')?.textContent)).toEqual(TILE_NAMES);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
      /^Good (morning|afternoon|evening)$/,
    );
    expect(container.querySelector('[data-block="header"]')?.textContent).toContain('IST');
  });

  it('summary card shows planned this month, the next item, confidence/source and compact actions', () => {
    renderApp({ data: dataWithOne() });
    const card = document.querySelector('[data-block="summary"]') as HTMLElement;
    expect(card.textContent).toMatch(/Planned in/);
    expect(card.textContent).toContain('Netflix');
    expect(card.textContent).toContain('₹649');
    expect(card.textContent).toMatch(/Date entered by you/);
    expect(card.textContent).toMatch(/Entered by you/);
    for (const n of [/^Review Netflix/, /^Snooze Netflix/])
      expect(within(card).getByRole('button', { name: n })).toBeTruthy();
    expect(within(card).getByRole('link', { name: /^Edit Netflix/ })).toBeTruthy();
  });

  it('every tile shows a value or helpful empty state, and links to its category view', () => {
    renderApp({ data: dataWithOne() });
    const sub = document.querySelector('[data-tile="subscription"]') as HTMLAnchorElement;
    expect(sub.getAttribute('href')).toBe('#/all/subscription');
    expect(sub.textContent).toMatch(/1 ·/);
    expect(sub.textContent).toMatch(/Next \d+ \w{3}/);
    const emi = document.querySelector('[data-tile="emi"]') as HTMLAnchorElement;
    expect(emi.textContent).toMatch(/Add an EMI/);
    expect(emi.className).toContain('jelly');
    for (const t of document.querySelectorAll<HTMLElement>('[data-tile]')) {
      expect(t.querySelector('.htile-value')?.textContent?.trim()).not.toBe('');
      expect(t.textContent?.startsWith(t.querySelector('.htile-name')?.textContent ?? '?')).toBe(
        true,
      );
    }
  });

  it('keyboard order reaches Review, Snooze, Edit, then the tiles in order', () => {
    const { container } = renderApp({ data: dataWithOne() });
    const els = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    const names = els.map((el) => (el.getAttribute('aria-label') ?? el.textContent ?? '').trim());
    const idx = [
      /^Review Netflix/,
      /^Snooze Netflix/,
      /^Edit Netflix/,
      ...TILE_NAMES.map((n) => new RegExp(`^${n} `)),
    ].map((re) => names.findIndex((n) => re.test(n)));
    idx.forEach((i) => expect(i).toBeGreaterThanOrEqual(0));
    for (let i = 1; i < idx.length; i++) expect(idx[i]).toBeGreaterThan(idx[i - 1]);
    expect(
      container.querySelector('[tabindex]:not([tabindex="-1"]):not([tabindex="0"])'),
    ).toBeNull();
  });

  it('every button has an accessible name', () => {
    renderApp({ data: dataWithOne() });
    for (const b of screen.getAllByRole('button'))
      expect((b.getAttribute('aria-label') ?? b.textContent ?? '').trim()).not.toBe('');
  });

  it('with no data shows tiles with empty states and the five first-use choices in order', async () => {
    const { container } = renderApp();
    expect(container.querySelectorAll('[data-tile]')).toHaveLength(8);
    expect(container.querySelector('[data-block="summary"]')?.textContent).toMatch(
      /Nothing planned yet/,
    );
    const choices = Array.from(container.querySelectorAll<HTMLElement>('[data-choice]')).map(
      (e) => e.querySelector('strong')?.textContent,
    );
    expect(choices).toEqual([
      'Add manually',
      'Upload a bill or sanction letter',
      'Forward a subscription email',
      'Connect Gmail',
      'Sign in for sync and reminders',
    ]);
    // Status endpoint unreachable in tests: integrations are labelled honestly, never "Live".
    await waitFor(() =>
      expect(container.querySelector('[data-choice="gmail"]')?.textContent).toMatch(
        /Status unavailable/,
      ),
    );
    expect(container.querySelector('[data-choice="gmail"]')?.textContent).not.toMatch(/Live/);
    expect(container.querySelector('[data-choice="upload"]')?.textContent).toMatch(
      /5 of 5 document uploads left/,
    );
  });

  it('Mark reviewed from the review sheet shows an Undo toast that restores the item', async () => {
    renderApp({ data: dataWithOne() });
    const card = document.querySelector('[data-block="summary"]') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: /^Review Netflix/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark reviewed' }));
    const toast = await screen.findByTestId('toast');
    expect(toast.textContent).toMatch(/Reviewed Netflix/);
    fireEvent.click(within(toast).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(screen.getByTestId('toast').textContent).toMatch(/Undone/));
  });

  it('the All page is a list view without tiles', () => {
    const { container } = renderApp({ data: dataWithOne(), hash: '#/all/subscription' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Subscriptions');
    expect(container.querySelector('[data-tile]')).toBeNull();
  });
});
