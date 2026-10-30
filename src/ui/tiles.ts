import type { CommitmentType } from '../lib/types';

export type TileColor =
  'lav' | 'green' | 'peach' | 'yellow' | 'pink' | 'mint' | 'slate' | 'coral' | 'sky';

export interface TileDef {
  type: CommitmentType;
  name: string;
  color: TileColor;
  icon: IconName;
  one: string;
  many: string;
  emptySub: string;
  emptyAct: string;
  add: string;
  lead: string;
}

export type IconName =
  | 'play'
  | 'steps'
  | 'link'
  | 'card'
  | 'book'
  | 'home'
  | 'dots'
  | 'sun'
  | 'gear'
  | 'shield'
  | 'leaf'
  | 'info'
  | 'flag'
  | 'gift';

export const TILES: TileDef[] = [
  {
    type: 'subscription',
    name: 'Subscriptions',
    color: 'lav',
    icon: 'play',
    one: 'plan',
    many: 'plans',
    emptySub: 'Plans you choose to keep',
    emptyAct: 'Add a subscription',
    add: 'Add subscription',
    lead: 'Your subscriptions',
  },
  {
    type: 'emi',
    name: 'EMIs',
    color: 'green',
    icon: 'steps',
    one: 'instalment',
    many: 'instalments',
    emptySub: 'Plan your instalments',
    emptyAct: 'Add an EMI',
    add: 'Add EMI',
    lead: 'Your EMIs',
  },
  {
    type: 'other_loan',
    name: 'Other loans',
    color: 'peach',
    icon: 'link',
    one: 'loan',
    many: 'loans',
    emptySub: 'Plan your instalments',
    emptyAct: 'Add a loan',
    add: 'Add loan',
    lead: 'Your other loans',
  },
  {
    type: 'credit_card',
    name: 'Credit cards',
    color: 'yellow',
    icon: 'card',
    one: 'statement',
    many: 'statements',
    emptySub: 'Statements in one place',
    emptyAct: 'Add a statement',
    add: 'Add statement',
    lead: 'Your card statements',
  },
  {
    type: 'school_fee',
    name: 'School fees',
    color: 'pink',
    icon: 'book',
    one: 'term',
    many: 'terms',
    emptySub: 'Terms and instalments',
    emptyAct: 'Add school fees',
    add: 'Add school fees',
    lead: 'Your school fees',
  },
  {
    type: 'bill',
    name: 'Bills & essentials',
    color: 'mint',
    icon: 'home',
    one: 'bill',
    many: 'bills',
    emptySub: 'Keep household plans together',
    emptyAct: 'Add a bill',
    add: 'Add bill',
    lead: 'Your bills and essentials',
  },
  {
    type: 'other',
    name: 'Other commitments',
    color: 'slate',
    icon: 'dots',
    one: 'item',
    many: 'items',
    emptySub: 'Rent, insurance, family, more',
    emptyAct: 'Add commitment',
    add: 'Add commitment',
    lead: 'Your other commitments',
  },
];

export const TILE_BY_TYPE = Object.fromEntries(TILES.map((t) => [t.type, t])) as Record<
  CommitmentType,
  TileDef
>;
