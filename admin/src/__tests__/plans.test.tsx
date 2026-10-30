import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { PlansPage, planPatch, parsePrice, type PlanRow } from '../pages/Plans';
import { mockFetch, renderAs } from './helpers';

const rows = [
  { id: 'free', name: 'Free', price_inr_monthly: null, price_inr_yearly: null, active: true, features: [], provider_plan_ids: {}, sort_order: 0, updated_at: '2026-10-30T10:00:00Z' },
  { id: 'plus', name: 'Plus', price_inr_monthly: 149, price_inr_yearly: 1299, active: true, features: [], provider_plan_ids: { monthly: 'plan_PLUSM12345' }, sort_order: 1, updated_at: '2026-10-30T10:00:00Z' },
  { id: 'household', name: 'Household', price_inr_monthly: 249, price_inr_yearly: 2199, active: false, features: [], provider_plan_ids: {}, sort_order: 2, updated_at: '2026-10-30T10:00:00Z' },
];

describe('plans page', () => {
  it('validates prices and Razorpay plan ids before saving', () => {
    expect(parsePrice('149')).toBe(149);
    expect(parsePrice(' 1299.50 ')).toBe(1299.5);
    expect(parsePrice('')).toBeNull();
    expect(parsePrice('12,99')).toBeUndefined();
    const plus = { id: 'plus', name: 'Plus' } as PlanRow;
    expect(planPatch(plus, { monthly: '179', yearly: '', active: true, rzpMonthly: 'plan_ABC123xyz', rzpYearly: '' })).toEqual({
      body: { active: true, providerPlanIds: { monthly: 'plan_ABC123xyz', yearly: null }, priceInrMonthly: 179, priceInrYearly: null },
    });
    expect(planPatch(plus, { monthly: '179', yearly: '', active: true, rzpMonthly: 'sub_123', rzpYearly: '' })).toHaveProperty('error');
    expect(planPatch(plus, { monthly: 'abc', yearly: '', active: true, rzpMonthly: '', rzpYearly: '' })).toHaveProperty('error');
  });

  it('admins edit price, active flag and Razorpay ids; the PATCH goes to /api/admin/plans/:id', async () => {
    const calls: { url: string; body: unknown }[] = [];
    mockFetch((url, init) => {
      if (url === '/api/admin/plans' && (!init?.method || init.method === 'GET')) return { body: { items: rows, total: 3, payments_configured: true } };
      if (url.startsWith('/api/admin/plans/') && init?.method === 'PATCH') {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return { body: rows[2] };
      }
      return undefined;
    });
    renderAs('admin', <PlansPage />, '/plans');
    const form = await screen.findByRole('form', { name: 'Household plan' });
    expect(form.textContent).toContain('Not sold');
    const inputs = form.querySelectorAll('input');
    fireEvent.change(inputs[0], { target: { value: '299' } });
    fireEvent.change(inputs[2], { target: { value: 'plan_HOUSE12345' } });
    fireEvent.click(form.querySelector('input[type="checkbox"]')!);
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[2]);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual({
      url: '/api/admin/plans/household',
      body: { active: true, providerPlanIds: { monthly: 'plan_HOUSE12345', yearly: null }, priceInrMonthly: 299, priceInrYearly: 2199 },
    });
  });

  it('is read-only for editors', async () => {
    mockFetch((url) => (url === '/api/admin/plans' ? { body: { items: rows, total: 3, payments_configured: false } } : undefined));
    renderAs('editor', <PlansPage />, '/plans');
    expect(await screen.findByText(/Read-only/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.getByText(/Razorpay keys are not configured/)).toBeTruthy();
  });
});
