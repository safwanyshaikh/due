import { expect, test, type Page } from '@playwright/test';
import { addGuestObligation, BLOCKS } from './helpers';

test.describe('Home first viewport at 390×844', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a guest adds one obligation and sees the six blocks in order with spec heights', async ({
    page,
  }) => {
    await addGuestObligation(page);
    await page.reload();
    const boxes: { name: string; x: number; y: number; width: number; height: number }[] = [];
    for (const b of BLOCKS) {
      const box = await page.locator(`[data-block="${b}"]`).boundingBox();
      expect(box, b).not.toBeNull();
      boxes.push({ name: b, ...box! });
    }
    for (let i = 1; i < boxes.length; i++)
      expect(boxes[i].y, `${boxes[i].name} below ${boxes[i - 1].name}`).toBeGreaterThanOrEqual(
        boxes[i - 1].y + boxes[i - 1].height - 1,
      );
    const h = Object.fromEntries(boxes.map((b) => [b.name, b.height]));
    expect(Math.abs(h.topbar - 56)).toBeLessThanOrEqual(2);
    expect(Math.abs(h.header - 56)).toBeLessThanOrEqual(2);
    expect(h.hero).toBeGreaterThanOrEqual(176);
    expect(Math.abs(h.strip - 72)).toBeLessThanOrEqual(2);
    expect(h.timeline).toBeGreaterThanOrEqual(180);
    expect(h.timeline).toBeLessThanOrEqual(220);
    expect(Math.abs(h.actions - 64)).toBeLessThanOrEqual(2);
    const last = boxes[boxes.length - 1];
    expect(last.y + last.height, 'all six blocks fit the first viewport').toBeLessThanOrEqual(844);

    const hero = page.locator('[data-block="hero"]');
    const geo = await hero.evaluate((el) => {
      const s = getComputedStyle(el);
      return { r: s.borderTopLeftRadius, p: s.paddingTop };
    });
    expect(geo).toEqual({ r: '24px', p: '20px' });
    await expect(page.locator('.ctile')).toHaveCount(0);
    await expect(hero).toContainText('Netflix');
    await expect(hero).toContainText('₹649');
    await expect(hero).toContainText('Date entered by you');
    await expect(hero.getByRole('button', { name: /^Review/ })).toBeVisible();
    await expect(hero.getByRole('button', { name: /^Snooze/ })).toBeVisible();
    await expect(hero.getByRole('link', { name: /^Edit/ })).toBeVisible();
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

  test('keyboard Tab reaches Review, Snooze, Edit, Add due item, Import in order', async ({
    page,
  }) => {
    await addGuestObligation(page);
    await page.reload();
    const names: string[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      names.push(
        await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          return (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim();
        }),
      );
    }
    const order = [
      /^Review Netflix/,
      /^Snooze Netflix/,
      /^Edit Netflix/,
      /Add due item/,
      /^Import$/,
    ].map((re) => names.findIndex((n) => re.test(n)));
    for (const i of order) expect(i, names.join(' | ')).toBeGreaterThanOrEqual(0);
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThan(order[i - 1]);
  });
});

test.describe('reduced motion', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  async function pressedTransform(page: Page) {
    const btn = page.locator('[data-block="hero"]').getByRole('button', { name: /^Review/ });
    const box = (await btn.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    const t = await btn.evaluate((el) => getComputedStyle(el).transform);
    await page.mouse.up();
    return t;
  }

  test('press scales to 0.985 normally', async ({ page }) => {
    await addGuestObligation(page);
    await page.reload();
    expect(await pressedTransform(page)).toContain('0.985');
  });

  test('prefers-reduced-motion removes the transform', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await addGuestObligation(page);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/reduce-motion/);
    expect(await pressedTransform(page)).toBe('none');
  });
});
