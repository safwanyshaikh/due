import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import { api } from '../lib/api';
import { can, useAuth } from '../lib/auth';
import { humanize } from '../lib/format';

const NAV: { to: string; label: string; perm?: 'admin' }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/companies', label: 'Companies & vendors' },
  { to: '/sources', label: 'Sources' },
  { to: '/records', label: 'Data' },
  { to: '/categories', label: 'Categories' },
  { to: '/automation', label: 'Automation' },
  { to: '/users', label: 'Users & access', perm: 'admin' },
  { to: '/plans', label: 'Plans' },
  { to: '/settings', label: 'Settings' },
];

export function Layout() {
  const { me, setMe } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      // Session may already be gone; continue to login either way.
    }
    setMe(null);
    navigate('/login');
  }

  return (
    <div className="shell">
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true">
            D
          </span>
          <span>Due Admin</span>
        </div>
        <button
          type="button"
          className="btn btn-ghost menu-toggle"
          aria-expanded={open}
          aria-controls="main-nav"
          onClick={() => setOpen((o) => !o)}
        >
          Menu
        </button>
        <div className="who">
          {me ? (
            <>
              <span className="muted">
                {me.name || me.email} · {humanize(me.role)}
              </span>
              <NavLink to="/account" className="btn btn-ghost">
                Change password
              </NavLink>
              <button type="button" className="btn btn-ghost" onClick={logout}>
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>
      <div className="body">
        <nav id="main-nav" className={open ? 'nav open' : 'nav'} aria-label="Main">
          <ul>
            {NAV.filter((n) => !n.perm || can(me?.role, n.perm)).map((n) => (
              <li key={n.to}>
                <NavLink to={n.to} end={n.to === '/'} onClick={() => setOpen(false)}>
                  {n.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
