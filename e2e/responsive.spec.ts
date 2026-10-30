import { expect, test } from '@playwright/test';
import { addGuestObligation } from './helpers';

for (const width of [320, 390, 768, 1440]) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.goto('/');
    const noOverflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      );
    expect(await noOverflow(), `landing at ${width}`).toBe(true);
    await page.screenshot({ path: `e2e/__screenshots__/landing-${width}.png` });
    await addGuestObligation(page);
    for (const hash of [
      '#/',
      '#/all',
      '#/import',
      '#/start',
      '#/plans',
      '#/account',
      '#/settings',
    ]) {
      await page.goto(`/${hash}`);
      await page.waitForTimeout(150);
      expect(await noOverflow(), `${hash} at ${width}`).toBe(true);
    }
    await page.goto('/#/');
    await page.reload();
    await page.screenshot({ path: `e2e/__screenshots__/home-${width}.png`, fullPage: true });
  });
}
