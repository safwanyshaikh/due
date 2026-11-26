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

/**
 * Every rival cell below comes from docs/launch/COMPETITION.md (scores 0 to 5 are Due's own judgment from public
 * information, 23 Nov 2026) or the first-run benchmark in docs/launch/UX_AUDIT.md (26 Nov 2026). "Our rating"
 * cells say so. Marks: 4 or 5 of 5 = yes, 2 or 3 = partly, 0 or 1 = no. Wording stays plain ASCII.
 */
export const COMPARE_ROWS: { id: string; label: string; cells: Record<CompareColumn, Cell> }[] = [
  {
    id: 'sees-all',
    label: 'Sees all your recurring payments (subs, EMIs, cards, telecom, rides)',
    cells: {
      Due: { mark: 'partly', note: 'Subs, EMIs, cards and bills you add or import' },
      CRED: { mark: 'partly', note: 'Card bills and rewards. Our rating: 2 of 5' },
      INDmoney: { mark: 'partly', note: 'Investments, net worth and tracking. Our rating: 3 of 5' },
      'Rocket Money': {
        mark: 'yes',
        note: 'Subscriptions and bills, US-focused. Our rating: 4 of 5',
      },
      'Monarch Money': {
        mark: 'yes',
        note: 'Budgeting across accounts, US-focused. Our rating: 4 of 5',
      },
    },
  },
  {
    id: 'life',
    label: 'Knows commute, food and phone-plan spending',
    cells: {
      Due: { mark: 'yes', note: 'Rides, food apps and telecom plans are part of its checks' },
      CRED: { mark: 'no', note: 'Our rating: 1 of 5' },
      INDmoney: { mark: 'no', note: 'Our rating: 0 of 5' },
      'Rocket Money': { mark: 'no', note: 'Our rating: 1 of 5' },
      'Monarch Money': { mark: 'no', note: 'Our rating: 0 of 5' },
    },
  },
  {
    id: 'proof',
    label: 'Shows savings actually achieved',
    cells: {
      Due: { mark: 'partly', note: 'Counts a saving only after your bills show the change' },
      CRED: { mark: 'no', note: 'Our rating: 1 of 5' },
      INDmoney: { mark: 'no', note: 'Our rating: 1 of 5' },
      'Rocket Money': {
        mark: 'partly',
        note: 'Our rating: 3 of 5. Bill negotiation, fee on success',
      },
      'Monarch Money': { mark: 'partly', note: 'Our rating: 2 of 5' },
    },
  },
  {
    id: 'neutral',
    label: 'No lender or merchant money steering its advice',
    cells: {
      Due: { mark: 'yes', note: 'Earns only from users (Plus, later)' },
      CRED: { mark: 'no', note: 'Sells loans through lenders. Our rating: 1 of 5' },
      INDmoney: { mark: 'partly', note: 'Earns from investment products. Our rating: 2 of 5' },
      'Rocket Money': { mark: 'partly', note: 'Success fee plus premium. Our rating: 3 of 5' },
      'Monarch Money': { mark: 'yes', note: 'Paid subscription, no ads. Our rating: 5 of 5' },
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
    id: 'signup',
    label: 'What you need to start',
    cells: {
      Due: { mark: 'yes', note: 'Nothing. Open it and add a bill, no sign-up' },
      CRED: { mark: 'partly', note: 'Phone number and OTP; members-only by credit score' },
      INDmoney: { mark: 'partly', note: 'Mobile number, then KYC details' },
      'Rocket Money': { mark: 'partly', note: 'An account and a linked bank account (via Plaid)' },
      'Monarch Money': NS,
    },
  },
  {
    id: 'price',
    label: 'Price',
    cells: {
      Due: { mark: 'yes', note: 'Free during beta' },
      CRED: { mark: 'yes', note: 'No paywall for core features; earns from lenders and merchants' },
      INDmoney: {
        mark: 'yes',
        note: 'No paywall for core features; earns from investment products',
      },
      'Rocket Money': {
        mark: 'partly',
        note: 'Finding subscriptions is free; cancelling needs Premium; fee on negotiated savings (amounts not stated)',
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
