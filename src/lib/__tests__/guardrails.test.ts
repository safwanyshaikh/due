import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const root = process.cwd();
const src = walk(join(root, 'src')).filter(
  (f) => !f.includes('__tests__') && /\.(ts|tsx|css)$/.test(f),
);
const shipped = [
  ...src,
  join(root, 'index.html'),
  join(root, 'public/manifest.webmanifest'),
  join(root, 'public/sw.js'),
];
// The privacy page and the input blocklist name the things the app refuses to store.
const PRIVACY_COPY = /(content\/privacy|lib\/sensitive)\.ts$/;

const forbidden: [string, RegExp][] = [
  [
    'payment or redemption prompts',
    /pay\s*now|buy\s*now|redeem\s*(now|for\s*me)|guaranteed\s*saving|we found money|proceed to pay|checkout\s*(now|button|page)/i,
  ],
  [
    'payment initiation or payment SDKs',
    /upi:\/\/|from\s+['"](razorpay|paytm|phonepe|@juspay|cashfree)|createMandate|initiatePayment/i,
  ],
  ['broad SMS permission', /READ_SMS|RECEIVE_SMS|SEND_SMS|READ_CALL_LOG/],
  ['mailbox tokens', /oauth|access_token|refresh_token|gmail\.googleapis/i],
  ['credentials fields', /cvv|upi[\s_-]?pin|net[\s_-]?banking[\s_-]?password/i],
  ['scraping/automation', /whatsapp[\s-]?web|puppeteer|selenium|AccessibilityService/i],
];

describe('MVP guardrails', () => {
  for (const [name, re] of forbidden) {
    it(`shipped code contains no ${name}`, () => {
      const hits = shipped
        .filter((f) => !PRIVACY_COPY.test(f))
        .filter((f) => re.test(readFileSync(f, 'utf8')));
      expect(hits).toEqual([]);
    });
  }
  it('manifest requests no special permissions', () => {
    const m = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));
    expect(m.permissions).toBeUndefined();
  });
  it('has no network calls to third parties from app code', () => {
    const hits = src.filter((f) =>
      /\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(readFileSync(f, 'utf8')),
    );
    expect(hits).toEqual([]);
  });
});
