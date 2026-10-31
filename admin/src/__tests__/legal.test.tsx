import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { LegalPage, legalValue, parseSubprocessors } from '../pages/Legal';
import { mockFetch, renderAs } from './helpers';

const incomplete = { complete: false, missing: ['legal.entity_name', 'legal.grievance_email'] };

describe('legal details', () => {
  it('the admin shell shows "Legal details incomplete" with the missing fields until the server says complete', async () => {
    mockFetch((url) => (url.endsWith('/api/public/legal') ? { body: incomplete } : { body: {} }));
    renderAs('viewer', <Routes><Route element={<Layout />}><Route path="/" element={<p>Home</p>} /></Route></Routes>);
    const banner = await screen.findByTestId('legal-incomplete');
    expect(banner).toHaveTextContent('Legal details incomplete');
    expect(banner).toHaveTextContent('Legal entity name, Grievance officer email');
  });

  it('shows nothing once complete', async () => {
    const fn = mockFetch((url) => (url.endsWith('/api/public/legal') ? { body: { complete: true, missing: [] } } : { body: {} }));
    renderAs('viewer', <Routes><Route element={<Layout />}><Route path="/" element={<p>Home</p>} /></Route></Routes>);
    await waitFor(() => expect(fn).toHaveBeenCalled());
    await screen.findByText('Home');
    expect(screen.queryByTestId('legal-incomplete')).toBeNull();
  });

  it('admins edit legal fields; only changed keys are saved through PATCH /api/admin/settings', async () => {
    const patches: unknown[] = [];
    mockFetch((url, init) => {
      if (url.endsWith('/api/public/legal')) return { body: incomplete };
      if (url.endsWith('/api/admin/settings') && init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return { body: {} };
      }
      if (url.endsWith('/api/admin/settings')) return { body: { 'legal.entity_name': '', 'legal.subprocessors': [], 'legal.effective_date': null } };
      return undefined;
    });
    renderAs('admin', <LegalPage />);
    expect(await screen.findByTestId('legal-incomplete')).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('Legal entity name'), { target: { value: 'Due Technologies Pvt Ltd' } });
    fireEvent.change(screen.getByLabelText('Effective date'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Subprocessors'), { target: { value: 'Render | Hosting | Singapore' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save legal details' }));
    await waitFor(() => expect(patches).toHaveLength(3));
    expect(patches).toEqual([
      { key: 'legal.entity_name', value: 'Due Technologies Pvt Ltd' },
      { key: 'legal.effective_date', value: '2026-11-01' },
      { key: 'legal.subprocessors', value: [{ name: 'Render', purpose: 'Hosting', region: 'Singapore' }] },
    ]);
  });

  it('viewers see the form read-only', async () => {
    mockFetch((url) => (url.endsWith('/api/public/legal') ? { body: incomplete } : { body: { 'legal.entity_name': 'X' } }));
    renderAs('viewer', <LegalPage />);
    expect(await screen.findByLabelText('Legal entity name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save legal details' })).toBeNull();
  });

  it('parses subprocessor lines and date values', () => {
    expect(parseSubprocessors('A | B | C\n\nD|E|F').items).toHaveLength(2);
    expect(parseSubprocessors('A | B').error).toMatch(/Line 1/);
    expect(legalValue('legal.effective_date', '')).toBeNull();
    expect(legalValue('legal.terms_md', '# T')).toBe('# T');
  });
});
