import type { CommitmentType } from '../../lib/types';

const SIMPLE = [
  'home',
  'start',
  'import',
  'upload',
  'sms',
  'forward',
  'csv',
  'account',
  'plans',
  'reminders',
  'settings',
  'connections',
  'budget',
  'seasons',
  'calendar',
  'calc',
  'offers',
  'offers-add',
  'offers-calc',
  'relay',
  'reminders-ics',
] as const;
type SimpleName = (typeof SIMPLE)[number];

export type Route =
  | { name: SimpleName }
  | { name: 'all'; type?: CommitmentType }
  | { name: 'category'; type: CommitmentType }
  | { name: 'add'; type?: CommitmentType }
  | { name: 'item' | 'edit' | 'details' | 'offer' | 'service'; id: string };

export interface Nav {
  go: (r: Route) => void;
  back: () => void;
}

export function parseRoute(hash: string): Route {
  const [name, a] = hash.replace(/^#\/?/, '').split('/');
  switch (name) {
    case 'all':
      return a ? { name: 'all', type: a as CommitmentType } : { name: 'all' };
    case 'category':
      return { name: 'all', type: (a as CommitmentType) || undefined };
    case 'add':
      return a ? { name: 'add', type: a as CommitmentType } : { name: 'add' };
    case 'item':
    case 'edit':
    case 'details':
    case 'offer':
    case 'service':
      return a ? { name, id: decodeURIComponent(a) } : { name: 'home' };
    default:
      return (SIMPLE as readonly string[]).includes(name)
        ? { name: name as SimpleName }
        : { name: 'home' };
  }
}

export function toHash(r: Route): string {
  switch (r.name) {
    case 'all':
    case 'add':
      return r.type ? `#/${r.name}/${r.type}` : `#/${r.name}`;
    case 'category':
      return `#/all/${r.type}`;
    case 'item':
    case 'edit':
    case 'details':
    case 'offer':
    case 'service':
      return `#/${r.name}/${encodeURIComponent(r.id)}`;
    case 'home':
      return '#/';
    default:
      return `#/${r.name}`;
  }
}

export const nav: Nav = {
  go: (r) => {
    window.location.hash = toHash(r);
    window.scrollTo(0, 0);
  },
  back: () => (window.history.length > 1 ? window.history.back() : (window.location.hash = '#/')),
};
