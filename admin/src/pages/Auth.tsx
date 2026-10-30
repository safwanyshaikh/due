import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Me } from '../lib/types';
import { Field, LiveStatus } from '../components/ui';

export const MIN_PASSWORD = 12;

/** Returns a plain-language problem with the password pair, or null if valid. */
export function validatePassword(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters.`;
  if (password !== confirm) return 'The two passwords do not match.';
  return null;
}

function AuthCard({ title, children, intro }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-page">
      <main className="auth-card" id="main">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            D
          </span>
          <span>Due Admin</span>
        </div>
        <h1>{title}</h1>
        {intro ? <p className="muted">{intro}</p> : null}
        {children}
      </main>
    </div>
  );
}

type Status = { kind: 'ok' | 'error'; text: string } | null;

function PasswordPair({
  password,
  confirm,
  setPassword,
  setConfirm,
  label = 'Password',
}: {
  password: string;
  confirm: string;
  setPassword: (v: string) => void;
  setConfirm: (v: string) => void;
  label?: string;
}) {
  return (
    <>
      <Field label={label} hint={`At least ${MIN_PASSWORD} characters.`}>
        {(id, hint) => (
          <input
            id={id}
            type="password"
            autoComplete="new-password"
            aria-describedby={hint}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={MIN_PASSWORD}
          />
        )}
      </Field>
      <Field label={`Confirm ${label.toLowerCase()}`}>
        {(id) => (
          <input
            id={id}
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        )}
      </Field>
    </>
  );
}

export function LoginPage() {
  const { setMe } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await api.post('/auth/login', { email, password }, { skipAuthRedirect: true });
      const me = await api.get<Me>('/auth/me', { skipAuthRedirect: true });
      setMe(me);
      navigate('/');
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Sign in">
      <form onSubmit={submit} noValidate>
        <Field label="Email">
          {(id) => (
            <input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          )}
        </Field>
        <Field label="Password">
          {(id) => (
            <input
              id={id}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          )}
        </Field>
        <LiveStatus status={status} />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="muted small">
        Setting up a new installation? <Link to="/setup">First-time setup</Link>. Forgot your password? Ask an admin
        for a reset link.
      </p>
    </AuthCard>
  );
}

export function SetupPage() {
  const navigate = useNavigate();
  const { setMe } = useAuth();
  const [setupToken, setSetupToken] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!setupToken.trim() || !email.trim() || !name.trim()) {
      setStatus({ kind: 'error', text: 'Setup token, email and name are all required.' });
      return;
    }
    const problem = validatePassword(password, confirm);
    if (problem) {
      setStatus({ kind: 'error', text: problem });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.post('/auth/setup', { setupToken: setupToken.trim(), email: email.trim(), name: name.trim(), password }, { skipAuthRedirect: true });
      try {
        const me = await api.get<Me>('/auth/me', { skipAuthRedirect: true });
        setMe(me);
        navigate('/');
      } catch {
        setStatus({ kind: 'ok', text: 'Owner account created. Please sign in.' });
        navigate('/login');
      }
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard
      title="First-time setup"
      intro="Create the owner account. This works only once, while no users exist, using the one-time setup token configured on the server."
    >
      <form onSubmit={submit} noValidate>
        <Field label="Setup token" hint="The ADMIN_SETUP_TOKEN value. Remove it from the server environment after setup.">
          {(id, hint) => (
            <input id={id} type="password" autoComplete="off" aria-describedby={hint} value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required />
          )}
        </Field>
        <Field label="Email">
          {(id) => <input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />}
        </Field>
        <Field label="Name">
          {(id) => <input id={id} type="text" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />}
        </Field>
        <PasswordPair password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} />
        <LiveStatus status={status} />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create owner account'}
        </button>
      </form>
      <p className="muted small">
        Already set up? <Link to="/login">Sign in</Link>.
      </p>
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = validatePassword(password, confirm);
    if (problem) {
      setStatus({ kind: 'error', text: problem });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.post('/auth/reset', { token, password }, { skipAuthRedirect: true });
      setDone(true);
      setStatus({ kind: 'ok', text: 'Password set. You can now sign in.' });
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <AuthCard title="Set your password">
        <p className="msg msg-error" role="alert">
          This link is missing its token. Ask an admin for a new setup or reset link.
        </p>
        <Link to="/login">Back to sign in</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Set your password" intro="Choose a new password for your Due admin account. Links expire and work once.">
      {done ? (
        <>
          <LiveStatus status={status} />
          <Link className="btn btn-primary" to="/login">
            Sign in
          </Link>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <PasswordPair password={password} confirm={confirm} setPassword={setPassword} setConfirm={setConfirm} label="New password" />
          <LiveStatus status={status} />
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </form>
      )}
    </AuthCard>
  );
}

export function ChangePasswordPage() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = validatePassword(next, confirm);
    if (problem) {
      setStatus({ kind: 'error', text: problem });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.post('/auth/change-password', { current, next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setStatus({ kind: 'ok', text: 'Password changed.' });
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="narrow">
      <h1>Change password</h1>
      <form className="card" onSubmit={submit} noValidate>
        <Field label="Current password">
          {(id) => (
            <input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          )}
        </Field>
        <PasswordPair password={next} confirm={confirm} setPassword={setNext} setConfirm={setConfirm} label="New password" />
        <LiveStatus status={status} />
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}
