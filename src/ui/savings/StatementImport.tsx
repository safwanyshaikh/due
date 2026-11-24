import { useState, type ChangeEvent } from 'react';
import type {
  TelecomBillSummary,
  UpiStatementSummary,
  BankStatementSummary,
  CardStatementSummary,
  LoanStatementSummary,
  RecurringCandidate,
  StatementLine,
} from '../../lib/savings/types';
import type { CommitmentType, Rail } from '../../lib/types';
import { createObligation, type MutationResult } from '../../lib/mutations';
import { rules, type RecurrenceRule } from '../../lib/recurrence';
import { addDays, formatDate } from '../../lib/dates';
import { looksSensitive } from '../../lib/sensitive';
import { STATEMENT_NOTE } from '../../content/savings';
import { useApp } from '../store';
import { Badge, Field, Notice } from '../components/ui';
import { readDocumentText } from '../lib/documentText';
import { nav } from '../lib/nav';
import {
  addGoldLoan,
  addTelecomBill,
  readTelecomBill,
  readUpiSummary,
  saveUpiStatement,
  addCardBill,
  addLoanEmi,
  findRecurring,
  parseStatement,
  readBankSummary,
  readCardSummary,
  readLoanSummary,
  saveBankStatement,
} from './engine';
import { CADENCE_TEXT, CONFIDENCE_LABEL, CONFIDENCE_TONE, RAIL_TEXT, rupees } from './format';

const MAX_BYTES = 15 * 1024 * 1024;
const TYPE_CHOICES: [CommitmentType, string][] = [
  ['subscription', 'Subscription'],
  ['bill', 'Bill'],
  ['emi', 'EMI'],
  ['other_loan', 'Loan'],
  ['other', 'Other'],
];

function ruleFor(c: RecurringCandidate, today: string): RecurrenceRule {
  let next = c.nextExpected;
  // Never anchor a new item in the past: move to the next date on the same cadence.
  const step = c.cadence === 'monthly' ? 30 : c.cadence === 'quarterly' ? 91 : 365;
  for (let i = 0; next < today && i < 50; i++) next = addDays(next, step);
  if (c.cadence === 'quarterly') return rules.quarterly(next);
  if (c.cadence === 'yearly') return rules.annual(next);
  return rules.monthly(next);
}

function guessType(c: RecurringCandidate): CommitmentType {
  return c.rail === 'bank_mandate' && c.averageInr >= 3000 ? 'emi' : 'subscription';
}

export function StatementImport() {
  const { mutate, update, ctx, today } = useApp();
  const [text, setText] = useState('');
  const [source, setSource] = useState<StatementLine['source']>('bank');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [found, setFound] = useState<RecurringCandidate[] | null>(null);
  const [lineCount, setLineCount] = useState(0);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [types, setTypes] = useState<Record<string, CommitmentType>>({});
  const [card, setCard] = useState<CardStatementSummary | null>(null);
  const [loan, setLoan] = useState<LoanStatementSummary | null>(null);
  const [added, setAdded] = useState<string | null>(null);
  const [bank, setBank] = useState<BankStatementSummary | null>(null);
  const [telecom, setTelecom] = useState<TelecomBillSummary | null>(null);
  const [upi, setUpi] = useState<UpiStatementSummary | null>(null);

  const check = (t: string) => {
    setMsg(null);
    setAdded(null);
    const tb = readTelecomBill(t);
    setTelecom(tb);
    if (tb) {
      setLoan(null);
      setBank(null);
      setCard(null);
      setUpi(null);
      setFound(null);
      return;
    }
    const u = readUpiSummary(t);
    setUpi(u);
    const l = u ? null : readLoanSummary(t);
    setLoan(l);
    const b = !l && !u && source === 'bank' ? readBankSummary(t) : null;
    setBank(b && b.morningBalances.length ? b : null);
    setCard(
      l || u ? null : source === 'card' || /credit\s+card/i.test(t) ? readCardSummary(t) : null,
    );
    if (l) {
      setFound(null);
      return;
    }
    const lines = parseStatement(t, source);
    setLineCount(lines.length);
    if (!lines.length) {
      setFound([]);
      if (readCardSummary(t)) return;
      setMsg('No payment lines were found. Paste rows with a date, a description and an amount.');
      return;
    }
    const cands = findRecurring(lines);
    setFound(cands);
    setPicked(Object.fromEntries(cands.map((c) => [c.key, c.confidence !== 'low'])));
    setTypes(Object.fromEntries(cands.map((c) => [c.key, guessType(c)])));
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > MAX_BYTES) return setMsg('This file is larger than 15 MB.');
    setBusy(true);
    try {
      const name = f.name.toLowerCase();
      let t: string;
      if (name.endsWith('.csv') || f.type === 'text/csv') t = await f.text();
      else {
        const r = await readDocumentText(f);
        if (!r.ok) {
          setMsg(r.message);
          return;
        }
        t = r.text;
      }
      setText(t);
      check(t);
    } finally {
      setBusy(false);
    }
  };

  const chosen = (found ?? []).filter((c) => picked[c.key]);

  const addCard = () => {
    if (!card) return;
    const r = mutate((d) => addCardBill(d, card, ctx()), { message: "Added this card's bill" });
    if (r) setAdded('card');
  };

  const gold = loan?.productKind === 'gold_loan_od';
  const addLoan = () => {
    if (!loan) return;
    const r = gold
      ? mutate((d) => addGoldLoan(d, loan, ctx()), { message: 'Added this loan' })
      : mutate((d) => addLoanEmi(d, loan, ctx()), { message: "Added this loan's EMI" });
    if (r) setAdded('loan');
  };

  const addTelecom = () => {
    if (!telecom) return;
    const r = mutate((d) => addTelecomBill(d, telecom, ctx()), { message: 'Added this bill' });
    if (r) setAdded('telecom');
  };

  const useUpi = () => {
    if (!upi) return;
    update((d) => ({ ...d, savings: saveUpiStatement(d.savings, upi) }));
    setAdded('upi');
  };
  const upiCard = upi ? upi.creditCardSpend.reduce((s2, c) => s2 + c.totalInr, 0) : 0;

  const useBank = () => {
    if (!bank) return;
    update((d) => ({ ...d, savings: saveBankStatement(d.savings, bank) }));
    setAdded('bank');
  };
  const failed = bank
    ? bank.failedAutoDebits.reduce(
        (a, f) => ({ count: a.count + f.count, charges: a.charges + f.chargesInr }),
        { count: 0, charges: 0 },
      )
    : null;

  const money = (n: number | null) => (n === null ? 'Not shown' : rupees(n));
  const cardFees = card
    ? (card.feesTaxesInterest ??
      [card.financeChargeInr, card.lateFeeInr, card.forexMarkupInr, card.annualFeeInr]
        .filter((n): n is number => n !== null)
        .reduce<number | null>((s, n) => (s ?? 0) + n, null))
    : null;

  const add = () => {
    const bad = chosen.map((c) => looksSensitive(c.label)).find(Boolean);
    if (bad) return setMsg(bad);
    const r = mutate(
      (d) => {
        const out: MutationResult[] = [];
        let cur = d;
        for (const c of chosen) {
          const res = createObligation(
            cur,
            {
              type: types[c.key] ?? 'subscription',
              provider: c.label,
              amountPaise: Math.round(c.averageInr * 100),
              rule: ruleFor(c, today),
              amountConfidence: 'imported',
              dateConfidence: 'estimated',
              source: { kind: 'statement', label: 'Statement import', importedAt: ctx().now },
              rail: c.rail as Rail,
              notes: `Found ${c.occurrences} times in a statement, last on ${formatDate(c.lastDate)}.`,
            },
            ctx(),
          );
          out.push(res);
          cur = res.data;
        }
        return out;
      },
      {
        message: `Added ${chosen.length} item${chosen.length === 1 ? '' : 's'} from your statement`,
      },
    );
    if (r) nav.go({ name: 'savings' });
  };

  return (
    <div className="page2">
      <header className="page-head">
        <a className="text-btn press" href="#/savings">
          ‹ Back to Savings
        </a>
        <h1>Find repeat payments in a statement</h1>
        <p className="muted">{STATEMENT_NOTE}</p>
      </header>

      <section className="panel2 stack-16" aria-label="Statement">
        <div className="field2">
          <span className="label-like" id="sv-src-label">
            Statement from
          </span>
          <div className="chip-group" role="radiogroup" aria-labelledby="sv-src-label">
            {(
              [
                ['bank', 'Bank account'],
                ['card', 'Credit card'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={source === k}
                className="chip-btn press"
                onClick={() => setSource(k)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="btn btn-primary press file-btn">
          <input
            type="file"
            accept=".pdf,.csv,.txt,application/pdf,text/csv,text/plain"
            className="sr-only"
            onChange={onFile}
            aria-label="Choose a statement file (PDF, CSV or text)"
          />
          {busy ? 'Reading…' : 'Choose PDF or CSV'}
        </label>
        <Field label="Or paste statement text" htmlFor="sv-stmt">
          <textarea
            id="sv-stmt"
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="05/11/2026  UPI-AUTOPAY NETFLIX  649.00 Dr"
          />
        </Field>
        <p className="muted small">
          Card numbers, account numbers and other personal details are not needed. Remove them
          before pasting if you like; Due only keeps the items you choose.
        </p>
        <button
          type="button"
          className="btn btn-secondary press jelly align-start"
          disabled={!text.trim() || busy}
          onClick={() => check(text)}
        >
          Find repeat payments
        </button>
      </section>

      <div aria-live="polite" className="stack-16">
        {msg && <Notice tone="warn">{msg}</Notice>}
        {card && (
          <section
            className="panel2 stack-16"
            aria-labelledby="sv-card-h"
            data-testid="sv-card-summary"
          >
            <h2 id="sv-card-h">{card.issuer ?? 'Card'} statement</h2>
            <dl className="sv-summary">
              <div>
                <dt>Due date</dt>
                <dd>{card.dueDate ? formatDate(card.dueDate) : 'Not shown'}</dd>
              </div>
              <div>
                <dt>Total due</dt>
                <dd>{money(card.totalDue)}</dd>
              </div>
              <div>
                <dt>Minimum due</dt>
                <dd>{money(card.minimumDue)}</dd>
              </div>
              <div>
                <dt>Interest and fees this month</dt>
                <dd>{money(cardFees)}</dd>
              </div>
            </dl>
            {added === 'card' ? (
              <Notice>Added. It will show on Home with its due date.</Notice>
            ) : (
              <button
                type="button"
                className="btn btn-primary press jelly align-start"
                disabled={!card.dueDate}
                onClick={addCard}
              >
                Add this card&apos;s bill
              </button>
            )}
          </section>
        )}
        {bank && (
          <section
            className="panel2 stack-16"
            aria-labelledby="sv-bank-h"
            data-testid="sv-bank-summary"
          >
            <h2 id="sv-bank-h">{bank.bank ?? 'Bank'} statement</h2>
            <dl className="sv-summary">
              {bank.periodFrom && bank.periodTo && (
                <div>
                  <dt>Period</dt>
                  <dd>
                    {formatDate(bank.periodFrom)} to {formatDate(bank.periodTo)}
                  </dd>
                </div>
              )}
              {failed && failed.count > 0 && (
                <div>
                  <dt>Failed auto-debits</dt>
                  <dd>
                    {failed.count} ({rupees(failed.charges)} in bank charges)
                  </dd>
                </div>
              )}
              {bank.priceSteps.map((p) => (
                <div key={p.key}>
                  <dt>{p.label}</dt>
                  <dd>
                    {rupees(p.fromInr)} → {rupees(p.toInr)} a month
                  </dd>
                </div>
              ))}
            </dl>
            {added === 'bank' ? (
              <Notice>Saved. Savings now uses these balances and charges.</Notice>
            ) : (
              <button
                type="button"
                className="btn btn-secondary press jelly align-start"
                onClick={useBank}
              >
                Use this statement for Savings
              </button>
            )}
          </section>
        )}
        {telecom && (
          <section
            className="panel2 stack-16"
            aria-labelledby="sv-tel-h"
            data-testid="sv-telecom-summary"
          >
            <h2 id="sv-tel-h">
              {telecom.service === 'fiber' ? 'JioFiber bill' : `${telecom.provider} Postpaid bill`}
            </h2>
            <dl className="sv-summary">
              <div>
                <dt>Plan</dt>
                <dd>{telecom.planName ?? 'Not shown'}</dd>
              </div>
              <div>
                <dt>Total payable</dt>
                <dd>{money(telecom.totalPayableInr)}</dd>
              </div>
              <div>
                <dt>Due date</dt>
                <dd>{telecom.dueDate ? formatDate(telecom.dueDate) : 'Not shown'}</dd>
              </div>
              {telecom.periodFrom && telecom.periodTo && (
                <div>
                  <dt>Bill period</dt>
                  <dd>
                    {formatDate(telecom.periodFrom)} to {formatDate(telecom.periodTo)}
                  </dd>
                </div>
              )}
              {telecom.includes.map((x) => (
                <div key={x}>
                  <dt>Includes</dt>
                  <dd>{x}</dd>
                </div>
              ))}
              {telecom.addOns.map((a) => (
                <div key={a.label}>
                  <dt>{a.label}</dt>
                  <dd>{rupees(a.amountInr)} a month</dd>
                </div>
              ))}
              {telecom.dataUsedGb !== null && telecom.planDataGb !== null && (
                <div>
                  <dt>Data used</dt>
                  <dd>
                    {telecom.dataUsedGb} GB of {telecom.planDataGb} GB
                  </dd>
                </div>
              )}
            </dl>
            {added === 'telecom' ? (
              <Notice>Added. It will show on Home with its due date.</Notice>
            ) : (
              <button
                type="button"
                className="btn btn-primary press jelly align-start"
                disabled={!telecom.dueDate}
                onClick={addTelecom}
              >
                Add this bill
              </button>
            )}
          </section>
        )}
        {upi && (
          <section
            className="panel2 stack-16"
            aria-labelledby="sv-upi-h"
            data-testid="sv-upi-summary"
          >
            <h2 id="sv-upi-h">{upi.app} statement</h2>
            <dl className="sv-summary">
              {upi.periodFrom && upi.periodTo && (
                <div>
                  <dt>Period</dt>
                  <dd>
                    {formatDate(upi.periodFrom)} to {formatDate(upi.periodTo)}
                  </dd>
                </div>
              )}
              <div>
                <dt>UPI payments on credit cards</dt>
                <dd>{upiCard > 0 ? rupees(upiCard) : 'None found'}</dd>
              </div>
              <div>
                <dt>Repeat payments found</dt>
                <dd>{(upi.recurring ?? []).length}</dd>
              </div>
            </dl>
            {added === 'upi' ? (
              <Notice>Saved. Savings now uses these payments.</Notice>
            ) : (
              <button
                type="button"
                className="btn btn-secondary press jelly align-start"
                onClick={useUpi}
              >
                Use this statement for Savings
              </button>
            )}
          </section>
        )}
        {loan && gold && (
          <section
            className="panel2 stack-16"
            aria-labelledby="sv-gold-h"
            data-testid="sv-gold-summary"
          >
            <h2 id="sv-gold-h">{loan.lender ?? 'Bank'} gold loan (overdraft)</h2>
            <dl className="sv-summary">
              <div>
                <dt>Limit</dt>
                <dd>{money(loan.limitInr ?? null)}</dd>
              </div>
              <div>
                <dt>Outstanding</dt>
                <dd>{money(loan.outstandingInr ?? null)}</dd>
              </div>
              <div>
                <dt>Interest rate</dt>
                <dd>
                  {loan.annualRatePct !== null ? `${loan.annualRatePct}% a year` : 'Not shown'}
                </dd>
              </div>
              <div>
                <dt>Latest monthly interest</dt>
                <dd>{money((loan.monthlyInterest ?? []).slice(-1)[0]?.amountInr ?? null)}</dd>
              </div>
              {(loan.irregularityCount ?? 0) > 0 && (
                <div>
                  <dt>Irregular or SMA recoveries</dt>
                  <dd>{loan.irregularityCount}</dd>
                </div>
              )}
            </dl>
            {added === 'loan' ? (
              <Notice>Added. It will show on Home at each month end.</Notice>
            ) : (
              <button
                type="button"
                className="btn btn-primary press jelly align-start"
                onClick={addLoan}
              >
                Add this loan
              </button>
            )}
          </section>
        )}
        {loan && !gold && (
          <section
            className="panel2 stack-16"
            aria-labelledby="sv-loan-h"
            data-testid="sv-loan-summary"
          >
            <h2 id="sv-loan-h">
              {[loan.lender, loan.product?.toLowerCase()].filter(Boolean).join(' ') || 'Loan'}
            </h2>
            <dl className="sv-summary">
              <div>
                <dt>EMI</dt>
                <dd>{money(loan.emiInr)}</dd>
              </div>
              <div>
                <dt>EMI date</dt>
                <dd>{loan.emiDueDay ? `Day ${loan.emiDueDay} of each month` : 'Not shown'}</dd>
              </div>
              <div>
                <dt>Interest rate</dt>
                <dd>
                  {loan.annualRatePct !== null ? `${loan.annualRatePct}% a year` : 'Not shown'}
                  {loan.rateType ? ` (${loan.rateType})` : ''}
                </dd>
              </div>
              {loan.balanceTenureMonths !== null && (
                <div>
                  <dt>Months left</dt>
                  <dd>{loan.balanceTenureMonths}</dd>
                </div>
              )}
              {loan.bounceCount > 0 && (
                <div>
                  <dt>Bounced EMIs</dt>
                  <dd>
                    {loan.bounceCount} ({rupees(loan.bounceChargesInr)} in bounce charges)
                  </dd>
                </div>
              )}
            </dl>
            {added === 'loan' ? (
              <Notice>Added. It will show on Home with its EMI date.</Notice>
            ) : (
              <button
                type="button"
                className="btn btn-primary press jelly align-start"
                disabled={loan.emiInr === null}
                onClick={addLoan}
              >
                Add this loan&apos;s EMI
              </button>
            )}
          </section>
        )}
        {found && found.length === 0 && !msg && !card && !upi && (
          <Notice>
            Read {lineCount} payment line{lineCount === 1 ? '' : 's'} but found nothing that
            repeats. A longer statement (two or three months) helps.
          </Notice>
        )}
        {found && found.length > 0 && (
          <section className="stack-16" aria-labelledby="sv-found-h">
            <h2 id="sv-found-h">
              {found.length} repeat payment{found.length === 1 ? '' : 's'} found
            </h2>
            <ul className="sv-cands">
              {found.map((c) => (
                <li key={c.key} className="sv-cand">
                  <label className="switch-row">
                    <input
                      type="checkbox"
                      checked={!!picked[c.key]}
                      onChange={(e) => setPicked((p) => ({ ...p, [c.key]: e.target.checked }))}
                    />
                    <span className="sv-cand-text">
                      <strong>{c.label}</strong>
                      <span className="muted small">
                        {rupees(c.averageInr)} · {CADENCE_TEXT[c.cadence]} · {RAIL_TEXT[c.rail]} ·
                        seen {c.occurrences} times · next around {formatDate(c.nextExpected)}
                      </span>
                    </span>
                  </label>
                  <div className="sv-cand-meta">
                    <Badge tone={CONFIDENCE_TONE[c.confidence]}>
                      {CONFIDENCE_LABEL[c.confidence]}
                    </Badge>
                    <label className="sr-only" htmlFor={`sv-type-${c.key}`}>
                      Type for {c.label}
                    </label>
                    <select
                      id={`sv-type-${c.key}`}
                      value={types[c.key] ?? 'subscription'}
                      onChange={(e) =>
                        setTypes((t) => ({ ...t, [c.key]: e.target.value as CommitmentType }))
                      }
                    >
                      {TYPE_CHOICES.map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn btn-primary press jelly align-start"
              disabled={!chosen.length}
              onClick={add}
            >
              Add {chosen.length} selected
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
