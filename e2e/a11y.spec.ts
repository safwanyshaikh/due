import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { addGuestObligation } from './helpers';

test.use({ viewport: { width: 390, height: 844 } });

const PAGES = [
  ['Home', '#/'],
  ['Import', '#/import'],
  ['Plans', '#/plans'],
  ['Account', '#/account'],
] as const;

for (const [name, hash] of PAGES) {
  test(`${name} has no serious or critical axe violations`, async ({ page }) => {
    await addGuestObligation(page);
    await page.goto(`/${hash}`);
    await page.reload();
    await page.waitForTimeout(400);
    const r = await new AxeBuilder({ page }).analyze();
    const bad = r.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map(
        (v) =>
          `${v.id}: ${v.nodes
            .slice(0, 3)
            .map((n) => n.target.join(' '))
            .join(' | ')}`,
      );
    expect(bad).toEqual([]);
  });
}

test('every button on Home has an accessible name', async ({ page }) => {
  await addGuestObligation(page);
  const unnamed = await page
    .getByRole('button')
    .evaluateAll(
      (els) => els.filter((e) => !(e.getAttribute('aria-label') || e.textContent?.trim())).length,
    );
  expect(unnamed).toBe(0);
});
