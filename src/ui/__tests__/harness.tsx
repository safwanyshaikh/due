import { render } from '@testing-library/react';
import { AccountApiError, type AccountClient } from '../../lib/account/client';
import { emptyData } from '../../lib/data';
import { addDays, todayInTz } from '../../lib/dates';
import { createObligation } from '../../lib/mutations';
import { rules } from '../../lib/recurrence';
import type { AppData } from '../../lib/types';
import { App } from '../App';

/** A client whose every call fails as "signed out" unless overridden. No network. */
export function fakeClient(overrides: Partial<Record<keyof AccountClient, unknown>> = {}) {
  return new Proxy({} as AccountClient, {
    get(_t, key: string) {
      if (key in overrides) return overrides[key as keyof AccountClient];
      return () => Promise.reject(new AccountApiError(401, 'unauthorized', 'Sign in required'));
    },
  });
}

export function dataWithOne(name = 'Netflix', amountPaise = 64_900): AppData {
  const today = todayInTz();
  const now = new Date().toISOString();
  return createObligation(
    emptyData(),
    { type: 'subscription', provider: name, amountPaise, rule: rules.monthly(addDays(today, 5)) },
    { now },
  ).data;
}

export function renderApp(opts: { data?: AppData; client?: AccountClient; hash?: string } = {}) {
  window.location.hash = opts.hash ?? '#/';
  localStorage.clear();
  return render(
    <App client={opts.client ?? fakeClient()} initialData={opts.data ?? emptyData()} />,
  );
}

export function stubNetwork() {
  globalThis.fetch = (() => Promise.reject(new TypeError('offline in tests'))) as typeof fetch;
  window.scrollTo = () => undefined;
}
