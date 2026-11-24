import { useState, type ChangeEvent } from 'react';
import type { RecurringCandidate, StatementLine } from '../../lib/savings/types';
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
import { findRecurring, parseStatement } from './engine';
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
  const { mutate, ctx, today } = useApp();
  const [text, setText] = useState('');
  const [source, setSource] = useState<StatementLine['source']>('bank');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [found, setFound] = useState<RecurringCandidate[] | null>(null);
  const [lineCount, setLineCount] = useState(0);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [types, setTypes] = useState<Record<string, CommitmentType>>({});

  const check = (t: string) => {
    setMsg(null);
    const lines = parseStatement(t, source);
    setLineCount(lines.length);
    if (!lines.length) {
      setFound([]);
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
        {found && found.length === 0 && !msg && (
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
