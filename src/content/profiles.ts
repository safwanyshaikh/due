/**
 * Profiles copy: plain and short. Entity names are the only jargon. Information only: no legal or
 * tax advice. Each choice says, in one line, what it changes in Due.
 */
import type {
  EntityQuestion,
  EntityType,
  LiabilityOwner,
  ProfileRole,
  QuestionAnswer,
} from '../lib/profiles/types';

export function questionText(q: Pick<EntityQuestion, 'name' | 'reason'>): string {
  return q.reason === 'loan_co_applicant'
    ? `Your loan lists ‘${q.name}’ as a co-applicant. Is this your business?`
    : `We see regular payments with ‘${q.name}’. Is this your business?`;
}

export const ANSWERS: { answer: QuestionAnswer; label: string; explain: string }[] = [
  {
    answer: 'own',
    label: 'Yes, I own/run it',
    explain: 'Due makes a business profile, so its dues can sit apart from yours.',
  },
  {
    answer: 'employee',
    label: 'I work there',
    explain: 'Nothing changes. Due won’t ask about it again.',
  },
  {
    answer: 'family',
    label: 'Family business',
    explain: 'Due makes a profile for it. You say how you’re linked.',
  },
  {
    answer: 'not_mine',
    label: 'Not mine',
    explain: 'Due won’t ask about this name again.',
  },
  {
    answer: 'later',
    label: 'Ask later',
    explain: 'Due keeps the question in Settings → Profiles.',
  },
];

/** Entity choices in the question flow, in plain words. */
export const ENTITY_CHOICES: Record<
  'own' | 'family',
  { type: EntityType; label: string; explain: string }[]
> = {
  own: [
    {
      type: 'proprietorship',
      label: 'Just me, on my PAN (proprietorship)',
      explain:
        'Your own shop or practice, filed on your PAN. No separate legal identity, so Due counts its dues as yours.',
    },
    {
      type: 'partnership',
      label: 'Partnership firm',
      explain:
        'Partners are personally liable for a firm’s dues, so Due shows them as able to come to you.',
    },
    {
      type: 'llp',
      label: 'LLP',
      explain:
        'An LLP has its own PAN. Its loans are the LLP’s, not yours, unless you signed as guarantor.',
    },
    {
      type: 'private_limited',
      label: 'Private Limited / OPC',
      explain:
        'A registered company (Private Limited or One Person Company). Its loans are the company’s, not yours, unless you signed as guarantor.',
    },
    {
      type: 'other',
      label: 'Not sure',
      explain: 'Due keeps its dues apart from yours for now. You can change this any time.',
    },
  ],
  family: [
    {
      type: 'proprietorship',
      label: 'On my PAN (proprietorship)',
      explain: 'No separate legal identity. Its dues are your dues, so Due counts them as yours.',
    },
    {
      type: 'partnership',
      label: 'Partnership firm',
      explain:
        'Partners are personally liable for a firm’s dues, so Due shows them as able to come to you.',
    },
    {
      type: 'llp',
      label: 'LLP',
      explain:
        'An LLP has its own PAN. Its loans are the LLP’s, not yours, unless you signed as guarantor.',
    },
    {
      type: 'private_limited',
      label: 'Private Limited / OPC',
      explain:
        'A Private Limited’s loans are the company’s, not yours, unless you signed as guarantor.',
    },
    {
      type: 'huf',
      label: 'HUF (Hindu Undivided Family)',
      explain: 'An HUF has its own PAN. Its karta is personally liable for its dues.',
    },
    {
      type: 'other',
      label: 'Not sure',
      explain: 'Due keeps its dues apart from yours for now. You can change this any time.',
    },
  ],
};

/** Every entity type, for the Settings form. */
export const ENTITY_LABEL: Record<EntityType, string> = {
  individual: 'Me (personal)',
  proprietorship: 'Proprietorship (on my PAN)',
  partnership: 'Partnership firm',
  llp: 'LLP',
  private_limited: 'Private Limited',
  opc: 'OPC (One Person Company)',
  huf: 'HUF',
  trust: 'Trust',
  other: 'Not sure / other',
};

/** What a name's ending says, for the hint under the question (never a choice made). */
export const NAME_SAYS: Record<EntityType, string> = {
  individual: '',
  proprietorship: '',
  partnership: '& Co',
  llp: 'LLP',
  private_limited: 'Private Limited',
  opc: 'OPC',
  huf: 'HUF',
  trust: 'Trust',
  other: '',
};

export const ENTITY_EXPLAIN: Record<EntityType, string> = {
  individual: 'Your own dues.',
  proprietorship: 'No separate legal identity. Its dues are your dues.',
  partnership: 'Own PAN, but partners are personally liable. Its dues can come to you.',
  llp: 'Own PAN. Its loans are the LLP’s, not yours, unless you signed as guarantor.',
  private_limited:
    'A Private Limited’s loans are the company’s, not yours, unless you signed as guarantor.',
  opc: 'A company with one owner. Its loans are the company’s, unless you signed as guarantor.',
  huf: 'Own PAN. Its karta is personally liable for its dues.',
  trust: 'Own PAN. Its dues are the trust’s.',
  other: 'Due keeps its dues apart from yours until you know.',
};

export const ROLE_LABEL: Record<ProfileRole, string> = {
  self: 'Me',
  proprietor: 'Owner (proprietor)',
  partner: 'Partner',
  designated_partner: 'Designated partner',
  director: 'Director',
  shareholder: 'Shareholder only',
  employee: 'I work there',
  guarantor: 'Guarantor',
  co_applicant: 'Co-applicant on its loans',
  karta: 'Karta (head of the HUF)',
  other: 'Something else',
};

export const ROLE_EXPLAIN: Record<ProfileRole, string> = {
  self: 'Your own dues.',
  proprietor: 'You run it on your own PAN.',
  partner: 'You run the firm with others. Its dues can come to you.',
  designated_partner: 'You’re named on the LLP’s papers for its filings.',
  director: 'You’re on the company’s board.',
  shareholder: 'You own shares. The company is separate from you.',
  employee: 'It pays you. Its dues aren’t yours.',
  guarantor: 'You signed to pay its loans if it can’t. Due marks those loans as able to reach you.',
  co_applicant: 'You signed its loans with it. Due marks those loans as able to reach you.',
  karta: 'Its dues can come to you. Due counts them in what you could owe.',
  other: 'Due keeps its dues apart from yours.',
};

export const GST_CHOICES: { value: boolean | null; label: string; explain: string }[] = [
  {
    value: true,
    label: 'Yes',
    explain:
      'Savings adds a note on business costs about input tax credit (GST you paid on business costs, which you may be able to claim back).',
  },
  { value: false, label: 'No', explain: 'No GST notes.' },
  {
    value: null,
    label: 'Not sure',
    explain: 'Savings shows the note, so you can check with your CA.',
  },
];

export const OWNER_TEXT: Record<LiabilityOwner, string> = {
  you: 'Yours',
  entity: 'The business’s',
  you_as_guarantor: 'The business’s, and can come to you (you signed)',
  you_as_partner: 'Can come to you (listed under the business)',
};

export const PROFILES_NOTE =
  'Profiles keep personal and business dues apart. Due asks; it never decides for you. Information only, not legal or tax advice.';

export const UPSELL_TEXT =
  'Free includes Personal and one business. More businesses come with Plus for now; a Business plan is planned.';
