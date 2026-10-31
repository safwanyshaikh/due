import { expect, test, type Page } from '@playwright/test';
import { addGuestObligation, TILE_NAMES, TILE_ORDER } from './helpers';

async function box(page: Page, sel: string) {
  const b = await page.locator(sel).first().boundingBox();
  expect(b, sel).not.toBeNull();
  return b!;
}

test.describe('Home first viewport at 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('summary card and the first row of tiles are fully visible, tiles in launch order', async ({
    page,
  }) => {
    await addGuestObligation(page);
    await page.reload();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const top = await box(page, '[data-block="topbar"]');
    const header = await box(page, '[data-block="header"]');
    const summary = await box(page, '[data-block="summary"]');
    expect(top.height).toBeLessThanOrEqual(58);
    expect(header.y).toBeGreaterThanOrEqual(top.y + top.height - 1);
    expect(summary.y).toBeGreaterThanOrEqual(header.y + header.height - 1);
    expect(summary.y + summary.height, 'summary card inside first viewport').toBeLessThanOrEqual(
      844,
    );

    const keys = await page
      .locator('[data-tile]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.tile));
    expect(keys).toEqual([...TILE_ORDER]);
    const names = await page.locator('[data-tile] .htile-name').allTextContents();
    expect(names).toEqual([...TILE_NAMES]);

    const first = await box(page, '[data-tile="subscription"]');
    const second = await box(page, '[data-tile="emi"]');
    expect(first.y).toBeGreaterThan(summary.y + summary.height);
    expect(Math.abs(first.y - second.y), 'first row shares a line').toBeLessThanOrEqual(1);
    for (const b of [first, second]) {
      expect(b.y + b.height, 'first row of tiles fully visible').toBeLessThanOrEqual(844);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(390);
    }
    // Mobile page padding 16–20px.
    expect(summary.x).toBeGreaterThanOrEqual(16);
    expect(summary.x).toBeLessThanOrEqual(20);

    const card = page.locator('[data-block="summary"]');
    await expect(card).toContainText('Netflix');
    await expect(card).toContainText('₹649');
    await expect(card).toContainText('Date entered by you');
    await expect(card.getByRole('button', { name: /^Review/ })).toBeVisible();
    await expect(card.getByRole('button', { name: /^Snooze/ })).toBeVisible();
    await expect(card.getByRole('link', { name: /^Edit/ })).toBeVisible();
    await page.screenshot({ path: 'e2e/__screenshots__/home-first-viewport-390.png' });
  });

  test('empty Home still starts the tiles inside the first viewport, with first-use choices', async ({
    page,
  }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    const first = await box(page, '[data-tile="subscription"]');
    expect(first.y + first.height).toBeLessThanOrEqual(844);
    await expect(page.locator('[data-choice]')).toHaveCount(5);
    await expect(page.locator('[data-tile="emi"]')).toContainText('Add an EMI');
  });

  test('a tile opens its category view', async ({ page }) => {
    await addGuestObligation(page);
    await page.locator('[data-tile="subscription"]').click();
    await expect(page).toHaveURL(/#\/all\/subscription$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Subscriptions');
  });

  test('every visible interactive element is at least 48×48', async ({ page }) => {
    await addGuestObligation(page);
    await page.reload();
    const small = await page.evaluate(() => {
      const els = Array.from(
        document.querySelectorAll<HTMLElement>(
          'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button]',
        ),
      );
      return els
        .filter((el) => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden')
            return false;
          if (el.closest('.sr-only') || el.classList.contains('skip')) return false;
          return r.width < 47.5 || r.height < 47.5;
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40);
          return `${el.tagName} "${label}" ${Math.round(r.width)}×${Math.round(r.height)}`;
        });
    });
    expect(small).toEqual([]);
  });

  test('keyboard Tab reaches Review, Snooze, Edit and then the tiles in order', async ({
    page,
  }) => {
    await addGuestObligation(page);
    await page.reload();
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      seen.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return el?.dataset.tile
            ? `tile:${el.dataset.tile}`
            : (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim();
        }),
      );
    }
    const order = [
      /^Review Netflix/,
      /^Snooze Netflix/,
      /^Edit Netflix/,
      ...TILE_ORDER.map((t) => new RegExp(`^tile:${t}$`)),
    ].map((re) => seen.findIndex((n) => re.test(n)));
    for (const i of order) expect(i, seen.join(' | ')).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });
});

test.describe('jelly interaction and reduced motion', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function pressedTransform(page: Page, sel: string) {
    const el = page.locator(sel).first();
    const b = (await el.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    const t = await el.evaluate((e) => getComputedStyle(e).transform);
    await page.mouse.up();
    // A completed press may navigate or open a sheet; let that settle before the next step.
    await page.waitForTimeout(300);
    return t;
  }
  const scaleOf = (t: string) => Number(/matrix\(([^,]+)/.exec(t)?.[1] ?? '1');

  test('tiles and primary buttons scale to 0.97–0.985 while pressed', async ({ page }) => {
    await addGuestObligation(page);
    await page.reload();
    const ms = await page
      .locator('[data-tile="emi"]')
      .evaluate((e) => getComputedStyle(e).transitionDuration.split(',')[0].trim());
    const release = parseFloat(ms) * (ms.endsWith('ms') ? 1 : 1000);
    expect(release).toBeGreaterThanOrEqual(180);
    expect(release).toBeLessThanOrEqual(260);
    // The summary button first (it opens a sheet), then the tile (it navigates).
    for (const sel of ['[data-block="summary"] button.btn-primary', '[data-tile="emi"]']) {
      await page.keyboard.press('Escape');
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      const s = scaleOf(await pressedTransform(page, sel));
      expect(s, sel).toBeGreaterThanOrEqual(0.97);
      expect(s, sel).toBeLessThanOrEqual(0.985);
    }
  });

  test('prefers-reduced-motion removes the transform', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addGuestObligation(page);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/reduce-motion/);
    expect(await pressedTransform(page, '[data-block="summary"] button.btn-primary')).toBe('none');
    await page.keyboard.press('Escape');
    await page.goto('/#/');
    expect(await pressedTransform(page, '[data-tile="emi"]')).toBe('none');
  });

  test('the in-app Reduce motion setting removes the transform and persists', async ({ page }) => {
    await addGuestObligation(page);
    await page.goto('/#/settings');
    await page.getByLabel(/Reduce motion/).check();
    await page.goto('/#/');
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/reduce-motion/);
    expect(await pressedTransform(page, '[data-tile="emi"]')).toBe('none');
    // Without the setting (and without the media query), the same press does scale.
    await page.evaluate(() => localStorage.removeItem('due:reduce-motion'));
    await page.goto('/#/');
    await page.reload();
    await expect(page.locator('html')).not.toHaveClass(/reduce-motion/);
  });
});

test.describe('document intake', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a PNG bill is read on-device with self-hosted OCR assets and redacted', async ({
    page,
  }) => {
    const foreign: string[] = [];
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (!['localhost', '127.0.0.1'].includes(u.hostname) && u.protocol.startsWith('http'))
        foreign.push(r.url());
    });
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.goto('/#/upload');
    await expect(page.getByTestId('upload-remaining')).toContainText('5 of 5');
    await page
      .getByLabel('Choose a PDF, JPG, PNG or TXT file')
      .setInputFiles('e2e/fixtures/bill-photo.png');
    await expect(page.getByText(/with on-device text recognition/)).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(/Masked before reading:.*pan/i)).toBeVisible();
    await expect(page.locator('body')).not.toContainText('ABCDE1234F');
    expect(foreign).toEqual([]);
    await page.reload();
    await expect(page.getByTestId('upload-remaining')).toContainText('4 of 5');
  });
});
