/**
 * Savings engine: the user's obligations + the public catalog → ranked, explained moves.
 * Pure and on-device. Money is whole rupees here (obligations keep paise).
 * No invented numbers: a null price produces no move. Assumptions are labelled and editable.
 */
import { addDays, addMonthsClamped, daysBetween, formatDate, todayInTz } from '../dates';
import { formatINR } from '../money';
import { effectiveNext, forecastObligations, liveHistory } from '../obligations';
import { cadenceMonths } from '../recurrence';
import { parseIndianAmount } from '../intake';
import { canonicalMerchant } from '../merchants';
import type { AppData, Commitment, Frequency } from '../types';
import { matchesKey, matchModule, type ModuleMatch } from './match';
import { researchNeeds } from './research';
import { cardKey } from './cardSummary';
import { loanKey } from './loanSummary';
import { bankMonths, incomeTiming } from './bankSummary';
import type {
  RecurringCandidate,
  TelecomBillSummary,
  UpiStatementSummary,
  BankStatementSummary,
  CardStatementSummary,
  LoanStatementSummary,
  Assumption,
  AssumptionSource,
  CityPack,
  CityPass,
  CommuteLeg,
  Move,
  MoveConfidence,
  ResearchNeed,
  SavingsCatalog,
  SavingsModule,
  SavingsProfile,
  SourceRef,
} from './types';

/** Labelled 'typical' defaults. Each is shown as an assumption and replaced by profile.overrides. */
export const TYPICAL = {
  ridesPerMonth: 8,
  ordersPerMonth: 6,
  avgFareInr: 250,
  avgOrderInr: 400,
  /** Indian credit cards commonly charge about 3.5% a month on revolving balances. */
  cardRatePctYear: 42,
} as const;

export const CONFIDENCE_WEIGHT: Record<MoveConfidence, number> = { high: 1, medium: 0.7, low: 0.4 };
const EFFORT_RANK: Record<Move['effort'], number> = { tap: 0, habit: 1, paperwork: 2 };

export const DEBT_LEGAL_NOTE = "Information only. Check your bank's own offer.";
export const LOAN_LEGAL_NOTE =
  "Information only. Due does not arrange loans. RBI rules say lenders may not charge foreclosure or prepayment fees on floating-rate loans taken by individuals for non-business purposes. Check your lender's own terms.";
export const BOUNCE_TRANSFER_NOTE =
  'Lenders usually want 6–12 months without bounces before a transfer; ask your current lender to lower the rate first.';
export const RBI_SOURCE: SourceRef = {
  url: 'https://www.rbi.org.in/',
  label: 'Reserve Bank of India: prepayment charges on floating-rate loans',
  kind: 'regulator',
  lastVerifiedAt: null,
};

const DAYS_PER_MONTH = 365 / 12;
const WEEKS_PER_MONTH = 52 / 12;

export interface MovesResult {
  moves: Move[];
  research: ResearchNeed[];
}

/* ---------- helpers ---------- */

const rupees = (n: number) => formatINR(Math.round(n) * 100);
const r0 = (n: number) => Math.round(n);

function freqMonths(f: Frequency, interval?: number | null): number | null {
  switch (f) {
    case 'monthly':
      return 1;
    case 'quarterly':
      return 3;
    case 'half_yearly':
      return 6;
    case 'annual':
      return 12;
    case 'custom_months':
      return interval && interval > 0 ? interval : null;
    default:
      return null;
  }
}

function cycleMonths(ob: Commitment): number | null {
  return (ob.rule ? cadenceMonths(ob.rule) : null) ?? freqMonths(ob.frequency, ob.intervalMonths);
}

function amountPaise(ob: Commitment): number | null {
  if (ob.rule?.kind === 'trial_to_paid') return ob.rule.paidAmountPaise ?? null;
  const v = ob.amount ? ob.amount.value : ob.amountPaise;
  return v === null || v === undefined || v <= 0 ? null : v;
}

/** The obligation's own cost per month in rupees, or null when unknown or not periodic. */
export function obligationMonthlyInr(ob: Commitment): number | null {
  const p = amountPaise(ob);
  const m = cycleMonths(ob);
  if (p === null || !m) return null;
  return p / 100 / m;
}

function confirmed(ob: Commitment): boolean {
  return (
    (ob.amount?.confidence ?? (ob.amountConfidence === 'confirmed' ? 'confirmed' : 'estimated')) !==
    'estimated'
  );
}

function displayName(ob: Commitment): string {
  return (ob.nickname || ob.provider || 'this bill').trim();
}

/** A module's own monthly-equivalent price (a ~monthly plan), or null. */
function moduleMonthlyInr(m: SavingsModule | null): number | null {
  const p = m?.rules.prices?.find(
    (x) => x.priceInr !== null && x.periodDays >= 28 && x.periodDays <= 31,
  );
  return p && p.priceInr !== null ? (p.priceInr * DAYS_PER_MONTH) / p.periodDays : null;
}

function norm(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/** "Thane" covers "Thane West"; "Navi Mumbai" covers "Vashi, Navi Mumbai". */
function covers(coverage: string[], locality: string): boolean {
  const l = norm(locality);
  if (!l.length) return false;
  return coverage.some((c) => {
    const t = norm(c);
    return t.length > 0 && (t.every((w) => l.includes(w)) || l.every((w) => t.includes(w)));
  });
}

class Assumptions {
  list: Assumption[] = [];
  constructor(private overrides: Record<string, number>) {}
  /** The value used: the user's override when set, else the default with its source. */
  use(
    key: string,
    label: string,
    value: number,
    unit: string,
    source: AssumptionSource,
    editable = true,
  ): number {
    const o = this.overrides[key];
    const has = editable && typeof o === 'number' && Number.isFinite(o);
    const v = has ? o : value;
    this.list.push({ key, label, value: v, unit, source: has ? 'you_entered' : source, editable });
    return v;
  }
  get anyTypical(): boolean {
    return this.list.some((a) => a.source === 'typical');
  }
}

function moveId(kind: Move['kind'], moduleId: string | null, obligationIds: string[]): string {
  return `${kind}:${moduleId ?? ''}:${obligationIds.join('+')}`;
}

function action(m: SavingsModule | null, fallback: string): Move['action'] {
  return { url: m?.actionUrl ?? null, label: m?.actionLabel ?? fallback };
}

interface Ctx {
  today: string;
  profile: SavingsProfile;
  catalog: SavingsCatalog;
  obs: Commitment[];
  match: Map<string, ModuleMatch | null>;
  cityPack: CityPack | null;
  modules: SavingsModule[];
}

function moduleOf(ctx: Ctx, ob: Commitment): SavingsModule | null {
  return ctx.match.get(ob.id)?.module ?? null;
}

function base(
  kind: Move['kind'],
  module: SavingsModule | null,
  obligationIds: string[],
  rest: Omit<
    Move,
    | 'id'
    | 'kind'
    | 'moduleId'
    | 'obligationIds'
    | 'sponsored'
    | 'sources'
    | 'unverifiedPrice'
    | 'legalNote'
  > &
    Partial<Pick<Move, 'sources' | 'unverifiedPrice' | 'legalNote'>>,
): Move {
  return {
    id: moveId(kind, module?.id ?? null, obligationIds),
    kind,
    moduleId: module?.id ?? null,
    obligationIds,
    sources: rest.sources ?? module?.sources ?? [],
    unverifiedPrice: rest.unverifiedPrice ?? module?.status === 'research',
    legalNote: rest.legalNote ?? null,
    ...rest,
    monthlySavingInr: Math.max(0, r0(rest.monthlySavingInr)),
    rangeInr: [Math.max(0, r0(rest.rangeInr[0])), Math.max(0, r0(rest.rangeInr[1]))],
    sponsored: false,
  };
}

/* ---------- generators ---------- */

function overlapMoves(ctx: Ctx): Move[] {
  const out: Move[] = [];
  for (const o1 of ctx.obs) {
    const m1 = moduleOf(ctx, o1);
    if (!m1?.rules.includes?.length) continue;
    for (const inc of m1.rules.includes) {
      for (const o2 of ctx.obs) {
        if (o2.id === o1.id) continue;
        const m2 = moduleOf(ctx, o2);
        if (m2?.id === m1.id) continue;
        if (!matchesKey(o2, inc.key, m2)) continue;
        const own = obligationMonthlyInr(o2);
        const cost = own ?? moduleMonthlyInr(m2);
        if (cost === null || cost <= 0) continue;
        const limited = inc.months !== null && inc.months < 12;
        const saving = limited ? (cost * (inc.months as number)) / 12 : cost;
        const months = limited ? ` for ${inc.months} months` : '';
        out.push(
          base('overlap', m1, [o1.id, o2.id], {
            title: `You already get ${inc.label} with ${m1.product}`,
            why: `${m1.product} includes ${inc.label}${months}; you also pay about ${rupees(cost)} a month for ${displayName(o2)}.`,
            monthlySavingInr: saving,
            rangeInr: [saving, cost],
            confidence: own !== null && confirmed(o2) && confirmed(o1) ? 'high' : 'medium',
            assumptions: [],
            effort: 'tap',
            action: action(m2, `Manage ${inc.label}`),
            unverifiedPrice: m1.status === 'research' || m2?.status === 'research' || own === null,
          }),
        );
      }
    }
  }
  return out;
}

function periodSwitchMove(ob: Commitment, m: SavingsModule): Move | null {
  if (cycleMonths(ob) !== 1) return null;
  const yearly = (m.rules.prices ?? [])
    .filter((p) => p.priceInr !== null && p.periodDays >= 330)
    .map((p) => ({ p, annual: ((p.priceInr as number) * 365) / p.periodDays }))
    .sort((a, b) => a.annual - b.annual)[0];
  if (!yearly) return null;
  const ownPaise = amountPaise(ob);
  const own = ownPaise === null ? null : ownPaise / 100;
  // A 28-day pack billed "monthly" is 13 recharges a year.
  const pack = (m.rules.prices ?? []).find(
    (p) =>
      p.priceInr !== null && p.periodDays < 30 && own !== null && Math.abs(p.priceInr - own) <= 1,
  );
  const cur = own ?? moduleMonthlyInr(m);
  if (cur === null) return null;
  const annualNow = pack ? (cur * 365) / pack.periodDays : cur * 12;
  const saving = (annualNow - yearly.annual) / 12;
  if (saving < 1) return null;
  const low = (cur * 12 - yearly.annual) / 12;
  return base('period_switch', m, [ob.id], {
    title: `Switch ${m.product} to the ${yearly.p.label.toLowerCase().startsWith('year') ? 'yearly' : yearly.p.label} plan`,
    why: `You pay ${rupees(cur)}${pack ? ` every ${pack.periodDays} days` : ' a month'}, about ${rupees(annualNow)} a year; the ${yearly.p.periodDays}-day plan is ${rupees(yearly.p.priceInr as number)}.`,
    monthlySavingInr: saving,
    rangeInr: [Math.min(Math.max(low, 0), saving), saving],
    confidence: own !== null && confirmed(ob) ? 'high' : 'medium',
    assumptions: [],
    effort: 'tap',
    action: action(m, `See ${m.product} plans`),
    unverifiedPrice: m.status === 'research' || own === null,
  });
}

function commuteCabTrips(profile: SavingsProfile): { trips: number; fare: number | null } | null {
  const legs = profile.commute.filter(
    (l) => (l.mode === 'cab' || l.mode === 'bike_taxi' || l.mode === 'auto') && l.daysPerWeek > 0,
  );
  if (!legs.length) return null;
  const trips = legs.reduce((s, l) => s + l.daysPerWeek * WEEKS_PER_MONTH, 0);
  const priced = legs.filter((l) => l.costPerTripInr !== null);
  const fare = priced.length
    ? priced.reduce((s, l) => s + (l.costPerTripInr as number) * l.daysPerWeek, 0) /
      priced.reduce((s, l) => s + l.daysPerWeek, 0)
    : null;
  return { trips, fare };
}

/** Returns a pause move when the membership does not pay back, 'pays' when it does, null when unknown. */
function membershipMove(ctx: Ctx, ob: Commitment, m: SavingsModule): Move | 'pays' | null {
  const own = obligationMonthlyInr(ob);
  const fee = own ?? moduleMonthlyInr(m);
  if (fee === null || fee <= 0) return null;
  const r = m.rules;
  const a = new Assumptions(ctx.profile.overrides);
  let value = 0;
  let known = false;
  const usage: string[] = [];
  if (r.creditPct !== null && r.creditPct !== undefined) {
    known = true;
    const commute = m.category === 'mobility' ? commuteCabTrips(ctx.profile) : null;
    const rides = a.use(
      `${m.id}:ridesPerMonth`,
      'Rides a month',
      commute ? r0(commute.trips) : TYPICAL.ridesPerMonth,
      'rides',
      commute ? 'you_entered' : 'typical',
    );
    const packFare = ctx.cityPack?.typicalFareInr.cab;
    const fare = a.use(
      `${m.id}:avgFareInr`,
      'Average fare',
      commute?.fare ?? packFare ?? TYPICAL.avgFareInr,
      '₹',
      commute?.fare != null ? 'you_entered' : 'typical',
    );
    const perRide = Math.min((fare * r.creditPct) / 100, r.creditCapPerUnitInr ?? Infinity);
    value += rides * perRide;
    usage.push(`${r0(rides)} rides a month`);
  }
  if (r.deliveryFeeSavedPerOrderInr !== null && r.deliveryFeeSavedPerOrderInr !== undefined) {
    known = true;
    const orders = a.use(
      `${m.id}:ordersPerMonth`,
      'Orders a month',
      TYPICAL.ordersPerMonth,
      'orders',
      'typical',
    );
    let eligible = 1;
    if (r.freeDeliveryMinOrderInr !== null && r.freeDeliveryMinOrderInr !== undefined) {
      const avg = a.use(
        `${m.id}:avgOrderInr`,
        'Average order',
        TYPICAL.avgOrderInr,
        '₹',
        'typical',
      );
      eligible = avg >= r.freeDeliveryMinOrderInr ? 1 : 0;
    }
    value += orders * r.deliveryFeeSavedPerOrderInr * eligible;
    usage.push(`${r0(orders)} orders a month`);
  }
  if (!known) return null;
  if (value >= fee) return 'pays';
  const next = effectiveNext(ob, ctx.today);
  return base('membership_breakeven', m, [ob.id], {
    title: next
      ? `Pause ${m.product} before ${formatDate(next.date)}`
      : `Pause ${m.product} before it renews`,
    why: `At ${usage.join(' and ')} it gives back about ${rupees(value)}; it costs ${rupees(fee)} a month.`,
    monthlySavingInr: fee,
    rangeInr: [fee - value, fee],
    confidence: a.anyTypical ? 'low' : 'medium',
    assumptions: a.list,
    effort: 'tap',
    action: action(m, `Manage ${m.product}`),
    unverifiedPrice: m.status === 'research' || own === null,
  });
}

function commuteMoves(ctx: Ctx): Move[] {
  const pack = ctx.cityPack;
  if (!pack || !ctx.profile.commute.length) return [];
  const best = new Map<string, Move>();
  for (const pass of pack.passes) {
    if (pass.status === 'retired' || pass.priceInr === null || !pass.periodDays) continue;
    const legs = ctx.profile.commute.filter(
      (l) => l.daysPerWeek > 0 && covers(pass.coverage, l.from) && covers(pass.coverage, l.to),
    );
    if (!legs.length) continue;
    const a = new Assumptions(ctx.profile.overrides);
    let current = 0;
    let trips = 0;
    const used: CommuteLeg[] = [];
    for (const l of legs) {
      const t = l.daysPerWeek * WEEKS_PER_MONTH;
      const typical = pack.typicalFareInr[l.mode];
      const defaultCost = l.costPerTripInr ?? typical ?? null;
      if (
        defaultCost === null &&
        ctx.profile.overrides[`commute:${l.id}:costPerTripInr`] === undefined
      )
        continue;
      const cost = a.use(
        `commute:${l.id}:costPerTripInr`,
        `Cost per trip, ${l.from} to ${l.to}`,
        defaultCost ?? 0,
        '₹',
        l.costPerTripInr !== null ? 'you_entered' : 'typical',
      );
      current += t * cost;
      trips += t;
      used.push(l);
    }
    if (!used.length) continue;
    const perMonthTrips =
      pass.trips !== null ? (pass.trips * DAYS_PER_MONTH) / pass.periodDays : Infinity;
    if (trips > perMonthTrips + 0.5) continue;
    const passMonthly = (pass.priceInr * DAYS_PER_MONTH) / pass.periodDays;
    const saving = current - passMonthly;
    if (saving < 1) continue;
    const first = used[0];
    const move = passMove(pack, pass, used, {
      title: `Try ${pass.name} for ${first.from} to ${first.to}`,
      why: `About ${r0(trips)} trips a month cost about ${rupees(current)}; ${pass.operator} lists ${pass.name} at ${rupees(pass.priceInr)} for ${pass.periodDays} days.`,
      saving,
      assumptions: a,
    });
    const key = used
      .map((l) => l.id)
      .sort()
      .join('+');
    const prev = best.get(key);
    if (!prev || move.monthlySavingInr > prev.monthlySavingInr) best.set(key, move);
  }
  return [...best.values()];
}

function passMove(
  pack: CityPack,
  pass: CityPass,
  _legs: CommuteLeg[],
  p: { title: string; why: string; saving: number; assumptions: Assumptions },
): Move {
  return {
    id: moveId('commute_pass', pass.id, []),
    kind: 'commute_pass',
    moduleId: pass.id,
    obligationIds: [],
    title: p.title,
    why: p.why,
    monthlySavingInr: r0(p.saving),
    rangeInr: [r0(p.saving), r0(p.saving)],
    confidence: p.assumptions.anyTypical ? 'low' : 'medium',
    assumptions: p.assumptions.list,
    sources: pass.sources,
    effort: 'habit',
    action: { url: pass.actionUrl, label: `See ${pass.operator}` },
    unverifiedPrice: pass.status === 'research' || pack.status === 'research',
    legalNote: null,
    sponsored: false,
  };
}

const REVOLVING =
  /revolv|carr(y|ied|ying)\s*(forward|over)|rolled\s*over|minimum\s*due|min\.?\s*due|interest|outstanding|unpaid\s*balance|not\s*paid\s*in\s*full/i;

/** A rate written in the notes: "3.5% a month" → 42; "36% p.a." → 36; bare "3.5%" (≤5) is read as monthly. */
export function rateFromNotes(notes: string): number | null {
  const monthly = /(\d+(?:\.\d+)?)\s*%\s*(?:a|per|\/|p\.?)\s*(?:month|mo|m)\b/i.exec(notes);
  if (monthly) return Number(monthly[1]) * 12;
  const any = /(\d+(?:\.\d+)?)\s*%/.exec(notes);
  if (!any) return null;
  const n = Number(any[1]);
  return n <= 5 ? n * 12 : n;
}

/** "balance ₹80,000", "outstanding Rs 1.2 lakh", "revolving 45k" → rupees. */
export function balanceFromNotes(notes: string): number | null {
  const m =
    /(?:balance|outstanding|revolving|owe|due)\D{0,20}?(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.\d{1,2})?)\s*(lakhs?|lacs?|k\b)?/i.exec(
      notes,
    );
  if (!m) return null;
  const unit = m[2]?.toLowerCase();
  if (unit === 'k') {
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n * 1000 : null;
  }
  const p = parseIndianAmount(m[1], unit);
  return p === null ? null : p / 100;
}

function debtMove(ctx: Ctx, ob: Commitment, m: SavingsModule): Move | null {
  if (ob.type !== 'credit_card') return null;
  const notes = ob.notes ?? '';
  const revolving =
    REVOLVING.test(notes) || ob.loan?.principalPaise != null || ob.loan?.interestRatePct != null;
  if (!revolving) return null;
  const high = m.rules.ratePctHigh;
  if (high === null || high === undefined) return null;
  const balanceKnown =
    ob.loan?.principalPaise != null
      ? ob.loan.principalPaise / 100
      : (balanceFromNotes(notes) ?? (amountPaise(ob) ?? 0) / 100);
  if (!(balanceKnown > 0)) return null;
  const a = new Assumptions(ctx.profile.overrides);
  const balance = a.use(
    `debt_rate:${ob.id}:balanceInr`,
    'Revolving balance',
    r0(balanceKnown),
    '₹',
    'your_data',
  );
  const stated = ob.loan?.interestRatePct ?? rateFromNotes(notes);
  const rate = a.use(
    `debt_rate:${ob.id}:ratePct`,
    'Card interest a year',
    stated ?? TYPICAL.cardRatePctYear,
    '%',
    stated !== null && stated !== undefined ? 'your_data' : 'typical',
  );
  if (rate <= high) return null;
  const fee =
    m.rules.processingFeePct != null ? (balance * m.rules.processingFeePct) / 100 / 12 : 0;
  const saving = (balance * (rate - high)) / 100 / 12 - fee;
  if (saving < 1) return null;
  const low = m.rules.ratePctLow;
  const best = low != null && low < high ? (balance * (rate - low)) / 100 / 12 - fee : saving;
  const interest = (balance * rate) / 100 / 12;
  const span = low != null && low < high ? `${low}–${high}%` : `up to ${high}%`;
  return base('debt_rate', m, [ob.id], {
    title: `Compare a balance-transfer EMI for ${displayName(ob)}`,
    why: `About ${rupees(balance)} carried at ${rate}% a year costs about ${rupees(interest)} a month in interest; published EMI rates are ${span}.`,
    monthlySavingInr: saving,
    rangeInr: [saving, best],
    confidence: a.anyTypical ? 'low' : 'medium',
    assumptions: a.list,
    effort: 'paperwork',
    action: action(m, 'See the official page'),
    legalNote: DEBT_LEGAL_NOTE,
  });
}

/** Standard EMI. `ratePct` is % a year. */
export function emi(principal: number, ratePct: number, months: number): number {
  const r = ratePct / 1200;
  if (months <= 0) return 0;
  if (r === 0) return principal / months;
  const f = Math.pow(1 + r, months);
  return (principal * r * f) / (f - 1);
}

function loanMove(ctx: Ctx, ob: Commitment, m: SavingsModule): Move | null {
  if (ob.type !== 'emi' && ob.type !== 'other_loan') return null;
  if (ob.loan?.rateType !== 'variable') return null;
  const rate = ob.loan.interestRatePct;
  const low = m.rules.ratePctLow;
  if (rate == null || low == null || rate <= low + 0.5) return null;
  const emiNow = cycleMonths(ob) === 1 ? (amountPaise(ob) ?? 0) / 100 || null : null;
  const r = rate / 1200;
  let n: number | null = ob.remainingOccurrences ?? null;
  let principal: number | null =
    ob.loan.principalPaise != null ? ob.loan.principalPaise / 100 : null;
  let principalSource: AssumptionSource = 'your_data';
  if (principal === null && emiNow !== null && n !== null)
    principal = r === 0 ? emiNow * n : (emiNow * (1 - Math.pow(1 + r, -n))) / r;
  if (n === null && principal !== null && emiNow !== null && emiNow > principal * r)
    n =
      r === 0
        ? principal / emiNow
        : Math.ceil(-Math.log(1 - (r * principal) / emiNow) / Math.log(1 + r));
  if (n === null) n = ob.loan.originalTenureMonths ?? null;
  if (principal === null || n === null || n <= 0 || principal <= 0) return null;
  if (ob.loan.principalPaise == null) principalSource = 'your_data';
  const a = new Assumptions(ctx.profile.overrides);
  a.use(`loan_switch:${ob.id}:ratePct`, 'Your rate a year', rate, '%', 'your_data', false);
  a.use(
    `loan_switch:${ob.id}:principalInr`,
    'Amount left to repay',
    r0(principal),
    '₹',
    principalSource,
    false,
  );
  a.use(`loan_switch:${ob.id}:months`, 'Months left', r0(n), 'months', 'your_data', false);
  const cur = emi(principal, rate, n);
  const saving = cur - emi(principal, low, n);
  if (saving < 1) return null;
  const high = m.rules.ratePctHigh;
  const lowEnd = high != null && high < rate ? cur - emi(principal, high, n) : 0;
  const sources = m.sources.some((s) => s.kind === 'regulator')
    ? m.sources
    : [...m.sources, RBI_SOURCE];
  return base('loan_switch', m, [ob.id], {
    title: `Ask about a lower rate on ${displayName(ob)}`,
    why: `Your floating rate is ${rate}%; published rates start at ${low}%. On about ${rupees(principal)} over ${r0(n)} months that is about ${rupees(saving)} less EMI a month.`,
    monthlySavingInr: saving,
    rangeInr: [lowEnd, saving],
    confidence: ob.loan.principalPaise != null && confirmed(ob) ? 'medium' : 'low',
    assumptions: a.list,
    sources,
    effort: 'paperwork',
    action: action(m, 'See published rates'),
    legalNote: LOAN_LEGAL_NOTE,
  });
}

function priceChangeMove(ctx: Ctx, ob: Commitment): Move | null {
  const paid = liveHistory(ob)
    .filter((e) => e.kind === 'paid' && typeof e.amountPaise === 'number' && e.amountPaise > 0)
    .sort((a, b) => a.occurrenceDate.localeCompare(b.occurrenceDate) || a.at.localeCompare(b.at));
  let prev: number | null = null;
  let last: number | null = null;
  if (paid.length >= 2) {
    prev = paid[paid.length - 2].amountPaise as number;
    last = paid[paid.length - 1].amountPaise as number;
  } else {
    const change = (ob.pendingChanges ?? [])
      .filter((c) => c.field === 'amount' && typeof c.from === 'number' && typeof c.to === 'number')
      .sort((a, b) => a.at.localeCompare(b.at))
      .pop();
    if (change) {
      prev = change.from as number;
      last = change.to as number;
    }
  }
  if (prev === null || last === null || prev <= 0 || last < prev * 1.05) return null;
  const months = cycleMonths(ob) ?? 1;
  const up = (last - prev) / 100 / months;
  if (up < 1) return null;
  const m = moduleOf(ctx, ob);
  return base('price_change', m, [ob.id], {
    title: `${displayName(ob)} went up by ${rupees((last - prev) / 100)}`,
    why: `Your last charge was ${rupees(last / 100)}, up from ${rupees(prev / 100)}. Check whether a cheaper plan still fits.`,
    monthlySavingInr: up,
    rangeInr: [up, up],
    confidence: 'high',
    assumptions: [],
    effort: 'tap',
    action: action(m, 'Review your plan'),
    unverifiedPrice: false,
  });
}

function trialEndMove(ctx: Ctx, ob: Commitment): Move | null {
  const end =
    ob.subscription?.trialEnd ?? (ob.rule?.kind === 'trial_to_paid' ? ob.rule.trialEnd : null);
  if (!end) return null;
  const days = daysBetween(ctx.today, end);
  if (days < 0 || days > 7) return null;
  const m = moduleOf(ctx, ob);
  const own = obligationMonthlyInr(ob);
  const cost = own ?? moduleMonthlyInr(m);
  if (cost === null || cost <= 0) return null;
  return base('trial_end', m, [ob.id], {
    title: `Free trial of ${displayName(ob)} ends ${formatDate(end)}`,
    why: `It then costs about ${rupees(cost)} a month. Cancel before then if you will not use it.`,
    monthlySavingInr: cost,
    rangeInr: [cost, cost],
    confidence: own !== null ? 'high' : 'medium',
    assumptions: [],
    effort: 'tap',
    action: action(m, 'Manage the trial'),
    unverifiedPrice: own === null && m?.status === 'research',
  });
}

/* ---------- statements: fee leaks and loan summaries ---------- */

function latestBy<T>(items: T[], key: (t: T) => string, date: (t: T) => string | null): T[] {
  const best = new Map<string, T>();
  for (const it of items) {
    const k = key(it);
    const prev = best.get(k);
    if (!prev || (date(it) ?? '') >= (date(prev) ?? '')) best.set(k, it);
  }
  return [...best.values()];
}

function genericModule(
  ctx: Ctx,
  type: Commitment['type'],
  provider: string,
  product: string,
): SavingsModule | null {
  const synthetic = {
    id: '__statement__',
    type,
    provider,
    nickname: product,
    canonicalProvider: null,
    loan: { loanType: product },
  } as unknown as Commitment;
  return matchModule(synthetic, ctx.modules)?.module ?? null;
}

function feeMove(
  sub: string,
  key: string,
  obligationId: string | null | undefined,
  module: SavingsModule | null,
  p: Pick<Move, 'title' | 'why' | 'confidence' | 'effort' | 'legalNote'> & {
    saving: number;
    action?: Move['action'];
  },
): Move {
  const s = r0(p.saving);
  return {
    id: `fee_leak:${sub}:${key}`,
    kind: 'fee_leak',
    moduleId: module?.id ?? null,
    obligationIds: obligationId ? [obligationId] : [],
    title: p.title,
    why: p.why,
    monthlySavingInr: s,
    rangeInr: [s, s],
    confidence: p.confidence,
    assumptions: [],
    sources: module?.sources ?? [],
    effort: p.effort,
    action: p.action ?? { url: null, label: 'See how' },
    unverifiedPrice: false,
    legalNote: p.legalNote,
    sponsored: false,
  };
}

function cardFeeMoves(ctx: Ctx, statements: CardStatementSummary[]): Move[] {
  const out: Move[] = [];
  for (const st of latestBy(statements, cardKey, (s) => s.statementDate)) {
    const key = cardKey(st);
    const card = st.issuer ?? 'Your card';
    if (st.financeChargeInr && st.financeChargeInr >= 1) {
      const m = genericModule(ctx, 'credit_card', st.issuer ?? '', 'credit card');
      const low = m?.rules.ratePctLow;
      const high = m?.rules.ratePctHigh;
      const alt =
        low != null && high != null
          ? ` A balance-transfer EMI or personal loan at about ${low}–${high}% a year may cost less while you clear it.`
          : ' A balance-transfer EMI or personal loan may cost less while you clear it.';
      out.push(
        feeMove('interest', key, st.obligationId, m, {
          title: `You paid ${rupees(st.financeChargeInr)} interest this month`,
          why: `${card} charged ${rupees(st.financeChargeInr)} in finance charges and GST${st.monthlyRatePct ? ` (its printed rate is ${st.monthlyRatePct}% a month)` : ''}. Paying the total due by the due date stops new interest.${alt}`,
          saving: st.financeChargeInr,
          confidence: 'high',
          effort: 'paperwork',
          legalNote: DEBT_LEGAL_NOTE,
          action: action(m, 'Compare on the official page'),
        }),
      );
    }
    if (st.lateFeeInr && st.lateFeeInr >= 1)
      out.push(
        feeMove('late_fee', key, st.obligationId, null, {
          title: 'Set an autopay for at least the minimum due',
          why: `${card} charged a late fee of ${rupees(st.lateFeeInr)} including GST. An autopay for the minimum due avoids it.`,
          saving: st.lateFeeInr,
          confidence: 'medium',
          effort: 'tap',
          legalNote: null,
          action: { url: null, label: "Set it up in your card's app" },
        }),
      );
    if (st.forexMarkupInr && st.forexMarkupInr >= 1)
      out.push(
        feeMove('forex', key, st.obligationId, null, {
          title: `${rupees(st.forexMarkupInr)} a month in forex markup + GST`,
          why: `Charged on ${st.foreignSpendInr ? `${rupees(st.foreignSpendInr)} of ` : ''}foreign-currency payments. A zero-forex card or paying in INR avoids it.`,
          saving: st.forexMarkupInr,
          confidence: 'high',
          effort: 'habit',
          legalNote: null,
        }),
      );
    if (st.annualFeeInr && st.annualFeeInr >= 1)
      out.push(
        feeMove('annual_fee', key, st.obligationId, null, {
          title: `Annual fee of ${rupees(st.annualFeeInr)} charged`,
          why: st.annualFeeWaiver
            ? `Your statement says: ${st.annualFeeWaiver}.`
            : 'Ask your bank whether it can be reversed or whether a lower-fee card suits you.',
          saving: st.annualFeeInr / 12,
          confidence: 'medium',
          effort: 'tap',
          legalNote: null,
        }),
      );
  }
  return out;
}

/** Bounced presentations in the 12 months up to today. */
export function bouncesIn12Months(loan: LoanStatementSummary, today: string): number {
  const from = addMonthsClamped(today, -11).slice(0, 7);
  return loan.bounceRows.filter((m) => m >= from && m <= today.slice(0, 7)).length;
}

const ORD = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;

function latestBank(banks: BankStatementSummary[]): BankStatementSummary | null {
  return (
    [...banks].sort((a, b) => (a.periodTo ?? '').localeCompare(b.periodTo ?? '')).pop() ?? null
  );
}

function failedDebits(bank: BankStatementSummary | null): { count: number; charges: number } {
  if (!bank) return { count: 0, charges: 0 };
  return bank.failedAutoDebits.reduce(
    (a, f) => ({ count: a.count + f.count, charges: a.charges + f.chargesInr }),
    { count: 0, charges: 0 },
  );
}

/** "On the 3rd your balance was ₹X against ₹Y of EMIs in N of M months", or ''. */
export function timingSentence(
  bank: BankStatementSummary | null,
  dueDay: number | null,
  emiTotal: number,
): string {
  if (!bank || !dueDay || !(emiTotal > 0)) return '';
  const months = incomeTiming(bank, dueDay, emiTotal);
  const short = months.filter((m) => (m.shortfallInr ?? 0) > 0);
  if (!months.length || !short.length) return '';
  const avg = short.reduce((s, m) => s + m.balanceInr, 0) / short.length;
  return `On the ${ORD(dueDay)} your balance was ${rupees(avg)} against ${rupees(emiTotal)} of EMIs in ${short.length} of ${months.length} months.`;
}

function bankMoves(banks: BankStatementSummary[], hasLoans: boolean): Move[] {
  const out: Move[] = [];
  const bank = latestBank(banks);
  if (!bank) return out;
  const key = `bank-${(bank.bank ?? 'account').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  const f = failedDebits(bank);
  // With a loan summary the failed debits join the EMI bounce move (same cause: EMI date vs income).
  if (!hasLoans && f.count > 0 && f.charges >= 1)
    out.push(
      feeMove('failed_debit', key, null, null, {
        title: `Your bank charged ${rupees(f.charges)} for ${f.count} failed auto-debits`,
        why: 'Each auto-debit that finds too little money in the account costs a charge. Keep the amount in the account a day before, or move the debit date nearer your income date.',
        saving: f.charges / bankMonths(bank),
        confidence: 'high',
        effort: 'habit',
        legalNote: null,
      }),
    );
  const sweeps = bank.smaSweeps ?? [];
  if (sweeps.length) {
    const lastMonth = sweeps
      .map((x) => x.date.slice(0, 7))
      .sort()
      .pop() as string;
    const inMonth = sweeps.filter((x) => x.date.startsWith(lastMonth));
    const total = inMonth.reduce((s, x) => s + x.amountInr, 0);
    const label = formatDate(`${lastMonth}-01`).replace(/^1 /, '');
    out.push({
      ...feeMove('sma', key, null, null, {
        title: 'A loan or overdraft is overdue (SMA)',
        why: `Your bank swept ${rupees(total)} to an overdue account in ${label}. SMA status is reported to credit bureaus and blocks cheaper loans.`,
        saving: 0,
        confidence: 'high',
        effort: 'paperwork',
        legalNote: 'Information only. Ask your bank which account is overdue and what clears it.',
        action: { url: null, label: 'Ask your bank' },
      }),
      severity: 'urgent',
    });
  }
  for (const p of bank.priceSteps) {
    const up = p.toInr - p.fromInr;
    if (up < 1) continue;
    out.push({
      id: `price_change:statement:${p.key}`,
      kind: 'price_change',
      moduleId: null,
      obligationIds: [],
      title: `${p.label} went from ${rupees(p.fromInr)} to ${rupees(p.toInr)} a month`,
      why: `Your statement shows the higher charge from ${formatDate(`${p.since}-01`).replace(/^1 /, '')}. Check whether a cheaper plan still fits.`,
      monthlySavingInr: r0(up),
      rangeInr: [r0(up), r0(up)],
      confidence: 'medium',
      assumptions: [],
      sources: [],
      effort: 'tap',
      action: { url: null, label: 'Review your plan' },
      unverifiedPrice: false,
      legalNote: null,
      sponsored: false,
    });
  }
  return out;
}

function loanSummaryMoves(
  ctx: Ctx,
  loans: LoanStatementSummary[],
  banks: BankStatementSummary[] = [],
): Move[] {
  const out: Move[] = [];
  const yearAgo = addDays(ctx.today, -365);
  const bank = latestBank(banks);
  const f = failedDebits(bank);
  const latestLoans = latestBy(loans, loanKey, (l) => l.statementDate);
  // Failed auto-debits join the move of the loan that bounced most (same cause: EMI vs income date).
  const bankTarget = [...latestLoans].sort((a, b) => b.bounceCount - a.bounceCount)[0];
  for (const loan of latestLoans) {
    const key = loanKey(loan);
    const name =
      [loan.lender, loan.product?.toLowerCase()].filter(Boolean).join(' ') || 'your loan';
    const bounces = bouncesIn12Months(loan, ctx.today);
    const charges = loan.bounceCharges
      .filter((c) => c.date >= yearAgo && c.date <= ctx.today)
      .reduce((s, c) => s + c.amountInr, 0);
    const late = loan.latePaymentChargesInr ?? 0;
    const bankPart: { count: number; charges: number } | null =
      loan === bankTarget && f.count > 0 ? f : null;
    if ((bounces >= 1 && charges + late >= 1) || bankPart) {
      const emiTotal = latestLoans
        .filter((l) => l.emiDueDay === loan.emiDueDay)
        .reduce((s, l) => s + (l.emiInr ?? 0), 0);
      const parts = [
        bounces >= 1
          ? `EMI bounced ${bounces} time${bounces === 1 ? '' : 's'} in 12 months: ${rupees(charges)} in bounce charges + ${rupees(late)} late interest.`
          : '',
        bankPart
          ? `Your bank charged ${rupees(bankPart.charges)} for ${bankPart.count} failed auto-debits.`
          : '',
        timingSentence(bank, loan.emiDueDay, emiTotal),
        'Or ask the lender to move the EMI date nearer your income date.',
      ].filter(Boolean);
      out.push(
        feeMove('bounce', key, loan.obligationId, null, {
          title: 'Keep the EMI amount in the account 1 day before the due date',
          why: parts.join(' '),
          saving:
            (charges + late) / 12 + (bankPart && bank ? bankPart.charges / bankMonths(bank) : 0),
          confidence: 'high',
          effort: 'habit',
          legalNote: null,
        }),
      );
    }
    const rate = loan.annualRatePct;
    const p = loan.futurePrincipalInr;
    const n = loan.balanceTenureMonths;
    if (loan.rateType !== 'floating' || rate == null || p == null || n == null || p <= 0 || n <= 0)
      continue;
    const m = genericModule(ctx, 'emi', loan.lender ?? '', loan.product ?? 'loan');
    if (!m || m.valueKind !== 'loan_switch') continue;
    const low = m.rules.ratePctLow;
    if (low == null || rate <= low + 0.5) continue;
    const cur = emi(p, rate, n);
    const saving = cur - emi(p, low, n);
    if (saving < 1) continue;
    const high = m.rules.ratePctHigh;
    const a = new Assumptions(ctx.profile.overrides);
    a.use(`loan_switch:${key}:ratePct`, 'Your rate a year', rate, '%', 'your_data', false);
    a.use(`loan_switch:${key}:principalInr`, 'Principal left', r0(p), '₹', 'your_data', false);
    a.use(`loan_switch:${key}:months`, 'Months left', n, 'months', 'your_data', false);
    const bounced = bounces >= 2;
    out.push({
      id: `loan_switch:${m.id}:${key}`,
      kind: 'loan_switch',
      moduleId: m.id,
      obligationIds: loan.obligationId ? [loan.obligationId] : [],
      title: `Ask about a lower rate on ${name}`,
      why: `Your floating rate is ${rate}%; published rates start at ${low}%. On ${rupees(p)} over ${n} months that is about ${rupees(saving)} less EMI a month.${bounced ? ` ${BOUNCE_TRANSFER_NOTE}` : ''}`,
      monthlySavingInr: r0(saving),
      rangeInr: [r0(high != null && high < rate ? cur - emi(p, high, n) : 0), r0(saving)],
      confidence: bounced ? 'low' : 'medium',
      assumptions: a.list,
      sources: m.sources.some((x) => x.kind === 'regulator')
        ? m.sources
        : [...m.sources, RBI_SOURCE],
      effort: 'paperwork',
      action: action(m, 'See published rates'),
      unverifiedPrice: m.status === 'research',
      legalNote: LOAN_LEGAL_NOTE,
      sponsored: false,
    });
  }
  return out;
}

/* ---------- statement-only moves: recurring overlaps, telecom bills, UPI on credit, gold loan ---------- */

const OTT_KEYS: Record<string, string> = {
  netflix: 'Netflix',
  amazon_prime: 'Amazon Prime',
  jiohotstar: 'JioHotstar',
  youtube_premium: 'YouTube Premium',
  sonyliv: 'Sony LIV',
  zee5: 'ZEE5',
};
const CADENCE_MONTHS: Record<RecurringCandidate['cadence'], number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};
const monthlyOf = (c: RecurringCandidate) => c.averageInr / CADENCE_MONTHS[c.cadence];

function infoMove(
  id: string,
  kind: Move['kind'],
  p: Pick<Move, 'title' | 'why'> & Partial<Pick<Move, 'effort' | 'action' | 'obligationIds'>>,
): Move {
  return {
    id,
    kind,
    moduleId: null,
    obligationIds: p.obligationIds ?? [],
    title: p.title,
    why: p.why,
    monthlySavingInr: 0,
    rangeInr: [0, 0],
    confidence: 'low',
    assumptions: [],
    sources: [],
    effort: p.effort ?? 'tap',
    action: p.action ?? { url: null, label: 'Check your plan' },
    unverifiedPrice: true,
    legalNote: null,
    sponsored: false,
    severity: 'info',
  };
}

function lowOverlap(id: string, title: string, why: string, saving: number): Move {
  const v = r0(saving);
  return {
    id,
    kind: 'overlap',
    moduleId: null,
    obligationIds: [],
    title,
    why,
    monthlySavingInr: v,
    rangeInr: [0, v],
    confidence: 'low',
    assumptions: [],
    sources: [],
    effort: 'tap',
    action: { url: null, label: 'Check your plan' },
    unverifiedPrice: true,
    legalNote: null,
    sponsored: false,
  };
}

/**
 * Moves from recurring candidates alone (no obligation needed): a postpaid plan next to OTT apps
 * paid separately, and one merchant billed as two plans at the same cadence.
 */
export function recurringMoves(cands: RecurringCandidate[]): Move[] {
  const out: Move[] = [];
  const subs = cands.filter((c) => c.kind === 'subscription' || c.kind === undefined);
  const has = (k: string) => cands.some((c) => c.key === k);
  const otts = subs.filter((c) => OTT_KEYS[c.key]);
  for (const [carrier, name] of [
    ['jio_postpaid', 'Jio Postpaid'],
    ['airtel_postpaid', 'Airtel postpaid'],
  ] as const) {
    if (!has(carrier) || !otts.length) continue;
    const parts = otts.map((c) => `${OTT_KEYS[c.key]} ${rupees(monthlyOf(c))}`);
    out.push(
      lowOverlap(
        `overlap:statement:${carrier}`,
        carrier === 'jio_postpaid'
          ? 'Check if your Jio Postpaid plan already includes Netflix, Prime or JioHotstar'
          : 'Check if your Airtel plan already includes Netflix, Prime or JioHotstar',
        `You pay ${parts.join(', ')} a month separately. Some ${name} plans bundle these; the plan page lists what yours includes.`,
        otts.reduce((s2, c) => s2 + monthlyOf(c), 0),
      ),
    );
  }
  const byKey = new Map<string, RecurringCandidate[]>();
  for (const c of subs) byKey.set(c.key, [...(byKey.get(c.key) ?? []), c]);
  for (const [key, list] of byKey) {
    if (list.length < 2) continue;
    for (const cadence of ['monthly', 'quarterly', 'yearly'] as const) {
      const same = list
        .filter((c) => c.cadence === cadence)
        .sort((a, b) => b.averageInr - a.averageInr);
      if (same.length < 2) continue;
      const [a, b] = same;
      if (a.averageInr <= b.averageInr * 1.1) continue;
      const per =
        cadence === 'monthly' ? 'a month' : cadence === 'quarterly' ? 'a quarter' : 'a year';
      out.push(
        lowOverlap(
          `overlap:statement:${key}:twice`,
          `${a.label} is billed twice: ${rupees(a.averageInr)} and ${rupees(b.averageInr)} ${per} — two plans or two ${key === 'apple' ? 'Apple IDs' : 'accounts'}?`,
          `The same merchant charges two different amounts on the same schedule${a.severalPaymentMethods || b.severalPaymentMethods ? ', from different payment methods' : ''}. If one is a duplicate, cancelling it saves the smaller amount.`,
          monthlyOf(b),
        ),
      );
      break;
    }
  }
  return out;
}

function separateOtts(
  ctx: Ctx,
  banks: BankStatementSummary[],
  keys: string[],
): { key: string; label: string; monthly: number }[] {
  const out = new Map<string, { key: string; label: string; monthly: number }>();
  for (const ob of ctx.obs) {
    const k =
      ob.canonicalProvider ?? canonicalMerchant(`${ob.provider} ${ob.nickname}`)?.key ?? null;
    const m = obligationMonthlyInr(ob);
    if (k && keys.includes(k) && m) out.set(k, { key: k, label: OTT_KEYS[k] ?? k, monthly: m });
  }
  for (const c of banks.flatMap((b) => b.recurring ?? []))
    if (keys.includes(c.key) && !out.has(c.key))
      out.set(c.key, { key: c.key, label: OTT_KEYS[c.key] ?? c.label, monthly: monthlyOf(c) });
  return [...out.values()];
}

function telecomMoves(
  ctx: Ctx,
  bills: TelecomBillSummary[],
  banks: BankStatementSummary[],
): Move[] {
  const out: Move[] = [];
  const latest = latestBy(
    bills,
    (b) => `${b.provider}-${b.service}`,
    (b) => b.periodFrom,
  );
  for (const b of latest) {
    const svc = b.service === 'fiber' ? 'JioFiber' : `${b.provider} Postpaid`;
    const key = `${b.provider}-${b.service}`.toLowerCase();
    if (
      b.dataUsedGb !== null &&
      b.planDataGb !== null &&
      b.planDataGb > 0 &&
      b.dataUsedGb <= b.planDataGb * 0.3
    ) {
      const m = genericModule(ctx, 'bill', b.provider, `${b.provider} postpaid`);
      const smaller = (m?.rules.prices ?? [])
        .filter(
          (p) =>
            p.priceInr !== null &&
            b.baseRentalInr !== null &&
            (p.priceInr as number) < (b.baseRentalInr as number) &&
            p.periodDays >= 28 &&
            p.periodDays <= 31,
        )
        .sort((x, y) => (y.priceInr as number) - (x.priceInr as number))[0];
      const title = `You use about ${r0(b.dataUsedGb)} GB of ${r0(b.planDataGb)} GB: a smaller plan may do`;
      const why = `Your ${svc} bill shows ${b.dataUsedGb} GB used of ${b.planDataGb} GB${b.addOns.length ? ' (shared with add-on members)' : ''}.`;
      if (smaller && b.baseRentalInr !== null)
        out.push({
          ...lowOverlap(
            `period_switch:telecom:${key}`,
            title,
            `${why} ${m?.product ?? 'A smaller plan'} lists ${smaller.label} at ${rupees(smaller.priceInr as number)}.`,
            b.baseRentalInr - (smaller.priceInr as number),
          ),
          kind: 'period_switch',
          moduleId: m?.id ?? null,
          sources: m?.sources ?? [],
          unverifiedPrice: m?.status !== 'verified',
        });
      else
        out.push(
          infoMove(`period_switch:telecom:${key}`, 'period_switch', {
            title,
            why: `${why} Due has no confirmed price for a smaller plan yet.`,
          }),
        );
    }
    for (const a of b.addOns)
      out.push(
        infoMove(
          `fee_leak:addon:${key}:${a.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          'fee_leak',
          {
            title: `${a.label}: ${rupees(a.amountInr)} a month on your ${svc} bill`,
            why: 'Shown as its own line item. Check it is still used before the next bill.',
          },
        ),
      );
    if (b.service === 'fiber' && b.includes.length) {
      for (const o of separateOtts(ctx, banks, ['jiohotstar', 'sonyliv', 'zee5']))
        out.push(
          lowOverlap(
            `overlap:telecom:${key}:${o.key}`,
            `Your JioFiber plan includes OTT apps; check whether ${o.label} is one of them before renewing it`,
            `Plan ${b.planName ?? ''} includes ${b.includes.join('; ')}. You also pay about ${rupees(o.monthly)} a month for ${o.label}.`.replace(
              'Plan  ',
              'Your plan ',
            ),
            o.monthly,
          ),
        );
    }
  }
  return out;
}

function upiCreditMoves(statements: CardStatementSummary[], upi: UpiStatementSummary[]): Move[] {
  const out: Move[] = [];
  const cards = latestBy(statements, cardKey, (s) => s.statementDate).filter(
    (c) => (c.financeChargeInr ?? 0) > 0 && c.monthlyRatePct,
  );
  if (!cards.length) return out;
  for (const spend of upi.flatMap((u) => u.creditCardSpend)) {
    const card =
      cards.find(
        (c) =>
          c.last4 &&
          spend.last4 &&
          (spend.last4.endsWith(c.last4) || c.last4.endsWith(spend.last4)),
      ) ?? (cards.length === 1 ? cards[0] : null);
    if (!card || !card.monthlyRatePct) continue;
    const monthly = spend.totalInr / Math.max(1, spend.months);
    const digits = spend.last4 ?? card.last4 ?? '';
    out.push({
      ...feeMove('upi_credit', `${cardKey(card)}-${digits}`, card.obligationId, null, {
        title: `Paying daily UPI with card ending ${digits} while it carries a balance: these start costing ~${card.monthlyRatePct}%/month at once`,
        why: `About ${rupees(monthly)} a month of UPI payments went on this card. While a balance is carried there is no interest-free period, so each payment is charged interest from the day it is made.`,
        saving: (monthly * card.monthlyRatePct) / 100,
        confidence: 'low',
        effort: 'habit',
        legalNote: DEBT_LEGAL_NOTE,
      }),
    });
  }
  return out;
}

function goldLoanMoves(
  ctx: Ctx,
  loans: LoanStatementSummary[],
  statements: CardStatementSummary[],
): Move[] {
  const out: Move[] = [];
  const golds = latestBy(
    loans.filter((l) => l.productKind === 'gold_loan_od'),
    loanKey,
    (l) => l.statementDate,
  );
  const threeMonths = addMonthsClamped(ctx.today, -3);
  for (const g of golds) {
    const key = loanKey(g);
    const recent = (g.irregularities ?? []).filter(
      (i) => i.date >= threeMonths && i.date <= ctx.today,
    );
    if (recent.length)
      out.push({
        ...feeMove('gold_irregular', key, g.obligationId, null, {
          title: 'Your gold loan OD went irregular recently',
          why: `${g.lender ?? 'Your bank'} recovered ${rupees(recent.reduce((s2, i) => s2 + i.amountInr, 0))} as ${[...new Set(recent.map((i) => i.label))].join(' / ')} on ${recent.map((i) => formatDate(i.date)).join(', ')}. Irregular or SMA status is reported to credit bureaus and blocks cheaper loans.`,
          saving: 0,
          confidence: 'high',
          effort: 'paperwork',
          legalNote: 'Information only. Ask your bank what keeps the account regular.',
          action: { url: null, label: 'Ask your bank' },
        }),
        severity: 'urgent',
      });
    const goldRate = g.annualRatePct;
    if (goldRate == null) continue;
    for (const c of latestBy(statements, cardKey, (s) => s.statementDate)) {
      if (!c.monthlyRatePct || !(c.financeChargeInr && c.financeChargeInr > 0)) continue;
      const cardRate = c.monthlyRatePct * 12;
      const balance = c.totalDue ?? c.previousBalance;
      if (!balance || cardRate < goldRate + 10) continue;
      const cardInterest = c.financeChargeInr ?? (balance * c.monthlyRatePct) / 100;
      const saving = cardInterest - (balance * goldRate) / 1200;
      if (saving < 1) continue;
      out.push({
        id: `debt_rate:gold-loan:${key}:${cardKey(c)}`,
        kind: 'debt_rate',
        moduleId: null,
        obligationIds: [c.obligationId, g.obligationId].filter((x): x is string => !!x),
        title: `Card debt costs ~${r0(cardRate)}%/yr, your gold loan ~${goldRate}%: ask your bank whether a gold revaluation can raise the drawing power to clear the card`,
        why: `${c.issuer ?? 'Your card'} charged ${rupees(cardInterest)} interest on about ${rupees(balance)}. The same amount at ${goldRate}% would cost about ${rupees((balance * goldRate) / 1200)} a month.`,
        monthlySavingInr: r0(saving),
        rangeInr: [0, r0(saving)],
        confidence: 'low',
        assumptions: [],
        sources: [],
        effort: 'paperwork',
        action: { url: null, label: 'Ask your bank' },
        unverifiedPrice: false,
        legalNote: DEBT_LEGAL_NOTE,
        sponsored: false,
      });
    }
  }
  return out;
}

/* ---------- ranking ---------- */

export function rankMoves(moves: Move[]): Move[] {
  return [...moves].sort((a, b) => {
    // Urgent alerts (an overdue loan in SMA) come first, whatever they would save; info last.
    const w = (m: Move) => (m.severity === 'urgent' ? 1 : m.severity === 'info' ? -1 : 0);
    const u = w(b) - w(a);
    if (u) return u;
    const s =
      b.monthlySavingInr * CONFIDENCE_WEIGHT[b.confidence] -
      a.monthlySavingInr * CONFIDENCE_WEIGHT[a.confidence];
    if (Math.abs(s) > 1e-9) return s;
    return EFFORT_RANK[a.effort] - EFFORT_RANK[b.effort] || a.id.localeCompare(b.id);
  });
}

/** The obligation a move would cut: overlap → the duplicate charge; others → the first id. */
export function targetObligationId(move: Pick<Move, 'kind' | 'obligationIds'>): string | null {
  if (move.kind === 'overlap') return move.obligationIds[1] ?? null;
  return move.obligationIds[0] ?? null;
}

/** Total found a month without double counting: moves on the same obligation count once (the largest). */
export function foundTotalInr(moves: Move[]): number {
  const byTarget = new Map<string, number>();
  for (const m of moves) {
    const k = targetObligationId(m) ?? m.id;
    byTarget.set(k, Math.max(byTarget.get(k) ?? 0, m.monthlySavingInr));
  }
  return [...byTarget.values()].reduce((s, v) => s + v, 0);
}

/* ---------- entry point ---------- */

export function computeMoves(data: AppData, catalog: SavingsCatalog, now: string): MovesResult {
  const tz = data.settings?.timezone || 'Asia/Kolkata';
  const today = /^\d{4}-\d{2}-\d{2}$/.test(now) ? now : todayInTz(tz, new Date(now));
  const profile = data.savings?.profile ?? {
    cityPack: null,
    homeLocality: null,
    commute: [],
    overrides: {},
    communityOptIn: false,
    researchSent: [],
  };
  const modules = (catalog?.modules ?? []).filter((m) => m.status !== 'retired');
  const obs = forecastObligations(data);
  const match = new Map<string, ModuleMatch | null>();
  for (const ob of obs) match.set(ob.id, matchModule(ob, modules));
  const cityPack =
    (catalog?.cityPacks ?? []).find((p) => p.id === profile.cityPack && p.status !== 'retired') ??
    null;
  const ctx: Ctx = { today, profile, catalog, obs, match, cityPack, modules };

  // Statement summaries first: their loan moves are more exact than the obligation's own terms
  // and win the de-duplication below.
  const moves: Move[] = [
    ...loanSummaryMoves(ctx, data.savings?.loans ?? [], data.savings?.banks ?? []),
    ...bankMoves(data.savings?.banks ?? [], (data.savings?.loans ?? []).length > 0),
    ...cardFeeMoves(ctx, data.savings?.statements ?? []),
    ...goldLoanMoves(ctx, data.savings?.loans ?? [], data.savings?.statements ?? []),
    ...upiCreditMoves(data.savings?.statements ?? [], data.savings?.upi ?? []),
    ...telecomMoves(ctx, data.savings?.telecom ?? [], data.savings?.banks ?? []),
    ...recurringMoves((data.savings?.banks ?? []).flatMap((b) => b.recurring ?? [])),
    ...overlapMoves(ctx),
    ...commuteMoves(ctx),
  ];
  for (const ob of obs) {
    const m = moduleOf(ctx, ob);
    let pausing = false;
    if (m) {
      if (m.valueKind === 'membership_breakeven') {
        const r = membershipMove(ctx, ob, m);
        if (r && r !== 'pays') {
          moves.push(r);
          pausing = true;
        }
      }
      if (!pausing) {
        const p = periodSwitchMove(ob, m);
        if (p) moves.push(p);
      }
      if (m.valueKind === 'debt_rate') {
        const d = debtMove(ctx, ob, m);
        if (d) moves.push(d);
      }
      if (m.valueKind === 'loan_switch') {
        const l = loanMove(ctx, ob, m);
        if (l) moves.push(l);
      }
    }
    const pc = priceChangeMove(ctx, ob);
    if (pc) moves.push(pc);
    const te = trialEndMove(ctx, ob);
    if (te) moves.push(te);
  }
  const seen = new Set<string>();
  const unique = moves.filter(
    (mv) =>
      (mv.monthlySavingInr > 0 || mv.severity === 'urgent' || mv.severity === 'info') &&
      !seen.has(mv.id) &&
      seen.add(mv.id),
  );
  const research = researchNeeds(obs.filter((ob) => !match.get(ob.id)));
  return { moves: rankMoves(unique), research };
}
