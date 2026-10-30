// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { AccountApiError } from '../../lib/account/client';
import type { PublicPlansResponse } from '../../lib/account/types';
import { fakeClient, renderApp, stubNetwork } from './harness';
import { EMAIL_UNAVAILABLE_COPY } from '../screens/AccountScreen';
import { PAYMENTS_UNAVAILABLE_COPY } from '../screens/PlansScreen';
import { applyMotionClass, REDUCE_MOTION_CLASS } from '../lib/motion';

beforeEach(stubNetwork);
afterEach(cleanup);

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
      checkoutAvailable: { monthly: false, yearly: false },
    },
  ],
  terms: {
    renewal: 'Renews until cancelled.',
    cancellation: 'Cancel anytime.',
    refund: 'No refunds for partial periods.',
    legalReviewStatus: 'pending',
  },
  cancellationPath: 'Account > Plan > Cancel',
  purchaseChannel: null,
  paymentsAvailable: false,
};

describe('truthful unavailable states', () => {
  it('magic link 503 email_unavailable shows the exact copy', async () => {
    const client = fakeClient({
      requestMagicLink: () =>
        Promise.reject(new AccountApiError(503, 'email_unavailable', 'Email is not configured')),
    });
    renderApp({ client, hash: '#/account' });
    const input = await screen.findByLabelText('Email address');
    fireEvent.change(input, { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Email me a sign-in link' }));
    expect(await screen.findByText(EMAIL_UNAVAILABLE_COPY)).toBeTruthy();
  });

  it('plans from the API with payments unavailable: disclosure shown, purchase disabled', async () => {
    const client = fakeClient({ getPublicPlans: () => Promise.resolve(PLANS) });
    renderApp({ client, hash: '#/plans' });
    expect((await screen.findAllByText(PAYMENTS_UNAVAILABLE_COPY)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Choose yearly' }));
    expect(screen.getByText('Cancel anytime.')).toBeTruthy();
    expect(screen.getByText('No refunds for partial periods.')).toBeTruthy();
    expect(screen.getByText(/unless you cancel before then/)).toBeTruthy();
    expect(screen.queryByText(/Indicative/)).toBeNull();
  });

  it('checkout returning payments_unavailable shows the disabled state', async () => {
    const client = fakeClient({
      me: () =>
        Promise.resolve({
          account: {
            id: 'a1',
            email: 'me@example.com',
            displayName: null,
            createdAt: '',
            lastLoginAt: null,
          },
          sessionId: 's1',
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
      getPublicPlans: () =>
        Promise.resolve({
          ...PLANS,
          paymentsAvailable: true,
          purchaseChannel: 'razorpay',
          plans: [{ ...PLANS.plans[0], checkoutAvailable: { monthly: true, yearly: true } }],
        }),
      checkout: () =>
        Promise.reject(
          new AccountApiError(503, 'payments_unavailable', 'Payments are not configured'),
        ),
    });
    renderApp({ client, hash: '#/plans' });
    fireEvent.click(await screen.findByRole('button', { name: 'Choose monthly' }));
    const go = await screen.findByRole('button', { name: 'Continue to secure payment' });
    fireEvent.click(go);
    expect(await screen.findByText(PAYMENTS_UNAVAILABLE_COPY)).toBeTruthy();
  });

  it('plans fall back to indicative constants when the API is unreachable', async () => {
    const client = fakeClient({
      getPublicPlans: () =>
        Promise.reject(new AccountApiError(0, 'network_error', 'Could not reach the server')),
    });
    renderApp({ client, hash: '#/plans' });
    expect(await screen.findByText('Indicative prices')).toBeTruthy();
  });
});

describe('reduced motion', () => {
  it('adds the class when the system asks for reduced motion and removes it otherwise', () => {
    const root = document.createElement('div');
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q })) as never;
    expect(applyMotionClass(false, root)).toBe(true);
    expect(root.classList.contains(REDUCE_MOTION_CLASS)).toBe(true);
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as never;
    expect(applyMotionClass(false, root)).toBe(false);
    expect(root.classList.contains(REDUCE_MOTION_CLASS)).toBe(false);
    expect(applyMotionClass(true, root)).toBe(true);
  });
});
