// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MeResponse, SyncDocument } from '../../lib/account/types';
import { AccountApiError } from '../../lib/account/client';
import { reconcileAction } from '../../lib/account/sync';
import { STORAGE_KEY, CORRUPT_BACKUP_PREFIX } from '../../lib/storage';
import type { AppData } from '../../lib/types';
import { App } from '../App';
import { dataWithOne, fakeClient, stubNetwork } from './harness';

beforeEach(() => {
  stubNetwork();
  localStorage.clear();
  window.location.hash = '#/account';
});
afterEach(cleanup);

const ME: MeResponse = {
  account: {
    id: 'a1',
    email: 'me@example.com',
    displayName: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastLoginAt: null,
  },
  sessionId: 's1',
  entitlements: {
    plan: 'free',
    status: 'active',
    billingPeriod: null,
    periodEnd: null,
    channel: null,
    features: ['backup'],
    householdAccess: null,
  },
};

const pref = (p: object) => localStorage.setItem('due:sync:a1', JSON.stringify(p));
const doc = (version: number, data: AppData | null): SyncDocument<AppData> => ({
  version,
  data,
  updatedAt: data ? '2026-10-30T08:00:00.000Z' : null,
});

describe('reconcileAction', () => {
  it('adopts a newer server copy only when this device has no unsynced changes', () => {
    const base = { serverHasData: true, lastSyncedVersion: 3 };
    expect(reconcileAction({ ...base, serverVersion: 3, dirty: false })).toBe('none');
    expect(reconcileAction({ ...base, serverVersion: 3, dirty: true })).toBe('push');
    expect(reconcileAction({ ...base, serverVersion: 5, dirty: false })).toBe('adopt');
    expect(reconcileAction({ ...base, serverVersion: 5, dirty: true })).toBe('conflict');
    // Server behind this device (account data reset): empty → upload, other data → ask.
    expect(
      reconcileAction({
        serverHasData: false,
        lastSyncedVersion: 3,
        serverVersion: 0,
        dirty: false,
      }),
    ).toBe('push');
    expect(reconcileAction({ ...base, serverVersion: 1, dirty: false })).toBe('conflict');
  });
});

describe('sync on app start', () => {
  it('adopts the server copy when it is newer and this device is unchanged since the last sync', async () => {
    pref({ on: true, version: 2, lastSyncedAt: '2026-10-29T00:00:00.000Z', dirty: false });
    const server = dataWithOne('Spotify', 11_900);
    const putData = vi.fn();
    const client = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () => Promise.resolve({ current: {}, history: [] }),
      getData: () => Promise.resolve(doc(4, server)),
      putData,
      listSessions: () => Promise.resolve([]),
    });
    render(<App client={client} initialData={dataWithOne('Netflix')} />);
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('due:sync:a1')!)).toMatchObject({
        version: 4,
        dirty: false,
      }),
    );
    window.location.hash = '#/all';
    expect(await screen.findByText(/Spotify/)).toBeTruthy();
    expect(screen.queryByText(/Netflix/)).toBeNull();
    expect(putData).not.toHaveBeenCalled();
  });

  it('shows the conflict sheet when both the server and this device changed', async () => {
    pref({ on: true, version: 2, lastSyncedAt: '2026-10-29T00:00:00.000Z', dirty: true });
    const client = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () => Promise.resolve({ current: {}, history: [] }),
      getData: () => Promise.resolve(doc(4, dataWithOne('Spotify', 11_900))),
      putData: vi.fn(),
      listSessions: () => Promise.resolve([]),
    });
    render(<App client={client} initialData={dataWithOne('Netflix')} />);
    expect(await screen.findByText('Two versions of your data')).toBeTruthy();
  });

  it('pushes local changes when the server has not moved', async () => {
    pref({ on: true, version: 4, lastSyncedAt: '2026-10-29T00:00:00.000Z', dirty: true });
    const putData = vi.fn(() => Promise.resolve({ version: 5, updatedAt: '2026-10-30T09:00:00Z' }));
    const client = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () => Promise.resolve({ current: {}, history: [] }),
      getData: () => Promise.resolve(doc(4, dataWithOne('Spotify', 11_900))),
      putData,
      listSessions: () => Promise.resolve([]),
    });
    render(<App client={client} initialData={dataWithOne('Netflix')} />);
    await waitFor(() => expect(putData).toHaveBeenCalledTimes(1));
    expect((putData.mock.calls[0] as unknown[])[0]).toBe(4);
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem('due:sync:a1')!)).toMatchObject({
        version: 5,
        dirty: false,
      }),
    );
  });

  it('keeps unreadable local data aside, offers an export, and never syncs over it', async () => {
    const raw = '{"version":2,"commitments":[{"id":"x"'; // truncated write
    localStorage.setItem(STORAGE_KEY, raw);
    pref({ on: true, version: 2, lastSyncedAt: null, dirty: false });
    const getData = vi.fn(() => Promise.resolve(doc(4, dataWithOne('Spotify'))));
    const putData = vi.fn();
    const client = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () => Promise.resolve({ current: {}, history: [] }),
      getData,
      putData,
      listSessions: () => Promise.resolve([]),
    });
    render(<App client={client} />);
    expect(await screen.findByText(/saved data on this device couldn’t be read/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export the kept copy' })).toBeTruthy();
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(CORRUPT_BACKUP_PREFIX));
    expect(keys).toHaveLength(1);
    expect(localStorage.getItem(keys[0])).toBe(raw);
    expect(await screen.findByText('Paused')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(getData).not.toHaveBeenCalled();
    expect(putData).not.toHaveBeenCalled();

    // Removing the kept copy (after exporting it) resumes sync.
    fireEvent.click(screen.getByRole('button', { name: 'Remove the kept copy' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove it' }));
    await waitFor(() => expect(getData).toHaveBeenCalled());
    expect(Object.keys(localStorage).some((k) => k.startsWith(CORRUPT_BACKUP_PREFIX))).toBe(false);
  });
});

describe('consents take effect in the app', () => {
  it('does not resume sync when the backup consent was withdrawn (on any device)', async () => {
    pref({ on: true, version: 2, lastSyncedAt: null, dirty: true });
    const getData = vi.fn();
    const client = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () =>
        Promise.resolve({
          current: { sync_backup: { granted: false, textVersion: 'sync-2026-10', at: '' } },
          history: [],
        }),
      getData,
      listSessions: () => Promise.resolve([]),
    });
    render(<App client={client} initialData={dataWithOne()} />);
    expect(await screen.findByText(/backup consent was withdrawn/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn on backup and sync' })).toBeTruthy();
    expect(getData).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('due:sync:a1')!).on).toBe(false);
  });

  it('withdrawing backup consent turns sync off; a 403 consent_required also stops it', async () => {
    pref({ on: true, version: 2, lastSyncedAt: null, dirty: false });
    const recordConsent = vi.fn(() =>
      Promise.resolve({ ok: true, purpose: 'sync_backup', granted: false, at: '' }),
    );
    const client = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () =>
        Promise.resolve({
          current: { sync_backup: { granted: true, textVersion: 'sync-2026-10', at: '' } },
          history: [],
        }),
      getData: () => Promise.resolve(doc(2, dataWithOne())),
      recordConsent,
      listSessions: () => Promise.resolve([]),
    });
    render(<App client={client} initialData={dataWithOne()} />);
    expect(await screen.findByRole('button', { name: 'Sync now' })).toBeTruthy();
    const box = (await screen.findByLabelText(/Back up my Due data/)) as HTMLInputElement;
    fireEvent.click(box);
    await waitFor(() =>
      expect(recordConsent).toHaveBeenCalledWith('sync_backup', false, 'sync-2026-10'),
    );
    expect(await screen.findByRole('button', { name: 'Turn on backup and sync' })).toBeTruthy();
    cleanup();

    pref({ on: true, version: 2, lastSyncedAt: null, dirty: true });
    const client2 = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () => Promise.resolve({ current: {}, history: [] }),
      getData: () => Promise.resolve(doc(2, dataWithOne())),
      putData: () =>
        Promise.reject(new AccountApiError(403, 'consent_required', 'Consent withdrawn')),
      listSessions: () => Promise.resolve([]),
    });
    render(<App client={client2} initialData={dataWithOne()} />);
    expect(await screen.findByText(/backup consent was withdrawn/)).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('due:sync:a1')!).on).toBe(false);
  });

  it('turning sync on records the backup consent first', async () => {
    const recordConsent = vi.fn(() =>
      Promise.resolve({ ok: true, purpose: 'sync_backup', granted: true, at: '' }),
    );
    const putData = vi.fn(() => Promise.resolve({ version: 1, updatedAt: '2026-10-30T09:00:00Z' }));
    const client = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () => Promise.resolve({ current: {}, history: [] }),
      getData: () => Promise.resolve(doc(0, null)),
      recordConsent,
      putData,
      listSessions: () => Promise.resolve([]),
    });
    render(<App client={client} initialData={dataWithOne()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on backup and sync' }));
    await waitFor(() => expect(putData).toHaveBeenCalled());
    expect(recordConsent).toHaveBeenCalledWith('sync_backup', true, 'sync-2026-10');
    expect(recordConsent.mock.invocationCallOrder[0]).toBeLessThan(
      putData.mock.invocationCallOrder[0],
    );
  });
});
