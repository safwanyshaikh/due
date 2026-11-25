import { beforeEach, describe, expect, it, vi } from 'vitest';

const secure = new Map<string, string>();
const prefs = new Map<string, string>();
const calls: string[] = [];
let bioOk = true;
let bioAvailable = true;

vi.mock('@aparajita/capacitor-secure-storage', () => ({
  KeychainAccess: { afterFirstUnlockThisDeviceOnly: 3, whenUnlocked: 0 },
  SecureStorage: {
    setKeyPrefix: vi.fn(async (p: string) => void calls.push(`prefix:${p}`)),
    setSynchronize: vi.fn(async (s: boolean) => void calls.push(`sync:${s}`)),
    setDefaultKeychainAccess: vi.fn(async (a: number) => void calls.push(`access:${a}`)),
    get: vi.fn(async (k: string) => secure.get(k) ?? null),
    set: vi.fn(async (k: string, v: string, _c?: boolean, sync?: boolean, access?: number) => {
      calls.push(`set:${k}:sync=${sync}:access=${access}`);
      secure.set(k, v);
    }),
    remove: vi.fn(async (k: string) => secure.delete(k)),
  },
}));
vi.mock('@aparajita/capacitor-biometric-auth', () => ({
  BiometricAuth: {
    checkBiometry: vi.fn(async () => ({ isAvailable: bioAvailable })),
    authenticate: vi.fn(async () => {
      if (!bioOk) throw new Error('cancelled');
    }),
  },
}));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null })),
    set: vi.fn(
      async ({ key, value }: { key: string; value: string }) => void prefs.set(key, value),
    ),
    remove: vi.fn(async ({ key }: { key: string }) => void prefs.delete(key)),
  },
}));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) },
}));
vi.mock('@capacitor/filesystem', () => ({ Directory: {}, Encoding: {}, Filesystem: {} }));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: {} }));
vi.mock('@capacitor/share', () => ({ Share: {} }));
vi.mock('@capacitor/splash-screen', () => ({ SplashScreen: {} }));
vi.mock('@capacitor/status-bar', () => ({ StatusBar: {}, Style: {} }));

const { createNativeAdapter } = await import('../native');

beforeEach(() => {
  secure.clear();
  prefs.clear();
  calls.length = 0;
  bioOk = true;
  bioAvailable = true;
});

describe('native token store (Keychain / Keystore)', () => {
  it('configures after-first-unlock, this-device-only, no iCloud sync', async () => {
    const a = createNativeAdapter('ios');
    await a.tokens.set('tok'.repeat(10));
    expect(calls).toContain('sync:false');
    expect(calls).toContain('access:3');
    expect(calls.some((c) => c.startsWith('set:session-token:sync=false:access=3'))).toBe(true);
    expect(await a.tokens.get()).toBe('tok'.repeat(10));
  });

  it('never writes the token to Preferences', async () => {
    const a = createNativeAdapter('android');
    await a.tokens.set('x'.repeat(40));
    expect([...prefs.keys()]).toEqual([]);
  });

  it('migrates a legacy Preferences token into secure storage, then deletes it', async () => {
    prefs.set('due.session-token', 'legacy-token-value-1234');
    const a = createNativeAdapter('ios');
    expect(await a.tokens.get()).toBe('legacy-token-value-1234');
    expect(secure.get('session-token')).toBe('legacy-token-value-1234');
    expect(prefs.has('due.session-token')).toBe(false);
    expect(await a.tokens.get()).toBe('legacy-token-value-1234');
  });

  it('clear removes both locations', async () => {
    const a = createNativeAdapter('ios');
    await a.tokens.set('x'.repeat(40));
    prefs.set('due.session-token', 'old');
    await a.tokens.clear();
    expect(await a.tokens.get()).toBeNull();
    expect(prefs.size).toBe(0);
  });
});

describe('native app lock', () => {
  it('is off by default and needs a successful unlock to turn on or off', async () => {
    const lock = createNativeAdapter('ios').appLock;
    expect(await lock.isEnabled()).toBe(false);
    bioOk = false;
    expect(await lock.setEnabled(true)).toBe(false);
    expect(await lock.isEnabled()).toBe(false);
    bioOk = true;
    expect(await lock.setEnabled(true)).toBe(true);
    expect(await lock.isEnabled()).toBe(true);
    bioOk = false;
    expect(await lock.setEnabled(false)).toBe(true); // refused: still on
    bioOk = true;
    expect(await lock.setEnabled(false)).toBe(false);
    expect(await lock.isEnabled()).toBe(false);
  });

  it('cannot be turned on without biometrics or a passcode', async () => {
    bioAvailable = false;
    const lock = createNativeAdapter('android').appLock;
    expect(await lock.available()).toBe(false);
    expect(await lock.setEnabled(true)).toBe(false);
  });

  it('authenticate is false when the person cancels', async () => {
    const lock = createNativeAdapter('ios').appLock;
    bioOk = false;
    expect(await lock.authenticate('x')).toBe(false);
    bioOk = true;
    expect(await lock.authenticate('x')).toBe(true);
  });
});
