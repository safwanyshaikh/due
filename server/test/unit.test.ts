import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { extractFeed, extractHtml, extractJson, extractSitemap } from '../src/monitor/extract.js';
import { isPrivateAddress } from '../src/monitor/net.js';
import { csvCell } from '../src/routes/admin/exportRoutes.js';
import { lineDiff } from '../src/routes/admin/sources.js';
import { createPool } from '../src/db.js';
import { makeApp, TEST_DB } from './helpers.js';

describe('extraction', () => {
  it('html: title + visible text without script/style/nav', () => {
    const r = extractHtml('<html><head><title> Hi  there </title><style>a{}</style></head><body><nav>menu</nav><h1>Head</h1><p>Para <b>bold</b></p><script>x()</script></body></html>');
    expect(r).toEqual({ title: 'Hi there', text: 'Head\nPara bold' });
    expect(() => extractHtml('<p>x</p>', '#missing')).toThrow(/matched nothing/);
  });
  it('atom feeds', () => {
    const r = extractFeed(
      '<feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><entry><title>E1</title><link rel="alternate" href="/e1"/><updated>2026-10-01T00:00:00Z</updated><summary>S</summary></entry></feed>',
      'https://x.example/feed',
    );
    expect(r.items).toEqual([{ title: 'E1', link: 'https://x.example/e1', pubDate: '2026-10-01T00:00:00.000Z', summary: 'S' }]);
  });
  it('json and sitemap', () => {
    expect(extractJson('{"b":2,"a":1}').text).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(extractSitemap('<urlset><url><loc>https://x/a</loc><lastmod>2026-01-01</lastmod></url><url><loc>https://x/b</loc></url></urlset>').text).toBe(
      'https://x/a 2026-01-01\nhttps://x/b',
    );
  });
});

describe('helpers', () => {
  it('line diff is multiset-aware', () => {
    expect(lineDiff('a\nb\nb', 'b\nc')).toEqual({ added: ['c'], removed: ['a', 'b'] });
  });
  it('csv cells are quoted and neutralise formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell(null)).toBe('');
  });
  it('private address detection', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });
  it('scrypt hashes verify and differ per salt', async () => {
    const a = await hashPassword('a long password!!');
    const b = await hashPassword('a long password!!');
    expect(a).not.toBe(b);
    expect(await verifyPassword('a long password!!', a)).toBe(true);
    expect(await verifyPassword('wrong', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('admin SPA serving', () => {
  it('serves admin/dist at /admin/ with SPA fallback and admin CSP', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'due-admin-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Admin</title>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
    const pool = createPool(TEST_DB, 2);
    const app = await makeApp(pool, { env: { ADMIN_DIST: dir } });
    const root = await app.inject({ method: 'GET', url: '/admin/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>Admin</title>');
    expect(root.headers['content-security-policy']).toContain("script-src 'self'");
    expect(root.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect((await app.inject({ method: 'GET', url: '/admin/companies/123' })).body).toContain('<title>Admin</title>');
    const js = await app.inject({ method: 'GET', url: '/admin/assets/app.js' });
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect((await app.inject({ method: 'GET', url: '/admin' })).body).toContain('<title>Admin</title>');
    expect((await app.inject({ method: 'GET', url: '/api/unknown' })).statusCode).toBe(404);
    await app.close();
    await pool.end();
  });
});

describe('config', () => {
  it('treats empty optional URLs (unset Render sync:false variables) as not set', async () => {
    const { loadConfig } = await import('../src/config.js');
    const base = { DATABASE_URL: 'postgres://x', SESSION_SECRET: 'x'.repeat(32) };
    expect(loadConfig({ ...base, PUBLIC_BASE_URL: '', RENDER_EXTERNAL_URL: 'https://due.onrender.com' }).publicBaseUrl).toBe('https://due.onrender.com');
    expect(loadConfig({ ...base, PUBLIC_BASE_URL: 'https://due.example.com/' }).publicBaseUrl).toBe('https://due.example.com');
    expect(loadConfig({ ...base, PUBLIC_BASE_URL: ' ' }).publicBaseUrl).toBeNull();
  });
});
