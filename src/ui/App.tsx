import { useEffect, useState } from 'react';
import { AppProvider, useApp } from './store';
import { Home } from './Home';
import { CategoryView } from './CategoryView';
import { CommitmentForm } from './CommitmentForm';
import { BudgetView } from './BudgetView';
import { SeasonsView } from './SeasonsView';
import { RemindersView } from './RemindersView';
import { SettingsView } from './SettingsView';
import { ImportView } from './ImportView';
import type { CommitmentType } from '../lib/types';
import { NO_PAYMENT_NOTE } from '../content/privacy';

export type Route =
  | { name: 'home' }
  | { name: 'category'; type: CommitmentType }
  | { name: 'add'; type: CommitmentType }
  | { name: 'edit'; id: string }
  | { name: 'budget' }
  | { name: 'seasons' }
  | { name: 'reminders' }
  | { name: 'settings' }
  | { name: 'import' };

export interface Nav {
  go: (r: Route) => void;
  back: () => void;
}

function parse(hash: string): Route {
  const [name, a] = hash.replace(/^#\/?/, '').split('/');
  switch (name) {
    case 'category':
      return { name: 'category', type: (a as CommitmentType) || 'subscription' };
    case 'add':
      return { name: 'add', type: (a as CommitmentType) || 'subscription' };
    case 'edit':
      return { name: 'edit', id: a };
    case 'budget':
    case 'seasons':
    case 'reminders':
    case 'settings':
    case 'import':
      return { name };
    default:
      return { name: 'home' };
  }
}

function toHash(r: Route): string {
  switch (r.name) {
    case 'category':
    case 'add':
      return `#/${r.name}/${r.type}`;
    case 'edit':
      return `#/edit/${r.id}`;
    default:
      return `#/${r.name === 'home' ? '' : r.name}`;
  }
}

function Shell() {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  const { persisted } = useApp();
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const nav: Nav = {
    go: (r) => {
      window.location.hash = toHash(r);
      window.scrollTo(0, 0);
    },
    back: () => (window.history.length > 1 ? window.history.back() : (window.location.hash = '#/')),
  };

  let view;
  switch (route.name) {
    case 'category':
      view = <CategoryView type={route.type} nav={nav} />;
      break;
    case 'add':
      view = <CommitmentForm type={route.type} nav={nav} />;
      break;
    case 'edit':
      view = <CommitmentForm editId={route.id} nav={nav} />;
      break;
    case 'budget':
      view = <BudgetView />;
      break;
    case 'seasons':
      view = <SeasonsView />;
      break;
    case 'reminders':
      view = <RemindersView />;
      break;
    case 'settings':
      view = <SettingsView nav={nav} />;
      break;
    case 'import':
      view = <ImportView nav={nav} />;
      break;
    default:
      view = <Home nav={nav} />;
  }

  const tab = (name: Route['name'], label: string) => (
    <a
      className={route.name === name ? 'tab active' : 'tab'}
      href={name === 'home' ? '#/' : `#/${name}`}
      aria-current={route.name === name ? 'page' : undefined}
    >
      {label}
    </a>
  );

  return (
    <div className="app">
      <header className="topbar">
        <strong>Payables Planner</strong>
        <span className="beta">invite-only beta</span>
      </header>
      {!persisted && (
        <div className="notice">
          Your browser is not saving data (private mode or storage blocked). Export before closing.
        </div>
      )}
      <main key={JSON.stringify(route)}>{view}</main>
      <p className="footnote">{NO_PAYMENT_NOTE}</p>
      <nav className="tabbar" aria-label="Main">
        {tab('home', 'Home')}
        {tab('budget', 'Limits')}
        {tab('seasons', 'Seasons')}
        {tab('reminders', 'Reminders')}
        {tab('settings', 'Settings')}
      </nav>
    </div>
  );
}

export function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
