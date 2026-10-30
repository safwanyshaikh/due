import { useEffect, useState } from 'react';
import { readPref, writePref } from './prefs';

export const REDUCE_MOTION_CLASS = 'reduce-motion';

function systemPrefersReduced(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** Applies the reduce-motion class from the system setting or the user's in-app choice. */
export function applyMotionClass(forced: boolean, root: HTMLElement = document.documentElement) {
  const on = forced || systemPrefersReduced();
  root.classList.toggle(REDUCE_MOTION_CLASS, on);
  return on;
}

export function useMotionPreference(): [boolean, (v: boolean) => void] {
  const [forced, setForced] = useState(() => readPref('reduce-motion') === '1');
  useEffect(() => {
    applyMotionClass(forced);
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    } catch {
      mq = null;
    }
    const on = () => applyMotionClass(forced);
    mq?.addEventListener?.('change', on);
    return () => mq?.removeEventListener?.('change', on);
  }, [forced]);
  return [
    forced,
    (v: boolean) => {
      writePref('reduce-motion', v ? '1' : null);
      setForced(v);
    },
  ];
}

export type ThemeChoice = 'system' | 'light' | 'dark';

export function useTheme(): [ThemeChoice, (t: ThemeChoice) => void] {
  const [theme, setTheme] = useState<ThemeChoice>(
    () => (readPref('theme') as ThemeChoice | null) ?? 'system',
  );
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
  }, [theme]);
  return [
    theme,
    (t: ThemeChoice) => {
      writePref('theme', t === 'system' ? null : t);
      setTheme(t);
    },
  ];
}
