import { expect, test, type Page } from '@playwright/test';
import { addGuestObligation } from './helpers';

/**
 * Mobile audit at the two phone sizes the native apps are tested on. Same web UI as the PWA; these checks
 * catch what breaks first inside a WebView: sideways scroll, small targets, hover-only controls, safe areas.
 */
const SIZES = [
  [360, 800],
  [390, 844],
] as const;

const PAGES = [
  '#/',
  '#/all',
  '#/add',
  '#/start',
  '#/upload',
  '#/import',
  '#/connections',
  '#/reminders',
  '#/plans',
  '#/legal',
  '#/account',
  '#/settings',
  '#/offers',
  '#/savings',
  '#/calendar',
  '#/profiles',
];

const MIN = 48;

/** Visible interactive elements smaller than 48px in either direction (inline text links are exempt). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    const out: string[] = [];
    const sel =
      'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch]';
    for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      if (el.closest('[hidden], [aria-hidden=true], .sr-only')) continue;
      if (el.classList.contains('sr-only') || el.classList.contains('skip')) continue;
      const input = el as HTMLInputElement;
      // A visually hidden file/checkbox input is represented by its (measured) label.
      if (el.tagName === 'INPUT' && /sr-only/.test(el.className)) continue;
      // Inline links inside running text are exempt (WCAG 2.5.8 inline exception).
      if (
        el.tagName === 'A' &&
        cs.display === 'inline' &&
        (el.parentElement?.textContent ?? '').trim().length >
          (el.textContent ?? '').trim().length + 3
      )
        continue;
      // Checkbox/radio are measured through their label when wrapped by one.
      const box =
        input.type === 'checkbox' || input.type === 'radio'
          ? (el.closest('label') ?? el).getBoundingClientRect()
          : el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.width < min - 0.5 || box.height < min - 0.5) {
        const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30);
        out.push(
          `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} "${label}" ${Math.round(box.width)}x${Math.round(box.height)}`,
        );
      }
    }
    return out;
  }, MIN);
}

for (const [width, height] of SIZES) {
  test.describe(`mobile ${width}x${height}`, () => {
    test.use({ viewport: { width, height }, hasTouch: true, isMobile: true });

    test('no horizontal scroll on any page', async ({ page }) => {
      await addGuestObligation(page);
      for (const hash of PAGES) {
        await page.goto(`/${hash}`);
        await page.waitForTimeout(150);
        const o = await page.evaluate(() => ({
          sw: document.documentElement.scrollWidth,
          cw: document.documentElement.clientWidth,
        }));
        expect(o.sw, `${hash}: scrollWidth ${o.sw} > ${o.cw}`).toBeLessThanOrEqual(o.cw);
      }
    });

    test('every tap target is at least 48px', async ({ page }) => {
      await addGuestObligation(page);
      for (const hash of PAGES) {
        await page.goto(`/${hash}`);
        await page.waitForTimeout(150);
        expect(await smallTargets(page), hash).toEqual([]);
      }
    });
  });
}

test('no control is hover-only (nothing is revealed by :hover alone)', async ({ page }) => {
  await page.goto('/');
  const offenders = await page.evaluate(() => {
    const bad: string[] = [];
    const visit = (rules: CSSRuleList) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule && r.selectorText.includes(':hover')) {
          const s = r.style;
          const reveals =
            s.display === 'block' ||
            s.display === 'flex' ||
            s.display === 'inline-block' ||
            s.visibility === 'visible' ||
            s.opacity === '1' ||
            s.pointerEvents === 'auto';
          // Only a rule that flips a hidden thing visible matters; ones that tint or lift are fine.
          if (reveals) bad.push(r.selectorText);
        } else if ('cssRules' in r) {
          visit((r as CSSGroupingRule).cssRules);
        }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        visit(sheet.cssRules);
      } catch {
        /* cross-origin sheet */
      }
    }
    return bad;
  });
  expect(offenders).toEqual([]);
});

test('safe-area insets pad the shell, the top bar and fixed bottom UI', async ({ page }) => {
  await page.goto('/');
  const css = await page.evaluate(async () => {
    const texts: string[] = [];
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        texts.push(
          Array.from(sheet.cssRules)
            .map((r) => r.cssText)
            .join('\n'),
        );
      } catch {
        /* ignore */
      }
    }
    return texts.join('\n');
  });
  expect(css).toContain('safe-area-inset-top');
  expect(css).toContain('safe-area-inset-bottom');
  expect(css).toContain('safe-area-inset-left');
  expect(css).toContain('safe-area-inset-right');
  expect(await page.locator('meta[name=viewport]').getAttribute('content')).toContain(
    'viewport-fit=cover',
  );
});
