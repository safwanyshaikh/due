/** Scenario maths on the user's own assumptions. Results are estimates only. */

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
  /** What the user would otherwise pay for Prime over the same 56 days. User assumption. */
  avoidedPrimeCostPaise: number | null;
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
      { label: 'Recharge price (documented)', paise: 69900, kind: 'documented' },
      {
        label: 'Prime cost you’d otherwise pay for 56 days (your assumption)',
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
    const end = input.trialStart ? addMonthsISO(input.trialStart, 3) : undefined;
    return {
      lines: [
        { label: 'One-time trial: 3 months, 50 GB (documented)', paise: 0, kind: 'documented' },
        {
          label: end ? `Trial ends around ${end}` : 'Add a start date to see the trial end',
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
}): ScenarioResult {
  const price = input.plan === 'pro' ? 195000 : 39900;
  return {
    lines: [
      { label: 'Payment method needed to start (documented)', paise: null, kind: 'note' },
      {
        label: `Expected paid renewal, ${input.plan === 'pro' ? 'AI Pro' : 'AI Plus'} per month (documented, can change)`,
        paise: price,
        kind: 'documented',
      },
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
