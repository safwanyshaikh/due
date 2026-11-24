import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Fixture catalog (never the real server): Uber One, Zomato Gold, Jio, JioHotstar, the MMR city pack. */
const CATALOG = readFileSync(join(here, 'fixtures', 'savings-catalog.json'), 'utf8');

async function mockSavingsApi(page: Page) {
  const research: unknown[] = [];
  await page.route('**/api/public/savings/catalog**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: CATALOG }),
  );
  await page.route('**/api/public/savings/research**', (r) => {
    research.push(r.request().postDataJSON());
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'queued' }),
    });
  });
  await page.route('**/api/public/savings/community**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ threshold: 20, items: [] }),
    }),
  );
  await page.route('**/api/public/savings/report**', (r) => r.fulfill({ status: 204, body: '' }));
  return research;
}

async function addItem(page: Page, name: string, amount: string) {
  await page.goto('/#/add');
  await page.getByLabel('Who is it with?').fill(name);
  await page.getByLabel('Amount (₹)').fill(amount);
  await page.getByRole('button', { name: 'Save due item' }).click();
  await expect(page.locator('[data-block="summary"]')).toBeVisible();
}

async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad).toEqual([]);
}

for (const [width, height] of [
  [360, 780],
  [1280, 900],
] as const) {
  test(`Sameer flow at ${width}px: commute, three bills, ranked moves, edit, done`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await mockSavingsApi(page);
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());

    await addItem(page, 'Uber One', '149');
    await addItem(page, 'Zomato Gold', '149');
    await addItem(page, 'Jio', '349');

    // Home: one compact entry in the summary card; tiles still lead.
    const entry = page.getByTestId('home-savings');
    await expect(entry).toBeVisible();
    const first = await page.locator('[data-tile="subscription"]').boundingBox();
    expect(first!.y + first!.height).toBeLessThanOrEqual(height);
    await entry.click();
    await expect(page).toHaveURL(/#\/savings$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Savings');

    // Commute: MMR, Kharghar, a Thane cab leg.
    await page.getByLabel('City').selectOption({ label: 'Mumbai, Navi Mumbai, Thane' });
    await page.getByLabel('Home area').selectOption('Kharghar');
    await expect(page.getByLabel('From')).toHaveValue('Kharghar');
    await page.getByLabel('To', { exact: true }).selectOption('Thane');
    await page.getByLabel('How you travel').selectOption('cab');
    await page.getByLabel('Days a week').fill('5');
    // Cost left empty: the city's typical cab fare becomes a labelled, editable assumption.
    await page.getByRole('button', { name: 'Add trip' }).click();
    await expect(page.getByRole('list', { name: 'Your regular trips' })).toContainText(
      'Kharghar → Thane',
    );

    // Ranked moves.
    const moves = page.getByTestId('moves').locator('[data-move]');
    await expect(moves.first()).toBeVisible();
    expect(await moves.count()).toBeGreaterThanOrEqual(2);
    const amounts = await page.getByTestId('moves').locator('.sv-move-amt').allTextContents();
    expect(amounts.every((a) => /₹[\d,]+/.test(a))).toBe(true);
    await expect(page.getByTestId('found-total')).toContainText(/₹[\d,]+\/month/);
    await expect(page.locator('body')).not.toContainText(/guarantee/i);
    await axeClean(page);

    // Open a move that has an editable assumption.
    const withAssumption = page.getByTestId('moves').locator('[data-move^="membership_breakeven"]');
    const target = (await withAssumption.count()) ? withAssumption.first() : moves.first();
    const title = (await target.locator('.sv-move-title').textContent())!.trim();
    await target.click();
    const sheet = page.getByRole('dialog', { name: title });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Sources');
    await expect(sheet).toContainText(/Last checked|Not checked yet/);
    await axeClean(page);

    const change = sheet.getByRole('button', { name: /^Change:/ }).first();
    await expect(change).toBeVisible();
    await expect(change).toHaveAttribute('aria-label', /^Change: We assumed ₹450/);
    {
      const before = (await change.getAttribute('aria-label'))!;
      await change.click();
      const input = sheet.locator('.sv-assume-edit input');
      await input.fill('400');
      await sheet.getByRole('button', { name: 'Save' }).click();
      await expect(sheet.getByText(/^You set/).first()).toBeVisible();
      expect(await sheet.getByRole('button', { name: before }).count()).toBe(0);
    }

    // The official page opens in a new tab.
    const action = sheet.locator('a.btn-primary[target="_blank"]');
    if (await action.count()) await expect(action).toHaveAttribute('rel', /noopener/);

    await sheet.getByRole('button', { name: 'I did this' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'You did these' })).toBeVisible();

    const noOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(noOverflow).toBe(true);
    await page.screenshot({ path: `e2e/__screenshots__/savings-${width}.png`, fullPage: true });
  });
}

test('start page shows the hero tagline', async ({ page }) => {
  await mockSavingsApi(page);
  await page.goto('/#/start');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Same life. Smaller bills.');
  await expect(page.locator('[data-block="hero"]')).toContainText(
    'Due checks your subscriptions, recharges, rides and EMIs',
  );
});
