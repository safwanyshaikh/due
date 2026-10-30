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
  it('withdrawing the telemetry consent also stops anonymous telemetry on this device', async () => {
    const consents: ConsentsResponse = { current: {}, history: [] };
    const recordConsent = vi.fn(() =>
      Promise.resolve({ ok: true, purpose: 'telemetry', granted: false, at: '' }),
    );
    const client = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () => Promise.resolve(consents),
      recordConsent,
      listSessions: () => Promise.resolve([]),
    });
    renderApp({ client, hash: '#/account' });
    const box = (await screen.findByLabelText(/Anonymous usage events/)) as HTMLInputElement;
    expect(box.checked).toBe(!telemetryOptedOut());
    expect(telemetryOptedOut()).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(recordConsent).toHaveBeenCalled());
    expect(recordConsent.mock.calls[0]).toEqual(['telemetry', false, expect.any(String)]);
    expect(telemetryOptedOut()).toBe(true);
  });
});
