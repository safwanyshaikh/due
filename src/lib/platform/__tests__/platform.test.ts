import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyData } from '../../data';
import { createObligation } from '../../mutations';
import { rules } from '../../recurrence';
import { ctx } from '../../__tests__/helpers';
import { createAccountClient, CSRF_HEADER } from '../../account/client';
import { apiOrigin, normaliseOrigin } from '../config';
import { MAX_LOCAL_NOTIFICATIONS, notificationId, planLocalNotifications } from '../localReminders';
import { getPlatform, isNative, setPlatformAdapter } from '../index';
import { authInit, getSessionToken, resetSessionTokenCache } from '../session';
import { webAdapter } from '../web';
import type { PlatformAdapter } from '../types';
import { fileNameFromUrl, permissionOf } from '../native';
import { signInTarget } from '../../../ui/lib/nativeShell';

afterEach(() => {
  setPlatformAdapter(null);
  resetSessionTokenCache();
  vi.unstubAllEnvs();
});

function nativeAdapter(store: { token: string | null }): PlatformAdapter {
  return {
    ...webAdapter,
    name: 'ios',
    isNative: true,
    tokens: {
      get: async () => store.token,
      set: async (t) => void (store.token = t),
      clear: async () => void (store.token = null),
    },
  };
}

describe('API origin config', () => {
  it('is same-origin by default and honours VITE_API_ORIGIN, then the legacy VITE_API_BASE', () => {
    vi.stubEnv('VITE_API_ORIGIN', '');
    vi.stubEnv('VITE_API_BASE', '');
    expect(apiOrigin()).toBe('');
    vi.stubEnv('VITE_API_BASE', 'https://old.example/');
    expect(apiOrigin()).toBe('https://old.example');
    vi.stubEnv('VITE_API_ORIGIN', ' https://due.karigarai.com/ ');
    expect(apiOrigin()).toBe('https://due.karigarai.com');
    expect(normaliseOrigin(undefined)).toBe('');
  });
});

describe('platform detection', () => {
  it('is web in tests and the web adapter is inert', async () => {
    expect(isNative()).toBe(false);
    expect(getPlatform().name).toBe('web');
    expect(await getSessionToken()).toBeNull();
    expect(await webAdapter.notifications.permission()).toBe('unsupported');
    expect(await webAdapter.saveAndShareFile('a.txt', 'x', 'text/plain')).toBe('unsupported');
  });
});

describe('account client: web (unchanged)', () => {
  it('sends cookies, no Authorization, and does not ask for a bearer token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createAccountClient({
      base: '',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ account: {}, created: false, entitlements: {} }), {
          status: 200,
        });
      },
    });
    await client.verifyMagicLink('t'.repeat(20), 'Chrome on Linux', true);
    const { init } = calls[0]!;
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({
      token: 't'.repeat(20),
      deviceLabel: 'Chrome on Linux',
      ageConfirmed: true,
      noticeVersion: 'privacy-2026-11',
    });
  });
});

describe('account client: native bearer session', () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it('asks for a bearer token, stores it, then sends it with credentials omitted', async () => {
    const store = { token: null as string | null };
    setPlatformAdapter(nativeAdapter(store));
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createAccountClient({
      base: 'https://due.karigarai.com',
      fetch: async (url, init) => {
        calls.push({ url, init });
        return url.endsWith('/verify')
          ? ok({
              account: { id: 'a' },
              created: true,
              entitlements: {},
              sessionToken: 'S'.repeat(43),
              tokenType: 'Bearer',
            })
          : ok({ account: { id: 'a' } });
      },
    });
    const v = await client.verifyMagicLink('t'.repeat(20), 'Due on iOS');
    expect(calls[0]!.url).toBe('https://due.karigarai.com/api/account/verify');
    expect(JSON.parse(calls[0]!.init.body as string).tokenTransport).toBe('bearer');
    expect(calls[0]!.init.credentials).toBe('omit');
    expect(store.token).toBe('S'.repeat(43));
    expect((v as unknown as Record<string, unknown>).sessionToken).toBeUndefined();

    await client.me();
    const h = calls[1]!.init.headers as Record<string, string>;
    expect(h.Authorization).toBe(`Bearer ${'S'.repeat(43)}`);
    expect(h[CSRF_HEADER]).toBe('due-app');
    expect(calls[1]!.init.credentials).toBe('omit');
  });

  it('forgets the token on logout (even if the request fails) and when the server rejects it', async () => {
    const store = { token: 'T'.repeat(43) };
    setPlatformAdapter(nativeAdapter(store));
    const failing = createAccountClient({
      base: 'https://x.test',
      fetch: async () => {
        throw new Error('offline');
      },
    });
    await expect(failing.logout()).rejects.toMatchObject({ code: 'network_error' });
    expect(store.token).toBeNull();

    store.token = 'U'.repeat(43);
    resetSessionTokenCache();
    const rejected = createAccountClient({
      base: 'https://x.test',
      fetch: async () => ok({ error: { code: 'unauthorized', message: 'no' } }, 401),
    });
    await expect(rejected.me()).rejects.toMatchObject({ status: 401 });
    expect(store.token).toBeNull();
  });

  it('authInit sends no Authorization when signed out', async () => {
    setPlatformAdapter(nativeAdapter({ token: null }));
    expect(await authInit()).toEqual({ headers: {}, credentials: 'omit', bearer: true });
  });
});

describe('local notification planning', () => {
  const now = new Date('2026-10-30T06:00:00.000Z');
  const data = createObligation(
    emptyData(),
    {
      type: 'emi',
      provider: 'Home loan',
      amountPaise: 2209300,
      rule: rules.monthly('2026-11-05'),
      reminder: { enabled: true, offsets: [3, 1] },
    },
    ctx(),
  ).data;

  it('plans only future reminders, soonest first, with stable ids', () => {
    const a = planLocalNotifications(data, now);
    expect(a.length).toBeGreaterThan(0);
    expect(a.every((n) => n.at.getTime() > now.getTime())).toBe(true);
    expect([...a].sort((x, y) => x.at.getTime() - y.at.getTime())).toEqual(a);
    expect(planLocalNotifications(data, now).map((n) => n.id)).toEqual(a.map((n) => n.id));
    expect(new Set(a.map((n) => n.id)).size).toBe(a.length);
    expect(a[0]!.title).toBeTruthy();
  });

  it('honours the cap and ids are positive 31-bit', () => {
    expect(planLocalNotifications(data, now, 2)).toHaveLength(2);
    expect(MAX_LOCAL_NOTIFICATIONS).toBeLessThan(64);
    const id = notificationId('some:reminder:key');
    expect(id).toBeGreaterThan(0);
    expect(id).toBeLessThanOrEqual(0x7fffffff);
  });
});

describe('native helpers', () => {
  it('maps permission states and file names', () => {
    expect(permissionOf('granted')).toBe('granted');
    expect(permissionOf('denied')).toBe('denied');
    expect(permissionOf('prompt-with-rationale')).toBe('prompt');
    expect(fileNameFromUrl('content://x/y/Bill%20May.pdf?z=1')).toBe('Bill May.pdf');
    expect(fileNameFromUrl('content://media/external/12345')).toBe('document.pdf');
  });

  it('app links open only the sign-in confirm screen', () => {
    const t = 'A'.repeat(32);
    expect(signInTarget(new URL(`https://due.karigarai.com/api/account/verify?token=${t}`))).toBe(
      `/?account=confirm#token=${t}`,
    );
    expect(
      signInTarget(new URL('https://due.karigarai.com/api/account/verify?token=short')),
    ).toBeNull();
    expect(signInTarget(new URL(`https://due.karigarai.com/api/admin?token=${t}`))).toBeNull();
    expect(signInTarget(new URL(`https://due.karigarai.com/other?token=${t}`))).toBeNull();
  });
});

describe('opened files (round-2 mobile)', () => {
  it("never reads Due's own private files or file:// on Android; iOS only from Documents/Inbox", async () => {
    const { openedFileAllowed } = await import('../native');
    expect(openedFileAllowed('content://com.android.providers.downloads.documents/document/12', 'android')).toBe(true);
    expect(openedFileAllowed('file:///data/data/com.karigarai.due/shared_prefs/x.xml', 'android')).toBe(false);
    expect(openedFileAllowed('content://com.karigarai.due.fileprovider/my_cache/a.pdf', 'android')).toBe(false);
    expect(openedFileAllowed('file:///var/mobile/Containers/Data/Application/ABC/Documents/Inbox/Bill.pdf', 'ios')).toBe(true);
    expect(openedFileAllowed('file:///var/mobile/Containers/Data/Application/ABC/Library/Cookies/x', 'ios')).toBe(false);
    expect(openedFileAllowed('file:///var/mobile/x/Documents/Inbox/../../Library/a.pdf', 'ios')).toBe(false);
    expect(openedFileAllowed('content://evil', 'ios')).toBe(false);
  });
});
