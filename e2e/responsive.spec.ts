import { expect, test } from '@playwright/test';
import { addGuestObligation } from './helpers';

const PAGES = [
  '#/',
  '#/all',
  '#/all/subscription',
  '#/start',
  '#/upload',
  '#/import',
  '#/connections',
  '#/reminders',
  '#/plans',
  '#/legal',
  '#/legal/privacy',
  '#/account',
  '#/settings',
];

for (const [width, height] of [
  [320, 700],
  [390, 844],
  [768, 1024],
  [1440, 900],
] as const) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.goto('/');
    const noOverflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
    expect(await noOverflow(), `empty home at ${width}`).toBe(true);
    await page.screenshot({ path: `e2e/__screenshots__/empty-home-${width}.png` });
    await addGuestObligation(page);
    for (const hash of PAGES) {
      await page.goto(`/${hash}`);
      await page.waitForTimeout(150);
      expect(await noOverflow(), `${hash} at ${width}`).toBe(true);
    }
    await page.goto('/#/');
    await page.reload();
    await page.screenshot({ path: `e2e/__screenshots__/home-${width}.png`, fullPage: true });
  });
}

test('desktop page padding is 24–32px and tiles form one row of four at 1440', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await addGuestObligation(page);
  const xs = await page
    .locator('[data-tile]')
    .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().y)));
  expect(new Set(xs.slice(0, 4)).size).toBe(1);
  const pad = await page
    .locator('.shell')
    .evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft));
  expect(pad).toBeGreaterThanOrEqual(24);
  expect(pad).toBeLessThanOrEqual(32);
});
