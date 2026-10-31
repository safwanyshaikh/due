import { expect, type Page } from '@playwright/test';

/** Guest path: Home → Add manually → save one obligation → back on Home with the summary card. */
export async function addGuestObligation(page: Page, name = 'Netflix', amount = '649') {
  await page.goto('/');
  await page.evaluate(() => localStorage.clear());
  await page.goto('/#/add');
  await page.getByLabel('Who is it with?').fill(name);
  await page.getByLabel('Amount (₹)').fill(amount);
  await page.getByRole('button', { name: 'Save due item' }).click();
  await expect(page.locator('[data-block="summary"]')).toContainText(name);
}

export const TILE_ORDER = [
  'subscription',
  'emi',
  'credit_card',
  'other_loan',
  'bill',
  'school_fee',
  'offers',
  'seasons',
] as const;

export const TILE_NAMES = [
  'Subscriptions',
  'EMIs',
  'Credit cards',
  'Other loans',
  'Bills & essentials',
  'School fees',
  'Due & Offers',
  'Seasonal plans',
] as const;
