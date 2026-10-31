import { describe, expect, it } from 'vitest';
import { AccountApiError, type FetchLike } from '../client';
import { createGmailClient, gmailReasonMessage, readGmailCallback } from '../gmail';
import { createIdentitiesClient } from '../identities';

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
const headers = (c: Call) => c.init.headers as Record<string, string>;

describe('gmail client', () => {
  it('reads status and starts the OAuth connect with the consent version', async () => {
    const { fetch, calls } = mockFetch([
      json(200, {
        mode: 'test_mode',
        scopes: ['openid'],
        consentVersion: 'v1',
        consentText: 't',
        blocker: 'b',
        missing: [],
      }),
      json(200, {
        authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
        expiresAt: '2026-10-30T10:10:00Z',
      }),
    ]);
    const g = createGmailClient({ base: 'https://api.example.test', fetch });
    expect((await g.status()).mode).toBe('test_mode');
    expect(calls[0]!.url).toBe('https://api.example.test/api/account/gmail/status');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
    const r = await g.connect('v1');
    expect(r.authorizeUrl).toMatch(/^https:\/\/accounts\.google\.com/);
    expect(calls[1]!.init.method).toBe('POST');
    expect(calls[1]!.init.credentials).toBe('include');
    expect(headers(calls[1]!)['X-Requested-With']).toBe('due-app');
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({ consentVersion: 'v1' });
  });

  it('maps server errors (not configured, premium, rate limit) to AccountApiError', async () => {
    const { fetch } = mockFetch([
      json(503, {
        error: {
          code: 'gmail_not_configured',
          message: 'no',
          details: { missing: ['GOOGLE_CLIENT_ID'] },
        },
      }),
      json(402, { error: { code: 'premium_required', message: 'plus' } }),
      json(429, { error: { code: 'scan_limit', message: 'limit' } }),
    ]);
    const g = createGmailClient({ base: '', fetch });
    const e1 = await g.connect('v1').catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(AccountApiError);
    expect((e1 as AccountApiError).code).toBe('gmail_not_configured');
    expect((e1 as AccountApiError).status).toBe(503);
    expect(
      ((await g.scan('i').catch((e: unknown) => e)) as AccountApiError).isPremiumRequired,
    ).toBe(true);
    expect(((await g.scan('i').catch((e: unknown) => e)) as AccountApiError).isRateLimited).toBe(
      true,
    );
  });

  it('queues scans, lists runs and disconnects with encoded ids', async () => {
    const { fetch, calls } = mockFetch([
      json(202, { ok: true, runId: 'r1', jobId: 'j1' }),
      json(200, { items: [{ id: 'r1', status: 'succeeded' }] }),
      json(200, { ok: true, revoked: true, deleted: { events: 2, seen: 3 } }),
    ]);
    const g = createGmailClient({ base: '', fetch });
    expect((await g.scan('a/b')).runId).toBe('r1');
    expect(calls[0]!.url).toBe('/api/account/gmail/a%2Fb/scan');
    expect((await g.scans('x'))[0]!.status).toBe('succeeded');
    const d = await g.disconnect('x', true);
    expect(d.deleted.events).toBe(2);
    expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ deleteImported: true });
  });

  it('reads the callback result from the URL and explains reasons', () => {
    expect(readGmailCallback('?gmail=connected&identity=abc')).toEqual({
      status: 'connected',
      identityId: 'abc',
    });
    expect(readGmailCallback('?gmail=error&reason=scope_mismatch')).toEqual({
      status: 'error',
      reason: 'scope_mismatch',
    });
    expect(readGmailCallback('?other=1')).toBeNull();
    expect(gmailReasonMessage('scope_mismatch')).toMatch(/read-only/);
    expect(gmailReasonMessage('weird')).toMatch(/try again/);
  });
});

describe('identities client', () => {
  it('lists, creates, updates and deletes identities', async () => {
    const ident = {
      id: 'i1',
      kind: 'work',
      label: 'Work',
      email: 'me@corp.example',
      status: 'active',
    };
    const { fetch, calls } = mockFetch([
      json(200, { items: [ident], max: 10 }),
      json(201, { identity: ident }),
      json(200, { identity: { ...ident, status: 'paused' } }),
      json(200, { ok: true, revoked: true, deleted: { events: 1, seen: 0 } }),
    ]);
    const c = createIdentitiesClient({ base: '', fetch });
    expect((await c.list()).items).toHaveLength(1);
    expect((await c.create({ kind: 'work', label: 'Work', email: 'me@corp.example' })).id).toBe(
      'i1',
    );
    expect(JSON.parse(calls[1]!.init.body as string)).toEqual({
      kind: 'work',
      label: 'Work',
      email: 'me@corp.example',
    });
    expect((await c.update('i1', { status: 'paused' })).status).toBe('paused');
    expect(calls[2]!.init.method).toBe('PATCH');
    expect((await c.remove('i1', true)).deleted.events).toBe(1);
    expect(calls[3]!.url).toBe('/api/account/identities/i1?deleteData=true');
    expect(calls[3]!.init.method).toBe('DELETE');
    for (const call of calls) {
      expect(call.init.credentials).toBe('include');
      expect(headers(call)['X-Requested-With']).toBe('due-app');
    }
  });

  it('reports network failures as status 0', async () => {
    const { fetch } = mockFetch([new TypeError('offline')]);
    const e = (await createIdentitiesClient({ base: '', fetch })
      .list()
      .catch((x: unknown) => x)) as AccountApiError;
    expect(e.status).toBe(0);
    expect(e.code).toBe('network_error');
  });
});
