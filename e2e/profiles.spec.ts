import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/** Synthetic statement: two firms that repeat, a person who repeats, a known subscription. */
const STATEMENT = [
  '03/08/2026  NEFT CR-YESB0000001-PARTYCO INDUSTRIAL-REF100  45,000.00 Cr',
  '03/09/2026  NEFT CR-YESB0000001-PARTYCO INDUSTRIAL-REF200  38,000.00 Cr',
  '10/08/2026  IMPS/P2A/600000001/ABC ENTERPRISES LLP/HDFC0000001  12,000.00 Dr',
  '10/09/2026  IMPS/P2A/600000002/ABC ENTERPRISES LLP/HDFC0000001  12,500.00 Dr',
  '05/08/2026  NEFT/N0000001/RAVI KUMAR/SBIN0000001  5,000.00 Dr',
  '05/09/2026  NEFT/N0000002/RAVI KUMAR/SBIN0000001  5,000.00 Dr',
  '05/10/2026  UPI-AUTOPAY NETFLIX  649.00 Dr',
  '05/11/2026  UPI-AUTOPAY NETFLIX  649.00 Dr',
].join('\n');

async function offline(page: Page) {
  // No real server: Savings price data is unavailable, which the screens handle.
  await page.route('**/api/**', (r) => r.fulfill({ status: 503, body: '' }));
}

async function axeClean(page: Page) {
  const r = await new AxeBuilder({ page }).analyze();
  const bad = r.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  expect(bad).toEqual([]);
}

async function noSidewaysScroll(page: Page) {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over).toBeLessThanOrEqual(0);
}

/** Every visible button, radio label and link in the area is at least 48px tall. */
async function targets48(page: Page, selector: string) {
  const small = await page.$$eval(selector, (els) =>
    els
      .filter((e) => (e as HTMLElement).offsetParent !== null)
      .map((e) => ({ h: e.getBoundingClientRect().height, t: (e.textContent ?? '').trim() }))
      .filter((x) => x.h < 47.5),
  );
  expect(small).toEqual([]);
}

async function addDue(page: Page, name: string, amount: string, belongsTo?: string) {
  await page.goto('/#/add');
  await page.getByLabel('Who is it with?').fill(name);
  await page.getByLabel('Amount (₹)').fill(amount);
  if (belongsTo) await page.getByLabel('Belongs to').selectOption({ label: belongsTo });
  await page.getByRole('button', { name: 'Save due item' }).click();
  await expect(page.locator('[data-block="summary"]')).toBeVisible();
}

for (const [width, height] of [
  [360, 780],
  [1280, 900],
] as const) {
  test(`profiles at ${width}px: ask after import, add a business, filter Home`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await offline(page);
    await page.goto('/');
    await page.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('due:landing-opened', '1');
    });

    // Personal only: Home has no switcher.
    await page.goto('/#/');
    await expect(page.getByTestId('profile-switcher')).toHaveCount(0);

    // Statement import → one question at a time.
    await page.goto('/#/savings-import');
    await page.getByLabel('Or paste statement text').fill(STATEMENT);
    await page.getByRole('button', { name: 'Find repeat payments' }).click();
    const card = page.getByTestId('entity-question');
    await expect(card).toContainText(
      'We see regular payments with ‘PARTYCO INDUSTRIAL’. Is this your business?',
    );
    await expect(card).not.toContainText('RAVI KUMAR');
    await axeClean(page);
    await targets48(page, '[data-testid="entity-question"] button');

    await card.getByRole('button', { name: /Yes, I own\/run it/ }).click();
    await expect(card.getByText(/A registered company .* Its loans are the company’s/)).toBeVisible();
    await card.getByText('LLP', { exact: true }).click();
    await card.getByText('Designated partner', { exact: true }).click();
    await card
      .getByRole('group', { name: 'GST registered?' })
      .getByText('Yes', { exact: true })
      .click();
    await axeClean(page);
    await targets48(page, '[data-testid="entity-question"] .pf-choice');
    await card.getByRole('button', { name: 'Save business' }).click();

    await expect(card).toContainText('ABC ENTERPRISES LLP');
    await card.getByRole('button', { name: /Not mine/ }).click();
    await expect(page.getByTestId('entity-question')).toHaveCount(0);
    await noSidewaysScroll(page);

    // Dues in both profiles.
    await addDue(page, 'Netflix', '649');
    await addDue(page, 'Office internet', '1180', 'PARTYCO INDUSTRIAL · LLP');

    // Home: All · Personal · PARTYCO INDUSTRIAL.
    const sw = page.getByTestId('profile-switcher');
    await expect(sw.getByRole('radio')).toHaveText(['All', 'Personal', 'PARTYCO INDUSTRIAL']);
    await targets48(page, '[data-testid="profile-switcher"] button');
    await sw.getByRole('radio', { name: 'PARTYCO INDUSTRIAL' }).click();
    const summary = page.locator('[data-block="summary"]');
    await expect(summary).toContainText('Office internet');
    await expect(summary).not.toContainText('Netflix');
    await expect(page.getByTestId('profile-scope-note')).toContainText('LLP');
    await noSidewaysScroll(page);
    await axeClean(page);
    // The tiles still start in the first viewport.
    const tile = await page.locator('[data-tile="subscription"]').boundingBox();
    expect(tile!.y).toBeLessThan(height);

    await sw.getByRole('radio', { name: 'Personal' }).click();
    await expect(summary).toContainText('Netflix');

    // Savings has the same filter, and remembers the choice.
    await page.goto('/#/savings');
    await expect(
      page.getByTestId('profile-switcher').getByRole('radio', { name: 'Personal' }),
    ).toHaveAttribute('aria-checked', 'true');
    await axeClean(page);

    // Settings → Profiles: totals, the answered name, Free limit note.
    await page.goto('/#/settings');
    await page.getByRole('link', { name: /Profiles: personal and business/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Profiles');
    await expect(page.locator('[data-profile-card]')).toHaveCount(2);
    await expect(page.getByText('Names you answered')).toBeVisible();
    await expect(page.getByText(/Free includes Personal and one business/)).toBeVisible();
    await targets48(page, '.pf-page button, .pf-page select, .pf-page a.btn');
    await noSidewaysScroll(page);
    await axeClean(page);
  });
}
