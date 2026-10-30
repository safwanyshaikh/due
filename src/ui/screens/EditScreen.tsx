import { useState, type FormEvent } from 'react';
import { editAmount, editNextDate, editSchedule, updateObligation } from '../../lib/mutations';
import { findObligation } from '../../lib/obligations';
import { obligationView, RAIL_LABELS } from '../../lib/home';
import { paiseToRupeeString, parseRupees } from '../../lib/money';
import { describeRule } from '../../lib/recurrence';
import { isValidISO } from '../../lib/dates';
import { TYPE_SINGULAR, TYPES } from '../../lib/status';
import { track } from '../../lib/telemetry';
import type {
  Commitment,
  CommitmentType,
  Importance,
  Rail,
  ValueConfidence,
} from '../../lib/types';
import { useApp } from '../store';
import { useAccount } from '../account/AccountContext';
import { RuleEditor, evaluateDraft } from '../components/RuleEditor';
import { Field, Notice, Panel } from '../components/ui';
import { draftFromRule } from '../lib/ruleDraft';
import { AMOUNT_CONFIDENCE_CHOICES } from './AddScreen';

export function EditScreen({ id }: { id: string }) {
  const { data } = useApp();
  const ob = findObligation(data, id);
  if (!ob)
    return (
      <div className="page2">
        <h1>Item not found</h1>
        <p className="muted">It may have been deleted or merged.</p>
        <a className="btn btn-secondary press" href="#/">
          Back to Home
        </a>
      </div>
    );
  return <EditForms key={ob.id} ob={ob} />;
}

function EditForms({ ob }: { ob: Commitment }) {
  const { data, today, mutate, ctx } = useApp();
  const { entitlement } = useAccount();
  const v = obligationView(data, ob, today, data.settings.timezone);
  const name = ob.nickname || ob.provider;

  // Next date (one occurrence only)
  const [date, setDate] = useState(v.date ?? today);
  const [reason, setReason] = useState('');
  const saveDate = (e: FormEvent) => {
    e.preventDefault();
    const r = mutate((d) =>
      editNextDate(d, ob.id, date, ctx(), {
        occurrenceDate: v.occurrenceDate ?? undefined,
        reason: reason.trim() || undefined,
      }),
    );
    if (r) track('correction_made', { field: 'date', scope: 'next' });
  };

  // Amount
  const [amount, setAmount] = useState(paiseToRupeeString(v.amountPaise));
  const [aconf, setAconf] = useState<ValueConfidence>('user_entered');
  const [scope, setScope] = useState<'next' | 'all'>('all');
  const [amountErr, setAmountErr] = useState('');
  const saveAmount = (e: FormEvent) => {
    e.preventDefault();
    const paise = amount.trim() ? parseRupees(amount) : null;
    if (amount.trim() && paise === null) {
      setAmountErr('Enter the amount in rupees, like 649 or 1,950.50.');
      return;
    }
    setAmountErr('');
    const r = mutate((d) =>
      editAmount(d, ob.id, paise, ctx(), {
        scope,
        confidence: aconf,
        occurrenceDate: scope === 'next' ? (v.occurrenceDate ?? undefined) : undefined,
      }),
    );
    if (r) track('correction_made', { field: 'amount', scope });
  };

  // Schedule
  const [draft, setDraft] = useState(() => draftFromRule(ob.rule, v.date ?? today));
  const ev = evaluateDraft(draft, entitlement);
  const saveSchedule = (e: FormEvent) => {
    e.preventDefault();
    if (!ev.rule || ev.errors.length || !ev.allowed) return;
    const r = mutate((d) => editSchedule(d, ob.id, ev.rule!, ctx()));
    if (r) track('correction_made', { field: 'schedule', scope: 'all' });
  };

  // Details
  const [nickname, setNickname] = useState(ob.nickname);
  const [provider, setProvider] = useState(ob.provider);
  const [owner, setOwner] = useState(ob.ownerLabel);
  const [rail, setRail] = useState<Rail>(ob.rail);
  const [importance, setImportance] = useState<Importance>(ob.importance);
  const [type, setType] = useState<CommitmentType>(ob.type);
  const saveDetails = (e: FormEvent) => {
    e.preventDefault();
    mutate((d) =>
      updateObligation(
        d,
        ob.id,
        {
          nickname: nickname.trim(),
          provider: provider.trim() || ob.provider,
          ownerLabel: owner.trim(),
          rail,
          importance,
          type,
        },
        ctx(),
      ),
    );
  };

  return (
    <div className="page2">
      <header className="page-head">
        <h1>Edit {name}</h1>
        <p className="muted">
          Each part saves on its own and can be undone. Past payments and history are never
          rewritten.
        </p>
        <a className="text-btn press" href={`#/item/${encodeURIComponent(ob.id)}`}>
          ‹ Back to {name}
        </a>
      </header>

      <Panel title="Next date" id="ed-date">
        <form className="stack-16" onSubmit={saveDate}>
          <p className="muted small">
            Currently {v.dateText} ({v.dateConfidenceText.toLowerCase()}). Only this one occurrence
            moves; the schedule “{v.ruleText}” stays the same.
          </p>
          <div className="inline-row">
            <Field label="New date" htmlFor="ed-date-in">
              <input
                id="ed-date-in"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label="Reason (optional)" htmlFor="ed-reason">
              <input
                id="ed-reason"
                placeholder="e.g. bank holiday"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
          </div>
          <button
            type="submit"
            className="btn btn-primary press"
            disabled={!isValidISO(date) || !v.occurrenceDate}
          >
            Move next date
          </button>
          {!v.occurrenceDate && (
            <p className="muted small">There’s no upcoming date to move. Set a schedule below.</p>
          )}
        </form>
      </Panel>

      <Panel title="Amount" id="ed-amount">
        <form className="stack-16" onSubmit={saveAmount}>
          <p className="muted small">
            Currently {v.amountText}
            {v.amountPaise !== null ? ` (${v.amountConfidenceText.toLowerCase()})` : ''}.
          </p>
          {amountErr && <Notice tone="warn">{amountErr}</Notice>}
          <div className="inline-row">
            <Field label="Amount (₹)" htmlFor="ed-amt">
              <input
                id="ed-amt"
                inputMode="decimal"
                placeholder="Not known yet"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="How sure?" htmlFor="ed-aconf">
              <select
                id="ed-aconf"
                value={aconf}
                onChange={(e) => setAconf(e.target.value as ValueConfidence)}
              >
                {AMOUNT_CONFIDENCE_CHOICES.map(([c, l]) => (
                  <option key={c} value={c}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="seg2" role="radiogroup" aria-label="Which payments">
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'all'}
              className="press"
              onClick={() => setScope('all')}
            >
              This and future payments
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={scope === 'next'}
              className="press"
              onClick={() => setScope('next')}
              disabled={!v.occurrenceDate}
            >
              Only the next one
            </button>
          </div>
          <button type="submit" className="btn btn-primary press">
            Save amount
          </button>
        </form>
      </Panel>

      <Panel title="Schedule" id="ed-rule">
        <form className="stack-16" onSubmit={saveSchedule}>
          <p className="muted small">
            Now: {describeRule(ob.rule)}. Changing it affects future dates only.
          </p>
          <RuleEditor
            draft={draft}
            onChange={setDraft}
            today={today}
            entitlement={entitlement}
            dateLabel="First date of the new schedule"
          />
          <button
            type="submit"
            className="btn btn-primary press"
            disabled={!ev.rule || ev.errors.length > 0 || !ev.allowed}
          >
            Save schedule
          </button>
        </form>
      </Panel>

      <Panel title="Details" id="ed-details">
        <form className="stack-16" onSubmit={saveDetails}>
          <Field label="Nickname" htmlFor="ed-nick">
            <input id="ed-nick" value={nickname} onChange={(e) => setNickname(e.target.value)} />
          </Field>
          <Field label="Provider" htmlFor="ed-prov">
            <input id="ed-prov" value={provider} onChange={(e) => setProvider(e.target.value)} />
          </Field>
          <div className="inline-row">
            <Field label="Type" htmlFor="ed-type">
              <select
                id="ed-type"
                value={type}
                onChange={(e) => setType(e.target.value as CommitmentType)}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_SINGULAR[t]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Owner" htmlFor="ed-owner">
              <input
                id="ed-owner"
                placeholder="You"
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
              />
            </Field>
          </div>
          <div className="inline-row">
            <Field label="Payment method" htmlFor="ed-rail">
              <select id="ed-rail" value={rail} onChange={(e) => setRail(e.target.value as Rail)}>
                {(Object.keys(RAIL_LABELS) as Rail[]).map((r) => (
                  <option key={r} value={r}>
                    {RAIL_LABELS[r]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Essential or optional" htmlFor="ed-imp">
              <select
                id="ed-imp"
                value={importance}
                onChange={(e) => setImportance(e.target.value as Importance)}
              >
                <option value="essential">Essential</option>
                <option value="important">Important</option>
                <option value="optional">Optional</option>
              </select>
            </Field>
          </div>
          <button type="submit" className="btn btn-primary press">
            Save details
          </button>
        </form>
        <a className="btn btn-quiet press" href={`#/details/${encodeURIComponent(ob.id)}`}>
          Loan terms, card statement links, billing-email label
        </a>
      </Panel>
    </div>
  );
}
