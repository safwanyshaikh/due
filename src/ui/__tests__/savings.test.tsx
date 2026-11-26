// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { emptyData } from '../../lib/data';
import { addDays, todayInTz } from '../../lib/dates';
import { createObligation } from '../../lib/mutations';
import { rules } from '../../lib/recurrence';
import type { AppData } from '../../lib/types';
import { STORAGE_KEY } from '../../lib/storage';
import { setCityPack, setHomeLocality, upsertCommuteLeg } from '../../lib/savings';
import { renderApp } from './harness';

const CATALOG = JSON.parse(
  readFileSync(join(process.cwd(), 'e2e', 'fixtures', 'savings-catalog.json'), 'utf8'),
);

type Calls = { url: string; method: string; body: unknown }[];

function mockFetch(opts: { catalog?: unknown; community?: unknown } = {}): Calls {
  const calls: Calls = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(init.body) : null,
    });
    const json = (v: unknown, status = 200) =>
      ({ ok: status < 300, status, json: async () => v }) as unknown as Response;
    if (url.includes('/api/public/savings/catalog')) return json(opts.catalog ?? CATALOG);
    if (url.includes('/api/public/savings/research')) return json({ status: 'queued' });
    if (url.includes('/api/public/savings/community'))
      return json(opts.community ?? { threshold: 20, items: [] });
    if (url.includes('/api/public/savings/report')) return json(null, 204);
    throw new TypeError('offline in tests');
  }) as unknown as typeof fetch;
  window.scrollTo = () => undefined;
  return calls;
}

function stored(): AppData {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as AppData;
}

/** Sameer: MMR, home in Kharghar, a cab to Thane five days a week (cost left to the typical fare). */
function sameer(extra: { provider: string; amountPaise: number }[] = []): AppData {
  const now = new Date().toISOString();
  const start = addDays(todayInTz(), 5);
  let d = emptyData();
  for (const x of [
    { provider: 'Uber One', amountPaise: 14_900 },
    { provider: 'Zomato Gold', amountPaise: 14_900 },
    { provider: 'Jio', amountPaise: 34_900 },
    ...extra,
  ])
    d = createObligation(
      d,
      {
        type: 'subscription',
        provider: x.provider,
        amountPaise: x.amountPaise,
        rule: rules.monthly(start),
      },
      { now },
    ).data;
  let sv = setHomeLocality(setCityPack(d.savings, 'in-mmr'), 'Kharghar');
  sv = upsertCommuteLeg(sv, {
    from: 'Kharghar',
    to: 'Thane',
    daysPerWeek: 5,
    mode: 'cab',
    costPerTripInr: null,
  });
  return { ...d, savings: sv };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe('Savings screen', () => {
  it('shows Found and Saved totals and a ranked move list from the catalog', async () => {
    mockFetch();
    renderApp({ data: sameer(), hash: '#/savings' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Savings');
    const list = await screen.findByTestId('moves');
    const rows = within(list).getAllByRole('button');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId('found-total').textContent).toMatch(/^₹[\d,]+\/month$/);
    expect(screen.getByTestId('saved-total').textContent).toBe('₹0/month');
    // Ranked: amounts never increase down the list unless confidence weighting says so.
    expect(list.querySelectorAll('.sv-rank')[0].textContent).toBe('1');
    expect(document.body.textContent).not.toMatch(/guarantee|minimum saving/i);
  });

  it('sends each known provider without a guide for research once, with no amounts (free text never)', async () => {
    const calls = mockFetch();
    const data = sameer([
      { provider: 'Sony LIV', amountPaise: 99_900 },
      { provider: 'Gala Bus', amountPaise: 99_900 },
    ]);
    const { unmount } = renderApp({ data, hash: '#/savings' });
    const research = await screen.findByTestId('research');
    expect(research.textContent).toContain('We’re studying these bills');
    expect(research.textContent).toContain('Sony LIV');
    expect(research.textContent).not.toContain('Gala Bus');
    await waitFor(() => expect(calls.filter((c) => c.url.includes('/research')).length).toBe(1));
    const body = calls.find((c) => c.url.includes('/research'))!.body as Record<string, unknown>;
    expect(body.providerLabel).toBe('Sony LIV');
    expect(JSON.stringify(body)).not.toMatch(/\d{3}/);
    unmount();
  });

  it('hides the community block when the API returns no items and shows it when it does', async () => {
    mockFetch();
    renderApp({ data: sameer(), hash: '#/savings' });
    await screen.findByTestId('moves');
    await act(async () => undefined);
    expect(screen.queryByTestId('community')).toBeNull();
    cleanup();
    mockFetch({
      community: {
        threshold: 20,
        items: [
          {
            moveKind: 'period_switch',
            moduleId: 'jio-prepaid-in',
            label: 'Jio yearly plan',
            reports: 24,
            medianSavedMonthlyInr: 70,
          },
        ],
      },
    });
    renderApp({ data: sameer(), hash: '#/savings' });
    const c = await screen.findByTestId('community');
    expect(c.textContent).toContain('Jio yearly plan');
    expect(c.textContent).toContain('24 people');
  });

  it('says so when the catalog is unavailable instead of inventing moves', async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError('offline'))) as typeof fetch;
    window.scrollTo = () => undefined;
    renderApp({ data: sameer(), hash: '#/savings' });
    expect(await screen.findByText(/Price information isn’t available/)).toBeTruthy();
    expect(screen.queryByTestId('moves')).toBeNull();
  });
});

describe('Move sheet', () => {
  it('shows why, saving, sources with check dates, an official link, and marks the move done', async () => {
    mockFetch();
    renderApp({ data: sameer(), hash: '#/savings' });
    const list = await screen.findByTestId('moves');
    const first = within(list).getAllByRole('button')[0];
    const title = first.querySelector('.sv-move-title')!.textContent!;
    fireEvent.click(first);
    const dialog = screen.getByRole('dialog', { name: title });
    expect(within(dialog).getByText(/\/month$/)).toBeTruthy();
    expect(dialog.textContent).toMatch(/Likely range/);
    expect(dialog.textContent).toMatch(/Last checked|Not checked yet/);
    // The fixture modules are 'research', so prices are flagged.
    expect(dialog.textContent).toContain('Reported price, check before switching');
    const official = dialog.querySelector('a.btn-primary') as HTMLAnchorElement | null;
    if (official) {
      expect(official.target).toBe('_blank');
      expect(official.rel).toContain('noopener');
    }
    fireEvent.click(within(dialog).getByRole('button', { name: 'I did this' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByRole('heading', { name: 'You did these' })).toBeTruthy();
  });

  it('edits an assumption chip and stores it as an override', async () => {
    mockFetch();
    renderApp({ data: sameer(), hash: '#/savings' });
    const list = await screen.findByTestId('moves');
    const rows = within(list).getAllByRole('button');
    let dialog: HTMLElement | null = null;
    for (const r of rows) {
      fireEvent.click(r);
      const d = screen.getByRole('dialog');
      if (within(d).queryAllByRole('button', { name: /^Change:/ }).length) {
        dialog = d;
        break;
      }
      fireEvent.click(within(d).getByRole('button', { name: /^Close/ }));
    }
    expect(dialog, 'a move with an editable assumption').not.toBeNull();
    const change = within(dialog!).getAllByRole('button', { name: /^Change:/ })[0];
    expect(change.getAttribute('aria-label')).toMatch(/^Change: (We assumed|From your data:) /);
    fireEvent.click(change);
    const input = dialog!.querySelector('.sv-assume-edit input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '300' } });
    fireEvent.click(within(dialog!).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(within(dialog!).getAllByText(/^You set/).length).toBeGreaterThan(0));
    expect(Object.values(stored().savings.profile.overrides)).toContain(300);
  });

  it('rejects a non-number assumption', async () => {
    mockFetch();
    renderApp({ data: sameer(), hash: '#/savings' });
    const list = await screen.findByTestId('moves');
    for (const r of within(list).getAllByRole('button')) {
      fireEvent.click(r);
      const d = screen.getByRole('dialog');
      const ch = within(d).queryAllByRole('button', { name: /^Change:/ });
      if (ch.length) {
        fireEvent.click(ch[0]);
        const input = d.querySelector('.sv-assume-edit input') as HTMLInputElement;
        fireEvent.change(input, { target: { value: 'lots' } });
        fireEvent.click(within(d).getByRole('button', { name: 'Save' }));
        expect(d.textContent).toContain('Enter a number, 0 or more.');
        return;
      }
      fireEvent.click(within(d).getByRole('button', { name: /^Close/ }));
    }
    throw new Error('no editable assumption');
  });
});

describe('Move sheet edge cases', () => {
  const openEditable = async () => {
    mockFetch();
    renderApp({ data: sameer(), hash: '#/savings' });
    const list = await screen.findByTestId('moves');
    for (const r of within(list).getAllByRole('button')) {
      fireEvent.click(r);
      const d = screen.getByRole('dialog');
      const ch = within(d).queryAllByRole('button', { name: /^Change:/ });
      if (ch.length) {
        fireEvent.click(ch[0]);
        return d;
      }
      fireEvent.click(within(d).getByRole('button', { name: /^Close/ }));
    }
    throw new Error('no editable assumption');
  };

  it('rejects an absurdly large assumption instead of inflating the found total', async () => {
    const d = await openEditable();
    const input = d.querySelector('.sv-assume-edit input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1000000000' } });
    fireEvent.click(within(d).getByRole('button', { name: 'Save' }));
    expect(d.textContent).toContain('Enter a smaller number.');
    expect(Object.values(stored()?.savings.profile.overrides ?? {})).toEqual([]);
  });

  it('keeps focus on the page when marking a move done removes the row that opened the sheet', async () => {
    const d = await openEditable();
    fireEvent.click(within(d).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(d).getByRole('button', { name: 'I did this' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: 'Moves, best first' }),
      ),
    );
  });
});

describe('Hidden moves', () => {
  it('lists a "Not for me" move under Hidden moves and brings it back with "Show this again"', async () => {
    mockFetch();
    renderApp({ data: sameer(), hash: '#/savings' });
    const list = await screen.findByTestId('moves');
    const first = within(list).getAllByRole('button')[0];
    const id = first.getAttribute('data-move')!;
    expect(screen.queryByTestId('hidden-moves')).toBeNull();
    fireEvent.click(first);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Not for me' }));
    const hidden = await screen.findByTestId('hidden-moves');
    expect(hidden.textContent).toContain('Hidden moves (1)');
    expect(screen.getByTestId('moves').querySelector(`[data-move="${id}"]`)).toBeNull();
    fireEvent.click(hidden.querySelector(`[data-move="${id}"]`)!);
    fireEvent.click(screen.getByRole('button', { name: 'Show this again' }));
    await waitFor(() =>
      expect(screen.getByTestId('moves').querySelector(`[data-move="${id}"]`)).not.toBeNull(),
    );
    expect(screen.queryByTestId('hidden-moves')).toBeNull();
  });
});

describe('Commute setup', () => {
  it('picks a city pack and home locality, adds and removes a leg', async () => {
    mockFetch();
    renderApp({ data: emptyData(), hash: '#/savings' });
    const box = await screen.findByTestId('commute-setup');
    const city = await within(box).findByLabelText('City');
    fireEvent.change(city, { target: { value: 'in-mmr' } });
    fireEvent.change(within(box).getByLabelText('Home area'), { target: { value: 'Kharghar' } });
    expect((within(box).getByLabelText('From') as HTMLSelectElement).value).toBe('Kharghar');
    fireEvent.change(within(box).getByLabelText('To'), { target: { value: 'Thane' } });
    fireEvent.change(within(box).getByLabelText('How you travel'), { target: { value: 'cab' } });
    fireEvent.change(within(box).getByLabelText('Days a week'), { target: { value: '5' } });
    fireEvent.change(within(box).getByLabelText('Cost per trip (₹)'), { target: { value: '450' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Add trip' }));
    const legs = within(box).getByRole('list', { name: 'Your regular trips' });
    expect(legs.textContent).toContain('Kharghar → Thane');
    expect(legs.textContent).toContain('Cab · 5 days a week · ₹450 a trip');
    fireEvent.click(within(box).getByRole('button', { name: 'Remove trip Kharghar to Thane' }));
    expect(within(box).queryByRole('list', { name: 'Your regular trips' })).toBeNull();
  });

  it('validates a leg before adding it', async () => {
    mockFetch();
    renderApp({ data: emptyData(), hash: '#/savings' });
    const box = await screen.findByTestId('commute-setup');
    fireEvent.change(await within(box).findByLabelText('City'), { target: { value: 'in-mmr' } });
    fireEvent.change(within(box).getByLabelText('Days a week'), { target: { value: '9' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Add trip' }));
    expect(box.textContent).toContain('Choose where the trip starts.');
    expect(box.textContent).toContain('Days a week must be 1 to 7.');
  });
});

describe('Statement import', () => {
  const TEXT = [
    '05/08/2026 UPI-AUTOPAY NETFLIX ENTERTAINMENT 649.00 Dr',
    '05/09/2026 UPI-AUTOPAY NETFLIX ENTERTAINMENT 649.00 Dr',
    '05/10/2026 UPI-AUTOPAY NETFLIX ENTERTAINMENT 649.00 Dr',
    '07/08/2026 NACH DR HDFC HOME LOAN EMI 24,500.00 Dr',
    '07/09/2026 NACH DR HDFC HOME LOAN EMI 24,500.00 Dr',
    '07/10/2026 NACH DR HDFC HOME LOAN EMI 24,500.00 Dr',
    '12/09/2026 SWIGGY ORDER 412.00 Dr',
  ].join('\n');

  it('finds repeat payments in pasted text and adds the chosen ones with their rail', async () => {
    mockFetch();
    renderApp({ data: emptyData(), hash: '#/savings-import' });
    fireEvent.change(screen.getByLabelText('Or paste statement text'), { target: { value: TEXT } });
    fireEvent.click(screen.getByRole('button', { name: 'Find repeat payments' }));
    const found = await screen.findByRole('heading', { name: /repeat payments? found/ });
    const section = found.closest('section') as HTMLElement;
    const boxes = within(section).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    expect(section.textContent).toContain('UPI AutoPay');
    expect(section.textContent).toContain('Bank mandate');
    fireEvent.click(within(section).getByRole('button', { name: /^Add \d+ selected$/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/savings'));
    const saved = stored().commitments;
    const rails = saved.map((c) => c.rail);
    expect(rails).toContain('upi_autopay');
    expect(rails).toContain('bank_mandate');
    expect(saved.every((c) => c.amount.source.kind === 'statement')).toBe(true);
  });

  it('explains when nothing repeats', async () => {
    mockFetch();
    renderApp({ data: emptyData(), hash: '#/savings-import' });
    fireEvent.change(screen.getByLabelText('Or paste statement text'), {
      target: { value: '12/09/2026 SWIGGY ORDER 412.00 Dr' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Find repeat payments' }));
    expect(await screen.findByText(/found nothing that repeats|No payment lines/)).toBeTruthy();
  });
});

describe('Home and landing', () => {
  it('Home has one compact savings entry inside the summary card, before the tiles', async () => {
    mockFetch();
    const { container } = renderApp({ data: sameer() });
    const entry = await screen.findByTestId('home-savings');
    expect(entry.closest('[data-block="summary"]')).not.toBeNull();
    expect(entry.getAttribute('href')).toBe('#/savings');
    await waitFor(() => expect(entry.textContent).toMatch(/^₹[\d,]+\/month found$/));
    expect(container.querySelectorAll('[data-testid="home-savings"]')).toHaveLength(1);
    const order = Array.from(container.querySelectorAll('[data-block]')).map((e) =>
      e.getAttribute('data-block'),
    );
    expect(order.slice(0, 4)).toEqual(['topbar', 'header', 'summary', 'tiles']);
  });

  it('start page leads with the tagline and sub-line', () => {
    mockFetch();
    renderApp({ hash: '#/start' });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Same life. Smaller bills.');
    expect(document.body.textContent).toContain(
      'Due checks your subscriptions, recharges, rides and EMIs, and shows where you’re overpaying.',
    );
  });
});
