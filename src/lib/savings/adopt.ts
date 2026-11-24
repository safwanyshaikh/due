/**
 * Turning a statement summary into an obligation the user can plan with: "Add this card's bill"
 * and "Add this loan's EMI". Creates or updates one obligation (audited, undoable) and saves the
 * summary into AppData.savings, linked to it. Nothing is paid or sent anywhere.
 */
import { addMonthsClamped, daysInMonth, parseISO, toISO } from '../dates';
import { commit, type MutationContext, type MutationResult } from '../audit';
import { buildObligation } from '../mutations';
import { rules } from '../recurrence';
import type { AppData, Commitment, Provenance } from '../types';
import { defaultSavingsState } from './state';
import { saveTelecomBill } from './state';
import type {
  CardStatementSummary,
  LoanStatementSummary,
  SavingsState,
  TelecomBillSummary,
} from './types';

const paise = (inr: number | null) => (inr === null ? null : Math.round(inr * 100));

function statementSource(ctx: MutationContext, label: string): Provenance {
  return { kind: 'statement', label, importedAt: ctx.now };
}

function title(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const cardId = (x: CardStatementSummary) => `${x.issuer}|${x.last4}|${x.statementDate}`;
const loanId = (x: LoanStatementSummary) =>
  `${x.lender}|${x.product}|${x.disbursementDate}|${x.source}|${x.statementDate}`;

/** Upserts a card summary (the same card's same statement replaces the older copy). */
export function saveCardStatement(state: SavingsState, s: CardStatementSummary): SavingsState {
  const list = (state.statements ?? []).filter((x) => cardId(x) !== cardId(s));
  return { ...state, statements: [...list, s] };
}

/** Upserts a loan summary (the same loan's same statement replaces the older copy). */
export function saveLoanStatement(state: SavingsState, s: LoanStatementSummary): SavingsState {
  const list = (state.loans ?? []).filter((x) => loanId(x) !== loanId(s));
  return { ...state, loans: [...list, s] };
}

function upsert(
  data: AppData,
  existing: Commitment | null,
  built: Commitment,
  ctx: MutationContext,
  summary: string,
  savings: (s: SavingsState, id: string) => SavingsState,
): MutationResult & { obligationId: string } {
  const record: Commitment = existing
    ? {
        ...built,
        id: existing.id,
        createdAt: existing.createdAt,
        history: existing.history,
        ownerLabel: existing.ownerLabel || built.ownerLabel,
        reminder: existing.reminder,
        importance: existing.importance,
        notes: existing.notes || built.notes,
      }
    : built;
  const commitments = existing
    ? data.commitments.map((c) => (c.id === existing.id ? record : c))
    : [...data.commitments, record];
  const next: AppData = {
    ...data,
    commitments,
    savings: savings(data.savings ?? defaultSavingsState(), record.id),
  };
  const r = commit(
    data,
    next,
    { commitments: [record.id] },
    { action: existing ? 'update' : 'create', entity: 'obligation', entityId: record.id, summary },
    ctx,
  );
  return { ...r, obligationId: record.id };
}

/** "Add this card's bill": a credit_card obligation due on the due date for the total due. */
export function addCardBill(
  data: AppData,
  s: CardStatementSummary,
  ctx: MutationContext,
): MutationResult & { obligationId: string } {
  if (!s.dueDate) throw new Error('This statement has no due date.');
  const issuer = s.issuer ?? 'Credit card';
  const cardNickname = `${issuer}${s.last4 ? ` ••${s.last4}` : ''}`;
  const existing =
    data.commitments.find((c) => !c.deletedAt && c.id === s.obligationId) ??
    data.commitments.find(
      (c) => !c.deletedAt && c.type === 'credit_card' && c.statement?.cardNickname === cardNickname,
    ) ??
    null;
  const built = buildObligation(
    {
      type: 'credit_card',
      provider: issuer,
      nickname: `${cardNickname} bill`,
      amountPaise: paise(s.totalDue),
      rule: rules.oneTime(s.dueDate),
      amountConfidence: 'imported',
      dateConfidence: 'imported',
      source: statementSource(ctx, 'Card statement'),
      rail: 'unknown',
      importance: 'essential',
      notes: s.minimumDue !== null ? `Minimum due ₹${s.minimumDue.toLocaleString('en-IN')}.` : '',
    },
    ctx.now,
  );
  built.statement = {
    cardNickname,
    periodEnd: s.statementDate,
    confirmedFromLatest: true,
  };
  return upsert(data, existing, built, ctx, `Card bill from statement: ${cardNickname}`, (st, id) =>
    saveCardStatement(st, { ...s, obligationId: id }),
  );
}

/** Next date on `day` of the month on or after today. */
export function nextOnDay(today: string, day: number): string {
  const { y, m } = parseISO(today);
  const at = (yy: number, mm: number) => toISO(yy, mm, Math.min(day, daysInMonth(yy, mm)));
  const here = at(y, m);
  if (here >= today) return here;
  const n = parseISO(addMonthsClamped(toISO(y, m, 1), 1));
  return at(n.y, n.m);
}

/** "Add this loan's EMI": a monthly emi obligation with loan terms on a bank mandate. */
export function addLoanEmi(
  data: AppData,
  s: LoanStatementSummary,
  ctx: MutationContext & { today: string },
): MutationResult & { obligationId: string } {
  if (s.emiInr === null) throw new Error('This statement has no EMI amount.');
  const lender = s.lender ?? 'Loan';
  const product = s.product ? title(s.product) : 'Loan';
  const existing =
    data.commitments.find((c) => !c.deletedAt && c.id === s.obligationId) ??
    data.commitments.find(
      (c) =>
        !c.deletedAt &&
        (c.type === 'emi' || c.type === 'other_loan') &&
        c.provider === lender &&
        (c.loan?.loanType ?? '').toLowerCase() === product.toLowerCase(),
    ) ??
    null;
  const start = nextOnDay(ctx.today, s.emiDueDay ?? parseISO(ctx.today).d);
  const months = s.balanceTenureMonths ?? null;
  const rule = { ...rules.monthly(start, s.emiDueDay ?? undefined), count: months };
  const built = buildObligation(
    {
      type: 'emi',
      provider: lender,
      nickname: `${lender} ${product.toLowerCase()}`,
      amountPaise: paise(s.emiInr),
      rule,
      amountConfidence: 'imported',
      dateConfidence: s.emiDueDay ? 'imported' : 'estimated',
      source: statementSource(
        ctx,
        s.source === 'welcome_letter' ? 'Loan welcome letter' : 'Loan statement',
      ),
      rail: 'bank_mandate',
      importance: 'essential',
    },
    ctx.now,
  );
  built.loan = {
    lenderNickname: lender,
    loanType: product,
    principalPaise: paise(
      s.futurePrincipalInr ?? (s.source === 'welcome_letter' ? s.loanAmountInr : null),
    ),
    interestRatePct: s.annualRatePct,
    rateType: s.rateType === 'floating' ? 'variable' : s.rateType === 'fixed' ? 'fixed' : null,
    originalTenureMonths: s.loanTenureMonths,
  };
  return upsert(data, existing, built, ctx, `Loan EMI from statement: ${lender}`, (st, id) =>
    saveLoanStatement(st, { ...s, obligationId: id }),
  );
}

/** "Add this bill" for a Jio Postpaid / JioFiber bill: a monthly 'bill' obligation for the total payable. */
export function addTelecomBill(
  data: AppData,
  b: TelecomBillSummary,
  ctx: MutationContext & { today: string },
): MutationResult & { obligationId: string } {
  if (!b.dueDate) throw new Error('This bill has no due date.');
  const nickname = b.service === 'fiber' ? 'JioFiber' : `${b.provider} Postpaid`;
  const existing =
    data.commitments.find((c) => !c.deletedAt && c.id === b.obligationId) ??
    data.commitments.find(
      (c) =>
        !c.deletedAt && c.type === 'bill' && c.provider === b.provider && c.nickname === nickname,
    ) ??
    null;
  const built = buildObligation(
    {
      type: 'bill',
      provider: b.provider,
      nickname,
      amountPaise: paise(b.totalPayableInr),
      rule: rules.monthly(b.dueDate),
      amountConfidence: 'imported',
      dateConfidence: 'imported',
      source: statementSource(ctx, `${nickname} bill`),
      rail: 'unknown',
      importance: 'important',
      notes: b.planName ? `Plan ${b.planName}.` : '',
    },
    ctx.now,
  );
  return upsert(data, existing, built, ctx, `${nickname} bill`, (st, id) =>
    saveTelecomBill(st, { ...b, obligationId: id }),
  );
}

/** Last day of the month on or after today. */
function nextMonthEnd(today: string): string {
  const { y, m } = parseISO(today);
  return toISO(y, m, daysInMonth(y, m));
}

/**
 * "Add this loan" for an overdraft-style gold loan: an other_loan obligation with the rate,
 * limit and outstanding, due monthly on the last day for the latest month's interest.
 */
export function addGoldLoan(
  data: AppData,
  s: LoanStatementSummary,
  ctx: MutationContext & { today: string },
): MutationResult & { obligationId: string } {
  const lender = s.lender ?? 'Bank';
  const latest = (s.monthlyInterest ?? []).slice(-1)[0] ?? null;
  const existing =
    data.commitments.find((c) => !c.deletedAt && c.id === s.obligationId) ??
    data.commitments.find(
      (c) =>
        !c.deletedAt &&
        c.type === 'other_loan' &&
        c.provider === lender &&
        c.loan?.loanType === 'Gold Loan OD',
    ) ??
    null;
  const fmt = (n: number | null | undefined) =>
    n == null ? 'not shown' : `₹${n.toLocaleString('en-IN')}`;
  const built = buildObligation(
    {
      type: 'other_loan',
      provider: lender,
      nickname: `${lender} gold loan OD`,
      amountPaise: paise(latest ? latest.amountInr : null),
      rule: rules.endOfMonth(nextMonthEnd(ctx.today)),
      amountConfidence: 'imported',
      dateConfidence: 'estimated',
      source: statementSource(ctx, 'Gold loan statement'),
      rail: 'unknown',
      importance: 'essential',
      notes: `Monthly interest is debited to the OD. Limit ${fmt(s.limitInr)}; outstanding ${fmt(s.outstandingInr)}.`,
    },
    ctx.now,
  );
  built.loan = {
    lenderNickname: lender,
    loanType: 'Gold Loan OD',
    principalPaise: paise(s.outstandingInr ?? null),
    interestRatePct: s.annualRatePct,
    rateType: null,
    originalTenureMonths: null,
  };
  return upsert(data, existing, built, ctx, `Gold loan from statement: ${lender}`, (st, id) =>
    saveLoanStatement(st, { ...s, obligationId: id }),
  );
}
