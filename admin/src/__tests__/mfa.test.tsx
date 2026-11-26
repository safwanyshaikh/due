import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { LoginPage } from '../pages/Auth';
import { api, setReauthHandler } from '../lib/api';
import { mockFetch, renderAs } from './helpers';

describe('admin sign-in with 2-step verification', () => {
  it('asks for the authenticator code after the password and only then signs in', async () => {
    const f = mockFetch((url) => {
      if (url === '/api/auth/login') return { body: { status: 'mfa_required', challengeToken: 'challenge-token-123456', expiresInSeconds: 300 } };
      if (url === '/api/auth/mfa') return { body: { user: { id: '1' }, via: 'totp', recoveryCodesRemaining: 10 } };
      if (url === '/api/auth/me') return { body: { id: '1', email: 'a@example.test', name: 'A', role: 'admin' } };
      return undefined;
    });
    renderAs(
      null,
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<p>home</p>} />
      </Routes>,
      '/login',
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'a@example.test');
    await user.type(screen.getByLabelText('Password'), 'a-long-password!');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    expect(await screen.findByText(/enter the 6-digit code/i)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Code'), '654321');
    await user.click(screen.getByRole('button', { name: /verify/i }));
    expect(await screen.findByText('home')).toBeInTheDocument();
    const mfa = f.mock.calls.find(([u]) => u === '/api/auth/mfa')!;
    expect(JSON.parse((mfa[1] as RequestInit).body as string)).toEqual({ challengeToken: 'challenge-token-123456', code: '654321' });
  });

  it('retries an owner/admin change once after a fresh code (reauth_required)', async () => {
    let calls = 0;
    mockFetch((url) => {
      if (url === '/api/admin/users/x') {
        calls++;
        return calls === 1 ? { status: 403, body: { error: { code: 'reauth_required', message: 'Confirm it is you' } } } : { body: { ok: true } };
      }
      return undefined;
    });
    let asked = 0;
    setReauthHandler(async () => {
      asked++;
      return true;
    });
    await expect(api.patch('/admin/users/x', { name: 'N' })).resolves.toEqual({ ok: true });
    expect(asked).toBe(1);
    expect(calls).toBe(2);
    setReauthHandler(async () => false);
    calls = 0;
    await expect(api.patch('/admin/users/x', { name: 'N' })).rejects.toMatchObject({ code: 'reauth_required' });
    setReauthHandler(null);
  });
});
