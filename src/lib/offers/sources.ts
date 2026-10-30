import type { SourceRef } from './types';

/** Official sources cited in "Due Offer Intelligence: moat and Due Relay strategy" (research date 30 Oct 2026). */
export const SRC: Record<number, SourceRef> = {
  1: {
    ref: 1,
    kind: 'landing_page',
    label: 'Jio Google Gemini offer page',
    url: 'https://www.jio.com/google-gemini-offer/',
  },
  2: {
    ref: 2,
    kind: 'terms',
    label: 'Jio Google Gemini offer terms and conditions',
    url: 'https://www.jio.com/jcms/en-in/jio-google-gemini-terms-and-conditions/',
  },
  3: {
    ref: 3,
    kind: 'faq',
    label: 'Jio Google Gemini offer FAQ',
    url: 'https://www.jio.com/help/faq/mobile/offers/google-gemini-offer/',
  },
  4: {
    ref: 4,
    kind: 'plan_page',
    label: 'Jio prepaid plans',
    url: 'https://www.jio.com/selfcare/plans/mobility/prepaid-plans-home/',
  },
  5: {
    ref: 5,
    kind: 'press_release',
    label: 'Airtel press release: postpaid with Apple iCloud, Apple TV and Apple Arcade (Sep 2026)',
    url: 'https://www.airtel.in/press-release/09-2026/airtel-enhances-its-postpaid-offering-by-adding-apples-newly-expanded-icloud-with-apple-tv-and-apple-arcade/',
  },
  6: {
    ref: 6,
    kind: 'plan_page',
    label: 'Airtel broadband (Fiber) plans',
    url: 'https://www.airtel.in/plans/broadband',
  },
  7: {
    ref: 7,
    kind: 'press_release',
    label: 'Airtel press release: Adobe Express Premium (Jan 2026)',
    url: 'https://www.airtel.in/press-release/01-2026/in-a-global-first-airtel-provides-360-million-indians-with-free-access-to-adobe-express-premium/',
  },
  8: {
    ref: 8,
    kind: 'campaign_page',
    label: 'Amazon.in page for the Airtel ₹699 recharge with Prime',
    url: 'https://www.amazon.in/b?ie=UTF8&node=16700000031',
  },
  9: {
    ref: 9,
    kind: 'plan_page',
    label: 'Vi Movies & TV',
    url: 'https://www.myvi.in/vi-movies-and-tv/all-ott-in-one-app',
  },
  10: {
    ref: 10,
    kind: 'campaign_page',
    label: 'Vi recharge cashback offers',
    url: 'https://www.myvi.in/prepaid/recharge-cashback-offers',
  },
  11: {
    ref: 11,
    kind: 'help_page',
    label: 'Amazon Prime plans help page',
    url: 'https://www.amazon.in/gp/help/customer/display.html?nodeId=G6RZ3AA6NQMCKYEM',
  },
  12: {
    ref: 12,
    kind: 'help_page',
    label: 'Amazon Prime membership and billing help page',
    url: 'https://www.amazon.in/gp/help/customer/display.html?nodeId=G2B9L3YR7LR8J4XP',
  },
  13: {
    ref: 13,
    kind: 'help_page',
    label: 'Prime Video help: subscriptions through partners',
    url: 'https://www.primevideo.com/help?nodeId=202095490',
  },
  14: {
    ref: 14,
    kind: 'campaign_page',
    label: 'Amazon Pay cashback campaign page (Apr–May 2026)',
    url: 'https://www.amazon.in/b?ie=UTF8&node=207354383031',
  },
  15: {
    ref: 15,
    kind: 'plan_page',
    label: 'Google AI subscriptions in India',
    url: 'https://gemini.google/in/subscriptions/?hl=en-IN',
  },
  16: {
    ref: 16,
    kind: 'help_page',
    label: 'Google One help: trials and payment method',
    url: 'https://support.google.com/googleone/answer/9155746?hl=en-IN',
  },
  17: {
    ref: 17,
    kind: 'help_page',
    label: 'Google One help: cancel or change your plan',
    url: 'https://support.google.com/googleone/answer/9056360?hl=en-IN',
  },
  18: {
    ref: 18,
    kind: 'help_page',
    label: 'Google One help: plans billed by partners',
    url: 'https://support.google.com/googleone/answer/15801606?hl=en-IN',
  },
  19: {
    ref: 19,
    kind: 'help_page',
    label: 'Google Pay India help: rewards and cashback',
    url: 'https://support.google.com/pay/india/answer/18815856',
  },
  20: {
    ref: 20,
    kind: 'product_page',
    label: 'RuPay credit card on UPI',
    url: 'https://www.rupay.co.in/rupay-credit-card-on-upi',
  },
  21: {
    ref: 21,
    kind: 'product_page',
    label: 'Paytm for Business: subscriptions and UPI Autopay',
    url: 'https://business.paytm.com/subscriptions',
  },
};

export const OFFICIAL_DOMAINS = [
  'jio.com',
  'airtel.in',
  'myvi.in',
  'amazon.in',
  'primevideo.com',
  'gemini.google',
  'support.google.com',
  'rupay.co.in',
  'business.paytm.com',
];

export function isOfficialUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return OFFICIAL_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
