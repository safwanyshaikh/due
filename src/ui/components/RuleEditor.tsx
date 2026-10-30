import { useId } from 'react';
import {
  describeRule,
  isAdvancedRule,
  nextOccurrences,
  RULE_KINDS,
  validateRule,
  type NthWeekday,
  type RecurrenceRule,
  type RuleKind,
  type Weekday,
} from '../../lib/recurrence';
import { canUseRule, type Entitlement } from '../../lib/plans';
import { formatDate } from '../../lib/dates';
import { parseRupees } from '../../lib/money';
import { buildRule, RULE_LABELS, type RuleDraft } from '../lib/ruleDraft';
import { Badge } from './ui';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NTHS: [NthWeekday, string][] = [
  [1, 'First'],
  [2, 'Second'],
  [3, 'Third'],
  [4, 'Fourth'],
  [-1, 'Last'],
];

export interface RuleEvaluation {
  rule: RecurrenceRule | null;
  errors: string[];
  allowed: boolean;
  advanced: boolean;
}

export function evaluateDraft(d: RuleDraft, ent: Entitlement): RuleEvaluation {
  const paid = d.paidAmount.trim() ? parseRupees(d.paidAmount) : null;
  const rule = buildRule(d, paid);
  const errors: string[] = [];
  if (!rule) errors.push('Choose a date.');
  else errors.push(...validateRule(rule));
  if (d.kind === 'trial_to_paid' && d.paidAmount.trim() && paid === null)
    errors.push('Enter the paid amount in rupees, like 199 or 1,950.');
  const advanced = rule ? isAdvancedRule(rule) : false;
  return { rule, errors, advanced, allowed: rule ? canUseRule(ent, rule) : true };
}

/** Edits any recurrence rule with a live plain-language preview (describeRule) and next dates. */
export function RuleEditor({
  draft,
  onChange,
  today,
  entitlement,
  dateLabel = 'Next due date',
}: {
  draft: RuleDraft;
  onChange: (d: RuleDraft) => void;
  today: string;
  entitlement: Entitlement;
  dateLabel?: string;
}) {
  const id = useId();
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => onChange({ ...draft, [k]: v });
  const ev = evaluateDraft(draft, entitlement);
  const upcoming = ev.rule && !ev.errors.length ? nextOccurrences(ev.rule, today, 3) : [];
  const needsStart = draft.kind !== 'trial_to_paid';
  return (
    <fieldset className="rule-editor">
      <legend>Schedule</legend>
      <div className="field2">
        <label htmlFor={`${id}-kind`}>How often</label>
        <select
          id={`${id}-kind`}
          value={draft.kind}
          onChange={(e) => set('kind', e.target.value as RuleKind)}
        >
          {RULE_KINDS.map((k) => (
            <option key={k} value={k}>
              {RULE_LABELS[k]}
              {k === 'weekday' || k === 'custom_months' || k === 'trial_to_paid' ? ' (Plus)' : ''}
            </option>
          ))}
        </select>
      </div>

      {needsStart && (
        <div className="field2">
          <label htmlFor={`${id}-start`}>
            {draft.kind === 'irregular' ? 'Next date, if you know it' : dateLabel}
          </label>
          <input
            id={`${id}-start`}
            type="date"
            value={draft.start}
            onChange={(e) => {
              // The day-of-month follows the chosen date, so the first payment lands on that date.
              const v = e.target.value;
              const m = /^\d{4}-\d{2}-(\d{2})$/.exec(v);
              onChange({ ...draft, start: v, ...(m ? { dayOfMonth: String(Number(m[1])) } : {}) });
            }}
            required={draft.kind !== 'irregular'}
          />
        </div>
      )}

      {draft.kind === 'monthly' && (
        <div className="field2">
          <label htmlFor={`${id}-dom`}>Day of the month</label>
          <input
            id={`${id}-dom`}
            type="number"
            inputMode="numeric"
            min={1}
            max={31}
            value={draft.dayOfMonth}
            onChange={(e) => set('dayOfMonth', e.target.value)}
          />
          <small className="hint">29, 30 or 31 fall on the last day in shorter months.</small>
        </div>
      )}

      {(draft.kind === 'custom_months' || draft.kind === 'end_of_month') && (
        <div className="field2">
          <label htmlFor={`${id}-int`}>Every how many months?</label>
          <input
            id={`${id}-int`}
            type="number"
            inputMode="numeric"
            min={1}
            max={60}
            value={draft.intervalMonths}
            onChange={(e) => set('intervalMonths', e.target.value)}
          />
        </div>
      )}

      {draft.kind === 'weekday' && (
        <>
          <div className="seg2" role="radiogroup" aria-label="Weekday pattern">
            <button
              type="button"
              role="radio"
              aria-checked={draft.weekMode === 'nth'}
              className="press"
              onClick={() => set('weekMode', 'nth')}
            >
              A week of the month
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={draft.weekMode === 'every'}
              className="press"
              onClick={() => set('weekMode', 'every')}
            >
              Every few weeks
            </button>
          </div>
          <div className="inline-row">
            {draft.weekMode === 'nth' ? (
              <div className="field2">
                <label htmlFor={`${id}-nth`}>Which</label>
                <select
                  id={`${id}-nth`}
                  value={draft.nth}
                  onChange={(e) => set('nth', Number(e.target.value) as NthWeekday)}
                >
                  {NTHS.map(([n, l]) => (
                    <option key={n} value={n}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field2">
                <label htmlFor={`${id}-wk`}>Every how many weeks?</label>
                <input
                  id={`${id}-wk`}
                  type="number"
                  min={1}
                  max={52}
                  value={draft.everyWeeks}
                  onChange={(e) => set('everyWeeks', e.target.value)}
                />
              </div>
            )}
            <div className="field2">
              <label htmlFor={`${id}-wd`}>Weekday</label>
              <select
                id={`${id}-wd`}
                value={draft.weekday}
                onChange={(e) => set('weekday', Number(e.target.value) as Weekday)}
              >
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i}>
                    {w}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </>
      )}

      {draft.kind === 'trial_to_paid' && (
        <>
          <div className="field2">
            <label htmlFor={`${id}-trial`}>Trial ends on</label>
            <input
              id={`${id}-trial`}
              type="date"
              value={draft.trialEnd}
              onChange={(e) => set('trialEnd', e.target.value)}
            />
          </div>
          <div className="inline-row">
            <div className="field2">
              <label htmlFor={`${id}-paid`}>Then it costs (₹)</label>
              <input
                id={`${id}-paid`}
                inputMode="decimal"
                placeholder="Not known yet"
                value={draft.paidAmount}
                onChange={(e) => set('paidAmount', e.target.value)}
              />
            </div>
            <div className="field2">
              <label htmlFor={`${id}-pk`}>Every</label>
              <select
                id={`${id}-pk`}
                value={draft.paidKind}
                onChange={(e) => set('paidKind', e.target.value as RuleDraft['paidKind'])}
              >
                <option value="monthly">Month</option>
                <option value="quarterly">3 months</option>
                <option value="annual">Year</option>
              </select>
            </div>
          </div>
        </>
      )}

      {[
        'monthly',
        'quarterly',
        'half_yearly',
        'annual',
        'end_of_month',
        'weekday',
        'custom_months',
      ].includes(draft.kind) && (
        <div className="field2">
          <label htmlFor={`${id}-count`}>Ends after how many payments? (optional)</label>
          <input
            id={`${id}-count`}
            type="number"
            min={1}
            placeholder="Keeps going"
            value={draft.count}
            onChange={(e) => set('count', e.target.value)}
          />
        </div>
      )}

      <div className="rule-preview" aria-live="polite">
        {ev.rule && !ev.errors.length ? (
          <>
            <p>
              <strong>{describeRule(ev.rule)}</strong>
            </p>
            {upcoming.length > 0 && (
              <p className="muted small">
                Next: {upcoming.map((o) => formatDate(o.date)).join(' · ')}
              </p>
            )}
            {ev.rule.kind === 'irregular' && (
              <p className="muted small">
                Due won’t invent dates for this. Add each one as you learn it.
              </p>
            )}
          </>
        ) : (
          <ul className="errors2">
            {ev.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {ev.advanced && (
          <p className="small">
            <Badge tone="premium">Plus</Badge>{' '}
            {ev.allowed
              ? 'Advanced schedule, included in your plan.'
              : 'Weekday, trial-to-paid and custom-month schedules are part of Plus because they need more checking and reminders. Your current plan is Free, so this can be previewed but not saved. A monthly or “no fixed schedule” rule works on Free.'}
            {!ev.allowed && (
              <>
                {' '}
                <a href="#/plans">See plans</a>
              </>
            )}
          </p>
        )}
      </div>
    </fieldset>
  );
}
