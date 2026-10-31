import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { AppRoutes } from '../App';
import { Layout } from '../components/Layout';
import { OfferDetailPage, OffersPage, offerEditPatch } from '../pages/Offers';
import { ReviewPage } from '../pages/Review';
import { ParsersPage, parserCreateBody } from '../pages/Parsers';
import { IncidentPage, IntegrationsPage, QueuePage, safeDetail } from '../pages/Operations';
import { mockFetch, renderAs } from './helpers';

const offer = {
  id: 'airtel-699-prime',
  provider: 'airtel',
  provider_family: 'airtel',
  product_family: 'Airtel prepaid',
  name: 'Airtel ₹699 with Prime',
  benefit_type: 'bundle',
  price_inr: 699,
  billing_period: 'none',
  benefit_value: { primeDays: 56 },
  source_urls: ['https://example.test/plan'],
  official_start_at: null,
  official_end_at: null,
  terms_status: 'active',
  page_status: 'visible',
  status: 'active_verify',
  status_reason: 'stale_beyond_freshness_window',
  confidence: 'high',
  effective_confidence: 'medium',
  freshness: { state: 'stale', reference_at: '2026-10-20T00:00:00Z', age_hours: 200, window_hours: 168 },
  freshness_window_hours: 168,
  sku: '699',
  geography: null,
  superseded_by: null,
  notes: [],
  verification_status: 'research_snapshot',
  last_successful_check_at: '2026-10-20T00:00:00Z',
  last_attempted_check_at: '2026-10-29T00:00:00Z',
  last_check_error: 'https://example.test/plan: HTTP 500',
  last_confirmed_at: '2026-10-20T00:00:00Z',
  pending_reviews: 1,
  observation_count: 2,
};

const review = {
  id: 5,
  offer_id: 'airtel-699-prime',
  offer_name: 'Airtel ₹699 with Prime',
  provider: 'airtel',
  change_kind: 'price',
  proposed: { price: 719 },
  current: { price: 699 },
  status: 'pending',
  created_at: '2026-10-30T09:00:00Z',
  source_url: 'https://example.test/plan',
  source_label: 'Plans page',
  parser_version: 'v1',
  observed_at: '2026-10-30T09:00:00Z',
  decided_by_email: null,
  decided_at: null,
  note: null,
};

describe('offers pages', () => {
  it('lists computed status, freshness and last successful vs last attempted check', async () => {
    mockFetch((url) => (url.startsWith('/api/admin/offers') ? { body: { items: [offer], total: 1 } } : undefined));
    renderAs('viewer', <OffersPage />, '/offers');
    const row = (await screen.findByRole('link', { name: 'Airtel ₹699 with Prime' })).closest('tr')!;
    expect(within(row).getByText('Active — verify')).toBeInTheDocument();
    expect(within(row).getByText(/Stale \(200 h, window 168 h\)/)).toBeInTheDocument();
    expect(within(row).getByText('Last attempt failed')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: '1 to review' })).toHaveAttribute('href', '/review?offerId=airtel-699-prime');
    expect(screen.queryByRole('button', { name: /recompute/i })).not.toBeInTheDocument();
  });

  it('offer detail shows observation diffs and lets editors refresh; edits never send a status', async () => {
    const calls: string[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'POST') {
        calls.push(url);
        return { status: 202, body: { jobs: [{ source_id: 's1', job_id: 'j1', deduped: false }] } };
      }
      if (url.includes('/observations'))
        return {
          body: {
            items: [
              { id: 2, source_url: 'https://example.test/plan', observed_at: '2026-10-30T09:00:00Z', parser_version: 'v1', fields: {}, diff: [{ field: 'price', from: 699, to: 719 }], first_for_source: false, http_status: 200 },
            ],
            total: 1,
          },
        };
      if (url.startsWith('/api/admin/offers/airtel-699-prime'))
        return {
          body: {
            ...offer,
            monitored_sources: [{ id: 's1', url: 'https://example.test/plan', label: 'Plans page', source_category: 'pricing', status: 'active', candidate: false, last_success_at: null }],
            transitions: [{ id: 1, from_status: 'active', to_status: 'active_verify', reason: 'stale_beyond_freshness_window', actor: 'system', actor_email: null, at: '2026-10-28T00:00:00Z' }],
          },
        };
      return undefined;
    });
    renderAs(
      'editor',
      <Routes>
        <Route path="/offers/:id" element={<OfferDetailPage />} />
      </Routes>,
      '/offers/airtel-699-prime',
    );
    expect(await screen.findByText(/Price: 699 → 719/)).toBeInTheDocument();
    expect(screen.getByText('Active → Active — verify')).toBeInTheDocument();
    expect(screen.getByText(/HTTP 500/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(calls).toEqual(['/api/admin/offers/airtel-699-prime/refresh']));
    expect(await screen.findByText(/Refresh queued for 1 source/)).toBeInTheDocument();

    const base = { name: 'X', priceInr: '719', officialEndAt: '', termsStatus: 'active', pageStatus: 'visible', confidence: 'high', freshnessWindowHours: '168', sku: '', geography: '' };
    const ok = offerEditPatch(base);
    expect(ok).toEqual({ body: { name: 'X', priceInr: 719, officialEndAt: null, termsStatus: 'active', pageStatus: 'visible', confidence: 'high', freshnessWindowHours: 168, sku: null, geography: null } });
    expect('body' in ok && 'computedStatus' in ok.body).toBe(false);
    expect(offerEditPatch({ ...base, officialEndAt: '31/12/2026' })).toHaveProperty('error');
    expect(offerEditPatch({ ...base, freshnessWindowHours: '0' })).toHaveProperty('error');
  });
});

describe('change review queue', () => {
  it('editors approve with a note; the request goes to /api/admin/review/:id/approve', async () => {
    const posts: { url: string; body: unknown }[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return { body: { review: { ...review, status: 'approved' }, offer_id: 'airtel-699-prime', offer_status: 'active_verify' } };
      }
      if (url.startsWith('/api/admin/review')) return { body: { items: [review], total: 1, counts: { pending: 1 } } };
      return undefined;
    });
    renderAs('editor', <ReviewPage />, '/review');
    const card = await screen.findByRole('article', { name: 'Change 5' });
    expect(within(card).getByText('699')).toBeInTheDocument();
    expect(within(card).getByText('719')).toBeInTheDocument();
    fireEvent.change(within(card).getByLabelText(/Note/), { target: { value: 'Matches the plans page' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/admin/review/5/approve', body: { note: 'Matches the plans page' } }]));
  });

  it('editors can reject without a note', async () => {
    const posts: { url: string; body: unknown }[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return { body: { review: { ...review, status: 'rejected' } } };
      }
      return url.startsWith('/api/admin/review') ? { body: { items: [review], total: 1, counts: {} } } : undefined;
    });
    renderAs('admin', <ReviewPage />, '/review');
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/admin/review/5/reject', body: { note: null } }]));
  });

  it('is read-only for viewers', async () => {
    mockFetch((url) => (url.startsWith('/api/admin/review') ? { body: { items: [review], total: 1, counts: { pending: 1 } } } : undefined));
    renderAs('viewer', <ReviewPage />, '/review');
    expect(await screen.findByText(/Read-only. Editors can approve/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });
});

describe('parser versions', () => {
  const versions = {
    items: [
      { id: 2, source_id: 's1', source_label: 'Plans page', provider: null, version: 'v2', rules: {}, active: false, created_at: '2026-10-30T09:00:00Z' },
      { id: 1, source_id: 's1', source_label: 'Plans page', provider: null, version: 'v1', rules: {}, active: true, created_at: '2026-10-29T09:00:00Z' },
    ],
  };

  it('admins create and activate; the activate call targets the version id', async () => {
    const posts: string[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'POST') {
        posts.push(url);
        return { body: { ...versions.items[0], active: true } };
      }
      return url.startsWith('/api/admin/parser-versions') ? { body: versions } : undefined;
    });
    renderAs('admin', <ParsersPage />, '/parsers');
    fireEvent.click(await screen.findByRole('button', { name: 'Activate v2' }));
    await waitFor(() => expect(posts).toEqual(['/api/admin/parser-versions/2/activate']));
    expect(screen.getByRole('button', { name: 'New version' })).toBeInTheDocument();
  });

  it('editors and viewers only read', async () => {
    mockFetch((url) => (url.startsWith('/api/admin/parser-versions') ? { body: versions } : undefined));
    renderAs('editor', <ParsersPage />, '/parsers');
    expect(await screen.findByText(/Read-only. Admins create/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Activate/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New version' })).not.toBeInTheDocument();
  });

  it('validates the create form', () => {
    const f = { scope: 'provider' as const, target: 'airtel', version: 'v3', rules: '{"price":{"pattern":"x(\\\\d+)"}}', notes: '', activate: true };
    expect(parserCreateBody(f)).toEqual({ body: { provider: 'airtel', version: 'v3', rules: { price: { pattern: 'x(\\d+)' } }, notes: null, activate: true } });
    expect(parserCreateBody({ ...f, rules: 'not json' })).toEqual({ error: 'Rules must be valid JSON.' });
    expect(parserCreateBody({ ...f, version: 'bad version' })).toHaveProperty('error');
    expect(parserCreateBody({ ...f, target: '' })).toHaveProperty('error');
  });
});

describe('operations pages', () => {
  it('integration health shows each entry and never renders secrets', async () => {
    mockFetch((url) =>
      url === '/api/admin/health/integrations'
        ? {
            body: {
              integrations: {
                db: { status: 'ok', detail: 'connected' },
                smtp: { status: 'not_configured', detail: 'SMTP_URL is not set' },
                billing: { status: 'error', detail: 'bad key=rzp_live_abc123' },
              },
              checked_at: '2026-10-30T09:00:00Z',
            },
          }
        : undefined,
    );
    renderAs('viewer', <IntegrationsPage />, '/integrations');
    expect(await screen.findByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('rzp_live_abc123');
    expect(safeDetail('token=abc password=x ok')).toBe('[hidden] [hidden] ok');
  });

  it('queue page: editors retry dead letters; viewers cannot', async () => {
    const job = { id: 'j-1', type: 'offers.refresh', status: 'dead', attempts: 3, max_attempts: 3, run_at: '2026-10-30T09:00:00Z', created_at: '2026-10-30T09:00:00Z', last_error_code: 'skipped_robots', last_error_message: 'Disallowed' };
    const stats = { counts: { queued: 0, running: 0, succeeded: 1, failed: 0, dead: 1 }, oldest_due_seconds: null, last_heartbeat_at: '2026-10-30T09:00:00Z', heartbeat_fresh: true, dead_last24h: 1 };
    const posts: string[] = [];
    const route = (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(url);
        return { body: { ...job, status: 'queued' } };
      }
      if (url === '/api/admin/queue/stats') return { body: stats };
      if (url.startsWith('/api/admin/queue')) return { body: { items: [job], total: 1 } };
      return undefined;
    };
    mockFetch(route);
    const v = renderAs('viewer', <QueuePage />, '/queue');
    expect(await screen.findByText('offers.refresh')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    v.unmount();
    mockFetch(route);
    renderAs('editor', <QueuePage />, '/queue');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(posts).toEqual(['/api/admin/queue/j-1/retry']));
  });

  it('incident editor: admins publish; editors read only', async () => {
    const patches: unknown[] = [];
    const route = (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)));
        return { body: { incident: { level: 'major', message: 'Email delays', updated_at: '2026-10-30T09:00:00Z' } } };
      }
      return url === '/api/admin/incident' ? { body: { incident: null } } : undefined;
    };
    mockFetch(route);
    const e = renderAs('editor', <IncidentPage />, '/incident');
    expect(await screen.findByText(/Read-only. Admins publish/)).toBeInTheDocument();
    e.unmount();
    mockFetch(route);
    renderAs('admin', <IncidentPage />, '/incident');
    fireEvent.change(await screen.findByLabelText('Level'), { target: { value: 'major' } });
    fireEvent.change(screen.getByLabelText('Message shown to users'), { target: { value: 'Email delays' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(patches).toEqual([{ level: 'major', message: 'Email delays' }]));
  });

  it('privacy requests are Admin-only in navigation and routing', async () => {
    mockFetch(() => ({ body: { items: [], counts: {}, total: 0 } }));
    const e = renderAs('editor', <AppRoutes />, '/privacy');
    expect(await screen.findByText(/cannot open this page/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Privacy requests' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Change review' })).toBeInTheDocument();
    e.unmount();
    renderAs(
      'admin',
      <Routes>
        <Route element={<Layout />}>
          <Route path="*" element={<div />} />
        </Route>
      </Routes>,
      '/',
    );
    expect(screen.getByRole('link', { name: 'Privacy requests' })).toBeInTheDocument();
  });
});
