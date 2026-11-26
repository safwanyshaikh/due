import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Loads public/sw.js with a fake service-worker global and returns its fetch handler. */
function loadWorker() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const put: string[] = [];
  const cache = { put: (req: { url: string }) => put.push(req.url), addAll: async () => undefined };
  const self = {
    location: { origin: 'https://due.example' },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    skipWaiting: () => undefined,
    clients: { claim: () => undefined },
  };
  const caches = { open: async () => cache, match: async () => undefined, keys: async () => [] };
  const fetchFn = async () => ({ ok: true, clone: () => ({}) });
  const src = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8');
  new Function('self', 'caches', 'fetch', src)(self, caches, fetchFn);
  const run = async (url: string) => {
    let p: Promise<unknown> | null = null;
    listeners.fetch!({ request: { url, method: 'GET' }, respondWith: (x: Promise<unknown>) => (p = x) });
    await p;
    await new Promise((r) => setTimeout(r, 0));
  };
  return { run, put };
}

describe('service worker (L1)', () => {
  it('never caches a URL with a query string (tokens), but caches the app shell', async () => {
    const w = loadWorker();
    await w.run('https://due.example/?account=confirm&token=SECRETSECRETSECRET');
    await w.run('https://due.example/?household_invite=SECRETSECRETSECRET');
    await w.run('https://due.example/assets/app.js');
    expect(w.put).toEqual(['https://due.example/assets/app.js']);
  });
});
