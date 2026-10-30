import { useMemo, useState, type ReactNode } from 'react';
import { useApp } from './store';
import { ConfirmButton } from './components/ui';
import { deleteObligation } from '../lib/mutations';
import { Card, inr } from './common';
import type { Nav } from './App';
import type {
  Commitment,
  CommitmentType,
  Confidence,
  Frequency,
  Importance,
  Rail,
  Status,
} from '../lib/types';
import {
  blankCommitment,
  setStatementLink,
  setStatus,
  upsertCommitment,
  newId,
  upsertLabel,
} from '../lib/data';
import { paiseToRupeeString, parseRupees } from '../lib/money';
import { STATUS_LABELS, STATUS_NOTE, TYPES, TYPE_SINGULAR } from '../lib/status';
import { validateCommitment } from '../lib/validate';
import { findDuplicates, suggestStatementLinks } from '../lib/duplicates';
import { roughRemainingLoanPaise, runRateFormula } from '../lib/schedule';
import { isValidISO } from '../lib/dates';
import { LABEL_NOTE } from '../content/privacy';
import { DEFAULT_OFFSETS } from '../lib/reminders';

const FREQ: [Frequency, string][] = [
  ['one_time', 'One time'],
  ['monthly', 'Monthly'],
  ['quarterly', 'Every 3 months'],
  ['half_yearly', 'Every 6 months'],
  ['annual', 'Yearly'],
  ['custom_months', 'Custom (every N months)'],
];
const RAILS: [Rail, string][] = [
  ['unknown', 'Not sure'],
  ['upi_autopay', 'UPI AutoPay'],
  ['credit_card', 'Credit card'],
  ['debit_card', 'Debit card'],
  ['bank_mandate', 'Bank mandate / NACH'],
  ['manual', 'I pay it myself'],
  ['other', 'Other'],
];
const CONF: [Confidence, string][] = [
  ['estimate', 'Estimate'],
  ['confirmed', 'Confirmed by me'],
  ['unknown', 'Not sure'],
];
const IMP: [Importance, string][] = [
  ['essential', 'Essential'],
  ['important', 'Important'],
  ['optional', 'Optional'],
];

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

export function CommitmentForm({
  type: newType,
  editId,
  nav,
}: {
  type?: CommitmentType;
  editId?: string;
  nav: Nav;
}) {
  const { data, today, update, mutate, ctx } = useApp();
  const existing = editId ? data.commitments.find((c) => c.id === editId) : undefined;
  const [c, setC] = useState<Commitment>(
    () => existing ?? blankCommitment(newType ?? 'subscription', today),
  );
  const [amount, setAmount] = useState(paiseToRupeeString(c.amountPaise));
  const [principal, setPrincipal] = useState(paiseToRupeeString(c.loan?.principalPaise ?? null));
  const [offsetsText, setOffsetsText] = useState(c.reminder.offsets.join(', '));
  const [parent, setParent] = useState<string>(
    () => data.links.find((l) => l.componentId === c.id)?.parentId ?? '',
  );
  const [newLabel, setNewLabel] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [dupAck, setDupAck] = useState(false);

  const set = <K extends keyof Commitment>(k: K, v: Commitment[K]) =>
    setC((p) => ({ ...p, [k]: v }));
  const cards = data.commitments.filter((x) => x.type === 'credit_card' && x.id !== c.id);
  const amountPaise = amount.trim() === '' ? null : parseRupees(amount);

  const draft = useMemo<Commitment>(
    () => ({
      ...c,
      amountPaise,
      loan: c.loan
        ? { ...c.loan, principalPaise: principal.trim() === '' ? null : parseRupees(principal) }
        : undefined,
    }),
    [c, amountPaise, principal],
  );
  const dups = findDuplicates(draft, data.commitments);
  const linkSuggestions = suggestStatementLinks(draft, data.commitments).filter(
    (x) => x.id !== parent,
  );
  const isLoan = c.type === 'emi' || c.type === 'other_loan';

  function save() {
    const offsets = offsetsText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number);
    const out: Commitment = {
      ...draft,
      reminder: { ...draft.reminder, offsets: offsets.length ? offsets : DEFAULT_OFFSETS },
      frequency: draft.type === 'credit_card' ? 'one_time' : draft.frequency,
      lastConfirmed: draft.lastConfirmed || (draft.dueConfidence === 'confirmed' ? today : null),
    };
    const errs = validateCommitment(out);
    if (amount.trim() !== '' && amountPaise === null)
      errs.push('Amount should be a rupee value like 499 or 1,250.50.');
    if (isLoan && principal.trim() !== '' && out.loan?.principalPaise === null)
      errs.push('Original amount should be a rupee value.');
    if (dups.length && !dupAck)
      errs.push(
        'This looks like something you already added. Tick the box below if it is a separate item.',
      );
    setErrors(errs);
    if (errs.length) return;
    update((d) => setStatementLink(upsertCommitment(d, out), out.id, parent || null));
    nav.back();
  }

  return (
    <div className="page">
      <h1>
        {existing ? 'Edit' : 'Add'} {TYPE_SINGULAR[c.type].toLowerCase()}
      </h1>

      <Card title="Basics">
        <Field label="Type">
          <select
            value={c.type}
            disabled={!!existing}
            onChange={(e) => setC(blankCommitment(e.target.value as CommitmentType, today))}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_SINGULAR[t]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label={
            c.type === 'school_fee' ? 'Label (generic, e.g. “School fees”)' : 'Provider / creditor'
          }
          hint={
            c.type === 'school_fee'
              ? 'Please do not enter a child’s name, birthdate, student ID or school login.'
              : undefined
          }
        >
          <input value={c.provider} onChange={(e) => set('provider', e.target.value)} />
        </Field>
        <Field label="Your nickname for it (optional)">
          <input value={c.nickname} onChange={(e) => set('nickname', e.target.value)} />
        </Field>
        <Field
          label={c.type === 'credit_card' ? 'Statement amount (₹)' : 'Amount (₹)'}
          hint="Leave empty if you don’t know yet. It will show as “amount not entered”, never as zero."
        >
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="How sure are you about the amount?">
          <select
            value={c.amountConfidence}
            onChange={(e) => set('amountConfidence', e.target.value as Confidence)}
          >
            {CONF.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {c.type !== 'credit_card' && (
          <Field label="How often">
            <select
              value={c.frequency}
              onChange={(e) => set('frequency', e.target.value as Frequency)}
            >
              {FREQ.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Field>
        )}
        {c.frequency === 'custom_months' && c.type !== 'credit_card' && (
          <Field label="Every how many months?">
            <input
              type="number"
              min={1}
              value={c.intervalMonths ?? ''}
              onChange={(e) =>
                set('intervalMonths', e.target.value ? Number(e.target.value) : null)
              }
            />
          </Field>
        )}
        <Field label={c.type === 'subscription' ? 'Next renewal date' : 'Next due date'}>
          <input type="date" value={c.nextDue} onChange={(e) => set('nextDue', e.target.value)} />
        </Field>
        <Field label="How sure are you about the date?">
          <select
            value={c.dueConfidence}
            onChange={(e) => set('dueConfidence', e.target.value as Confidence)}
          >
            {CONF.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Last confirmed on (optional)">
          <input
            type="date"
            value={c.lastConfirmed ?? ''}
            onChange={(e) => set('lastConfirmed', e.target.value || null)}
          />
        </Field>
        <Field label="Remaining instalments (optional)" hint="Leave empty if it keeps going.">
          <input
            type="number"
            min={0}
            value={c.remainingOccurrences ?? ''}
            onChange={(e) =>
              set('remainingOccurrences', e.target.value === '' ? null : Number(e.target.value))
            }
          />
        </Field>
      </Card>

      {c.type === 'subscription' && (
        <Card title="Subscription details">
          <Field label="Trial ends (optional)">
            <input
              type="date"
              value={c.subscription?.trialEnd ?? ''}
              onChange={(e) =>
                set('subscription', { ...c.subscription, trialEnd: e.target.value || null })
              }
            />
          </Field>
          <Field
            label="Cancellation-by date (optional)"
            hint="A date you note for yourself. The app never cancels anything."
          >
            <input
              type="date"
              value={c.subscription?.cancellationBy ?? ''}
              onChange={(e) =>
                set('subscription', { ...c.subscription, cancellationBy: e.target.value || null })
              }
            />
          </Field>
          <Field label="Provider help link (optional)">
            <input
              type="url"
              placeholder="https://"
              value={c.subscription?.helpUrl ?? ''}
              onChange={(e) => set('subscription', { ...c.subscription, helpUrl: e.target.value })}
            />
          </Field>
          <Field label="Billing-email label" hint={LABEL_NOTE}>
            <select
              value={c.billingEmailLabelId ?? ''}
              onChange={(e) => set('billingEmailLabelId', e.target.value || null)}
            >
              <option value="">None</option>
              {data.labels.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.displayName || l.label}
                </option>
              ))}
            </select>
          </Field>
          <div className="inline">
            <input
              placeholder="Add a label, e.g. home@example.com"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              aria-label="New billing-email label"
            />
            <button
              type="button"
              onClick={() => {
                if (!newLabel.trim()) return;
                const id = newId('lbl');
                update((d) => upsertLabel(d, { id, label: newLabel.trim() }));
                set('billingEmailLabelId', id);
                setNewLabel('');
              }}
            >
              Add label
            </button>
          </div>
        </Card>
      )}

      {isLoan && (
        <Card title="Loan details (what you tell us)">
          <Field label="Lender nickname">
            <input
              value={c.loan?.lenderNickname ?? ''}
              onChange={(e) => set('loan', { ...c.loan, lenderNickname: e.target.value })}
            />
          </Field>
          <Field label="Loan type (e.g. home, personal, vehicle)">
            <input
              value={c.loan?.loanType ?? ''}
              onChange={(e) => set('loan', { ...c.loan, loanType: e.target.value })}
            />
          </Field>
          <Field label="Original amount (₹, optional)">
            <input
              inputMode="decimal"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value)}
            />
          </Field>
          <Field label="Interest rate % (optional)" hint="Entered by you, not verified.">
            <input
              type="number"
              step="0.01"
              value={c.loan?.interestRatePct ?? ''}
              onChange={(e) =>
                set('loan', {
                  ...c.loan,
                  interestRatePct: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </Field>
          <Field label="Fixed or variable (optional)">
            <select
              value={c.loan?.rateType ?? ''}
              onChange={(e) =>
                set('loan', {
                  ...c.loan,
                  rateType: (e.target.value || null) as 'fixed' | 'variable' | null,
                })
              }
            >
              <option value="">Not sure</option>
              <option value="fixed">Fixed</option>
              <option value="variable">Variable</option>
            </select>
          </Field>
          <Field label="Original tenure (months, optional)">
            <input
              type="number"
              min={1}
              value={c.loan?.originalTenureMonths ?? ''}
              onChange={(e) =>
                set('loan', {
                  ...c.loan,
                  originalTenureMonths: e.target.value === '' ? null : Number(e.target.value),
                })
              }
            />
          </Field>
          {roughRemainingLoanPaise(draft) !== null && (
            <p className="muted">
              Rough remaining: {inr(roughRemainingLoanPaise(draft)!)} (EMI × remaining instalments,
              from your numbers. It excludes rate changes, fees, penalties and lender adjustments.
              Not a payoff figure.)
            </p>
          )}
        </Card>
      )}

      {c.type === 'credit_card' && (
        <Card title="Statement details">
          <Field label="Card nickname only (never the card number)">
            <input
              value={c.statement?.cardNickname ?? ''}
              onChange={(e) => set('statement', { ...c.statement!, cardNickname: e.target.value })}
            />
          </Field>
          <Field label="Statement period start">
            <input
              type="date"
              value={c.statement?.periodStart ?? ''}
              onChange={(e) =>
                set('statement', { ...c.statement!, periodStart: e.target.value || null })
              }
            />
          </Field>
          <Field label="Statement period end">
            <input
              type="date"
              value={c.statement?.periodEnd ?? ''}
              onChange={(e) =>
                set('statement', { ...c.statement!, periodEnd: e.target.value || null })
              }
            />
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={!!c.statement?.confirmedFromLatest}
              onChange={(e) =>
                set('statement', { ...c.statement!, confirmedFromLatest: e.target.checked })
              }
            />{' '}
            I confirmed this amount from my latest statement
          </label>
        </Card>
      )}

      <Card title="How it’s paid and who owns it">
        <Field label="Payment source">
          <select value={c.rail} onChange={(e) => set('rail', e.target.value as Rail)}>
            {RAILS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Account or card nickname (optional)">
          <input
            value={c.accountNickname}
            onChange={(e) => set('accountNickname', e.target.value)}
          />
        </Field>
        <Field label="Whose is it? (household label, optional)">
          <input value={c.ownerLabel} onChange={(e) => set('ownerLabel', e.target.value)} />
        </Field>
        <Field
          label="How important is it to you?"
          hint="Only optional subscriptions are ever offered a review prompt."
        >
          <select
            value={c.importance}
            onChange={(e) => set('importance', e.target.value as Importance)}
          >
            {IMP.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {c.type !== 'credit_card' && (
          <Field
            label="Charged to a credit-card statement you’ve added?"
            hint="If yes, it still shows in your breakdown and reminders, but its amount is not added to cash due a second time."
          >
            <select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">No / not sure</option>
              {cards.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.nickname || x.provider}
                </option>
              ))}
            </select>
          </Field>
        )}
        {linkSuggestions.length > 0 && (
          <p className="notice">
            This says it’s paid by credit card. Is it already inside{' '}
            {linkSuggestions.map((x) => x.nickname || x.provider).join(' or ')}? If so, pick it
            above so it isn’t counted twice. (Suggestion only.)
          </p>
        )}
        <Field label="Notes (no card numbers, PINs or passwords)">
          <textarea rows={2} value={c.notes} onChange={(e) => set('notes', e.target.value)} />
        </Field>
      </Card>

      <Card title="Reminders">
        <label className="check">
          <input
            type="checkbox"
            checked={c.reminder.enabled}
            onChange={(e) => set('reminder', { ...c.reminder, enabled: e.target.checked })}
          />{' '}
          Remind me in the app
        </label>
        <Field label="Days before (comma separated)" hint="Default 7, 3, 1.">
          <input value={offsetsText} onChange={(e) => setOffsetsText(e.target.value)} />
        </Field>
        <p className="muted">Runs: {runRateFormula(draft)}</p>
      </Card>

      {existing && (
        <Card title="Status (your own note)">
          <Field label="Status">
            <select value={c.status} onChange={(e) => set('status', e.target.value as Status)}>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <p className="muted">{STATUS_NOTE}</p>
          {c.status === 'pause_planned' && (
            <p className="muted">
              “Pause planned” means you intend to pause. Nothing has been paused with the provider.
            </p>
          )}
          {c.status === 'cancel_pending' && (
            <p className="muted">
              “Cancel requested” is your note. Confirm with the provider before changing it to
              cancelled.
            </p>
          )}
        </Card>
      )}

      {dups.length > 0 && (
        <label className="check notice">
          <input type="checkbox" checked={dupAck} onChange={(e) => setDupAck(e.target.checked)} />{' '}
          Possible duplicate of: {dups.map((d) => d.nickname || d.provider).join(', ')}. This is a
          separate item.
        </label>
      )}
      {errors.length > 0 && (
        <ul className="errors" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="actions">
        <button className="primary" onClick={save}>
          Save
        </button>
        <button onClick={nav.back}>Cancel</button>
        {existing && (
          <>
            <button
              onClick={() => {
                update((d) => setStatus(d, existing.id, 'review_needed'));
                nav.back();
              }}
            >
              Mark “review later”
            </button>
            <ConfirmButton
              label="Delete"
              confirmLabel="Yes, delete it"
              message="Delete this item? You can undo this or restore it from its page."
              onConfirm={() => {
                if (mutate((d) => deleteObligation(d, existing.id, ctx())))
                  nav.go({ name: 'home' });
              }}
            />
          </>
        )}
      </div>
      {!isValidISO(c.nextDue) && <p className="muted">Pick a valid date to continue.</p>}
    </div>
  );
}
