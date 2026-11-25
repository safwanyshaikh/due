/**
 * "How Due is different": the comparison table. Facts about other products come only from
 * docs/research/value-graph-v2.html and docs/launch/COMPETITION.md (public information, Due's own reading).
 * Where those sources say nothing the cell says "Not stated". Plain product names only; no logos. Information only:
 * no guarantee or minimum-saving wording. Review monthly with the competition watch list.
 */
export const COMPARE_AS_OF = 'Nov 2026';

export type Mark = 'yes' | 'no' | 'partly' | 'unknown';
export interface Cell {
  mark: Mark;
  note: string;
}

export const COMPARE_COLUMNS = [
  'Due',
  'CRED',
  'INDmoney',
  'Rocket Money',
  'Monarch Money',
] as const;
export type CompareColumn = (typeof COMPARE_COLUMNS)[number];

const NS: Cell = { mark: 'unknown', note: 'Not stated' };

export const COMPARE_ROWS: { id: string; label: string; cells: Record<CompareColumn, Cell> }[] = [
  {
    id: 'sees-all',
    label: 'Sees all your recurring payments (subs, EMIs, cards, telecom, rides)',
    cells: {
      Due: { mark: 'partly', note: 'Subs, EMIs, cards and bills you add or import' },
      CRED: { mark: 'partly', note: 'Card bills and rewards' },
      INDmoney: { mark: 'partly', note: 'Investments, net worth and tracking' },
      'Rocket Money': { mark: 'partly', note: 'Subscriptions and bills, US-focused' },
      'Monarch Money': { mark: 'partly', note: 'Budgeting across accounts, US-focused' },
    },
  },
  {
    id: 'on-phone',
    label: 'Reads your statements on your phone, not on a server',
    cells: {
      Due: { mark: 'yes', note: 'Files are read on your device' },
      CRED: NS,
      INDmoney: NS,
      'Rocket Money': NS,
      'Monarch Money': NS,
    },
  },
  {
    id: 'double',
    label: 'Finds double payments & overlaps',
    cells: {
      Due: { mark: 'yes', note: 'Flags repeats and overlapping plans' },
      CRED: NS,
      INDmoney: NS,
      'Rocket Money': NS,
      'Monarch Money': NS,
    },
  },
  {
    id: 'leaks',
    label: 'Shows card-interest and EMI-bounce leaks',
    cells: {
      Due: {
        mark: 'partly',
        note: 'Loan and EMI summary from a statement; bounce alerts are not built yet',
      },
      CRED: NS,
      INDmoney: NS,
      'Rocket Money': NS,
      'Monarch Money': NS,
    },
  },
  {
    id: 'lenders',
    label: 'Earns money from lenders / loan referrals',
    cells: {
      Due: { mark: 'no', note: 'Earns only from users (Plus, later)' },
      CRED: { mark: 'yes', note: 'Offers loans through partner lenders' },
      INDmoney: NS,
      'Rocket Money': NS,
      'Monarch Money': { mark: 'no', note: 'Paid subscription, no ads' },
    },
  },
  {
    id: 'india',
    label: 'Works for Indian banks & UPI AutoPay',
    cells: {
      Due: { mark: 'yes', note: 'Built for India, in rupees' },
      CRED: { mark: 'yes', note: 'Built for India' },
      INDmoney: { mark: 'yes', note: 'Built for India' },
      'Rocket Money': { mark: 'no', note: 'US product' },
      'Monarch Money': { mark: 'no', note: 'US product' },
    },
  },
  {
    id: 'business',
    label: 'Business + personal profiles',
    cells: {
      Due: { mark: 'yes', note: 'Personal and business in one place' },
      CRED: NS,
      INDmoney: NS,
      'Rocket Money': NS,
      'Monarch Money': NS,
    },
  },
  {
    id: 'price',
    label: 'Price',
    cells: {
      Due: { mark: 'yes', note: 'Free during beta' },
      CRED: NS,
      INDmoney: NS,
      'Rocket Money': {
        mark: 'partly',
        note: 'Fee on negotiated savings and a premium plan (amounts not stated)',
      },
      'Monarch Money': { mark: 'partly', note: 'Paid only, no free tier (amount not stated)' },
    },
  },
];

export const WHY_DUE = [
  {
    id: 'phone',
    title: 'Your statements stay on your phone',
    body: 'Documents are read on your device. Only the fields you approve are kept.',
  },
  {
    id: 'ranked',
    title: 'Ranked moves, not ads',
    body: 'Due shows what may be worth a look, in order. It earns only from users, never from lenders.',
  },
  {
    id: 'both',
    title: 'Personal + business in one place',
    body: 'Keep personal and business dues side by side, each with its own view.',
  },
] as const;

export const MARK_LABEL: Record<Mark, string> = {
  yes: 'Yes',
  no: 'No',
  partly: 'Partly',
  unknown: 'Not stated',
};
export const MARK_SYMBOL: Record<Mark, string> = { yes: '✓', no: '✗', partly: '◐', unknown: '?' };
