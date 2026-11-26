import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, errorText } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { Me, SecondStep } from '../lib/types';
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

/** The recovery codes, shown once after enrolment (or after making new ones). */
export function RecoveryCodes({ codes, onDone, doneLabel = 'I have saved these codes' }: { codes: string[]; onDone: () => void; doneLabel?: string }) {
  return (
    <div>
      <p>
        Keep these recovery codes somewhere safe, such as a password manager. Each code works once, if you lose your
        phone. We will not show them again.
      </p>
      <ol className="recovery-codes" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <button className="btn btn-primary" type="button" onClick={onDone}>
        {doneLabel}
      </button>
    </div>
  );
}

/**
 * Second sign-in step: a 6-digit code from an authenticator app (or a recovery code), or first-time enrolment
 * with a QR code. 2-step verification is required for every admin account.
 */
export function SecondStepForm({ step, onSignedIn }: { step: SecondStep; onSignedIn: () => Promise<void> | void }) {
  const [current, setCurrent] = useState<SecondStep>(step);
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      if (current.status === 'enrol_required') {
        const r = await api.post<{ recoveryCodes: string[] }>(
          '/auth/mfa/enrol',
          { challengeToken: current.challengeToken, code: code.trim() },
          { skipAuthRedirect: true },
        );
        setCodes(r.recoveryCodes);
      } else {
        const r = await api.post<SecondStep | { user: Me }>('/auth/mfa', { challengeToken: current.challengeToken, code: code.trim() }, { skipAuthRedirect: true });
        if ('status' in r && r.status === 'enrol_required') {
          setCurrent(r);
          setCode('');
          setStatus({ kind: 'ok', text: 'Recovery code accepted. Set up your authenticator app again to continue.' });
        } else {
          await onSignedIn();
        }
      }
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={() => void onSignedIn()} />;

  return (
    <form onSubmit={submit} noValidate>
      {current.status === 'enrol_required' ? (
        <>
          <p>
            2-step verification is required for admin accounts. Scan this code with an authenticator app (for example
            Google Authenticator, Microsoft Authenticator or 1Password), then enter the 6-digit code it shows.
          </p>
          <img
            className="totp-qr"
            width={200}
            height={200}
            alt="QR code for your authenticator app"
            src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(current.enrolment.qrSvg)}`}
          />
          <p className="small">
            <button className="btn btn-link" type="button" onClick={() => setShowSecret((v) => !v)} aria-expanded={showSecret}>
              {showSecret ? 'Hide the setup key' : 'Can’t scan? Show the setup key'}
            </button>
          </p>
          {showSecret ? (
            <p className="small">
              Account: {current.enrolment.account}
              <br />
              Key: <code aria-label="Setup key">{current.enrolment.secret.match(/.{1,4}/g)?.join(' ')}</code>
            </p>
          ) : null}
        </>
      ) : (
        <p>Enter the 6-digit code from your authenticator app. Lost your phone? Enter one of your recovery codes instead.</p>
      )}
      <Field label={current.status === 'enrol_required' ? '6-digit code' : 'Code'}>
        {(id) => (
          <input
            id={id}
            type="text"
            inputMode={current.status === 'enrol_required' ? 'numeric' : 'text'}
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            maxLength={40}
          />
        )}
      </Field>
      <LiveStatus status={status} />
      <button className="btn btn-primary" type="submit" disabled={busy || code.trim().length < 6}>
        {busy ? 'Checking…' : current.status === 'enrol_required' ? 'Turn on 2-step verification' : 'Verify'}
      </button>
    </form>
  );
}

function useFinishSignIn() {
  const { setMe } = useAuth();
  const navigate = useNavigate();
  return async () => {
    const me = await api.get<Me>('/auth/me', { skipAuthRedirect: true });
    setMe(me);
    navigate('/');
  };
}

export function LoginPage() {
  const finish = useFinishSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<SecondStep | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      setStep(await api.post<SecondStep>('/auth/login', { email, password }, { skipAuthRedirect: true }));
      setPassword('');
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  if (step) {
    return (
      <AuthCard title={step.status === 'enrol_required' ? 'Set up 2-step verification' : '2-step verification'}>
        <SecondStepForm step={step} onSignedIn={finish} />
        <p className="muted small">
          <button className="btn btn-link" type="button" onClick={() => setStep(null)}>
            Start again
          </button>
        </p>
      </AuthCard>
    );
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
  const finish = useFinishSignIn();
  const [step, setStep] = useState<SecondStep | null>(null);
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
      setStep(
        await api.post<SecondStep>('/auth/setup', { setupToken: setupToken.trim(), email: email.trim(), name: name.trim(), password }, { skipAuthRedirect: true }),
      );
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  if (step) {
    return (
      <AuthCard title="Set up 2-step verification" intro="Owner account created. One more step: connect an authenticator app.">
        <SecondStepForm step={step} onSignedIn={finish} />
      </AuthCard>
    );
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
  const [step, setStep] = useState<SecondStep | null>(null);
  const [busy, setBusy] = useState(false);
  const finish = useFinishSignIn();

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
      setStep(await api.post<SecondStep>('/auth/reset', { token, password }, { skipAuthRedirect: true }));
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
      {step ? (
        <>
          <p className="msg msg-ok">Password set.</p>
          <SecondStepForm step={step} onSignedIn={finish} />
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
      <RecoveryCodesCard />
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

/** Make a new set of recovery codes (old ones stop working). Needs a fresh code from the authenticator app. */
function RecoveryCodesCard() {
  const { me, refresh } = useAuth();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [status, setStatus] = useState<Status>(null);
  async function regenerate() {
    setStatus(null);
    try {
      setCodes((await api.post<{ recoveryCodes: string[] }>('/auth/recovery-codes')).recoveryCodes);
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    }
  }
  return (
    <div className="card">
      <h2>2-step verification</h2>
      {codes ? (
        <RecoveryCodes
          codes={codes}
          doneLabel="Done"
          onDone={() => {
            setCodes(null);
            void refresh();
          }}
        />
      ) : (
        <>
          <p>
            On. Recovery codes left: {me?.recoveryCodesRemaining ?? 'unknown'}.
          </p>
          <LiveStatus status={status} />
          <button className="btn" type="button" onClick={() => void regenerate()}>
            Make new recovery codes
          </button>
        </>
      )}
    </div>
  );
}

/**
 * Asks for a fresh authenticator code before an owner/admin change (the server answered reauth_required).
 * Rendered once by the app shell; `request` resolves true once the code is accepted, false if cancelled.
 */
export function ReauthDialog({ open, onResult }: { open: boolean; onResult: (ok: boolean) => void }) {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setCode('');
      setStatus(null);
      input.current?.focus();
    }
  }, [open]);
  if (!open) return null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await api.post('/auth/reauth', { code: code.trim() }, { skipReauth: true });
      onResult(true);
    } catch (err) {
      setStatus({ kind: 'error', text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop">
      <div className="modal card" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
        <h2 id="reauth-title">Confirm it is you</h2>
        <p>This change needs a fresh code from your authenticator app.</p>
        <form onSubmit={submit} noValidate>
          <Field label="Code">
            {(id) => (
              <input id={id} ref={input} type="text" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} required />
            )}
          </Field>
          <LiveStatus status={status} />
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={busy || code.trim().length < 6}>
              {busy ? 'Checking…' : 'Confirm'}
            </button>
            <button className="btn" type="button" onClick={() => onResult(false)}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
