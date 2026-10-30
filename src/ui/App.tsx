import { useEffect, useRef, useState } from 'react';
import { AppProvider, useApp } from './store';
import { Home } from './Home';
import { CategoryView } from './CategoryView';
import { CommitmentForm } from './CommitmentForm';
import { BudgetView } from './BudgetView';
import { SeasonsView } from './SeasonsView';
import { RemindersView } from './RemindersView';
import { SettingsView } from './SettingsView';
import { ImportView } from './ImportView';
import { CalendarView } from './CalendarView';
import { CalcView } from './CalcView';
import { OffersHome } from './offers/OffersHome';
import { OfferDetail } from './offers/OfferDetail';
import { AddService } from './offers/AddService';
import { ServiceCard } from './offers/ServiceCard';
import { ScenarioCalculator } from './offers/ScenarioCalculator';
import { RelayInbox } from './offers/RelayInbox';
import type { CommitmentType } from '../lib/types';

export type Route =
  | { name: 'home' }
  | { name: 'category'; type: CommitmentType }
  | { name: 'add'; type: CommitmentType }
  | { name: 'edit'; id: string }
  | { name: 'offer'; id: string }
  | { name: 'service'; id: string }
  | {
      name:
        | 'budget'
        | 'seasons'
        | 'reminders'
        | 'settings'
        | 'import'
        | 'calendar'
        | 'calc'
        | 'offers'
        | 'offers-add'
        | 'offers-calc'
        | 'relay';
    };

export interface Nav {
  go: (r: Route) => void;
  back: () => void;
}

const SIMPLE = [
  'budget',
  'seasons',
  'reminders',
  'settings',
  'import',
  'calendar',
  'calc',
  'offers',
  'offers-add',
  'offers-calc',
  'relay',
] as const;

function parse(hash: string): Route {
  const [name, a] = hash.replace(/^#\/?/, '').split('/');
  switch (name) {
    case 'category':
      return { name: 'category', type: (a as CommitmentType) || 'subscription' };
    case 'add':
      return { name: 'add', type: (a as CommitmentType) || 'subscription' };
    case 'edit':
      return { name: 'edit', id: a };
    case 'offer':
      return { name: 'offer', id: a };
    case 'service':
      return { name: 'service', id: a };
    default:
      return (SIMPLE as readonly string[]).includes(name)
        ? { name: name as (typeof SIMPLE)[number] }
        : { name: 'home' };
  }
}

export function toHash(r: Route): string {
  switch (r.name) {
    case 'category':
    case 'add':
      return `#/${r.name}/${r.type}`;
    case 'edit':
    case 'offer':
    case 'service':
      return `#/${r.name}/${r.id}`;
    default:
      return `#/${r.name === 'home' ? '' : r.name}`;
  }
}

function Shell() {
  const [route, setRoute] = useState<Route>(() => parse(window.location.hash));
  const { persisted } = useApp();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    const h = mainRef.current?.querySelector<HTMLElement>('h1');
    if (h) {
      h.setAttribute('tabindex', '-1');
      h.focus({ preventScroll: true });
    }
  }, [route]);
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
    case 'calendar':
      view = <CalendarView nav={nav} />;
      break;
    case 'calc':
      view = <CalcView />;
      break;
    case 'offers':
      view = <OffersHome nav={nav} />;
      break;
    case 'offers-add':
      view = <AddService nav={nav} />;
      break;
    case 'offers-calc':
      view = <ScenarioCalculator />;
      break;
    case 'relay':
      view = <RelayInbox nav={nav} />;
      break;
    case 'offer':
      view = <OfferDetail id={route.id} />;
      break;
    case 'service':
      view = <ServiceCard id={route.id} nav={nav} />;
      break;
    default:
      view = <Home nav={nav} />;
  }

  const inOffers = ['offer', 'service', 'offers-add', 'offers-calc', 'relay'].includes(route.name);
  return (
    <div className="app">
      {!persisted && (
        <div className="notice">
          Your browser isn’t saving data (private mode or storage blocked). Export from Settings
          before closing.
        </div>
      )}
      {route.name !== 'home' && (
        <div className="backrow">
          <a className="back" href={inOffers ? '#/offers' : '#/'}>
            ‹ {inOffers ? 'Back to Due & Offers' : 'Back to Due'}
          </a>
        </div>
      )}
      <main key={JSON.stringify(route)} ref={mainRef}>
        {view}
      </main>
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
