import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

for (const [name, width, height] of [
  ['360px', 360, 740],
  ['1280px', 1280, 800],
] as const) {
  test.describe(`compare at ${name}`, () => {
    test.use({ viewport: { width, height } });

    test('has no horizontal page scroll, only the table scrolls, with 48px targets and no serious axe violations', async ({
      page,
    }) => {
      await page.goto('/compare');
      await expect(
        page.getByRole('heading', { level: 1, name: 'How Due is different' }),
      ).toBeVisible();
      const o = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      expect(o.sw).toBeLessThanOrEqual(o.cw);
      if (width < 700) {
        const scroll = await page
          .locator('.compare-scroll')
          .evaluate((el) => el.scrollWidth > el.clientWidth);
        expect(scroll).toBe(true);
        // First column stays visible while the table scrolls.
        await page.locator('.compare-scroll').evaluate((el) => (el.scrollLeft = 300));
        const left = await page
          .locator('tbody th.compare-sticky')
          .first()
          .evaluate((el) => el.getBoundingClientRect().left);
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left).toBeLessThan(40);
      }
      const small = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.compare a[href], .compare button')]
          .filter((e) => e.offsetParent !== null)
          .map((e) => ({ t: e.textContent?.trim(), h: e.getBoundingClientRect().height }))
          .filter((x) => x.h < 47.5),
      );
      expect(small).toEqual([]);
      const r = await new AxeBuilder({ page }).analyze();
      const bad = r.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => v.id);
      expect(bad).toEqual([]);
    });

    test('dark mode keeps the table readable', async ({ page }) => {
      await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
      await page.goto('/compare');
      const r = await new AxeBuilder({ page }).analyze();
      expect(
        r.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => v.id),
      ).toEqual([]);
    });
  });
}
