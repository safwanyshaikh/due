/**
 * Finds organisation-like names in statement lines and loan summaries, and turns them into
 * questions ("Is this your business?"). It never decides: every result is a question the person
 * answers. Runs on the device; returns names only (no amounts, no account numbers).
 */
import { statementAlias } from '../savings/recurring';
import type { LoanStatementSummary, StatementLine } from '../savings/types';
import { nameKey } from './profiles';
import type { AppData } from '../types';
import type { EntityQuestion, EntityType } from './types';

/** Words that mark an organisation (whole words, on the tidied name). */
const ORG_WORD =
  /\b(PVT|PRIVATE|LTD|LIMITED|LLP|OPC|ENTERPRISES?|INDUSTRIAL|INDUSTRIES|ACADEMY|INTERNATIONAL|TRADERS|TRADING|ASSOCIATES|TECHNOLOGIES|SOLUTIONS|VENTURES|EXPORTS|IMPEX|AGENCIES|CORPORATION|HUF|TRUST|FOUNDATION|CONSULTANTS|CONSULTANCY|MANUFACTURERS|MANUFACTURING|BUILDERS|CONSTRUCTIONS?|INFRATECH)\b|&\s*CO\b|\bAND\s+CO\b/;

/** Long markers also found when a statement split them across a space ("PARTYENTER PRISES"). */
const ORG_COLLAPSED =
  /(ENTERPRISES|INDUSTRIAL|INDUSTRIES|ACADEMY|INTERNATIONAL|TRADERS|TECHNOLOGIES|ASSOCIATES|CORPORATION)/;

/**
 * Banks, lenders, payment companies and big consumer brands: organisations, but not the person's
 * business. Never asked about.
 */
const NOT_ASKED =
  /\bBANK\b|\bCARDS?\b|FINANCE|FINSERV|FINVEST|INSURANCE|ASSURANCE|\bLIFE\b|PAYMENTS?\b|RAZORPAY|PAYTM|PHONEPE|BILLDESK|CCAVENUE|EURONET|CASHFREE|\bPAYU\b|\bNPCI\b|MUTUAL\s+FUND|SECURITIES|BROKING|CAPITAL|HOUSING|TELECOM|RELIANCE|\bJIO\b|AIRTEL|VODAFONE|GOOGLE|AMAZON|FLIPKART|SWIGGY|ZOMATO|BUNDL|\bUBER\b|\bOLA\b|ANI\s+TECHNOLOGIES|FACEBOOK|\bMETA\b|NETFLIX|MICROSOFT|APPLE|SPOTIFY|HOTSTAR|NOVI\s+DIGITAL|ELECTRICITY|\bPOWER\b|\bGAS\b|MUNICIPAL|GOVERNMENT|\bGOVT\b|INCOME\s+TAX|\bGST\b|\bCBDT\b|\bLIC\b|\bIRCTC\b|RAILWAY|AIRLINES|\bINDIGO\b/;

/** Rail and narration words to drop from a name segment. */
const NOISE =
  /^(NEFT|NEFTO|NEFTI|IMPS|IMPSAB|IMPSAR|RTGS|UPI|CR|DR|P2A|P2M|P2P|BY|TO|FROM|TRANSFER|TFR|TRF|WDL|DEP|INB|MB|IB|PAID|RECEIVED|PAYMENT|REF|NO|AT|OF|INWARD|OUTWARD|CREDIT|DEBIT|ACH|NACH|ECS|FT|INFT|MMT|OTHERS?|FAMILY|OR|FOR|SALARY|SAL|SELF|SENT|AND)$/;

/** Words that are only page or reference furniture. */
const REF = /\d/;

function tidyName(words: string[]): string {
  return words.join(' ').replace(/\s+/g, ' ').replace(/^&\s*/, '').trim();
}

function isOrgName(name: string): boolean {
  if (ORG_WORD.test(name)) return true;
  return ORG_COLLAPSED.test(name.replace(/\s+/g, ''));
}

/** True when a name reads like an organisation (Pvt Ltd, LLP, Enterprises, & Co …), not a person. */
export function looksLikeOrganisation(name: string): boolean {
  const n = name.toUpperCase().replace(/\s+/g, ' ').trim();
  return n.length >= 4 && isOrgName(n);
}

/** The organisation-like name inside a segment, trimmed of rail words and references. */
function nameIn(segment: string): string | null {
  // "… OF PARTYCO INDUSTRIAL TRAIN AT 00343 …" (SBI transfer narrations): keep what follows "OF".
  const of = /\bOF\s+(.+?)(?:\s+AT\s+\d|$)/.exec(segment);
  const body = of && isOrgName(of[1]) ? of[1] : segment.replace(/\s+AT\s+\d.*$/, '');
  const words = body
    .split(/\s+/)
    .map((w) => w.replace(/^[.,;()]+|[.,;()]+$/g, ''))
    .filter((w) => w && !REF.test(w));
  // Drop rail words at either end only: "BY TRANSFER ACME TRADERS" → "ACME TRADERS".
  while (words.length && NOISE.test(words[0])) words.shift();
  while (words.length && NOISE.test(words[words.length - 1]) && !/^CO$/.test(words.at(-1)!))
    words.pop();
  if (!words.length) return null;
  const name = tidyName(words.slice(0, 7));
  if (name.length < 4 || name.length > 60) return null;
  return isOrgName(name) ? name : null;
}

/**
 * The counterparty of a statement line when it looks like an organisation, else null. Narrations
 * are split on the separators banks print (`/`, `-`, `*`, `:` and `|`).
 */
export function organisationIn(narration: string): string | null {
  const upper = narration.toUpperCase().replace(/\s+/g, ' ').trim();
  if (!upper) return null;
  const app = /^(?:PAID TO|RECEIVED FROM|MONEY SENT TO|PAYMENT FROM)\s+(.+)$/.exec(upper);
  const segments = app ? [app[1]] : upper.split(/\s*[/|*:\\]\s*|\s+-\s*|-(?=[A-Z])/);
  for (const seg of segments) {
    const name = nameIn(seg);
    if (name && !NOT_ASKED.test(name)) return name;
  }
  return null;
}

/** What the name itself says about its legal form, or null when it does not say. */
export function entityTypeFromName(name: string): EntityType | null {
  const n = name.toUpperCase();
  if (/\bLLP\b/.test(n)) return 'llp';
  if (/\bOPC\b|\(OPC\)/.test(n)) return 'opc';
  if (/\b(PVT|PRIVATE)\b.*\b(LTD|LIMITED)\b/.test(n)) return 'private_limited';
  if (/\bHUF\b/.test(n)) return 'huf';
  if (/\bTRUST\b|\bFOUNDATION\b/.test(n)) return 'trust';
  return null;
}

const SKIP_KINDS = new Set<NonNullable<StatementLine['lineKind']>>([
  'fee',
  'interest',
  'tax',
  'wallet_topup',
  'loan_repayment',
  'p2p',
  'payment',
]);

/** Refunds and reversals are not regular payments (credits in free text are read as 'reversal'). */
const REFUND = /REVERSA|REFUND|CASH\s*BACK|WAIVE/i;

/** Minimum statement lines that must carry a name before Due asks about it. */
export const MIN_REPEATS = 2;
/** At most this many questions come out of one import (one is shown at a time). */
export const MAX_QUESTIONS = 5;

interface Tally {
  name: string;
  count: number;
  inflow: number;
  outflow: number;
  transferRail: boolean;
}

/**
 * Questions about organisation-like names: counterparties that repeat in bank statement lines
 * (Pvt Ltd, LLP, Enterprises, Industrial, Academy, International, Traders, & Co …), and
 * organisation co-applicants on loans. People's names, the holder's own transfers, card
 * purchases at shops, known subscriptions, banks and lenders are never asked about.
 */
export function entityCandidates(
  lines: StatementLine[],
  loanSummaries: Pick<LoanStatementSummary, 'coApplicantEntities'>[] = [],
): EntityQuestion[] {
  const tally = new Map<string, Tally>();
  for (const l of lines) {
    // Card lines are purchases at merchants; an own business shows up in bank transfers.
    if (l.source !== 'bank' || l.selfTransfer) continue;
    if (l.lineKind && SKIP_KINDS.has(l.lineKind)) continue;
    if (REFUND.test(l.narration)) continue;
    if (statementAlias(l.narration)) continue;
    const name = organisationIn(l.narration);
    if (!name) continue;
    const key = nameKey(name);
    if (!key) continue;
    const t = tally.get(key) ?? { name, count: 0, inflow: 0, outflow: 0, transferRail: false };
    t.count++;
    if (l.amountInr < 0) t.inflow++;
    else t.outflow++;
    if (/\b(NEFT|RTGS|IMPS)/i.test(l.narration)) t.transferRail = true;
    tally.set(key, t);
  }
  const out: (EntityQuestion & { score: number })[] = [];
  const loanNames = new Set<string>();
  for (const s of loanSummaries) {
    for (const raw of s.coApplicantEntities ?? []) {
      const name = raw.replace(/\s+/g, ' ').trim();
      const key = nameKey(name);
      if (!key || loanNames.has(key)) continue;
      loanNames.add(key);
      out.push({
        key,
        name,
        reason: 'loan_co_applicant',
        occurrences: 1,
        direction: null,
        nameSays: entityTypeFromName(name),
        score: 1000,
      });
    }
  }
  for (const [key, t] of tally) {
    if (t.count < MIN_REPEATS || loanNames.has(key)) continue;
    out.push({
      key,
      name: t.name,
      reason: 'regular_payments',
      occurrences: t.count,
      direction: t.inflow && t.outflow ? 'both' : t.inflow ? 'received' : 'paid',
      nameSays: entityTypeFromName(t.name),
      // Money received from a firm, by bank transfer, is the strongest sign of one's own business.
      score: t.count + (t.inflow ? 3 : 0) + (t.transferRail ? 2 : 0),
    });
  }
  return out
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_QUESTIONS)
    .map(({ score: _s, ...q }) => {
      void _s;
      return q;
    });
}

/**
 * The questions still worth asking: not about a name that already has a profile, and not one the
 * person already answered ('later' answers are asked again).
 */
export function openQuestions(
  data: Pick<AppData, 'profiles' | 'profileDecisions'>,
  questions: EntityQuestion[],
): EntityQuestion[] {
  const profileKeys = new Set((data.profiles ?? []).map((p) => nameKey(p.name)));
  const answered = new Set(
    (data.profileDecisions ?? []).filter((d) => d.answer !== 'later').map((d) => d.key),
  );
  return questions.filter((q) => !profileKeys.has(q.key) && !answered.has(q.key));
}
