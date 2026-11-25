import { webAdapter } from './web';
import type { PlatformAdapter, PlatformName } from './types';

export * from './types';
export { apiOrigin } from './config';

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
}

function detect(): PlatformName {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  try {
    if (cap?.isNativePlatform?.() === true) {
      const p = cap.getPlatform?.();
      return p === 'ios' ? 'ios' : 'android';
    }
  } catch {
    /* not native */
  }
  return 'web';
}

let current: PlatformAdapter | null = null;

/** The adapter for this build: Capacitor inside the native shell, the no-op web adapter everywhere else. */
export function getPlatform(): PlatformAdapter {
  if (!current) {
    const name = detect();
    current = name === 'web' ? webAdapter : lazyNativeAdapter(name);
  }
  return current;
}

export function isNative(): boolean {
  return getPlatform().isNative;
}

/** Test hook: install an adapter (null restores detection). */
export function setPlatformAdapter(a: PlatformAdapter | null): void {
  current = a;
}

/**
 * The native adapter is loaded on first use so the web bundle never pays for it. Its sync fields are
 * known up front; everything else awaits the dynamic import.
 */
function lazyNativeAdapter(name: 'ios' | 'android'): PlatformAdapter {
  const load = () => import('./native').then((m) => m.createNativeAdapter(name));
  let loaded: Promise<PlatformAdapter> | null = null;
  const native = () => (loaded ??= load());
  return {
    name,
    isNative: true,
    tokens: {
      get: async () => (await native()).tokens.get(),
      set: async (t) => (await native()).tokens.set(t),
      clear: async () => (await native()).tokens.clear(),
    },
    start: async (h) => (await native()).start(h),
    appLock: {
      supported: true,
      available: async () => (await native()).appLock.available(),
      isEnabled: async () => (await native()).appLock.isEnabled(),
      setEnabled: async (on) => (await native()).appLock.setEnabled(on),
      authenticate: async (r) => (await native()).appLock.authenticate(r),
      onActiveChange: async (cb) => (await native()).appLock.onActiveChange(cb),
    },
    notifications: {
      supported: true,
      permission: async () => (await native()).notifications.permission(),
      request: async () => (await native()).notifications.request(),
      replaceAll: async (i) => (await native()).notifications.replaceAll(i),
      cancelAll: async () => (await native()).notifications.cancelAll(),
    },
    share: async (i) => (await native()).share(i),
    saveAndShareFile: async (f, t, m) => (await native()).saveAndShareFile(f, t, m),
  };
}
