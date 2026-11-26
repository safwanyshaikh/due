// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ConsentsResponse, MeResponse } from '../../lib/account/types';
import { fakeClient, renderApp, stubNetwork } from './harness';

beforeEach(stubNetwork);
afterEach(cleanup);

const ME: MeResponse = {
  account: { id: 'a1', email: 'me@example.com', displayName: null, createdAt: '2026-10-01T00:00:00.000Z', lastLoginAt: null },
  sessionId: 's1',
  entitlements: { plan: 'free', status: 'active', billingPeriod: null, periodEnd: null, channel: null, features: ['backup'], householdAccess: null },
};

describe('nominee in Account settings', () => {
  it('shows the plain-words notice and saves only after the checkbox is ticked', async () => {
    const consents: ConsentsResponse = { current: {}, history: [] };
    const setNomination = vi.fn(() => Promise.resolve({ nominee: {} as never }));
    const client = fakeClient({
      me: () => Promise.resolve(ME),
      getConsents: () => Promise.resolve(consents),
      listSessions: () => Promise.resolve([]),
      getNomination: () => Promise.resolve({ nominee: null, noticeVersion: 'v1', notice: 'We never email or contact your nominee.' }),
      setNomination,
    });
    renderApp({ client, hash: '#/account' });
    expect(await screen.findByText(/We never email or contact your nominee/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Nominee’s name'), { target: { value: 'Test Nominee' } });
    fireEvent.change(screen.getByLabelText('Nominee’s email'), { target: { value: 'nominee@example.com' } });
    const save = screen.getByRole('button', { name: 'Save nominee' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I have read the note above/));
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(setNomination).toHaveBeenCalledWith({ name: 'Test Nominee', email: 'nominee@example.com', relationship: undefined }));
  });
});
