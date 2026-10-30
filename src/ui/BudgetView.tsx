import { useState } from 'react';
import { useApp } from './store';
import { Card, inr } from './common';
import { paiseToRupeeString, parseRupees } from '../lib/money';
import { evaluateCap } from '../lib/budget';
import { cashForecast, discretionaryRunRatePaise } from '../lib/totals';
import { monthPeriod, parseISO } from '../lib/dates';
import {
  COOLING_OFF_NOTE,
  ESSENTIAL_NOTE,
  REVIEW_ACTIONS,
  canOfferReview,
  overCapMessage,
} from '../lib/review';
import { remindersForCommitment } from '../lib/reminders';
import { addDays } from '../lib/dates';
import { setStatus, upsertCommitment } from '../lib/data';

export function BudgetView() {
  const { data, today, update } = useApp();
  const b = data.budget;
  const [overall, setOverall] = useState(paiseToRupeeString(b.overallMonthlyCapPaise));
  const [disc, setDisc] = useState(paiseToRupeeString(b.discretionaryMonthlyCapPaise));
  const [thr, setThr] = useState(b.thresholds.join(', '));
  const [err, setErr] = useState('');
  const t = parseISO(today);
  const month = cashForecast(data, monthPeriod(t.y, t.m));
  const discValue = discretionaryRunRatePaise(data);

  function save(enabled: boolean) {
    const o = overall.trim() === '' ? null : parseRupees(overall);
    const d = disc.trim() === '' ? null : parseRupees(disc);
    const th = thr
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0 && n <= 200);
    if ((overall.trim() && o === null) || (disc.trim() && d === null))
      return setErr('Limits should be rupee values like 25000.');
    setErr('');
    update((x) => ({
      ...x,
      budget: {
        enabled,
        overallMonthlyCapPaise: o,
        discretionaryMonthlyCapPaise: d,
        thresholds: th.length ? th : [80, 100],
      },
    }));
  }

  const oRes = evaluateCap(month.totalPaise, b.overallMonthlyCapPaise, b.thresholds, b.enabled);
  const dRes = evaluateCap(discValue, b.discretionaryMonthlyCapPaise, b.thresholds, b.enabled);
  const reviewable = data.commitments.filter(
    (c) => canOfferReview(c) && c.status !== 'cancelled_confirmed_by_user',
  );

  return (
    <div className="page">
      <h1>Your limits</h1>
      <p className="muted">
        Limits are yours to set, change or turn off. They are for planning, not advice.
      </p>
      <Card title="Set limits">
        <label className="field">
          <span>All commitments, per month (₹)</span>
          <input inputMode="decimal" value={overall} onChange={(e) => setOverall(e.target.value)} />
          <small className="muted">Compared with cash due this month.</small>
        </label>
        <label className="field">
          <span>Optional subscriptions, per month (₹)</span>
          <input inputMode="decimal" value={disc} onChange={(e) => setDisc(e.target.value)} />
          <small className="muted">
            Compared with the monthly run-rate of subscriptions you marked optional.
          </small>
        </label>
        <label className="field">
          <span>Alert at these percentages</span>
          <input value={thr} onChange={(e) => setThr(e.target.value)} />
          <small className="muted">
            Default 80, 100. You are also told if you are above the limit.
          </small>
        </label>
        {err && (
          <p className="errors" role="alert">
            {err}
          </p>
        )}
        <div className="actions">
          <button className="primary" onClick={() => save(true)}>
            Save and turn on
          </button>
          <button onClick={() => save(false)}>Turn off</button>
        </div>
      </Card>

      {oRes.level !== 'off' && (
        <Card title="All commitments this month">
          <p>
            {inr(month.totalPaise)} of {inr(b.overallMonthlyCapPaise!)} ({Math.round(oRes.percent)}
            %)
          </p>
          {oRes.level === 'approaching' && (
            <p className="muted">You’ve reached {oRes.crossed.at(-1)}% of the limit you chose.</p>
          )}
          {oRes.level === 'at_cap' && <p className="muted">You’re at the limit you chose.</p>}
          {oRes.level === 'over' && (
            <>
              <p>
                {overCapMessage(
                  inr(month.totalPaise),
                  inr(b.overallMonthlyCapPaise!),
                  month.estimateCount + month.unknownAmountCount > 0,
                )}
              </p>
              <p className="muted">{ESSENTIAL_NOTE}</p>
              <p className="muted">
                Dates this month:{' '}
                {month.items
                  .map(
                    (i) =>
                      `${i.date.slice(8)}/${i.date.slice(5, 7)} ${i.commitment.nickname || i.commitment.provider}`,
                  )
                  .join(' · ')}
              </p>
            </>
          )}
        </Card>
      )}

      {dRes.level !== 'off' && (
        <Card title="Optional subscriptions">
          <p>
            {inr(discValue)} of {inr(b.discretionaryMonthlyCapPaise!)} a month (
            {Math.round(dRes.percent)}%)
          </p>
          {dRes.level === 'over' && (
            <>
              <p>
                Optional subscriptions are above the limit you chose. You can review them whenever
                you’re ready.
              </p>
              {reviewable.map((c) => (
                <div key={c.id} className="review">
                  <strong>{c.nickname || c.provider}</strong>
                  <div className="chips">
                    {REVIEW_ACTIONS.map((a) => {
                      if (a === 'Open provider help') {
                        const url = c.subscription?.helpUrl;
                        return url ? (
                          <a
                            key={a}
                            className="chip"
                            href={url}
                            target="_blank"
                            rel="noreferrer noopener"
                          >
                            {a}
                          </a>
                        ) : (
                          <span key={a} className="chip off">
                            {a} (add a link first)
                          </span>
                        );
                      }
                      if (a === 'Set a reminder')
                        return (
                          <a key={a} className="chip" href={`#/edit/${c.id}`}>
                            {a}
                          </a>
                        );
                      if (a === 'Review this item')
                        return (
                          <a key={a} className="chip" href={`#/edit/${c.id}`}>
                            {a}
                          </a>
                        );
                      return (
                        <button
                          key={a}
                          className="chip"
                          onClick={() => update((d) => setStatus(d, c.id, 'review_needed'))}
                        >
                          {c.status === 'review_needed' ? 'Marked for later' : a}
                        </button>
                      );
                    })}
                  </div>
                  <button
                    className="chip"
                    onClick={() =>
                      update((d) =>
                        upsertCommitment(d, { ...c, coolingOffUntil: addDays(today, 1) }),
                      )
                    }
                  >
                    {c.coolingOffUntil
                      ? `Cooling-off until ${c.coolingOffUntil}`
                      : 'Remind me tomorrow (24-hour cooling-off)'}
                  </button>
                  <small className="muted">
                    Reminders set: {remindersForCommitment(c).length}. Nothing here changes your
                    subscription with the provider.
                  </small>
                </div>
              ))}
              <p className="muted">{COOLING_OFF_NOTE}</p>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
