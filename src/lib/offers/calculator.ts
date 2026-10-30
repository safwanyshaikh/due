/**
 * Scenario maths on the user's own assumptions. Results are estimates only.
 * Documented prices and terms are passed in from Due's monitoring service; when it has none,
 * the result says so instead of using a bundled figure.
 */

export const NOT_AVAILABLE =
  'Not available from Due’s monitoring service — check the provider app or site';

export interface ScenarioLine {
  label: string;
  paise: number | null;
  kind: 'documented' | 'user_assumption' | 'estimated_value' | 'note';
}

export interface ScenarioResult {
  lines: ScenarioLine[];
  estimatedValuePaise: number;
  confidence: 'high' | 'medium' | 'low';
  unresolved: string[];
  warnings: string[];
  reminderDate?: string;
}

export function airtel699Prime(input: {
  existingPrime: boolean | null;
  /** What the user would otherwise pay for Prime over the same period. User assumption. */
  avoidedPrimeCostPaise: number | null;
  /** Recharge price from the monitoring service, if it has one. */
  documentedPricePaise: number | null;
}): ScenarioResult {
  const warnings: string[] = [];
  const unresolved = [
    'Prime validity starts with the recharge or pack start',
    'Circle availability',
  ];
  let avoided = input.avoidedPrimeCostPaise ?? 0;
  if (input.existingPrime === true) {
    warnings.push(
      'You said you already have Prime. Existing Prime members may not be eligible, so no value is counted.',
    );
    avoided = 0;
  } else if (input.existingPrime === null) {
    unresolved.push('Whether you already have Prime');
  }
  return {
    lines: [
      input.documentedPricePaise != null
        ? {
            label: 'Recharge price (documented)',
            paise: input.documentedPricePaise,
            kind: 'documented',
          }
        : { label: `Recharge price: ${NOT_AVAILABLE}`, paise: null, kind: 'note' },
      {
        label: 'Prime cost you’d otherwise pay for the same period (your assumption)',
        paise: input.avoidedPrimeCostPaise,
        kind: 'user_assumption',
      },
    ],
    estimatedValuePaise: avoided,
    confidence:
      input.existingPrime === false && input.avoidedPrimeCostPaise !== null ? 'medium' : 'low',
    unresolved,
    warnings,
  };
}

export function airtelMonthlyCashback(input: {
  variants: ('wallet' | 'upi')[];
  /** Reward amount as shown to the user in the Airtel app. User assumption. */
  rewardPaise: number | null;
  alreadyUsedThisMonth: boolean;
}): ScenarioResult {
  const warnings: string[] = [];
  const v = [...new Set(input.variants)];
  if (v.length > 1)
    warnings.push('Wallet and UPI cashback variants cannot be combined. Only one can count.');
  const remaining = input.alreadyUsedThisMonth ? 0 : (input.rewardPaise ?? 0);
  return {
    lines: [
      {
        label: 'Reward shown to you (your entry)',
        paise: input.rewardPaise,
        kind: 'user_assumption',
      },
      { label: 'Remaining this month', paise: remaining, kind: 'estimated_value' },
    ],
    estimatedValuePaise: remaining,
    confidence: 'low',
    unresolved: ['Reward cap and dates in the Airtel app', 'Whether your account is selected'],
    warnings,
  };
}

export function addMonthsISO(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(d, dim)).padStart(2, '0')}`;
}

export function jioAiCloud(input: {
  numberType: 'jio' | 'non_jio' | null;
  trialStart: string | null;
  /** Trial terms from the monitoring service, if it has them. */
  trialMonths: number | null;
  storageGb: number | null;
}): ScenarioResult {
  if (input.numberType === 'jio') {
    return {
      lines: [{ label: 'JioAICloud for Jio numbers', paise: 0, kind: 'documented' }],
      estimatedValuePaise: 0,
      confidence: 'medium',
      unresolved: ['Storage included for your account'],
      warnings: [],
    };
  }
  if (input.numberType === 'non_jio') {
    const months = input.trialMonths;
    const end = input.trialStart && months ? addMonthsISO(input.trialStart, months) : undefined;
    const terms = [
      months ? `${months} months` : null,
      input.storageGb ? `${input.storageGb} GB` : null,
    ]
      .filter(Boolean)
      .join(', ');
    return {
      lines: [
        terms
          ? { label: `One-time trial: ${terms} (documented)`, paise: 0, kind: 'documented' }
          : { label: `Trial terms: ${NOT_AVAILABLE}`, paise: null, kind: 'note' },
        {
          label: end
            ? `Trial ends around ${end}`
            : months
              ? 'Add a start date to see the trial end'
              : 'Trial length unknown — check the end date in the provider app',
          paise: null,
          kind: 'note',
        },
      ],
      estimatedValuePaise: 0,
      confidence: 'medium',
      unresolved: ['What happens to stored files after the trial'],
      warnings: [],
      reminderDate: end,
    };
  }
  return {
    lines: [],
    estimatedValuePaise: 0,
    confidence: 'low',
    unresolved: ['Whether your number is Jio or non-Jio'],
    warnings: [],
  };
}

export function googleAiTrial(input: {
  plan: 'plus' | 'pro';
  trialEnd: string | null;
  /** Monthly price of the chosen plan from the monitoring service, if it has one. */
  documentedPricePaise: number | null;
}): ScenarioResult {
  const planName = input.plan === 'pro' ? 'AI Pro' : 'AI Plus';
  return {
    lines: [
      { label: 'A payment method is usually needed to start a trial', paise: null, kind: 'note' },
      input.documentedPricePaise != null
        ? {
            label: `Expected paid renewal, ${planName} per month (documented, can change)`,
            paise: input.documentedPricePaise,
            kind: 'documented',
          }
        : { label: `${planName} price: ${NOT_AVAILABLE}`, paise: null, kind: 'note' },
      {
        label: input.trialEnd ? `Decide before ${input.trialEnd}` : 'Add your trial end date',
        paise: null,
        kind: 'note',
      },
    ],
    estimatedValuePaise: 0,
    confidence: input.trialEnd ? 'medium' : 'low',
    unresolved: [
      'Exact trial length for your account',
      'What happens to extra storage if you stop',
    ],
    warnings: ['If you do nothing, the trial can renew into the paid plan.'],
    reminderDate: input.trialEnd ?? undefined,
  };
}
