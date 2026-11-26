import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test.describe('landing', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/public/status', (r) =>
      r.fulfill({
        json: {
          incident: null,
          integrations: {
            smtp: 'live',
            inbound: 'not_configured',
            gmail: 'not_configured',
            billing: 'not_configured',
          },
          beta: { plusFree: true, endsOn: null },
          apps: {
            androidUrl: 'https://play.google.com/store/apps/details?id=example',
            iosUrl: null,
          },
        },
      }),
    );
  });

  test('signed-out first visit shows the landing on a phone, then Open Due goes to the start page', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 740 });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Same life. Smaller bills.' }),
    ).toBeVisible();
    await expect(page.getByTestId('beta-badge')).toHaveText('Free during beta');
    await expect(page.getByTestId('store-android')).toHaveText('Get it on Google Play');
    await expect(page.getByTestId('store-ios')).toHaveCount(0);
    await expect(page.getByTestId('landing-privacy')).toHaveText(
      'Your statements are read on your phone.',
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await expect(page.getByRole('link', { name: 'Privacy' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Terms' })).toBeVisible();
    await page.getByRole('link', { name: 'Start free, no sign-up' }).click();
    await expect(page.getByRole('heading', { name: 'How would you like to start?' })).toBeVisible();
  });

  test('serves SEO basics', async ({ page, request }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Same life\. Smaller bills\./);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute(
      'content',
      /subscriptions/,
    );
    await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
    const robots = await request.get('/robots.txt');
    expect(await robots.text()).toContain('Sitemap: https://due.karigarai.com/sitemap.xml');
    expect(await (await request.get('/sitemap.xml')).text()).toContain(
      '<loc>https://due.karigarai.com/</loc>',
    );
  });
});
