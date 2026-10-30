import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { SetupPage, validatePassword } from '../pages/Auth';
import { mockFetch, renderAs } from './helpers';

describe('password validation', () => {
  it('requires at least 12 characters', () => {
    expect(validatePassword('short', 'short')).toMatch(/at least 12/);
    expect(validatePassword('elevenchars', 'elevenchars')).toMatch(/at least 12/);
    expect(validatePassword('twelve-chars', 'twelve-chars')).toBeNull();
  });
  it('requires matching confirmation', () => {
    expect(validatePassword('a-long-password', 'a-long-passw0rd')).toMatch(/do not match/);
  });
});

describe('setup form', () => {
  async function fill(password: string, confirm: string) {
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Setup token'), 'tok');
    await user.type(screen.getByLabelText('Email'), 'owner@example.test');
    await user.type(screen.getByLabelText('Name'), 'Owner');
    await user.type(screen.getByLabelText('Password'), password);
    await user.type(screen.getByLabelText('Confirm password'), confirm);
    await user.click(screen.getByRole('button', { name: /create owner account/i }));
  }

  it('blocks short passwords without calling the API', async () => {
    const f = mockFetch(() => ({ body: {} }));
    renderAs(null, <SetupPage />, '/setup');
    await fill('short', 'short');
    expect(await screen.findByText(/at least 12 characters/)).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  it('blocks mismatched passwords without calling the API', async () => {
    const f = mockFetch(() => ({ body: {} }));
    renderAs(null, <SetupPage />, '/setup');
    await fill('a-long-password!', 'a-long-password?');
    expect(await screen.findByText(/do not match/)).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  it('posts setup with the token when valid', async () => {
    const f = mockFetch((url) => {
      if (url === '/api/auth/setup') return { status: 201, body: { ok: true } };
      if (url === '/api/auth/me') return { body: { id: '1', email: 'owner@example.test', name: 'Owner', role: 'owner' } };
      return undefined;
    });
    renderAs(
      null,
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/" element={<p>home</p>} />
      </Routes>,
      '/setup',
    );
    await fill('a-long-password!', 'a-long-password!');
    expect(await screen.findByText('home')).toBeInTheDocument();
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/setup');
    expect(JSON.parse(init.body as string)).toEqual({
      setupToken: 'tok',
      email: 'owner@example.test',
      name: 'Owner',
      password: 'a-long-password!',
    });
    expect((init.headers as Record<string, string>)['X-Requested-With']).toBe('due-admin');
  });
});
