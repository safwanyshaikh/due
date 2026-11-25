/**
 * Capacitor implementation of the platform adapter. Loaded only inside the native shell (dynamic import
 * from index.ts), so the web bundle does not include these plugins' native glue.
 */
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';
import { App } from '@capacitor/app';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import type {
  LocalNotification,
  NotificationPermission,
  PlatformAdapter,
  PlatformHandlers,
} from './types';

const TOKEN_KEY = 'session-token';
const LOCK_KEY = 'app-lock';
/** Where earlier builds kept the token (plain Preferences). Read once to migrate, then deleted. */
const LEGACY_PREFS_KEY = 'due.session-token';

let secureReady: Promise<void> | null = null;
/**
 * iOS Keychain (accessible after first unlock, this device only, never iCloud-synced) and Android
 * Keystore-backed AES-GCM storage.
 */
function secure(): Promise<typeof SecureStorage> {
  secureReady ??= (async () => {
    await SecureStorage.setKeyPrefix('due.');
    await SecureStorage.setSynchronize(false);
    await SecureStorage.setDefaultKeychainAccess(KeychainAccess.afterFirstUnlockThisDeviceOnly);
  })();
  return secureReady.then(() => SecureStorage);
}

export async function readToken(): Promise<string | null> {
  const store = await secure();
  const v = await store.get(TOKEN_KEY, false, false).catch(() => null);
  if (typeof v === 'string' && v) return v;
  // One-time migration from the old Preferences location: copy into secure storage, then delete it.
  const legacy = (await Preferences.get({ key: LEGACY_PREFS_KEY })).value;
  if (!legacy) return null;
  await store.set(TOKEN_KEY, legacy, false, false, KeychainAccess.afterFirstUnlockThisDeviceOnly);
  await Preferences.remove({ key: LEGACY_PREFS_KEY });
  return legacy;
}

export function permissionOf(v: string | undefined): NotificationPermission {
  return v === 'granted' ? 'granted' : v === 'denied' ? 'denied' : 'prompt';
}

/** Decodes base64 into bytes. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function fileNameFromUrl(url: string): string {
  const last = decodeURIComponent(url.split(/[?#]/)[0]!.split('/').pop() ?? '');
  return /\.pdf$/i.test(last) ? last : 'document.pdf';
}

/** Reads a file:// or content:// PDF handed to the app and returns it as a web File. */
export async function readOpenedFile(url: string): Promise<File | null> {
  try {
    const r = await Filesystem.readFile({ path: url });
    if (typeof r.data !== 'string') {
      return new File([r.data], fileNameFromUrl(url), { type: 'application/pdf' });
    }
    return new File([base64ToBytes(r.data)], fileNameFromUrl(url), { type: 'application/pdf' });
  } catch {
    return null;
  }
}

function isDocumentUrl(url: string): boolean {
  return /^(content|file):/i.test(url);
}

async function dispatchUrl(url: string, h: PlatformHandlers): Promise<void> {
  if (isDocumentUrl(url)) {
    const file = await readOpenedFile(url);
    if (file) h.onOpenFile?.(file);
    return;
  }
  try {
    h.onOpenUrl?.(new URL(url));
  } catch {
    /* ignore malformed links */
  }
}

export function createNativeAdapter(name: 'ios' | 'android'): PlatformAdapter {
  return {
    name,
    isNative: true,
    tokens: {
      get: readToken,
      async set(value) {
        const store = await secure();
        await store.set(
          TOKEN_KEY,
          value,
          false,
          false,
          KeychainAccess.afterFirstUnlockThisDeviceOnly,
        );
        await Preferences.remove({ key: LEGACY_PREFS_KEY });
      },
      async clear() {
        const store = await secure();
        await store.remove(TOKEN_KEY, false).catch(() => false);
        await Preferences.remove({ key: LEGACY_PREFS_KEY });
      },
    },

    appLock: {
      supported: true,
      available: async () =>
        (await BiometricAuth.checkBiometry().catch(() => null))?.isAvailable ?? false,
      async isEnabled() {
        const store = await secure();
        return (await store.get(LOCK_KEY, false, false).catch(() => null)) === '1';
      },
      async authenticate(reason) {
        try {
          await BiometricAuth.authenticate({
            reason,
            cancelTitle: 'Cancel',
            allowDeviceCredential: true,
            androidTitle: 'Unlock Due',
            iosFallbackTitle: 'Use passcode',
          });
          return true;
        } catch {
          return false;
        }
      },
      async setEnabled(on) {
        const self = createNativeAdapter(name).appLock;
        // Changing the lock needs a successful unlock, so a borrowed unlocked phone cannot switch it off.
        if (on && !(await self.available())) return false;
        if (!(await self.authenticate(on ? 'Turn on app lock' : 'Turn off app lock')))
          return await self.isEnabled();
        const store = await secure();
        if (on)
          await store.set(
            LOCK_KEY,
            '1',
            false,
            false,
            KeychainAccess.afterFirstUnlockThisDeviceOnly,
          );
        else await store.remove(LOCK_KEY, false).catch(() => false);
        return on;
      },
      async onActiveChange(cb) {
        const sub = await App.addListener('appStateChange', ({ isActive }) => cb(isActive));
        return () => void sub.remove();
      },
    },

    async start(handlers = {}) {
      const subs: { remove: () => Promise<void> }[] = [];
      const dark = (() => {
        try {
          return window.matchMedia('(prefers-color-scheme: dark)').matches;
        } catch {
          return false;
        }
      })();
      // Style.Dark means "light text for a dark background".
      await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }).catch(() => undefined);
      if (name === 'android')
        await StatusBar.setBackgroundColor({ color: dark ? '#0b1114' : '#f3f6f8' }).catch(
          () => undefined,
        );

      subs.push(
        await App.addListener('appUrlOpen', ({ url }) => {
          void dispatchUrl(url, handlers);
        }),
      );
      if (name === 'android') {
        subs.push(
          await App.addListener('backButton', ({ canGoBack }) => {
            if (canGoBack) {
              window.history.back();
              return;
            }
            if (handlers.onBackAtRoot?.()) return;
            void App.minimizeApp();
          }),
        );
      }
      const launch = await App.getLaunchUrl().catch(() => undefined);
      if (launch?.url) void dispatchUrl(launch.url, handlers);
      await SplashScreen.hide().catch(() => undefined);
      return () => {
        for (const s of subs) void s.remove();
      };
    },

    notifications: {
      supported: true,
      permission: async () =>
        permissionOf((await LocalNotifications.checkPermissions().catch(() => null))?.display),
      request: async () =>
        permissionOf((await LocalNotifications.requestPermissions().catch(() => null))?.display),
      async replaceAll(items: LocalNotification[]) {
        const pending = await LocalNotifications.getPending().catch(() => ({ notifications: [] }));
        if (pending.notifications.length)
          await LocalNotifications.cancel({
            notifications: pending.notifications.map((n) => ({ id: n.id })),
          });
        if (items.length === 0) return 0;
        await LocalNotifications.schedule({
          notifications: items.map((n) => ({
            id: n.id,
            title: n.title,
            body: n.body,
            schedule: { at: n.at, allowWhileIdle: true },
          })),
        });
        return items.length;
      },
      async cancelAll() {
        const pending = await LocalNotifications.getPending().catch(() => ({ notifications: [] }));
        if (pending.notifications.length)
          await LocalNotifications.cancel({
            notifications: pending.notifications.map((n) => ({ id: n.id })),
          });
      },
    },

    async share(input) {
      try {
        await Share.share({ ...input, dialogTitle: input.title });
        return true;
      } catch {
        return false;
      }
    },

    async saveAndShareFile(filename, text) {
      try {
        const { uri } = await Filesystem.writeFile({
          path: filename,
          data: text,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({ title: filename, files: [uri], dialogTitle: filename });
        return 'shared';
      } catch {
        return 'unsupported';
      }
    },
  };
}
