// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { AccountApiError } from '../../lib/account/client';
import type { Requester } from '../../lib/account/identities';
import type { PublicPlansResponse } from '../../lib/account/types';
import { createPlatformClient, normaliseStatus, setPlatformClient } from '../lib/platform';
import { fakeClient, renderApp, stubNetwork } from './harness';

const STATUS = (beta: unknown) => ({
  incident: null,
  integrations: {
    smtp: 'live',
    inbound: 'not_configured',
    gmail: 'not_configured',
    billing: 'test_mode',
  },
  beta,
});

function fakePlatform(routes: Record<string, unknown>) {
  const req: Requester = async <T,>(method: string, path: string) => {
    const key = `${method} ${path.split('?')[0]}`;
    if (!(key in routes)) throw new AccountApiError(404, 'not_found', 'Not found');
    return routes[key] as T;
  };
  setPlatformClient(createPlatformClient({}, req));
}

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
  terms: { renewal: 'r', cancellation: 'c', refund: 'f', legalReviewStatus: 'pending' },
  cancellationPath: 'Account > Plan',
  purchaseChannel: 'razorpay',
  paymentsAvailable: true,
};

beforeEach(() => {
  stubNetwork();
  setPlatformClient(null);
});
afterEach(() => {
  cleanup();
  setPlatformClient(null);
});

describe('beta status', () => {
  it('normalises the beta block and defaults to off', () => {
    expect(normaliseStatus({}).beta).toEqual({ plusFree: false, endsOn: null });
    expect(normaliseStatus({ beta: { plusFree: true, endsOn: '2026-12-31' } }).beta).toEqual({
      plusFree: true,
      endsOn: '2026-12-31',
    });
    expect(normaliseStatus({ beta: { plusFree: 'yes', endsOn: 'soon' } }).beta).toEqual({
      plusFree: false,
      endsOn: null,
    });
  });
});

describe('Plans during the free beta', () => {
  it('shows "Free during beta" with the end date and hides checkout', async () => {
    fakePlatform({ 'GET /api/public/status': STATUS({ plusFree: true, endsOn: '2026-12-31' }) });
    renderApp({
      hash: '#/plans',
      client: fakeClient({ getPublicPlans: () => Promise.resolve(PLANS) }),
    });
    const notice = await screen.findByTestId('beta-notice');
    expect(notice.textContent).toContain('31 Dec 2026');
    expect(screen.getByTestId('plan-beta-price').textContent).toBe('Free during beta');
    expect(screen.queryByRole('button', { name: 'Choose monthly' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose yearly' })).toBeNull();
    expect(screen.queryByText('Continue to secure payment')).toBeNull();
    expect(screen.queryByText(/₹149/)).toBeNull();
  });

  it('shows the paid flow when the beta is off', async () => {
    fakePlatform({ 'GET /api/public/status': STATUS({ plusFree: false, endsOn: null }) });
    renderApp({
      hash: '#/plans',
      client: fakeClient({ getPublicPlans: () => Promise.resolve(PLANS) }),
    });
    await screen.findByRole('button', { name: 'Choose monthly' });
    expect(screen.queryByTestId('beta-notice')).toBeNull();
  });
});

describe('start page', () => {
  it('leads with the choices (no repeated hero), the beta badge and the policy links', async () => {
    fakePlatform({ 'GET /api/public/status': STATUS({ plusFree: true, endsOn: null }) });
    renderApp({ hash: '#/start' });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'How would you like to start?' }),
    ).toBeTruthy();
    expect(screen.queryByText('Same life. Smaller bills.')).toBeNull();
    expect(screen.queryByTestId('start-benefits')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('beta-badge').textContent).toBe('Free during beta'),
    );
    const legal = screen.getByTestId('start-legal');
    expect(legal.querySelector('a[href="#/legal/privacy"]')).toBeTruthy();
    expect(legal.querySelector('a[href="#/legal/terms"]')).toBeTruthy();
    for (const d of ['refund', 'delivery', 'contact', 'cookies'])
      expect(legal.querySelector(`a[href="#/legal/${d}"]`)).toBeTruthy();
  });

  it('shows no beta badge when the beta is off or the status is unavailable', async () => {
    fakePlatform({ 'GET /api/public/status': STATUS({ plusFree: false, endsOn: null }) });
    renderApp({ hash: '#/start' });
    await screen.findByRole('heading', { level: 1, name: 'How would you like to start?' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('beta-badge')).toBeNull();
  });
});

describe('landing page', () => {
  const APPS = { androidUrl: 'https://play.google.com/store/apps/details?id=x', iosUrl: null };

  it('shows tagline, benefits, steps, privacy line, Open Due and only the store buttons that are set', async () => {
    fakePlatform({
      'GET /api/public/status': { ...STATUS({ plusFree: true, endsOn: null }), apps: APPS },
    });
    renderApp({ hash: '', landing: true });
    const landing = await screen.findByTestId('landing');
    expect(landing.textContent).toContain('Same life. Smaller bills.');
    expect(screen.getByTestId('start-benefits').querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByTestId('how-steps').querySelectorAll('li')).toHaveLength(3);
    expect(screen.getByTestId('landing-privacy').textContent).toBe(
      'Your statements are read on your phone.',
    );
    expect(screen.getByRole('link', { name: 'Start free, no sign-up' }).getAttribute('href')).toBe(
      '#/start',
    );
    await waitFor(() =>
      expect(screen.getByTestId('beta-badge').textContent).toBe('Free during beta'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('store-android').getAttribute('href')).toBe(APPS.androidUrl),
    );
    expect(screen.getByTestId('store-android').textContent).toBe('Get it on Google Play');
    expect(screen.queryByTestId('store-ios')).toBeNull();
    expect(landing.textContent).not.toMatch(/guarantee/i);
  });

  it('hides both store buttons when no links are set, and ignores non-https links', async () => {
    fakePlatform({
      'GET /api/public/status': {
        ...STATUS({ plusFree: false, endsOn: null }),
        apps: { androidUrl: 'javascript:alert(1)', iosUrl: null },
      },
    });
    renderApp({ hash: '', landing: true });
    await screen.findByTestId('landing');
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByTestId('store-android')).toBeNull();
    expect(screen.queryByTestId('store-ios')).toBeNull();
  });

  it('after Open Due the landing is remembered as seen on this device', async () => {
    fakePlatform({ 'GET /api/public/status': STATUS({ plusFree: false, endsOn: null }) });
    renderApp({ hash: '', landing: true });
    fireEvent.click(await screen.findByRole('link', { name: 'Start free, no sign-up' }));
    expect(window.localStorage.getItem('due:landing-opened')).toBe('1');
    await waitFor(() => expect(screen.queryByTestId('landing')).toBeNull());
  });
});

describe('Plans with Cashfree', () => {
  it('asks for a mobile number, sends only plan, cadence and phone, and shows the GST wording from the server', async () => {
    fakePlatform({ 'GET /api/public/status': STATUS({ plusFree: false, endsOn: null }) });
    const sent: unknown[] = [];
    const plans = {
      ...PLANS,
      purchaseChannel: 'cashfree' as const,
      tax: {
        note: 'Prices include 18% GST.',
        pricesIncludeTax: true,
        gstRegistered: true,
        gstin: '27AAAAA0000A1Z2',
      },
    };
    const client = fakeClient({
      getPublicPlans: () => Promise.resolve(plans),
      me: () =>
        Promise.resolve({
          account: {
            id: 'a1',
            email: 'a@example.com',
            displayName: null,
            createdAt: '',
            lastLoginAt: null,
          },
          sessionId: 's',
          entitlements: {
            plan: 'free',
            status: 'active',
            billingPeriod: null,
            periodEnd: null,
            channel: null,
            features: [],
            householdAccess: null,
          },
        }),
      checkout: (plan: string, cadence: string, phone?: string) => {
        sent.push({ plan, cadence, phone });
        return Promise.resolve({
          provider: 'cashfree',
          subscriptionId: 'due_x',
          shortUrl: 'https://pay.example.test/x',
          plan: 'plus',
          billingPeriod: 'monthly',
          amountInr: 149,
          renewal: 'Renews every month until you cancel.',
          cancellationPath: '',
          terms: {},
        });
      },
    });
    renderApp({ hash: '#/plans', client });
    expect((await screen.findByTestId('tax-note')).textContent).toContain(
      'Prices include 18% GST.',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Choose monthly' }));
    const pay = screen.getByRole('button', {
      name: 'Continue to secure payment',
    }) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByTestId('checkout-phone')).toBeTruthy());
    expect(pay.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('checkout-phone'), { target: { value: '9876543210' } });
    await waitFor(() => expect(pay.disabled).toBe(false));
    fireEvent.click(pay);
    await waitFor(() =>
      expect(sent).toEqual([{ plan: 'plus', cadence: 'monthly', phone: '9876543210' }]),
    );
    expect(await screen.findByText(/Open Cashfree to complete payment/)).toBeTruthy();
  });
});
