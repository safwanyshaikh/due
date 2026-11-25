import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { OfferInboxPage, candidateText, parseDomains, type WatchRow } from '../pages/OfferInbox';
import { mockFetch, renderAs } from './helpers';

const jio: WatchRow = { slug: 'jio', displayName: 'Jio', senderDomains: ['jio.example.test'], category: 'telecom', signupUrl: null, researchAddress: null, status: 'pending', lastEmailAt: null, messageCount: 0, stale: false };
const airtel: WatchRow = { ...jio, slug: 'airtel', displayName: 'Airtel', senderDomains: [], status: 'subscribed', stale: true };

describe('offer inbox helpers', () => {
  it('parses domains and describes candidates', () => {
    expect(parseDomains('A.com, b.com  a.com')).toEqual(['a.com', 'b.com']);
    expect(candidateText({ kind: 'plan', planName: 'Uber One', priceInr: 149, discountPct: null, validUntil: '2026-12-15', free: true, cashback: false })).toBe('Uber One · ₹149 · free · until 2026-12-15');
  });
});

describe('Offer inbox page', () => {
  it('lists the watchlist, marks subscribed, and filters stale', async () => {
    const calls: { url: string; method: string }[] = [];
    mockFetch((url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (init?.method === 'POST') return { body: { ...jio, status: 'subscribed' } };
      if (url.startsWith('/api/admin/offer-inbox/watch')) return { body: { items: url.includes('stale=true') ? [airtel] : [jio, airtel], staleDays: 30 } };
      return undefined;
    });
    renderAs('editor', <OfferInboxPage />, '/offer-inbox');
    expect(await screen.findByText('Jio')).toBeInTheDocument();
    expect(screen.getByText(/cannot be matched automatically/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark Jio subscribed' }));
    await waitFor(() => expect(calls).toContainEqual({ url: '/api/admin/offer-inbox/watch/jio/mark-subscribed', method: 'POST' }));
    expect(await screen.findByText('Jio marked subscribed.')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Stale: subscribed/));
    await waitFor(() => expect(screen.queryByText('Jio')).not.toBeInTheDocument());
    expect(screen.getByText('Airtel')).toBeInTheDocument();
    expect(screen.getAllByText('Stale').length).toBeGreaterThan(0);
  });

  it('inbox tab shows candidates and attaches an unmatched sender', async () => {
    const posts: unknown[] = [];
    mockFetch((url, init) => {
      if (init?.method === 'POST') {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return { body: { requeued: 1 } };
      }
      if (url.startsWith('/api/admin/offer-inbox/unmatched')) return { body: { items: [{ domain: 'card.example.test', messages: 2, lastReceivedAt: '2026-11-24T00:00:00Z', sampleSubject: 'Dining offer' }] } };
      if (url.startsWith('/api/admin/offer-inbox/messages'))
        return { body: { items: [
          { id: 'm1', receivedAt: '2026-11-24T00:00:00Z', fromDomain: 'jio.example.test', subject: 'Jio ₹299 plan', status: 'parsed', reason: null, personalised: false, providerSlug: 'jio', providerName: 'Jio', reviewsQueued: 1, candidates: [{ kind: 'plan', planName: null, priceInr: 299, discountPct: null, validUntil: '2026-11-30', free: false, cashback: false }] },
          { id: 'm2', receivedAt: '2026-11-24T00:00:00Z', fromDomain: 'x.test', subject: 'Spoof', status: 'quarantined', reason: 'dkim_failed', personalised: false, providerSlug: null, providerName: null, reviewsQueued: 0, candidates: [] },
        ] } };
      if (url.startsWith('/api/admin/offer-inbox/watch')) return { body: { items: [jio], staleDays: 30 } };
      return undefined;
    });
    renderAs('editor', <OfferInboxPage />, '/offer-inbox');
    fireEvent.click(await screen.findByRole('tab', { name: 'Inbox' }));
    const row = (await screen.findByText('Jio ₹299 plan')).closest('tr')!;
    expect(within(row).getByText('Plan · ₹299 · until 2026-11-30')).toBeInTheDocument();
    expect(screen.getByText('Dkim failed')).toBeInTheDocument();
    expect(await screen.findByText('card.example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Attach card.example.test' }));
    expect(await screen.findByText('Choose a provider first.')).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('Provider for card.example.test'), { target: { value: 'jio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach card.example.test' }));
    await waitFor(() => expect(posts).toEqual([{ url: '/api/admin/offer-inbox/unmatched/attach', body: { domain: 'card.example.test', providerSlug: 'jio' } }]));
  });

  it('viewers get no write controls', async () => {
    mockFetch((url) => (url.startsWith('/api/admin/offer-inbox/watch') ? { body: { items: [jio], staleDays: 30 } } : undefined));
    renderAs('viewer', <OfferInboxPage />, '/offer-inbox');
    expect(await screen.findByText('Jio')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Mark Jio subscribed/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Add provider' })).not.toBeInTheDocument();
  });
});
