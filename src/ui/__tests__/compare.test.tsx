// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { COMPARE_COLUMNS, COMPARE_ROWS } from '../../content/compare';
import { parseRoute } from '../lib/nav';
import { renderApp, stubNetwork } from './harness';

beforeEach(stubNetwork);
afterEach(cleanup);

describe('compare page', () => {
  it('has exactly five columns and 6 to 8 rows with a dated, sourced note in every cell', () => {
    expect(COMPARE_COLUMNS).toEqual(['Due', 'CRED', 'INDmoney', 'Rocket Money', 'Monarch Money']);
    expect(COMPARE_ROWS.length).toBeGreaterThanOrEqual(6);
    expect(COMPARE_ROWS.length).toBeLessThanOrEqual(8);
    for (const r of COMPARE_ROWS)
      for (const c of COMPARE_COLUMNS)
        expect(r.cells[c].note.length, `${r.id}/${c}`).toBeGreaterThan(0);
  });

  it('renders the table, highlights Due, footnote and Why Due cards, with no guarantee wording', async () => {
    renderApp({ hash: '#/compare' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'How Due is different' }),
    ).toBeTruthy();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('columnheader')).toHaveLength(6);
    expect(within(table).getAllByRole('row')).toHaveLength(COMPARE_ROWS.length + 1);
    expect(table.querySelectorAll('td.compare-due')).toHaveLength(COMPARE_ROWS.length);
    expect(screen.getByTestId('compare-footnote').textContent).toContain(
      'Comparison based on public information as of Nov 2026; features change.',
    );
    expect(screen.getByTestId('compare-footnote').textContent).toContain(
      'Write to us to correct anything',
    );
    for (const t of [
      'Your statements stay on your phone',
      'Ranked moves, not ads',
      'Personal + business in one place',
    ])
      expect(screen.getByRole('heading', { name: t })).toBeTruthy();
    expect(screen.getByTestId('compare').textContent).not.toMatch(
      /guarantee|at least \d|minimum saving/i,
    );
    expect(table.textContent).toContain('Not stated');
  });

  it('is also the route for the /compare path', () => {
    window.history.pushState({}, '', '/compare');
    expect(parseRoute('')).toEqual({ name: 'compare' });
    window.history.pushState({}, '', '/');
    expect(parseRoute('')).toEqual({ name: 'home' });
  });
});
