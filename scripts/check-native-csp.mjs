/* global process, console */
/**
 * CI check (round-2 M10): the native (Capacitor) build must carry its Content Security Policy in index.html,
 * because inside the app's WebView no server sends the header. Fails when the meta tag is missing or weaker.
 *   npx vite build --mode native --outDir dist-native && node scripts/check-native-csp.mjs dist-native
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'dist';
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
const fail = (msg) => {
  console.error(`native CSP check failed: ${msg}`);
  process.exit(1);
};
if (!m) fail('no <meta http-equiv="Content-Security-Policy"> in index.html');
const d = Object.fromEntries(m[1].split(';').map((p) => p.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
if (!d['default-src']?.includes("'self'") || d['default-src'].length !== 1) fail("default-src must be 'self' only");
if ((d['script-src'] ?? []).some((v) => v === "'unsafe-inline'" || v === "'unsafe-eval'" || v.startsWith('http'))) fail('script-src allows inline/eval or remote scripts');
if (!d['object-src']?.includes("'none'")) fail("object-src must be 'none'");
const connect = d['connect-src'] ?? [];
if (connect.some((v) => v !== "'self'" && !/^https:\/\/[a-z0-9.-]+$/i.test(v))) fail(`connect-src may list only 'self' and https origins: ${connect.join(' ')}`);
console.log(`native CSP ok: ${m[1]}`);
