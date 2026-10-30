// Test-only helpers. Not imported by application code.
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthContext } from '../lib/auth';
import type { Me, Role } from '../lib/types';

export type Route = (url: string, init?: RequestInit) => { status?: number; body?: unknown } | undefined;

export function mockFetch(route: Route) {
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = route(url, init) ?? { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
    const status = r.status ?? 200;
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

export function renderAs(role: Role | null, ui: ReactNode, path = '/') {
  const me: Me | null = role ? { id: 'u-test', email: 'test@example.test', name: 'Test User', role } : null;
  return render(
    <AuthContext.Provider value={{ me, setMe: () => undefined, refresh: async () => undefined }}>
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>
    </AuthContext.Provider>,
  );
}
