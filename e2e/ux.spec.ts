import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CATALOG = readFileSync(join(here, 'fixtures', 'savings-catalog.json'), 'utf8');

async function mock(page: Page) {
  await page.route('**/api/public/savings/catalog**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: CATALOG }),
  );
  await page.route('**/api/public/savings/research**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"status":"queued"}' }),
  );
  await page.route('**/api/public/savings/community**', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"threshold":20,"items":[]}',
    }),
  );
}

async function add(page: Page, name: string, amount: string) {
  await page.goto('/#/add');
  await page.getByLabel('Who is it with?').fill(name);
  await page.getByLabel('Amount (₹)').fill(amount);
  await page.getByRole('button', { name: 'Save due item' }).click();
  await expect(page.locator('[data-block="summary"]')).toBeVisible();
}

for (const width of [320, 360]) {
  test(`found amount is the Home hero and never wraps mid-word at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 740 });
    await mock(page);
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('due:landing-opened', '1');
    });
    await add(page, 'Uber One', '149');
    await add(page, 'Zomato Gold', '149');
    await add(page, 'Jio', '349');
    await page.goto('/');
    const hero = page.getByTestId('home-savings');
    await expect(hero).toContainText(/₹[\d,]+\/month/);
    await expect(hero).toContainText('See how');
    // The figure sits on one line: its height is one line of text.
    const fig = hero.locator('.sv-hero-fig');
    const lines = await fig.evaluate(
      (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
    );
    expect(lines).toBeLessThan(1.5);
    const box = await hero.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    expect(box!.height).toBeGreaterThanOrEqual(48);
    // No horizontal overflow on Home or Savings.
    for (const route of ['/', '/#/savings']) {
      await page.goto(route);
      await page.waitForTimeout(400);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
        .toBe(true);
    }
    const found = page.getByTestId('found-total');
    await expect(found).toContainText(/₹[\d,]+\/month/);
    const fl = await found.evaluate(
      (el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight),
    );
    expect(fl).toBeLessThan(2.6); // figure, then "/month" on its own line
    await expect(page.locator('.sv-total-found')).toBeVisible();
  });
}

test('Settings link uses a gear, not a sun, and the add form is short', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/#/add');
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(h).toBeLessThan(1950);
  const path = await page.locator('a[aria-label="Settings"] svg path').first().getAttribute('d');
  expect(path).toMatch(/^M10\.\d|^M\d+\.\d L/i);
});
