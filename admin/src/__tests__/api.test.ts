import { describe, expect, it, vi } from 'vitest';
import { ApiError, api, asList, setUnauthorizedHandler } from '../lib/api';
import { mockFetch } from './helpers';

function headersOf(init?: RequestInit): Record<string, string> {
  return (init?.headers ?? {}) as Record<string, string>;
}

describe('api client', () => {
  it('sends X-Requested-With and same-origin credentials on mutating requests', async () => {
    const f = mockFetch(() => ({ body: { ok: true } }));
    await api.post('/admin/companies', { name: 'x' });
    await api.patch('/admin/companies/1', { name: 'y' });
    await api.del('/admin/categories/1');
    for (const call of f.mock.calls) {
      const init = call[1] as RequestInit;
      expect(headersOf(init)['X-Requested-With']).toBe('due-admin');
      expect(init.credentials).toBe('same-origin');
    }
    expect((f.mock.calls[0][1] as RequestInit).body).toBe(JSON.stringify({ name: 'x' }));
  });

  it('uses same-origin credentials on GET and camelizes keys', async () => {
    const f = mockFetch(() => ({ body: { items: [{ last_checked_at: 't', frequency_minutes: 60 }] } }));
    const data = await api.get('/admin/sources');
    expect((f.mock.calls[0][1] as RequestInit).credentials).toBe('same-origin');
    expect(f.mock.calls[0][0]).toBe('/api/admin/sources');
    expect(asList(data)).toEqual([{ lastCheckedAt: 't', frequencyMinutes: 60 }]);
  });

  it('calls the unauthorized handler on 401 and throws an ApiError', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    mockFetch(() => ({ status: 401, body: { error: { code: 'unauthorized', message: 'Authentication required' } } }));
    await expect(api.get('/admin/dashboard')).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
    setUnauthorizedHandler(null);
  });

  it('does not redirect when skipAuthRedirect is set', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    mockFetch(() => ({ status: 401, body: { error: { code: 'unauthorized', message: 'nope' } } }));
    await expect(api.get('/auth/me', { skipAuthRedirect: true })).rejects.toThrow('nope');
    expect(handler).not.toHaveBeenCalled();
    setUnauthorizedHandler(null);
  });

  it('surfaces server error messages and validation details in plain language', async () => {
    mockFetch(() => ({
      status: 400,
      body: { error: { code: 'validation_error', message: 'Request validation failed', details: [{ path: 'url', message: 'Invalid url' }] } },
    }));
    await expect(api.post('/admin/sources', {})).rejects.toThrow('Request validation failed (url: Invalid url)');
  });

  it('falls back to a friendly message when the body has no error object', async () => {
    mockFetch(() => ({ status: 500 }));
    await expect(api.get('/admin/dashboard')).rejects.toThrow('The server had a problem');
  });
});
