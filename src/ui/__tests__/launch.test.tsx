// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AccountApiError, type MeResponse } from '../../lib/account/client';
import type { Requester } from '../../lib/account/identities';
import type { GmailClient } from '../../lib/account/gmail';
import type { IdentitiesClient, EmailIdentity } from '../../lib/account/identities';
import {
  createPlatformClient,
  featureTag,
  normaliseStatus,
  setAccountWrappers,
  setPlatformClient,
  type PublicLegal,
  type PublicStatus,
} from '../lib/platform';
import { SafeMarkdown, safeHref } from '../lib/markdown';
import { countGuestUpload, guestUploadsRemaining, uploadMonth } from '../lib/uploads';
import { greeting, HOME_TILE_ORDER } from '../lib/homeTiles';
import { fetchOfferMatches, soften } from '../components/OfferMatches';
import { redirectTo } from '../components/GmailConnect';
import { GMAIL_CONSENT_COPY } from '../../content/privacy';
import { dataWithOne, fakeClient, renderApp, stubNetwork } from './harness';
import { App } from '../App';
import { emptyData } from '../../lib/data';

const ME = (features: string[] = ['backup']): MeResponse =>
  ({
    account: {
      id: 'a1',
      email: 'me@example.com',
      displayName: null,
      createdAt: '2026-10-01T00:00:00.000Z',
      lastLoginAt: null,
    },
    sessionId: 's1',
    entitlements: {
      plan: features.includes('email_import') ? 'plus' : 'free',
      status: 'active',
      billingPeriod: null,
      periodEnd: null,
      channel: null,
      features,
      householdAccess: null,
    },
  }) as MeResponse;

const STATUS = (over: Partial<PublicStatus['integrations']> = {}, incident: unknown = null) => ({
  incident,
  integrations: {
    smtp: 'live',
    inbound: 'not_configured',
    gmail: 'verification_pending',
    billing: 'test_mode',
    ...over,
  },
});

const LEGAL: PublicLegal = {
  entityName: null,
  address: null,
  grievanceOfficerName: null,
  grievanceEmail: 'placeholder@example.com',
  grievancePhone: null,
  supportEmail: null,
  incidentContact: null,
  privacyPolicyMd: '# Privacy\n\nDraft text',
  termsMd: null,
  deletionPolicyMd: null,
  subprocessors: null,
  effectiveDate: null,
  complete: false,
};

function fakePlatform(routes: Record<string, unknown | (() => unknown)>) {
  const req: Requester = async <T,>(method: string, path: string) => {
    const key = `${method} ${path.split('?')[0]}`;
    if (!(key in routes)) throw new AccountApiError(404, 'not_found', 'Not found');
    const v = routes[key];
    const out = typeof v === 'function' ? (v as () => unknown)() : v;
    if (out instanceof Error) throw out;
    return out as T;
  };
  setPlatformClient(createPlatformClient({}, req));
}

beforeEach(() => {
  stubNetwork();
  setPlatformClient(null);
  setAccountWrappers(null, null);
});
afterEach(() => {
  cleanup();
  setPlatformClient(null);
  setAccountWrappers(null, null);
});

describe('platform helpers', () => {
  it('normalises status; unknown modes never become live', () => {
    const s = normaliseStatus({ integrations: { gmail: 'weird', smtp: 'live' } });
    expect(s.integrations.gmail).toBe('not_configured');
    expect(s.integrations.smtp).toBe('live');
    expect(s.incident).toBeNull();
  });

  it('labels Plus-only features honestly', () => {
    expect(featureTag('live', true, false).text).toBe('Plus required');
    expect(featureTag('live', true, true).text).toBe('Live');
    expect(featureTag('test_mode', true, false).text).toBe('Test mode');
    expect(featureTag('verification_pending', true, true).text).toBe('Verification pending');
    expect(featureTag('not_configured', true, true).text).toBe('Not configured');
  });

  it('guest uploads: 5 per IST month, then refused', () => {
    localStorage.clear();
    const now = new Date('2026-10-31T10:00:00Z');
    for (let i = 0; i < 5; i++) expect(countGuestUpload(now)).toBe(true);
    expect(countGuestUpload(now)).toBe(false);
    expect(guestUploadsRemaining(now)).toBe(0);
    // 31 Oct 19:00 UTC is already 1 Nov in India.
    expect(uploadMonth(new Date('2026-10-31T19:00:00Z'))).toBe('2026-11');
    expect(guestUploadsRemaining(new Date('2026-10-31T19:00:00Z'))).toBe(5);
  });

  it('greeting uses India time', () => {
    expect(greeting(new Date('2026-10-31T02:00:00Z')).hello).toBe('Good morning'); // 07:30 IST
    expect(greeting(new Date('2026-10-31T13:00:00Z')).hello).toBe('Good evening'); // 18:30 IST
  });

  it('tile order matches the launch spec', () => {
    expect(HOME_TILE_ORDER).toEqual([
      'subscription',
      'emi',
      'credit_card',
      'other_loan',
      'bill',
      'school_fee',
      'offers',
      'seasons',
    ]);
  });

  it('offer copy never claims a guaranteed benefit', () => {
    expect(soften('Guaranteed Prime for 3 months')).toBe('possible Prime for 3 months');
  });

  it('offer matching never sends a Due category as the telecom service type', async () => {
    const urls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ matches: [] }), { status: 200 });
    }) as typeof fetch;
    try {
      await fetchOfferMatches({ provider: 'Jio', serviceType: 'subscription', price: 349 });
      await fetchOfferMatches({ provider: 'Jio', serviceType: 'prepaid' });
    } finally {
      globalThis.fetch = orig;
    }
    expect(urls[0]).toContain('/api/public/offers/match?provider=Jio&price=349');
    expect(urls[0]).not.toContain('serviceType');
    expect(urls[1]).toContain('serviceType=prepaid');
  });
});

describe('safe markdown', () => {
  it('renders headings, lists and safe links; raw HTML stays text', () => {
    const { container } = render(
      <SafeMarkdown
        source={
          '# Title\n\nHello **bold** <img src=x onerror=alert(1)>\n\n- one\n- [two](https://example.com)\n- [bad](javascript:alert(1))'
        }
      />,
    );
    expect(container.querySelector('h2')?.textContent).toBe('Title');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com']);
    expect(container.querySelectorAll('li')).toHaveLength(3);
    expect(safeHref('mailto:a@b.in')).toBe('mailto:a@b.in');
    expect(safeHref('data:text/html,x')).toBeNull();
  });
});

describe('legal pages', () => {
  it('incomplete legal data shows "being finalised" and never the placeholder contact', async () => {
    fakePlatform({ 'GET /api/public/legal': LEGAL, 'GET /api/public/status': STATUS() });
    renderApp({ hash: '#/legal/grievance' });
    await screen.findByText(/Legal details are being finalised/);
    expect(document.body.textContent).not.toContain('placeholder@example.com');
    cleanup();
    renderApp({ hash: '#/legal/privacy' });
    await screen.findByText(/Legal details are being finalised/);
    expect(document.body.textContent).not.toContain('Draft text');
  });

  it('complete legal data renders markdown and the grievance contact', async () => {
    fakePlatform({
      'GET /api/public/legal': {
        ...LEGAL,
        complete: true,
        grievanceOfficerName: 'A. Officer',
        grievanceEmail: 'grievance@due.example',
        privacyPolicyMd: '## What we collect\n\nOnly what you enter.',
        subprocessors: [{ name: 'Render', purpose: 'Hosting', region: 'Singapore' }],
        effectiveDate: '2026-11-01',
      },
      'GET /api/public/status': STATUS(),
    });
    renderApp({ hash: '#/legal/privacy' });
    await screen.findByRole('heading', { name: 'What we collect' });
    expect(document.body.textContent).toContain('Effective 1 Nov 2026');
    cleanup();
    renderApp({ hash: '#/legal/grievance' });
    await screen.findByText('A. Officer');
    expect(screen.getByRole('link', { name: 'grievance@due.example' })).toBeTruthy();
    cleanup();
    renderApp({ hash: '#/legal/subprocessors' });
    await screen.findByText('Render');
  });

  it('shows the incident banner from /api/public/status', async () => {
    fakePlatform({
      'GET /api/public/status': STATUS(
        {},
        {
          level: 'major',
          message: 'Email reminders are delayed.',
          updatedAt: '2026-10-31T00:00:00Z',
        },
      ),
    });
    renderApp({ data: dataWithOne() });
    expect((await screen.findByTestId('incident')).textContent).toContain(
      'Email reminders are delayed.',
    );
  });
});

function gmailFake(over: Partial<GmailClient> = {}): GmailClient {
  return {
    status: async () => ({
      mode: 'test_mode',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'openid', 'email'],
      consentVersion: 'gmail-2026-10',
      consentText: GMAIL_CONSENT_COPY,
      blocker: null,
      missing: [],
    }),
    connect: vi.fn(async () => ({
      authorizeUrl: 'https://accounts.google.com/o/oauth2/x',
      expiresAt: '',
    })),
    scan: vi.fn(async () => ({ ok: true as const, runId: 'r', jobId: 'j' })),
    scans: async () => [],
    disconnect: vi.fn(async () => ({
      ok: true as const,
      revoked: true,
      deleted: { events: 0, seen: 0 },
    })),
    ...over,
  } as GmailClient;
}

const IDENTITY: EmailIdentity = {
  id: 'id1',
  kind: 'gmail',
  label: 'Personal Gmail',
  email: 'me@gmail.com',
  status: 'active',
  statusReason: null,
  consentVersion: 'gmail-2026-10',
  consentedAt: '2026-10-30T10:00:00Z',
  revokedAt: null,
  attachmentsEnabled: false,
  senderFilters: [],
  lastScanAt: '2026-10-30T11:00:00Z',
  lastScanStatus: 'ok',
  lastScanErrorCode: null,
  scanning: false,
  scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
  createdAt: '2026-10-30T10:00:00Z',
};

describe('Gmail connect', () => {
  it('shows the exact consent copy and scopes, then redirects to the authorize URL', async () => {
    fakePlatform({ 'GET /api/public/status': STATUS({ gmail: 'test_mode' }) });
    const g = gmailFake();
    setAccountWrappers(g, null);
    const assign = vi.spyOn(redirectTo, 'assign').mockImplementation(() => undefined);
    renderApp({
      client: fakeClient({ me: () => Promise.resolve(ME(['backup', 'email_import'])) }),
    });
    await waitFor(() =>
      expect(document.querySelector('[data-choice="gmail"]')?.textContent).toMatch(/Test mode/),
    );
    fireEvent.click(document.querySelector('[data-choice="gmail"]') as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByTestId('gmail-consent').textContent).toBe(GMAIL_CONSENT_COPY);
    await within(dialog).findByText('https://www.googleapis.com/auth/gmail.readonly');
    const go = within(dialog).getByRole('button', {
      name: 'Continue to Google',
    }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(go);
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/x'),
    );
    expect(g.connect).toHaveBeenCalledWith('gmail-2026-10');
    assign.mockRestore();
  });

  it('asks a signed-out person to sign in instead of redirecting', async () => {
    setAccountWrappers(gmailFake(), null);
    renderApp({ hash: '#/start' });
    fireEvent.click(document.querySelector('[data-choice="gmail"]') as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: 'Sign in to connect Gmail' })).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: 'Continue to Google' })).toBeNull();
  });

  it('handles ?gmail=error on return and opens Connections', async () => {
    window.history.replaceState(null, '', '/?gmail=error&reason=access_denied#/');
    renderApp();
    expect((await screen.findByTestId('gmail-return')).textContent).toContain(
      'Gmail access was not granted.',
    );
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#/connections');
    window.history.replaceState(null, '', '/');
  });
});

describe('Connections', () => {
  it('lists identities with consent, last scan, Rescan, Disconnect (with delete option) and Delete', async () => {
    const g = gmailFake();
    const remove = vi.fn(async () => ({
      ok: true as const,
      revoked: true,
      deleted: { events: 0, seen: 0 },
    }));
    const ids = {
      list: async () => ({ items: [IDENTITY], max: 5 }),
      create: vi.fn(),
      update: vi.fn(),
      remove,
    } as unknown as IdentitiesClient;
    setAccountWrappers(g, ids);
    renderApp({
      hash: '#/connections',
      client: fakeClient({ me: () => Promise.resolve(ME(['backup', 'email_import'])) }),
    });
    const card = (await screen.findByText('Personal Gmail')).closest('li') as HTMLElement;
    expect(card.textContent).toContain('Version gmail-2026-10');
    expect(card.textContent).toMatch(/Last scan/);
    fireEvent.click(within(card).getByRole('button', { name: 'Rescan' }));
    await waitFor(() => expect(g.scan).toHaveBeenCalledWith('id1'));
    fireEvent.click(within(card).getByLabelText(/Also delete review items imported/));
    fireEvent.click(within(card).getByRole('button', { name: 'Disconnect Gmail' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Yes, disconnect' }));
    await waitFor(() => expect(g.disconnect).toHaveBeenCalledWith('id1', true));
    fireEvent.click(within(card).getByRole('button', { name: 'Delete identity' }));
    fireEvent.click(within(card).getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith('id1', false));
    expect(screen.getByText(/1 of 5 identities used/)).toBeTruthy();
  });
});

describe('Forwarding (signed-in Plus only)', () => {
  it('guests are asked to sign in instead of being offered an address', async () => {
    renderApp({ hash: '#/connections' });
    expect(await screen.findByText('Sign in to use forwarding')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Get my forwarding address' })).toBeNull();
    expect(screen.getByText('Sign in required')).toBeTruthy();
  });

  it('a Free account that asks for an address is told forwarding is part of Plus (402), not that the server is down', async () => {
    const createIntakeAlias = vi.fn(() =>
      Promise.reject(
        new AccountApiError(402, 'premium_required', 'This feature needs a premium plan'),
      ),
    );
    renderApp({
      hash: '#/connections',
      client: fakeClient({
        me: () => Promise.resolve(ME(['backup'])),
        getIntakeAlias: () => Promise.resolve({ alias: null, live: true }),
        listIntakeEvents: () => Promise.resolve({ items: [], rawStorage: 'encrypted' }),
        createIntakeAlias,
      }),
    });
    fireEvent.click(await screen.findByLabelText(/I’ve read how forwarding works/));
    fireEvent.click(screen.getByRole('button', { name: 'Get my forwarding address' }));
    expect(await screen.findByText('Forwarding is part of Plus')).toBeTruthy();
    expect(createIntakeAlias).toHaveBeenCalled();
    expect(screen.queryByText(/Forwarding is unavailable right now/)).toBeNull();
  });
});

describe('Plans', () => {
  it('shows INR, the tax note, Plus features without selling unavailable ones, and hides Household', async () => {
    const plans = {
      currency: 'INR',
      plans: [
        {
          id: 'free',
          name: 'Free',
          priceInrMonthly: null,
          priceInrYearly: null,
          billingCadences: [],
          features: ['manual_obligations'],
          active: true,
          checkoutAvailable: { monthly: false, yearly: false },
        },
        {
          id: 'plus',
          name: 'Plus',
          priceInrMonthly: 99,
          priceInrYearly: 999,
          billingCadences: ['monthly', 'yearly'],
          features: ['backup'],
          active: true,
          checkoutAvailable: { monthly: true, yearly: true },
        },
        {
          id: 'household',
          name: 'Household',
          priceInrMonthly: 199,
          priceInrYearly: null,
          billingCadences: ['monthly'],
          features: ['household_sharing'],
          active: true,
          checkoutAvailable: { monthly: true, yearly: false },
        },
      ],
      terms: {
        renewal: 'Renews',
        cancellation: 'Cancel any time',
        refund: 'No refunds',
        legalReviewStatus: 'reviewed',
      },
      cancellationPath: 'Settings → Plans → Cancel',
      tax: { note: 'Prices include 18% GST.', pricesIncludeTax: true },
      purchaseChannel: 'razorpay',
      paymentsAvailable: true,
    };
    fakePlatform({
      'GET /api/public/status': STATUS({
        gmail: 'verification_pending',
        inbound: 'live',
        smtp: 'live',
      }),
    });
    renderApp({
      hash: '#/plans',
      client: fakeClient({ getPublicPlans: () => Promise.resolve(plans) }),
    });
    await screen.findByText('₹99/month or ₹999/year');
    expect(screen.getByTestId('tax-note').textContent).toContain('Prices include 18% GST.');
    expect(screen.getByTestId('tax-note').textContent).toContain('INR');
    expect(screen.queryByText('Household')).toBeNull();
    const feats = screen.getByTestId('plus-features');
    await waitFor(() =>
      expect(feats.textContent).toMatch(
        /Gmail scanning \(read-only\) Not included yet: verification pending/,
      ),
    );
    expect(feats.textContent).toMatch(/Unlimited document uploads/);
    expect(feats.textContent).toMatch(/Cross-device sync/);
    expect(feats.textContent).not.toMatch(/forwarding to your private Due address Not included/);
  });
});

describe('Reminders', () => {
  it('stays off until a channel is chosen and agreed; WhatsApp is not available', async () => {
    fakePlatform({ 'GET /api/public/status': STATUS({ smtp: 'not_configured' }) });
    renderApp({ data: dataWithOne(), hash: '#/reminders' });
    expect(screen.getByText('Reminders are off')).toBeTruthy();
    const panel = screen.getByRole('group', { name: /How should Due remind you/ });
    const radio = (n: RegExp) => within(panel).getByRole('radio', { name: n }) as HTMLInputElement;
    expect(radio(/WhatsApp/).disabled).toBe(true);
    expect(radio(/^Email/).disabled).toBe(true);
    expect(panel.textContent).toMatch(/Sign in first/);
    const on = screen.getByRole('button', { name: 'Turn on reminders' }) as HTMLButtonElement;
    expect(on.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I agree to get reminders in the app/));
    fireEvent.click(on);
    await screen.findByTestId('reminders-on');
    expect(screen.queryByText('Reminders are off')).toBeNull();
    expect(JSON.parse(localStorage.getItem('due:reminder-consent') ?? '{}').channel).toBe('in_app');
  });
});

describe('Uploads and offers', () => {
  it('shows the remaining guest allowance and blocks after 5', async () => {
    renderApp({ hash: '#/upload' });
    expect(screen.getByTestId('upload-remaining').textContent).toMatch(/5 of 5/);
    cleanup();
    window.location.hash = '#/upload';
    localStorage.clear();
    for (let i = 0; i < 5; i++) countGuestUpload();
    render(<App client={fakeClient()} initialData={emptyData()} />);
    expect(screen.getByTestId('upload-remaining').textContent).toMatch(/0 of 5/);
    expect(screen.getByText(/used this month’s 5 free document uploads/)).toBeTruthy();
    expect(
      (screen.getByLabelText(/Choose a PDF, JPG, PNG or TXT file/) as HTMLInputElement).disabled,
    ).toBe(true);
  });

  it('cross-calculation says "Offer data unavailable" when the server cannot be reached', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp({ hash: '#/add/subscription' });
    fireEvent.change(screen.getByLabelText('Who is it with?'), { target: { value: 'Airtel' } });
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
    expect((await screen.findByTestId('offers-unavailable')).textContent).toContain(
      'Offer data unavailable',
    );
  });

  it('cross-calculation shows possible benefits with assumptions, expiry, eligibility, confidence and sources', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          disclaimer: 'Possible benefits only.',
          matches: [
            {
              offerId: 'o1',
              name: 'Prime Lite with Airtel 838',
              possibleBenefit: 'Guaranteed Amazon Prime Lite for 84 days',
              eligibility: { overall: 'provider_only', checks: [] },
              expiry: { officialStartAt: null, officialEndAt: '2026-12-31T00:00:00Z', note: '' },
              estimate: { amountInr: 299, basis: 'Value stated by the provider.' },
              confidence: 'medium',
              assumptions: ['Plan bought on or after the offer start'],
              doubleCountNote: null,
              sources: [{ url: 'https://www.airtel.in/prepaid', label: 'airtel.in' }],
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
    renderApp({ hash: '#/add/subscription' });
    fireEvent.change(screen.getByLabelText('Who is it with?'), { target: { value: 'Airtel' } });
    const card = (
      await screen.findByText('Prime Lite with Airtel 838', {}, { timeout: 3000 })
    ).closest('article') as HTMLElement;
    expect(card.textContent).toContain('Possible benefit to verify');
    expect(card.textContent).toContain('Confidence: medium');
    expect(card.textContent).toContain('ends 2026-12-31');
    expect(card.textContent).toContain('Only the provider can confirm eligibility');
    expect(card.textContent).toContain('Plan bought on or after the offer start');
    expect(card.textContent).not.toMatch(/guaranteed/i);
    expect(within(card).getByRole('link', { name: 'airtel.in' }).getAttribute('href')).toBe(
      'https://www.airtel.in/prepaid',
    );
  });
});

describe('Account deletion', () => {
  it('shows asynchronous progress from GET /api/account/deletion-status', async () => {
    let calls = 0;
    fakePlatform({
      'GET /api/account/deletion-status': () => {
        calls++;
        return {
          requestId: 'r1',
          status: 'completed',
          progress: 100,
          steps: [
            { step: 'sessions', done: true, doneAt: '2026-10-31T00:00:00Z' },
            { step: 'account_record', done: true, doneAt: '2026-10-31T00:00:01Z' },
          ],
          retentionExceptions: [{ record: 'Invoices', reason: 'Tax law' }],
        };
      },
    });
    window.location.hash = '#/account';
    localStorage.clear();
    localStorage.setItem(
      'due:deletion-request',
      JSON.stringify({
        requestId: 'r1',
        token: 'tok-1234567890abcdef',
        at: '2026-10-31T00:00:00Z',
      }),
    );
    render(<App client={fakeClient()} initialData={emptyData()} />);
    await screen.findByText('Your account and its data have been deleted.');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    expect(document.body.textContent).toContain('Account record deleted');
    expect(document.body.textContent).toContain('Invoices — Tax law');
    expect(calls).toBe(1);
  });
});
