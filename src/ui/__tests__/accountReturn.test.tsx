// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AccountApiError } from '../../lib/account/client';
import type { Entitlements, MeResponse, PublicPlansResponse } from '../../lib/account/types';
import { emptyData } from '../../lib/data';
import { App } from '../App';
import { deviceLabel } from '../account/AccountReturn';
import { fakeClient, renderApp, stubNetwork } from './harness';

beforeEach(() => {
  stubNetwork();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

const FREE: Entitlements = {
  plan: 'free',
  status: 'active',
  billingPeriod: null,
  periodEnd: null,
  channel: null,
  features: ['backup'],
  householdAccess: null,
};
const me = (entitlements: Entitlements = FREE): MeResponse => ({
  account: {
    id: 'a1',
    email: 'me@example.com',
    displayName: null,
    createdAt: '',
    lastLoginAt: null,
  },
  sessionId: 's1',
  entitlements,
});
const TOKEN = 'tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

describe('magic-link confirmation', () => {
  it('asks to confirm sign-in on this device; only the button consumes the link', async () => {
    window.history.replaceState(null, '', `/?account=confirm&token=${TOKEN}#/`);
    let signedIn = false;
    const verifyMagicLink = vi.fn(() => {
      signedIn = true;
      return Promise.resolve({ account: me().account, created: false, entitlements: FREE });
    });
    const client = fakeClient({
      me: () =>
        signedIn
          ? Promise.resolve(me())
          : Promise.reject(new AccountApiError(401, 'unauthorized', 'Sign in required')),
      verifyMagicLink,
    });
    render(<App client={client} initialData={emptyData()} />);
    expect(await screen.findByText('Confirm sign-in on this device')).toBeTruthy();
    // The token is removed from the address bar immediately and nothing was consumed yet.
    expect(window.location.search).toBe('');
    expect(verifyMagicLink).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in on this device' }));
    await waitFor(() => expect(verifyMagicLink).toHaveBeenCalledTimes(1));
    expect(verifyMagicLink).toHaveBeenCalledWith(TOKEN, expect.any(String));
    expect(await screen.findByText('You’re signed in')).toBeTruthy();
  });

  it('cancel leaves the person signed out; a used link shows the invalid-link notice', async () => {
    window.history.replaceState(null, '', `/?account=confirm&token=${TOKEN}#/`);
    const verifyMagicLink = vi.fn(() =>
      Promise.reject(new AccountApiError(400, 'invalid_token', 'Link used')),
    );
    render(<App client={fakeClient({ verifyMagicLink })} initialData={emptyData()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in on this device' }));
    expect(await screen.findByText('That sign-in link didn’t work')).toBeTruthy();
  });

  it('labels the device without identifying details', () => {
    expect(
      deviceLabel(
        'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
      ),
    ).toBe('Chrome on Android');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Version/18.0 Safari/604.1')).toBe(
      'Safari on iOS',
    );
  });
});

describe('household invites are never accepted automatically', () => {
  it('asks to accept or decline after sign-in', async () => {
    window.history.replaceState(null, '', `/?household_invite=${TOKEN}#/`);
    const acceptHouseholdInvite = vi.fn(() =>
      Promise.resolve({
        household: { id: 'h1', name: 'Home', ownerAccountId: 'o1', createdAt: '' },
        role: 'member' as const,
      }),
    );
    const client = fakeClient({ me: () => Promise.resolve(me()), acceptHouseholdInvite });
    render(<App client={client} initialData={emptyData()} />);
    expect(await screen.findByText('Join a household?')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 30));
    expect(acceptHouseholdInvite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(acceptHouseholdInvite).toHaveBeenCalledWith(TOKEN));
    expect(localStorage.getItem('due:household-invite')).toBeNull();
  });

  it('decline drops the invite without calling the server', async () => {
    localStorage.setItem('due:household-invite', TOKEN);
    const acceptHouseholdInvite = vi.fn();
    render(
      <App
        client={fakeClient({ me: () => Promise.resolve(me()), acceptHouseholdInvite })}
        initialData={emptyData()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    expect(screen.queryByText('Join a household?')).toBeNull();
    expect(localStorage.getItem('due:household-invite')).toBeNull();
    expect(acceptHouseholdInvite).not.toHaveBeenCalled();
  });
});

const PLANS: PublicPlansResponse = {
  currency: 'INR',
  plans: [
    {
      id: 'plus',
      name: 'Plus',
      priceInrMonthly: 149,
      priceInrYearly: 1299,
      billingCadences: ['monthly', 'yearly'],
      features: ['email_import'],
      active: true,
      checkoutAvailable: { monthly: true, yearly: true },
    },
  ],
  terms: { renewal: 'R', cancellation: 'C', refund: 'F', legalReviewStatus: 'pending' },
  cancellationPath: 'Account > Plan > Cancel',
  purchaseChannel: 'razorpay',
  paymentsAvailable: true,
};

describe('plans', () => {
  it('the offline price list does not offer the Household plan (not sold yet)', async () => {
    const client = fakeClient({
      getPublicPlans: () => Promise.reject(new AccountApiError(0, 'network_error', 'offline')),
    });
    renderApp({ client, hash: '#/plans' });
    expect(await screen.findByText('Indicative prices')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Plus' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Household' })).toBeNull();
  });

  it('inactive plans are never shown even if the API sends them', async () => {
    const client = fakeClient({
      getPublicPlans: () =>
        Promise.resolve({
          ...PLANS,
          plans: [
            ...PLANS.plans,
            { ...PLANS.plans[0], id: 'household' as const, name: 'Household', active: false },
          ],
        }),
    });
    renderApp({ client, hash: '#/plans' });
    expect(await screen.findByRole('heading', { name: 'Plus' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Household' })).toBeNull();
  });

  it('hides "Cancel subscription" for manual plans and blocks buying while a plan is active', async () => {
    const manual: Entitlements = {
      ...FREE,
      plan: 'plus',
      billingPeriod: 'monthly',
      periodEnd: '2026-12-01T00:00:00.000Z',
      channel: 'manual',
      features: ['backup', 'reminder_email'],
    };
    const client = fakeClient({
      me: () => Promise.resolve(me(manual)),
      getPublicPlans: () => Promise.resolve(PLANS),
    });
    renderApp({ client, hash: '#/plans' });
    expect(await screen.findByText(/set up by Due support/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel subscription' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Choose monthly' }));
    const go = (await screen.findByRole('button', {
      name: 'Continue to secure payment',
    })) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    expect(screen.getByText(/You already have a plan/)).toBeTruthy();
  });

  it('shows "Cancel subscription" for an active Razorpay subscription', async () => {
    const paid: Entitlements = {
      ...FREE,
      plan: 'plus',
      billingPeriod: 'monthly',
      periodEnd: '2026-12-01T00:00:00.000Z',
      channel: 'razorpay',
    };
    const client = fakeClient({
      me: () => Promise.resolve(me(paid)),
      getPublicPlans: () => Promise.resolve(PLANS),
    });
    renderApp({ client, hash: '#/plans' });
    expect(await screen.findByRole('button', { name: 'Cancel subscription' })).toBeTruthy();
  });
});
