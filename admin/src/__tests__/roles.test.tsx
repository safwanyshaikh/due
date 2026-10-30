import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { can } from '../lib/auth';
import { CompaniesPage } from '../pages/Companies';
import { SourcesPage } from '../pages/Sources';
import { Layout } from '../components/Layout';
import { mockFetch, renderAs } from './helpers';

const company = {
  id: 'c1',
  kind: 'company',
  name: 'Acme Test Co',
  status: 'active',
  verification_status: 'pending',
  monitoring_enabled: true,
};
const source = {
  id: 's1',
  company_id: 'c1',
  url: 'https://example.test/pricing',
  label: 'Pricing',
  source_category: 'pricing',
  is_official: true,
  extraction_method: 'html_text',
  priority: 'regular',
  frequency_minutes: 1440,
  enabled: true,
  status: 'active',
};

function routes(url: string) {
  if (url.startsWith('/api/admin/companies')) return { body: [company] };
  if (url.startsWith('/api/admin/sources')) return { body: [source] };
  if (url.startsWith('/api/admin/categories')) return { body: [] };
  return undefined;
}

describe('role gating', () => {
  it('permission ladder matches the contract', () => {
    expect(can('viewer', 'read')).toBe(true);
    expect(can('viewer', 'edit')).toBe(false);
    expect(can('editor', 'edit')).toBe(true);
    expect(can('editor', 'admin')).toBe(false);
    expect(can('admin', 'admin')).toBe(true);
    expect(can('admin', 'owner')).toBe(false);
    expect(can('owner', 'owner')).toBe(true);
    expect(can(null, 'read')).toBe(false);
  });

  it('hides mutating company controls for viewers', async () => {
    mockFetch(routes);
    renderAs('viewer', <CompaniesPage />, '/companies');
    expect(await screen.findByText('Acme Test Co')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add company/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /archive/i })).not.toBeInTheDocument();
  });

  it('shows company controls for editors', async () => {
    mockFetch(routes);
    renderAs('editor', <CompaniesPage />, '/companies');
    expect(await screen.findByText('Acme Test Co')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add company/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /archive/i })).toBeInTheDocument();
  });

  it('hides source actions for viewers and labels polling frequency', async () => {
    mockFetch(routes);
    renderAs('viewer', <SourcesPage />, '/sources');
    expect(await screen.findByText('Pricing')).toBeInTheDocument();
    expect(screen.getByText('Checked every 1 day')).toBeInTheDocument();
    for (const name of [/add source/i, /run now/i, /validate/i, /disable/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('hides the Users nav item for editors and shows it for admins', async () => {
    mockFetch(() => ({ body: {} }));
    const { unmount } = renderAs(
      'editor',
      <Routes>
        <Route path="/" element={<Layout />} />
      </Routes>,
    );
    await waitFor(() => expect(screen.getByRole('link', { name: 'Dashboard' })).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: /users & access/i })).not.toBeInTheDocument();
    unmount();
    renderAs(
      'admin',
      <Routes>
        <Route path="/" element={<Layout />} />
      </Routes>,
    );
    expect(screen.getByRole('link', { name: /users & access/i })).toBeInTheDocument();
  });
});
