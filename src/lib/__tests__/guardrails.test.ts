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
// The read-only Gmail connector (LAUNCH_SPEC) is the one sanctioned place that names Google OAuth.
const GMAIL_WRAPPER = /lib\/account\/gmail\.ts$/;

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
        .filter((f) => !(name === 'mailbox tokens' && GMAIL_WRAPPER.test(f)))
        .filter((f) => re.test(readFileSync(f, 'utf8')));
      expect(hits).toEqual([]);
    });
  }
  it('manifest requests no special permissions', () => {
    const m = JSON.parse(readFileSync(join(root, 'public/manifest.webmanifest'), 'utf8'));
    expect(m.permissions).toBeUndefined();
  });
  it('makes network calls only from Due’s own API clients', () => {
    const hits = src.filter((f) =>
      /\bfetch\b|XMLHttpRequest|WebSocket|sendBeacon|EventSource/.test(readFileSync(f, 'utf8')),
    );
    expect(hits.map((f) => f.slice(root.length + 1)).sort()).toEqual([
      'src/lib/account/client.ts',
      'src/lib/account/identities.ts',
      'src/lib/offers/api.ts',
    ]);
  });
  it('the account client only calls Due’s own relative /api paths', () => {
    const c = readFileSync(join(root, 'src/lib/account/client.ts'), 'utf8');
    expect(c).not.toMatch(/https?:\/\/[a-z0-9]/i);
    expect(c).toContain('due-app');
  });
  it('the API client only calls Due’s own public catalog endpoint, without credentials', () => {
    const api = readFileSync(join(root, 'src/lib/offers/api.ts'), 'utf8');
    expect(api).toContain("CATALOG_PATH = '/api/public/catalog'");
    expect(api).toContain("credentials: 'omit'");
    expect(api).not.toMatch(/https?:\/\/[a-z0-9]/i);
    expect(api).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/);
  });
});

// Mock, sample and demo data must never reach production code paths.
const NO_MOCKS: [string, RegExp][] = [
  [
    'imports of sample/demo/mock/fixture modules',
    /from\s+['"][^'"]*(sample|demo|mock|fixture)[^'"]*['"]/i,
  ],
  ['demo labels', /\(demo\)|demo data|demo only|turn on \(demo|\bdemo:/i],
  [
    'sample-data wording',
    /sample data|sample row data|buildSampleData|sampleRelay|removeSampleData/i,
  ],
  [
    'a bundled offer catalog',
    /buildCatalog|offers\/catalog['"]|snapshotAdapter|research snapshot\)/i,
  ],
  ['fake source re-checks', /check sources again/i],
];
// The one-time migration must name the legacy flag to remove flagged records.
const MIGRATION = /lib\/migrate\.ts$/;

describe('no mock or demo data in production code', () => {
  const files = walk(join(root, 'src')).filter(
    (f) => !f.includes('__tests__') && /\.(ts|tsx|css|html)$/.test(f),
  );
  for (const [name, re] of NO_MOCKS) {
    it(`src contains no ${name}`, () => {
      const hits = [...files, join(root, 'index.html')].filter((f) =>
        re.test(readFileSync(f, 'utf8')),
      );
      expect(hits).toEqual([]);
    });
  }
  it('only the migration refers to the legacy isSample flag', () => {
    const hits = files.filter(
      (f) => !MIGRATION.test(f) && /isSample/.test(readFileSync(f, 'utf8')),
    );
    expect(hits).toEqual([]);
  });
  it('the sample and catalog modules are gone', () => {
    const names = files.map((f) => f.slice(root.length + 1));
    expect(names).not.toContain('src/lib/sample.ts');
    expect(names).not.toContain('src/lib/offers/catalog.ts');
    expect(names).not.toContain('src/lib/offers/refresh.ts');
  });
});
