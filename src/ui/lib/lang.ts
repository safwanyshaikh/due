import { useSyncExternalStore } from 'react';
import { tr, type Lang, type StrKey } from '../../content/i18n';
import { readPref, writePref } from './prefs';

const listeners = new Set<() => void>();

export function getLang(): Lang {
  return readPref('lang') === 'hi' ? 'hi' : 'en';
}

export function setLang(l: Lang): void {
  writePref('lang', l === 'hi' ? 'hi' : null);
  if (typeof document !== 'undefined') document.documentElement.lang = l === 'hi' ? 'hi' : 'en';
  listeners.forEach((f) => f());
}

function subscribe(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, () => 'en');
}

/** Translator bound to the current language; re-renders when the language changes. */
export function useT(): (key: StrKey, vars?: Record<string, string | number>) => string {
  const lang = useLang();
  return (key, vars) => tr(lang, key, vars);
}
