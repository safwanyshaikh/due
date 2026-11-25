import type { PlatformAdapter } from './types';

/** The browser/PWA adapter: nothing native, nothing loaded. Behaviour of the web build is unchanged. */
export const webAdapter: PlatformAdapter = {
  name: 'web',
  isNative: false,
  tokens: {
    get: async () => null,
    set: async () => undefined,
    clear: async () => undefined,
  },
  start: async () => () => undefined,
  appLock: {
    supported: false,
    available: async () => false,
    isEnabled: async () => false,
    setEnabled: async () => false,
    authenticate: async () => true,
    onActiveChange: async () => () => undefined,
  },
  notifications: {
    supported: false,
    permission: async () => 'unsupported',
    request: async () => 'unsupported',
    replaceAll: async () => 0,
    cancelAll: async () => undefined,
  },
  async share(input) {
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
        await navigator.share(input);
        return true;
      }
    } catch {
      /* cancelled or blocked */
    }
    return false;
  },
  saveAndShareFile: async () => 'unsupported',
};
