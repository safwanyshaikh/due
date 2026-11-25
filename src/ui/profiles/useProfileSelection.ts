import { useCallback, useState } from 'react';
import { validSelection, type ProfileSelection } from '../../lib/profiles';
import type { AppData } from '../../lib/types';
import { readPref, writePref } from '../lib/prefs';

const KEY = 'profile-filter';

/**
 * The profile filter shared by Home and Savings ("All · Personal · <Business>"), kept on this device.
 * A profile that no longer exists falls back to All.
 */
export function useProfileSelection(
  data: Pick<AppData, 'profiles'>,
): [ProfileSelection, (s: ProfileSelection) => void] {
  const [raw, setRaw] = useState<ProfileSelection>(() => readPref(KEY) ?? 'all');
  const set = useCallback((s: ProfileSelection) => {
    setRaw(s);
    writePref(KEY, s === 'all' ? null : s);
  }, []);
  return [validSelection(data, raw), set];
}
