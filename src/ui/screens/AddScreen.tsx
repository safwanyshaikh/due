import { useState, type FormEvent } from 'react';
import { createObligation } from '../../lib/mutations';
import { activeObligations } from '../../lib/obligations';
import { RAIL_LABELS } from '../../lib/home';
import { parseRupees } from '../../lib/money';
import { addDays } from '../../lib/dates';
import { looksSensitive } from '../../lib/sensitive';
import { TYPE_SINGULAR, TYPES } from '../../lib/status';
import { track } from '../../lib/telemetry';
import type { CommitmentType, Importance, Rail, ValueConfidence } from '../../lib/types';
import { useApp } from '../store';
import { useAccount } from '../account/AccountContext';
import { RuleEditor, evaluateDraft } from '../components/RuleEditor';
import { Field, Notice } from '../components/ui';
import { OfferMatches } from '../components/OfferMatches';
import { defaultDraft, type RuleDraft } from '../lib/ruleDraft';
import { nav } from '../lib/nav';

export const AMOUNT_CONFIDENCE_CHOICES: [ValueConfidence, string][] = [
  ['user_entered', 'Entered by me'],
  ['confirmed', 'Confirmed from a bill or statement'],
  ['estimated', 'An estimate'],
];

export function AddScreen({ type: initialType }: { type?: CommitmentType }) {
  const { mutate, ctx, today, data } = useApp();
  const { entitlement } = useAccount();
  const [type, setType] = useState<CommitmentType>(initialType ?? 'subscription');
  const [provider, setProvider] = useState('');
  const [nickname, setNickname] = useState('');
  const [amount, setAmount] = useState('');
  const [amountConf, setAmountConf] = useState<ValueConfidence>('user_entered');
  const [dateConf, setDateConf] = useState<ValueConfidence>('user_entered');
  const [owner, setOwner] = useState('');
  const [rail, setRail] = useState<Rail>('unknown');
  const [importance, setImportance] = useState<Importance>('essential');
  const [draft, setDraft] = useState<RuleDraft>(() => defaultDraft(addDays(today, 7)));
  const [errors, setErrors] = useState<string[]>([]);
  const members = data.settings.householdMembers ?? [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: string[] = [];
    const amountPaise = amount.trim() ? parseRupees(amount) : null;
    if (!provider.trim())
      errs.push('Enter who this is with, for example “Netflix” or “HDFC home loan”.');
    if (amount.trim() && amountPaise === null)
      errs.push('Enter the amount in rupees, like 649 or 1,950.50.');
    const sensitive = looksSensitive(`${provider} ${nickname}`);
    if (sensitive) errs.push(sensitive);
    const ev = evaluateDraft(draft, entitlement);
    errs.push(...ev.errors);
    if (ev.rule && !ev.allowed)
      errs.push('This schedule needs Plus. Choose another schedule or see plans.');
    setErrors(errs);
    if (errs.length || !ev.rule) return;
    const first = activeObligations(data).length === 0;
    const r = mutate((d) =>
      createObligation(
        d,
        {
          type,
          provider: provider.trim(),
          nickname: nickname.trim() || undefined,
          amountPaise,
          rule: ev.rule!,
          amountConfidence: amountConf,
          dateConfidence: dateConf,
          ownerLabel: owner,
          rail,
          importance,
        },
        ctx(),
      ),
    );
    if (r) {
      if (first) track('first_obligation_completed', { ruleKind: ev.rule.kind, source: 'manual' });
      nav.go({ name: 'home' });
    }
  };

  return (
    <form className="page2 form2" onSubmit={submit} noValidate>
      <header className="page-head">
        <h1>Add a due item</h1>
        <p className="muted">
          Only the name and date are needed. You can leave the amount empty if you don’t know it yet
          — it won’t be counted as zero.
        </p>
      </header>

      {errors.length > 0 && (
        <Notice tone="warn" title="Please check">
          <ul className="errors2">
            {errors.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className="field2">
        <span className="label-like" id="type-label">
          Type
        </span>
        <div className="chip-group" role="radiogroup" aria-labelledby="type-label">
          {TYPES.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={type === t}
              className="chip-btn press"
              onClick={() => {
                setType(t);
                setImportance(t === 'subscription' ? 'optional' : 'essential');
              }}
            >
              {TYPE_SINGULAR[t]}
            </button>
          ))}
        </div>
      </div>

      <Field
        label="Who is it with?"
        htmlFor="add-provider"
        hint="Provider, lender, school or biller. Don’t include account numbers."
      >
        <input
          id="add-provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          autoComplete="off"
          required
        />
      </Field>
      <Field label="Nickname (optional)" htmlFor="add-nick">
        <input id="add-nick" value={nickname} onChange={(e) => setNickname(e.target.value)} />
      </Field>

      <div className="inline-row">
        <Field label="Amount (₹)" htmlFor="add-amount">
          <input
            id="add-amount"
            inputMode="decimal"
            placeholder="Not known yet"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="How sure is the amount?" htmlFor="add-aconf">
          <select
            id="add-aconf"
            value={amountConf}
            onChange={(e) => setAmountConf(e.target.value as ValueConfidence)}
          >
            {AMOUNT_CONFIDENCE_CHOICES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <RuleEditor draft={draft} onChange={setDraft} today={today} entitlement={entitlement} />

      <Field label="How sure is the date?" htmlFor="add-dconf">
        <select
          id="add-dconf"
          value={dateConf}
          onChange={(e) => setDateConf(e.target.value as ValueConfidence)}
        >
          {AMOUNT_CONFIDENCE_CHOICES.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Field>

      <details className="more">
        <summary className="press">More (owner, payment method, importance)</summary>
        <div className="stack-16">
          <Field label="Whose is it?" htmlFor="add-owner">
            <input
              id="add-owner"
              list="owner-list"
              placeholder="You"
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
            />
            <datalist id="owner-list">
              {members.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
          <Field label="How is it paid?" htmlFor="add-rail">
            <select id="add-rail" value={rail} onChange={(e) => setRail(e.target.value as Rail)}>
              {(Object.keys(RAIL_LABELS) as Rail[]).map((r) => (
                <option key={r} value={r}>
                  {RAIL_LABELS[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Essential or optional?" htmlFor="add-imp">
            <select
              id="add-imp"
              value={importance}
              onChange={(e) => setImportance(e.target.value as Importance)}
            >
              <option value="essential">Essential</option>
              <option value="important">Important</option>
              <option value="optional">Optional</option>
            </select>
          </Field>
        </div>
      </details>

      <OfferMatches
        provider={provider}
        type={type}
        amountPaise={amount.trim() ? parseRupees(amount) : null}
      />

      <div className="btn-row sticky-actions">
        <button type="submit" className="btn btn-primary press jelly">
          Save due item
        </button>
        <a className="btn btn-quiet press" href="#/">
          Cancel
        </a>
      </div>
      <p className="muted small">Saved on this device. Nothing is paid from here.</p>
    </form>
  );
}
