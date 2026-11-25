import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SettingsPage, toSettingsMap } from '../pages/Settings';
import { IntegrationsPage } from '../pages/Operations';
import { mockFetch, renderAs } from './helpers';

const SETTINGS = {
  frequency_defaults: { critical: 1440, regular: 10080, secondary: 10080 },
  retry: { base_minutes: 30, max_minutes: 1440, max_attempts_before_inaccessible: 8 },
  retention: { snapshots_days: 365, login_events_days: 180 },
  notifications: { email_enabled: false, recipients: [] },
  business: { app_name: 'Due', support_email: null },
  'beta.plus_free': false,
  'beta.ends_on': null,
  smtp_configured: true,
};

describe('beta setting', () => {
  it('keeps scalar settings in raw', () => {
    expect(toSettingsMap(SETTINGS).raw['beta.plus_free']).toBe(false);
  });

  it('admins save the beta flag and end date through PATCH /api/admin/settings', async () => {
    const calls: unknown[] = [];
    mockFetch((url, init) => {
      if (url === '/api/admin/settings' && init?.method === 'PATCH') {
        calls.push(JSON.parse(String(init.body)));
        return { body: SETTINGS };
      }
      if (url === '/api/admin/settings') return { body: SETTINGS };
      return undefined;
    });
    renderAs('admin', <SettingsPage />, '/settings');
    const form = await screen.findByRole('form', { name: 'Free public beta' });
    fireEvent.click(form.querySelector('input[type=checkbox]')!);
    fireEvent.change(form.querySelector('input[type=date]')!, { target: { value: '2026-12-31' } });
    fireEvent.click(form.querySelector('button[type=submit]')!);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { key: 'beta.ends_on', value: '2026-12-31' },
      { key: 'beta.plus_free', value: true },
    ]);
  });
});

describe('store links', () => {
  it('saves both links, empty as null', async () => {
    const calls: unknown[] = [];
    mockFetch((url, init) => {
      if (url === '/api/admin/settings' && init?.method === 'PATCH') {
        calls.push(JSON.parse(String(init.body)));
        return { body: SETTINGS };
      }
      if (url === '/api/admin/settings') return { body: SETTINGS };
      return undefined;
    });
    renderAs('admin', <SettingsPage />, '/settings');
    const form = await screen.findByRole('form', { name: 'App store links' });
    fireEvent.change(form.querySelectorAll('input')[0], { target: { value: 'https://play.google.com/store/apps/details?id=x' } });
    fireEvent.click(form.querySelector('button[type=submit]')!);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { key: 'app.android_url', value: 'https://play.google.com/store/apps/details?id=x' },
      { key: 'app.ios_url', value: null },
    ]);
  });
});

describe('store links', () => {
  it('saves both links, empty as null', async () => {
    const calls: unknown[] = [];
    mockFetch((url, init) => {
      if (url === '/api/admin/settings' && init?.method === 'PATCH') {
        calls.push(JSON.parse(String(init.body)));
        return { body: SETTINGS };
      }
      if (url === '/api/admin/settings') return { body: SETTINGS };
      return undefined;
    });
    renderAs('admin', <SettingsPage />, '/settings');
    const form = await screen.findByRole('form', { name: 'App store links' });
    fireEvent.change(form.querySelectorAll('input')[0], { target: { value: 'https://play.google.com/store/apps/details?id=x' } });
    fireEvent.click(form.querySelector('button[type=submit]')!);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { key: 'app.android_url', value: 'https://play.google.com/store/apps/details?id=x' },
      { key: 'app.ios_url', value: null },
    ]);
  });
});

describe('smtp test button', () => {
  it('posts to /api/admin/health/smtp-test and says it was accepted', async () => {
    let posted = false;
    mockFetch((url, init) => {
      if (url === '/api/admin/health/smtp-test' && init?.method === 'POST') {
        posted = true;
        return { body: { ok: true, sentTo: 'test@example.test' } };
      }
      if (url === '/api/admin/health/integrations') return { body: { integrations: {}, checkedAt: '2026-11-25T10:00:00Z' } };
      return undefined;
    });
    renderAs('admin', <IntegrationsPage />, '/operations');
    fireEvent.click(await screen.findByRole('button', { name: 'Send test email to me' }));
    expect(await screen.findByText(/accepted by the mail server/)).toBeTruthy();
    expect(posted).toBe(true);
  });
});

describe('GST setting', () => {
  it('validates GSTIN format and checksum in the browser, then saves both keys', async () => {
    const { isValidGstin } = await import('../pages/Settings');
    expect(isValidGstin('27AAAAA0000A1Z2')).toBe(true); // made-up GSTIN
    expect(isValidGstin('27AAAAA0000A1Z3')).toBe(false);
    const calls: unknown[] = [];
    mockFetch((url, init) => {
      if (url === '/api/admin/settings' && init?.method === 'PATCH') {
        calls.push(JSON.parse(String(init.body)));
        return { body: SETTINGS };
      }
      if (url === '/api/admin/settings') return { body: SETTINGS };
      return undefined;
    });
    renderAs('admin', <SettingsPage />, '/settings');
    const form = await screen.findByRole('form', { name: 'GST' });
    fireEvent.click(form.querySelector('input[type=checkbox]')!);
    fireEvent.change(form.querySelector('input:not([type=checkbox])')!, { target: { value: '27aaaaa0000a1z9' } });
    fireEvent.click(form.querySelector('button[type=submit]')!);
    expect(await screen.findByText(/valid 15-character GSTIN/)).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.change(form.querySelector('input:not([type=checkbox])')!, { target: { value: '27AAAAA0000A1Z2' } });
    fireEvent.click(form.querySelector('button[type=submit]')!);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual([
      { key: 'billing.gstin', value: '27AAAAA0000A1Z2' },
      { key: 'billing.gst_registered', value: true },
    ]);
  });
});
