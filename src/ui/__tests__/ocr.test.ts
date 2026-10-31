import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { recognizeImage, browserOcrAssets, OCR_FAILED } from '../lib/ocr';

const fixture = fileURLToPath(new URL('../../../e2e/fixtures/bill-photo.png', import.meta.url));
const langPath = fileURLToPath(
  new URL('../../../node_modules/@tesseract.js-data/eng/4.0.0_best_int', import.meta.url),
);

describe('local OCR', () => {
  it('reads text from a PNG with local assets and redacts it before returning', async () => {
    const r = await recognizeImage(new Uint8Array(readFileSync(fixture)), { langPath }, undefined, {
      cacheMethod: 'none',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toMatch(/Airtel/i);
    expect(r.text).toMatch(/599/);
    expect(r.text).not.toMatch(/ABCDE1234F/);
    expect(r.text).toContain('[PAN removed]');
    expect(r.redactions).toEqual(expect.arrayContaining([{ kind: 'pan', count: 1 }]));
  }, 60_000);

  it('returns an honest failure instead of throwing for an unreadable image', async () => {
    const r = await recognizeImage(new Uint8Array([1, 2, 3, 4]), { langPath }, undefined, {
      cacheMethod: 'none',
    });
    expect(r.ok).toBe(false);
  }, 60_000);

  it('gives up with an honest failure when the worker does not answer in time (e.g. WebAssembly blocked)', async () => {
    const r = await recognizeImage(new Uint8Array(readFileSync(fixture)), { langPath }, undefined, {
      timeoutMs: 1,
      cacheMethod: 'none',
    });
    expect(r).toEqual({ ok: false, reason: 'failed', message: OCR_FAILED });
  }, 60_000);

  it('browser assets point at our own origin, never a CDN', () => {
    const a = browserOcrAssets('/');
    for (const v of Object.values(a)) expect(v.startsWith('/ocr/')).toBe(true);
  });
});
