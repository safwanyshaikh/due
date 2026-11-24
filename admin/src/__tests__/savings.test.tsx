import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { SavingsPage, emptyForm, formToModule, moduleToForm, type SavingsModuleRow } from '../pages/Savings';
import { mockFetch, renderAs } from './helpers';

const mod: SavingsModuleRow = {
  id: 'uber-one-in',
  version: 2,
  status: 'research',
  detect: { merchantAliases: ['UBER ONE'], senderDomains: ['uber.com'], keywords: [] },
  provider: 'Uber',
  product: 'Uber One',
  category: 'mobility',
  country: 'IN',
  cityPack: null,
  rules: { prices: [{ label: 'Monthly', priceInr: null, periodDays: 30 }] },
  valueKind: 'membership_breakeven',
  proof: { signal: 'charge_stopped', description: 'Charge stops' },
  nudge: { trigger: 'before_renewal', leadDays: 3 },
  legalRole: 'information',
  sources: [{ url: 'https://example.test/uber', label: 'Uber One', kind: 'official', lastVerifiedAt: '2026-11-10T00:00:00Z' }],
  actionUrl: 'https://example.test/uber',
  actionLabel: 'Open',
  updatedAt: '2026-11-20T00:00:00Z',
};

describe('savings form helpers', () => {
  it('round-trips a module and never sends status, version or updatedAt', () => {
    const r = formToModule(moduleToForm(mod));
    expect('body' in r).toBe(true);
    const body = 'body' in r ? r.body : {};
    expect(body).toMatchObject({ id: 'uber-one-in', cityPack: null, rules: mod.rules, sources: [{ lastVerifiedAt: '2026-11-10T00:00:00Z' }] });
    for (const k of ['status', 'version', 'updatedAt']) expect(k in body).toBe(false);
  });
  it('rejects bad ids, bad rules JSON and sources without URLs', () => {
    const f = moduleToForm(mod);
    expect(formToModule({ ...f, id: 'Bad Id' })).toHaveProperty('error');
    expect(formToModule({ ...f, rulesJson: '{oops' })).toHaveProperty('error');
    expect(formToModule({ ...f, rulesJson: '[]' })).toHaveProperty('error');
    expect(formToModule({ ...f, sources: [{ url: 'ftp://x', label: 'x', kind: 'official', lastVerifiedAt: '' }] })).toHaveProperty('error');
    expect(formToModule(emptyForm())).toHaveProperty('error');
  });
});

describe('Savings page', () => {
  it('lists modules, shows grouped fields, saves with PUT, and verifies', async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    mockFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (method !== 'GET') calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/admin/savings/modules/uber-one-in/verify') return { body: { ...mod, status: 'verified', version: 3 } };
      if (url === '/api/admin/savings/modules/uber-one-in' && method === 'PUT') return { body: { ...mod, version: 3 } };
      if (url.startsWith('/api/admin/savings/modules')) return { body: { items: [mod], total: 1 } };
      return undefined;
    });
    renderAs('editor', <SavingsPage />, '/savings');
    expect(await screen.findByText('Uber One')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Uber One' }));
    const form = await screen.findByRole('form', { name: 'Module uber-one-in' });
    for (const g of ['Identify', 'Detect', 'Rules', 'Value', 'Proof', 'Nudge', 'Legal', 'Sources']) {
      expect(within(form).getByRole('group', { name: g })).toBeInTheDocument();
    }
    fireEvent.change(within(form).getByLabelText('Action label'), { target: { value: 'Go' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save module' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ method: 'PUT', url: '/api/admin/savings/modules/uber-one-in', body: { actionLabel: 'Go' } });
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Verify' }));
    await waitFor(() => expect(calls[1]).toMatchObject({ method: 'POST', url: '/api/admin/savings/modules/uber-one-in/verify' }));
    expect(await screen.findByText('Marked verified.')).toBeInTheDocument();
  });

  it('shows a server refusal to verify', async () => {
    mockFetch((url, init) => {
      if (init?.method === 'POST')
        return { status: 422, body: { error: { code: 'verification_required', message: 'Verification needs an official source checked within the last 30 days' } } };
      if (url.startsWith('/api/admin/savings/modules')) return { body: { items: [mod], total: 1 } };
      return undefined;
    });
    renderAs('editor', <SavingsPage />, '/savings');
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Uber One' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verify' }));
    expect(await screen.findByText(/official source checked within the last 30 days/)).toBeInTheDocument();
  });

  it('viewers cannot edit', async () => {
    mockFetch((url) => (url.startsWith('/api/admin/savings/modules') ? { body: { items: [mod], total: 1 } } : undefined));
    renderAs('viewer', <SavingsPage />, '/savings');
    expect(await screen.findByText('Uber One')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New module' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'View Uber One' }));
    expect(screen.queryByRole('button', { name: 'Save module' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify' })).not.toBeInTheDocument();
  });

  it('city packs and the research queue tabs', async () => {
    const patches: unknown[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'PATCH') {
        patches.push({ url, body: JSON.parse(String(init.body)) });
        return { body: { id: 7, providerLabel: 'Pocket FM', category: 'music', cityPack: null, requestCount: 4, lastSeen: '2026-11-20T00:00:00Z', status: 'researching', moduleId: null } };
      }
      if (url.startsWith('/api/admin/savings/city-packs'))
        return { body: { items: [{ id: 'in-mmr', name: 'Mumbai', status: 'research', passes: [{}], localities: ['Thane', 'Powai'], updatedAt: '2026-11-20T00:00:00Z' }] } };
      if (url.startsWith('/api/admin/savings/research'))
        return { body: { items: [{ id: 7, providerLabel: 'Pocket FM', category: 'music', cityPack: null, requestCount: 4, lastSeen: '2026-11-20T00:00:00Z', status: 'open', moduleId: null }] } };
      return { body: { items: [] } };
    });
    renderAs('editor', <SavingsPage />, '/savings');
    fireEvent.click(await screen.findByRole('tab', { name: 'City packs' }));
    expect(await screen.findByText('Mumbai')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Research queue' }));
    expect(await screen.findByText('Pocket FM')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Status for Pocket FM'), { target: { value: 'researching' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Pocket FM' }));
    await waitFor(() => expect(patches).toEqual([{ url: '/api/admin/savings/research/7', body: { status: 'researching', moduleId: null } }]));
  });
});
