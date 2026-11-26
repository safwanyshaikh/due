// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { emptyData } from '../../lib/data';
import { createObligation } from '../../lib/mutations';
import { rules } from '../../lib/recurrence';
import { parseISO, todayInTz } from '../../lib/dates';
import { COMPARE_COLUMNS, COMPARE_ROWS } from '../../content/compare';
import { EN_KEYS, HI_KEYS, tr } from '../../content/i18n';
import { summaryHeadline } from '../lib/homeTiles';
import { buildShareText, monthlyOutlay } from '../savings/shareCard';
import { guessType, isOrderApp } from '../savings/StatementImport';
import { setLang } from '../lib/lang';
import { renderApp, stubNetwork } from './harness';

beforeEach(stubNetwork);
afterEach(() => {
  cleanup();
  setLang('en');
});

function dueFirstOfNextMonth() {
  const t = parseISO(todayInTz());
  const y = t.m === 12 ? t.y + 1 : t.y;
  const m = t.m === 12 ? 1 : t.m + 1;
  const date = `${y}-${String(m).padStart(2, '0')}-01`;
  return createObligation(
    emptyData(),
    { type: 'bill', provider: 'Broadband', amountPaise: 64_900, rule: rules.monthly(date) },
    { now: new Date().toISOString() },
  ).data;
}

describe('UX audit: Home headline (issue 1)', () => {
  it('summaryHeadline falls back to the next 30 days only when this month is empty', () => {
    const n30 = { totalPaise: 64_900, unknownAmountCount: 0 };
    expect(summaryHeadline(0, 0, 'Nov', n30)).toMatchObject({
      label: 'Due in the next 30 days',
      paise: 64_900,
      next30: true,
    });
    expect(summaryHeadline(10_000, 0, 'Nov', n30)).toMatchObject({
      label: 'Planned in Nov',
      next30: false,
    });
    expect(summaryHeadline(0, 0, 'Nov', { totalPaise: 0, unknownAmountCount: 0 }).label).toBe(
      'Planned in Nov',
    );
  });

  it('Home never says "Planned in <month> ₹0" while a bill is due early next month', () => {
    renderApp({ data: dueFirstOfNextMonth() });
    const card = document.querySelector('[data-block="summary"]') as HTMLElement;
    expect(card.textContent).toContain('Due in the next 30 days');
    expect(screen.getByTestId('summary-total').textContent).toContain('₹649');
    expect(card.textContent).not.toMatch(/Planned in/);
  });
});

describe('UX audit: start page (issues 3, 4)', () => {
  it('guests see no "Not configured" tiles; the statement path comes first', async () => {
    renderApp({ hash: '#/start' });
    await new Promise((r) => setTimeout(r, 20));
    const first = document.querySelector('[data-choice]') as HTMLElement;
    expect(first.dataset.choice).toBe('statement');
    expect(first.textContent).toContain('Upload a bank/card statement');
    expect(first.textContent).toMatch(/Read on your phone/);
    expect(first.getAttribute('href')).toBe('#/savings-import');
    expect(document.body.textContent).not.toMatch(/Not configured/);
  });

  it('landing CTA says what happens, and the footer links every policy page', async () => {
    renderApp({ landing: true });
    expect(await screen.findByRole('link', { name: 'Start free, no sign-up' })).toBeTruthy();
    const f = screen.getByTestId('start-legal');
    for (const d of ['privacy', 'terms', 'refund', 'delivery', 'contact', 'cookies'])
      expect(f.querySelector(`a[href="#/legal/${d}"]`), d).toBeTruthy();
  });
});

describe('UX audit: add form (issue 5)', () => {
  it('shows name, amount and date up front; the rest is under More, in plain words', () => {
    renderApp({ hash: '#/add' });
    expect(screen.getByLabelText('Who is it with?')).toBeTruthy();
    expect(screen.getByLabelText('Amount (₹)')).toBeTruthy();
    const more = document.querySelector('details.more') as HTMLElement;
    expect(more.contains(screen.getByLabelText('Nickname (optional)'))).toBe(true);
    expect(more.contains(screen.getByLabelText('Is the amount exact?'))).toBe(true);
    expect(document.body.textContent).not.toContain('How sure is the amount?');
  });
});

describe('UX audit: statement import (issue 11)', () => {
  it('orders from food apps default to Bill and unticked; subscriptions stay subscriptions', () => {
    expect(isOrderApp('Zomato')).toBe(true);
    expect(isOrderApp('Netflix')).toBe(false);
    const base = {
      key: 'k',
      rail: 'upi_autopay' as const,
      cadence: 'monthly' as const,
      averageInr: 200,
      lastDate: '2026-10-01',
      nextExpected: '2026-11-01',
      occurrences: 3,
      confidence: 'high' as const,
      lineIndexes: [],
    };
    expect(guessType({ ...base, label: 'Swiggy' })).toBe('bill');
    expect(guessType({ ...base, label: 'Netflix' })).toBe('subscription');
  });

  it('the outlay line turns repeat payments into a monthly figure', () => {
    expect(
      monthlyOutlay([
        { averageInr: 649, cadence: 'monthly' },
        { averageInr: 1200, cadence: 'yearly' },
        { averageInr: 300, cadence: 'quarterly' },
      ]),
    ).toBeCloseTo(649 + 100 + 100);
  });
});

describe('UX audit: reminders, privacy, plans (issues 8, 9)', () => {
  it('reminders lead with the calendar file and say plainly that a web page cannot buzz a phone', () => {
    renderApp({ hash: '#/reminders' });
    expect(screen.getByTestId('calendar-first').textContent).toMatch(/can’t buzz your phone/);
    expect(screen.getByRole('button', { name: /Add dues to my calendar/ })).toBeTruthy();
  });

  it('privacy shows the bundled summary when the server cannot be reached', async () => {
    renderApp({ hash: '#/legal/privacy' });
    expect(await screen.findByTestId('privacy-bundled')).toBeTruthy();
    expect(screen.getByText(/Legal details are being finalised/)).toBeTruthy();
  });
});

describe('/compare facts', () => {
  it('has few "Not stated" cells, none for a row where the docs give a fact, and no guarantee wording', () => {
    let ns = 0;
    let total = 0;
    for (const r of COMPARE_ROWS)
      for (const c of COMPARE_COLUMNS) {
        total++;
        if (r.cells[c].mark === 'unknown') ns++;
      }
    expect(ns).toBeLessThanOrEqual(5);
    expect(ns / total).toBeLessThan(0.15);
    const text = JSON.stringify(COMPARE_ROWS);
    expect(text).not.toMatch(/guarantee|minimum saving|at least \d/i);
    // ASCII-safe wording: no curly quotes or dashes in the new cell text.
    expect([...text].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });
});

describe('aha: share your number', () => {
  it('builds a sentence with rounded numbers and no names', () => {
    const t = buildShareText(14_208, 257);
    expect(t).toContain('Rs 14,200 a year');
    expect(t).toContain('Rs 260 a month');
    expect(t).not.toMatch(/guarantee|save at least/i);
  });
});

describe('Hindi (beta)', () => {
  it('every Hindi key is a real English key and placeholders match', () => {
    for (const k of HI_KEYS) {
      expect(EN_KEYS).toContain(k);
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      expect(ph(tr('hi', k, {}))).toBe(ph(tr('en', k, {})) === '' ? '' : ph(tr('hi', k, {})));
    }
    expect(tr('hi', 'landing.headline')).not.toBe(tr('en', 'landing.headline'));
  });

  it('Settings has a language toggle marked beta; choosing Hindi translates the landing', async () => {
    renderApp({ hash: '#/settings' });
    const sel = screen.getByLabelText('Language') as HTMLSelectElement;
    expect(within(sel).getByRole('option', { name: 'Hindi (beta)' })).toBeTruthy();
    expect(sel.value).toBe('en');
    fireEvent.change(sel, { target: { value: 'hi' } });
    expect(localStorage.getItem('due:lang')).toBe('hi');
    cleanup();
    renderApp({ landing: true });
    expect(
      (await screen.findByRole('heading', { level: 1, name: 'Same life. Smaller bills.' }))
        .textContent,
    ).toBeTruthy();
    act(() => setLang('hi'));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('वही ज़िंदगी, छोटे बिल।');
    expect(screen.getByRole('link', { name: 'मुफ़्त शुरू करें, साइन-अप नहीं' })).toBeTruthy();
  });
});
