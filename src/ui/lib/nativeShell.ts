import { useEffect } from 'react';
import { getPlatform, isNative } from '../../lib/platform';
import { nav } from './nav';
import { setPendingFile } from './pendingFile';

/** Where an app link should land: the e-mailed sign-in link goes to the confirm screen, nothing else is claimed. */
export function signInTarget(url: URL): string | null {
  const token = url.searchParams.get('token');
  if (url.pathname !== '/api/account/verify' || !token || !/^[A-Za-z0-9_-]{16,256}$/.test(token))
    return null;
  return `/?account=confirm&token=${encodeURIComponent(token)}`;
}

/**
 * Starts the native shell integration (status bar, back button, "Open with Due", app links). Does nothing
 * in the browser.
 */
export function useNativeShell(): void {
  useEffect(() => {
    if (!isNative()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void getPlatform()
      .start({
        onOpenFile: (file) => {
          setPendingFile(file);
          nav.go({ name: 'upload' });
        },
        onOpenUrl: (url) => {
          const target = signInTarget(url);
          if (target) window.location.replace(target);
        },
        onBackAtRoot: () => {
          if (
            window.location.hash &&
            window.location.hash !== '#/' &&
            window.location.hash !== '#'
          ) {
            nav.go({ name: 'home' });
            return true;
          }
          return false;
        },
      })
      .then((cleanup) => {
        if (cancelled) cleanup();
        else stop = cleanup;
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}
