import { addDays } from './dates';
import { blankCommitment, emptyData, setStatementLink } from './data';
import type { AppData } from './types';
import { sampleRelay } from './offers/relay';

/** Demo dataset, all labelled "(demo)". Dates are relative to `today` so the demo always looks current. */
export function buildSampleData(today: string): AppData {
  let data = emptyData();
  const stamp = { isSample: true, lastConfirmed: today } as const;

  const card = {
    ...blankCommitment('credit_card', today),
    id: 'sample_card',
    provider: 'Sample Bank card',
    nickname: 'Card statement (demo)',
    amountPaise: 1500000,
    frequency: 'one_time' as const,
    nextDue: addDays(today, 14),
    dueConfidence: 'confirmed' as const,
    amountConfidence: 'estimate' as const,
    statement: {
      cardNickname: 'Sample card',
      periodStart: addDays(today, -26),
      periodEnd: addDays(today, 4),
      confirmedFromLatest: false,
    },
    notes: 'Sample data. Replace with your own statement.',
    ...stamp,
  };
  const stream = {
    ...blankCommitment('subscription', today),
    id: 'sample_stream',
    provider: 'Sample Streaming',
    nickname: 'Streaming (demo)',
    amountPaise: 49900,
    nextDue: addDays(today, 3),
    dueConfidence: 'confirmed' as const,
    amountConfidence: 'confirmed' as const,
    rail: 'credit_card' as const,
    accountNickname: 'Sample card',
    importance: 'optional' as const,
    notes: 'Sample data. Charged to the sample card, so it is not added again to cash due.',
    subscription: { cancellationBy: addDays(today, 2) },
    ...stamp,
  };
  const emi = {
    ...blankCommitment('emi', today),
    id: 'sample_emi',
    provider: 'Sample Lender',
    nickname: 'Appliance EMI (demo)',
    amountPaise: 325000,
    nextDue: addDays(today, 5),
    dueConfidence: 'confirmed' as const,
    amountConfidence: 'confirmed' as const,
    remainingOccurrences: 8,
    importance: 'essential' as const,
    loan: {
      lenderNickname: 'Sample Lender',
      loanType: 'Consumer durable',
      originalTenureMonths: 12,
      interestRatePct: 12,
      rateType: 'fixed' as const,
    },
    notes: 'Sample data. Interest rate is user-entered, not verified.',
    ...stamp,
  };
  const school = {
    ...blankCommitment('school_fee', today),
    id: 'sample_school',
    provider: 'School fees',
    nickname: 'School fees (demo)',
    amountPaise: 1200000,
    frequency: 'quarterly' as const,
    nextDue: addDays(today, 20),
    dueConfidence: 'estimate' as const,
    amountConfidence: 'estimate' as const,
    remainingOccurrences: 3,
    importance: 'essential' as const,
    notes: 'Sample data. Generic label only; no child details.',
    ...stamp,
  };

  data.commitments.push(card, stream, emi, school);
  data = setStatementLink(data, stream.id, card.id);
  data.seasons.push({
    id: 'sample_season',
    name: 'Cricket season (demo)',
    start: addDays(today, 30),
    end: addDays(today, 75),
    linkedCommitmentIds: [stream.id],
    considerLeadDays: 7,
    reviewLeadDays: 3,
    restartDate: null,
    isSample: true,
  });
  data.services.push({
    id: 'sample_svc_airtel',
    provider: 'airtel',
    serviceType: 'prepaid',
    label: 'Airtel prepaid (demo)',
    planName: '₹699 recharge',
    approxPricePaise: 69900,
    existingSubscription: null,
    renewalDate: addDays(today, 25),
    notes: 'Demo record.',
    createdAt: today,
    isSample: true,
  });
  data.relay = sampleRelay(`${today}T09:00:00.000Z`);
  return data;
}
