// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ConsentsResponse, MeResponse } from '../../lib/account/types';
import { fakeClient, renderApp, stubNetwork } from './harness';
import { telemetryOptedOut } from '../lib/telemetrySink';

beforeEach(stubNetwork);
afterEach(cleanup);

const ME: MeResponse = {
  account: {
    id: 'a1',
    email: 'me@example.com',
    displayName: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    lastLoginAt: null,
  },
  sessionId: 's1',
  entitlements: {
    plan: 'free',
    status: 'active',
    billingPeriod: null,
    periodEnd: null,
    channel: null,
    features: ['backup'],
    householdAccess: null,
  },
};

describe('account consents', () => {
  it('usage analytics are off by default; turning them on records the consent, turning off withdraws it', async () => {
    const consents: ConsentsResponse = { current: {}, history: [] };
    const recordConsent = vi.fn(() =>
      Promise.resolve({ ok: true, purpose: 'telemetry', granted: true, at: '' }),
    );
    const client = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () => Promise.resolve(consents),
      recordConsent,
      listSessions: () => Promise.resolve([]),
    });
    renderApp({ client, hash: '#/account' });
    const box = (await screen.findByLabelText(/Anonymous usage events/)) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(telemetryOptedOut()).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(recordConsent).toHaveBeenCalled());
    expect(recordConsent.mock.calls[0]).toEqual(['telemetry', true, expect.any(String)]);
    expect(telemetryOptedOut()).toBe(false);
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    await waitFor(() => expect(recordConsent).toHaveBeenCalledTimes(2));
    expect((recordConsent.mock.calls as unknown[][])[1]).toEqual(['telemetry', false, expect.any(String)]);
    expect(telemetryOptedOut()).toBe(true);
  });
});
