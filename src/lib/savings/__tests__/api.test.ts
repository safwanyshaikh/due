import { describe, expect, it, vi } from 'vitest';
import {
  fetchCommunity,
  fetchSavingsCatalog,
  parseSavingsCatalog,
  postReport,
  postResearch,
  roundReportInr,
  SAVINGS_CATALOG_CACHE_KEY,
  type SavingsFetchLike,
} from '..';
import { CATALOG, UBER_ONE } from './testCatalog';

function memStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}
const ok = (body: unknown, status = 200): ReturnType<SavingsFetchLike> =>
  Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) });

describe('savings api', () => {
  it('fetches the catalog from the relative path without credentials and caches it', async () => {
    const storage = memStorage();
    const fetchImpl = vi.fn<SavingsFetchLike>(() => ok(CATALOG));
    const r = await fetchSavingsCatalog({ base: '', fetchImpl, storage, now: () => 'T' });
    expect(r).toMatchObject({ ok: true, source: 'network', fetchedAt: 'T' });
    expect(r.catalog!.modules).toHaveLength(CATALOG.modules.length);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/public/savings/catalog');
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit' });
    expect(init.body).toBeUndefined();
    expect(storage.m.has(SAVINGS_CATALOG_CACHE_KEY)).toBe(true);
  });

  it('offline: falls back to the cached catalog, else none', async () => {
    const storage = memStorage();
    await fetchSavingsCatalog({ base: '', fetchImpl: () => ok(CATALOG), storage, now: () => 'T' });
    const off: SavingsFetchLike = () => Promise.reject(new Error('offline'));
    expect(await fetchSavingsCatalog({ base: '', fetchImpl: off, storage })).toMatchObject({
      ok: true,
      source: 'cache',
      fetchedAt: 'T',
    });
    expect(
      await fetchSavingsCatalog({ base: '', fetchImpl: () => ok({}, 500), storage: memStorage() }),
    ).toEqual({ ok: false, catalog: null, source: 'none', fetchedAt: null });
  });

  it('drops retired and malformed modules', () => {
    const c = parseSavingsCatalog({
      ...CATALOG,
      modules: [UBER_ONE, { ...UBER_ONE, id: 'x', status: 'retired' }, { id: 'bad' }],
    });
    expect(c!.modules.map((m) => m.id)).toEqual(['uber-one-in']);
    expect(parseSavingsCatalog({ modules: [] })).toBeNull();
  });

  it('postResearch sends only a cleaned label + category (+ city pack)', async () => {
    const fetchImpl = vi.fn<SavingsFetchLike>(() => ok({ status: 'queued' }));
    const r = await postResearch(
      { providerLabel: 'Acme Gym 98765 me@x.com', category: 'unknown', cityPack: 'in-mmr' },
      null,
      { base: '', fetchImpl },
    );
    expect(r).toEqual({ status: 'queued' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/public/savings/research');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body!)).toEqual({
      providerLabel: 'Acme Gym',
      category: 'unknown',
      cityPack: 'in-mmr',
    });
    expect(
      await postResearch({ providerLabel: '12345', category: 'unknown' }, null, {
        base: '',
        fetchImpl,
      }),
    ).toBeNull();
    expect(
      await postResearch({ providerLabel: 'Acme', category: 'unknown' }, null, {
        base: '',
        fetchImpl: () => Promise.reject(new Error('x')),
      }),
    ).toBeNull();
  });

  it('postReport rounds to ₹10 and fails soft', async () => {
    expect(roundReportInr(1347)).toBe(1350);
    expect(roundReportInr(3)).toBeNull();
    expect(roundReportInr(200_000)).toBeNull();
    const fetchImpl = vi.fn<SavingsFetchLike>(() => ok(null, 204));
    expect(
      await postReport(
        { moveKind: 'overlap', moduleId: 'uber-one-in', savedMonthlyInr: 49 },
        { base: '', fetchImpl },
      ),
    ).toBe(true);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body!)).toEqual({
      moveKind: 'overlap',
      moduleId: 'uber-one-in',
      savedMonthlyInr: 50,
    });
    expect(
      await postReport({ moveKind: 'overlap', savedMonthlyInr: 0 }, { base: '', fetchImpl }),
    ).toBe(false);
    expect(
      await postReport(
        { moveKind: 'overlap', savedMonthlyInr: 100 },
        { base: '', fetchImpl: () => Promise.reject(new Error('x')) },
      ),
    ).toBe(false);
  });

  it('fetchCommunity hides items below the threshold (never padded)', async () => {
    const fetchImpl = vi.fn<SavingsFetchLike>(() =>
      ok({
        threshold: 5,
        items: [
          {
            moveKind: 'overlap',
            moduleId: 'uber-one-in',
            label: 'Uber One',
            reports: 25,
            medianSavedMonthlyInr: 50,
          },
          {
            moveKind: 'period_switch',
            moduleId: null,
            label: 'Jio',
            reports: 19,
            medianSavedMonthlyInr: 80,
          },
        ],
      }),
    );
    const r = await fetchCommunity('in-mmr', { base: '', fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/public/savings/community?cityPack=in-mmr');
    expect(r).toEqual({
      threshold: 20,
      items: [expect.objectContaining({ label: 'Uber One', reports: 25 })],
    });
    expect(
      await fetchCommunity(null, { base: '', fetchImpl: () => Promise.reject(new Error('x')) }),
    ).toBeNull();
  });
});
