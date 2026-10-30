import { useMemo, useState } from 'react';
import { useApp } from './store';
import { Badge, Card, CommitmentRow, inr } from './common';
import type { Nav } from './App';
import { addDays, formatDate, monthName, monthPeriod, parseISO, yearPeriod } from '../lib/dates';
import {
  cashBreakdown,
  cashForecast,
  datePassed,
  discretionaryRunRatePaise,
  dueSoon,
  linkedParentMap,
  markedOverdue,
  runRate,
} from '../lib/totals';
import { evaluateCap } from '../lib/budget';
import { ESSENTIAL_NOTE, overCapMessage } from '../lib/review';
import { TYPES, TYPE_LABELS } from '../lib/status';
import { ESTIMATE_NOTE } from '../content/privacy';
import { removeSampleData } from '../lib/data';

export function Home({ nav }: { nav: Nav }) {
  const { data, today, update } = useApp();
  const [mode, setMode] = useState<'month' | 'year'>('month');
  const t = parseISO(today);
  const [offset, setOffset] = useState(0);
  const { y, m } = useMemo(() => {
    const total = t.y * 12 + (t.m - 1) + (mode === 'month' ? offset : 0);
    return { y: mode === 'year' ? t.y + offset : Math.floor(total / 12), m: (total % 12) + 1 };
  }, [mode, offset, t.y, t.m]);
  const period = mode === 'month' ? monthPeriod(y, m) : yearPeriod(y);
  const label = mode === 'month' ? monthName(y, m) : String(y);

  const cash = cashForecast(data, period);
  const rr = runRate(data);
  const breakdown = cashBreakdown(data, period);
  const soon = dueSoon(data, today);
  const overdue = markedOverdue(data);
  const passed = data.commitments.filter((c) => datePassed(c, today));
  const linked = linkedParentMap(data);
  const hasSample = data.commitments.some((c) => c.isSample);

  const b = data.budget;
  const thisMonthCash = cashForecast(data, monthPeriod(t.y, t.m));
  const overall = evaluateCap(
    thisMonthCash.totalPaise,
    b.overallMonthlyCapPaise,
    b.thresholds,
    b.enabled,
  );
  const disc = evaluateCap(
    discretionaryRunRatePaise(data),
    b.discretionaryMonthlyCapPaise,
    b.thresholds,
    b.enabled,
  );
  const hasEstimates = thisMonthCash.estimateCount > 0 || thisMonthCash.unknownAmountCount > 0;

  return (
    <>
      {hasSample && (
        <div className="notice">
          Showing <Badge tone="sample">Sample data</Badge> so you can look around.{' '}
          <button className="link" onClick={() => update(removeSampleData)}>
            Remove sample data
          </button>
        </div>
      )}

      <div className="seg" role="group" aria-label="Period">
        <button
          className={mode === 'month' ? 'on' : ''}
          onClick={() => {
            setMode('month');
            setOffset(0);
          }}
        >
          This month
        </button>
        <button
          className={mode === 'year' ? 'on' : ''}
          onClick={() => {
            setMode('year');
            setOffset(0);
          }}
        >
          This year
        </button>
      </div>
      <div className="period">
        <button aria-label="Previous period" onClick={() => setOffset(offset - 1)}>
          ‹
        </button>
        <strong>{label}</strong>
        <button aria-label="Next period" onClick={() => setOffset(offset + 1)}>
          ›
        </button>
      </div>

      <div className="grid2">
        <Card title="Cash due">
          <p className="big">{inr(cash.totalPaise)}</p>
          <p className="muted">
            Scheduled to go out in {label}, on the dates you entered. Each card statement is counted
            once.
          </p>
          {cash.unknownAmountCount > 0 && (
            <p className="muted">
              {cash.unknownAmountCount} item(s) have no amount entered yet, so they are not in this
              total.
            </p>
          )}
          {cash.estimateCount > 0 && (
            <Badge tone="warm">{cash.estimateCount} estimate(s) included</Badge>
          )}
        </Card>
        <Card title="Monthly run-rate">
          <p className="big">{inr(rr.totalPaise)}</p>
          <p className="muted">
            A planning estimate: quarterly and annual plans are spread over their months. It is not
            what leaves your account in a given month.
          </p>
        </Card>
      </div>

      {(overall.level !== 'off' || disc.level !== 'off') && (
        <Card title="Your limits" right={<a href="#/budget">Edit</a>}>
          {overall.level !== 'off' && (
            <p>
              All commitments this month: {inr(thisMonthCash.totalPaise)} of{' '}
              {inr(b.overallMonthlyCapPaise!)} ({Math.round(overall.percent)}%)
            </p>
          )}
          {overall.level === 'over' && (
            <>
              <p>
                {overCapMessage(
                  inr(thisMonthCash.totalPaise),
                  inr(b.overallMonthlyCapPaise!),
                  hasEstimates,
                )}
              </p>
              <p className="muted">{ESSENTIAL_NOTE}</p>
            </>
          )}
          {disc.level !== 'off' && (
            <p>
              Optional subscriptions (monthly run-rate): {inr(discretionaryRunRatePaise(data))} of{' '}
              {inr(b.discretionaryMonthlyCapPaise!)}
              {disc.level === 'approaching' && ' · getting close to the limit you chose'}
              {disc.level === 'at_cap' && ' · at the limit you chose'}
              {disc.level === 'over' &&
                ' · above the limit you chose. You can review at your own pace.'}
            </p>
          )}
        </Card>
      )}

      <Card title="Coming up">
        {soon.length === 0 && <p className="muted">Nothing is due in the next 7 days.</p>}
        {soon.map((c) => (
          <CommitmentRow
            key={c.id}
            c={c}
            onOpen={(id) => nav.go({ name: 'edit', id })}
            linkedNote={
              linked.has(c.id) ? 'charged to a card statement (not added again)' : undefined
            }
          />
        ))}
        {overdue.length > 0 && (
          <p className="muted">
            Marked overdue by you: {overdue.map((c) => c.nickname || c.provider).join(', ')}
          </p>
        )}
        {passed.length > 0 && (
          <p className="muted">
            {passed.length} item(s) have a date that has passed. Update the next date when you know
            it, e.g. {formatDate(passed[0].nextDue)} for {passed[0].nickname || passed[0].provider}.
          </p>
        )}
      </Card>

      <h2 className="section">Your commitments</h2>
      <div className="cats">
        {TYPES.map((tp) => {
          const items = data.commitments.filter((c) => c.type === tp);
          const total = cashForecast({ ...data, commitments: items }, period).totalPaise;
          return (
            <button key={tp} className="cat" onClick={() => nav.go({ name: 'category', type: tp })}>
              <strong>{TYPE_LABELS[tp]}</strong>
              <span>{items.length} item(s)</span>
              <span className="muted">
                {label}: {inr(total)}
              </span>
            </button>
          );
        })}
      </div>

      <Card title={`Where ${label}’s cash goes`}>
        {Object.entries(breakdown.byType).length === 0 && (
          <p className="muted">Nothing scheduled in this period.</p>
        )}
        {TYPES.filter((tp) => (breakdown.byType[tp] ?? 0) > 0).map((tp) => (
          <div className="line" key={tp}>
            <span>{TYPE_LABELS[tp]}</span>
            <span>{inr(breakdown.byType[tp]!)}</span>
          </div>
        ))}
        {breakdown.warnings.map((w) => (
          <p key={w} className="muted">
            {w}
          </p>
        ))}
        <p className="muted">
          Items you linked to a card statement appear in their own category here, and the rest of
          the statement is shown under Credit Cards. The total still matches Cash due.
        </p>
      </Card>

      <p className="muted">{ESTIMATE_NOTE}</p>
      <button className="fab" onClick={() => nav.go({ name: 'add', type: 'subscription' })}>
        + Add a commitment
      </button>
      <p className="muted">
        <a href={`#/import`}>Import from a CSV file</a> · Today is {formatDate(today)} (IST) · next
        7 days end {formatDate(addDays(today, 7))}
      </p>
    </>
  );
}
