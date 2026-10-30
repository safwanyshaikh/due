import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { DashboardPage } from '../pages/Dashboard';
import { mockFetch, renderAs } from './helpers';

// Fixture lives only in this test file.
const payload = {
  companies: 17,
  vendors: 4,
  activeSources: 63,
  monitoredSources: 58,
  newRecords7d: 0,
  updatedRecords7d: 912,
  failedFetches7d: 3,
  pendingVerification: 21,
  latestRuns: [{ id: 9, job_id: 'monitor_sources', triggered_by: 'schedule', started_at: '2026-10-30T04:30:00Z', status: 'success' }],
  automation: {
    jobs: [
      {
        id: 'monitor_sources',
        enabled: true,
        interval_minutes: 60,
        last_run_at: '2026-10-30T04:30:00Z',
        next_run_at: '2026-10-30T05:30:00Z',
        last_status: 'success',
      },
    ],
  },
};

describe('dashboard', () => {
  it('renders counters exactly as returned by the API', async () => {
    mockFetch((url) => {
      if (url === '/api/admin/dashboard') return { body: payload };
      if (url.startsWith('/api/admin/alerts')) return { body: [] };
      return undefined;
    });
    renderAs('viewer', <DashboardPage />);
    const expected: Record<string, string> = {
      companies: '17',
      vendors: '4',
      activeSources: '63',
      monitoredSources: '58',
      newRecords7d: '0',
      updatedRecords7d: '912',
      failedFetches7d: '3',
      pendingVerification: '21',
    };
    for (const [key, value] of Object.entries(expected)) {
      const tile = await screen.findByTestId(`stat-${key}`);
      expect(within(tile).getByText(value)).toBeInTheDocument();
    }
    expect(screen.getAllByText('Checked every 1 hour').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/IST$/).length).toBeGreaterThan(0);
    expect(screen.getByText('No unread alerts.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/real-time/i);
  });

  it('shows Data unavailable when the API fails', async () => {
    mockFetch((url) => (url.startsWith('/api/admin/dashboard') ? { status: 500 } : { body: [] }));
    renderAs('viewer', <DashboardPage />);
    expect(await screen.findByText('Data unavailable.')).toBeInTheDocument();
  });
});
