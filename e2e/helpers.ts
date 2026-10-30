import { expect, type Page } from '@playwright/test';

/** Guest path: landing → See my next due date → Add manually → save one obligation. */
export async function addGuestObligation(page: Page, name = 'Netflix', amount = '649') {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/');
  await page.getByRole('link', { name: 'See my next due date' }).click();
  await page.getByRole('link', { name: /Add manually/ }).click();
  await page.getByLabel('Who is it with?').fill(name);
  await page.getByLabel('Amount (₹)').fill(amount);
  await page.getByRole('button', { name: 'Save due item' }).click();
  await expect(page.locator('[data-block="hero"]')).toBeVisible();
}

export const BLOCKS = ['topbar', 'header', 'hero', 'strip', 'timeline', 'actions'] as const;
