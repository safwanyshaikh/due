import { describe, expect, it } from 'vitest';
import {
  AccountApiError,
  createAccountClient,
  serverCopyFromConflict,
  type FetchLike,
} from '../client';

interface Call {
  url: string;
  init: RequestInit;
}

/** Test-only fetch double: records calls and replays queued responses. */
function mockFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('no response queued');
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('account client', () => {
  it('sends credentials, the CSRF header and JSON bodies to the configured base', async () => {
    const { fetch, calls } = mockFetch([
      json(202, { ok: true, message: 'sent', expiresInMinutes: 15 }),
    ]);
    const c = createAccountClient({ base: 'https://api.example.test/', fetch });
    const r = await c.requestMagicLink('a@example.com');
    expect(r.expiresInMinutes).toBe(15);
    expect(calls[0]!.url).toBe('https://api.example.test/api/account/magic-link');
    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['X-Requested-With']).toBe('due-app');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'a@example.com' });
  });

  it('defaults to same-origin paths and sends no body on GET', async () => {
    const { fetch, calls } = mockFetch([json(200, { items: [{ id: 's1', current: true }] })]);
    const c = createAccountClient({ base: '', fetch });
    const items = await c.listSessions();
    expect(items[0]!.id).toBe('s1');
    expect(calls[0]!.url).toBe('/api/account/sessions');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });

  it('maps server errors, including unavailable and premium codes', async () => {
    const { fetch } = mockFetch([
      json(503, {
        error: { code: 'email_unavailable', message: 'Email sign-in is not available' },
      }),
      json(402, {
        error: {
          code: 'premium_required',
          message: 'Needs premium',
          details: { feature: 'household_sharing' },
        },
      }),
      json(503, {
        error: { code: 'payments_unavailable', message: 'Payments are not available yet' },
      }),
      json(401, { error: { code: 'unauthorized', message: 'Sign in' } }),
    ]);
    const c = createAccountClient({ base: '', fetch });
    const e1 = await c.requestMagicLink('a@example.com').catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(AccountApiError);
    expect((e1 as AccountApiError).isUnavailable).toBe(true);
    expect((e1 as AccountApiError).status).toBe(503);
    const e2 = (await c.getHousehold().catch((e: unknown) => e)) as AccountApiError;
    expect(e2.isPremiumRequired).toBe(true);
    expect(e2.details).toEqual({ feature: 'household_sharing' });
    const e3 = (await c.checkout('plus', 'monthly').catch((e: unknown) => e)) as AccountApiError;
    expect(e3.code).toBe('payments_unavailable');
    expect(e3.isUnavailable).toBe(true);
    const e4 = (await c.me().catch((e: unknown) => e)) as AccountApiError;
    expect(e4.isUnauthorized).toBe(true);
  });

  it('exposes the server copy on a sync conflict', async () => {
    const server = { version: 3, data: { items: [1] }, updatedAt: '2026-10-30T10:00:00.000Z' };
    const { fetch, calls } = mockFetch([
      json(409, { error: { code: 'version_conflict', message: 'changed', details: { server } } }),
    ]);
    const c = createAccountClient({ base: '', fetch });
    const err = await c.putData(2, { items: [2] }).catch((e: unknown) => e);
    expect((err as AccountApiError).isConflict).toBe(true);
    expect(serverCopyFromConflict(err)).toEqual(server);
    expect(serverCopyFromConflict(new Error('x'))).toBeNull();
    expect(calls[0]!.init.method).toBe('PUT');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      baseVersion: 2,
      data: { items: [2] },
    });
  });

  it('maps network failures, timeouts and non-JSON errors', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fetch } = mockFetch([
      new TypeError('Failed to fetch'),
      abort,
      new Response('<html>Bad gateway</html>', { status: 502 }),
    ]);
    const c = createAccountClient({ base: '', fetch });
    const n = (await c.me().catch((e: unknown) => e)) as AccountApiError;
    expect([n.status, n.code]).toEqual([0, 'network_error']);
    const t = (await c.me().catch((e: unknown) => e)) as AccountApiError;
    expect([t.status, t.code]).toEqual([0, 'timeout']);
    const h = (await c.me().catch((e: unknown) => e)) as AccountApiError;
    expect([h.status, h.code]).toEqual([502, 'http_error']);
  });

  it('builds intake, household and billing requests with the right methods and paths', async () => {
    const ok = () => json(200, { ok: true });
    const { fetch, calls } = mockFetch(Array.from({ length: 9 }, ok));
    const c = createAccountClient({ base: '', fetch });
    await c.startIntakeSession('intake-v1');
    await c.pauseIntakeAlias();
    await c.editIntakeEvent('ev/1', { amountInr: 499, benefit: null });
    await c.deleteIntakeRaw('ev1');
    await c.listIntakeEvents('needs_review');
    await c.removeHouseholdMember('m1');
    await c.checkout('household', 'yearly');
    await c.recordConsent('email_intake', false, 'v1');
    await c.deleteAccount('tok');
    expect(calls.map((x) => `${x.init.method} ${x.url}`)).toEqual([
      'POST /api/intake/session',
      'POST /api/intake/alias/pause',
      'PATCH /api/intake/events/ev%2F1',
      'DELETE /api/intake/events/ev1/raw',
      'GET /api/intake/events?status=needs_review',
      'DELETE /api/account/household/members/m1',
      'POST /api/account/checkout',
      'POST /api/account/consents',
      'DELETE /api/account',
    ]);
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({
      fields: { amountInr: 499, benefit: null },
    });
    expect(JSON.parse(calls[6]!.init.body as string)).toEqual({
      plan: 'household',
      billingPeriod: 'yearly',
    });
    expect(JSON.parse(calls[8]!.init.body as string)).toEqual({ confirmationToken: 'tok' });
  });
});
