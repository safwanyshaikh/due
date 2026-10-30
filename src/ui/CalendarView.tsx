import { useState } from 'react';
import { useApp } from './store';
import type { Nav } from './App';
import { formatDate, monthPeriod, parseISO, yearPeriod } from '../lib/dates';
import { occurrences } from '../lib/schedule';
import { countsTowardForecast, TYPE_SINGULAR } from '../lib/status';
import { linkedParentMap } from '../lib/totals';
import { formatINR } from '../lib/money';
import type { Commitment } from '../lib/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function CalendarView({ nav }: { nav: Nav }) {
  const { data, today } = useApp();
  const t = parseISO(today);
  const [mode, setMode] = useState<'month' | 'year'>('month');
  const [offset, setOffset] = useState(0);
  const total = t.y * 12 + (t.m - 1) + (mode === 'month' ? offset : 0);
  const y = mode === 'year' ? t.y + offset : Math.floor(total / 12);
  const m = (total % 12) + 1;
  const period = mode === 'month' ? monthPeriod(y, m) : yearPeriod(y);
  const linked = linkedParentMap(data);
  const rows: { c: Commitment; d: string }[] = [];
  for (const c of data.commitments) {
    if (!countsTowardForecast(c.status)) continue;
    for (const o of occurrences(c, period)) rows.push({ c, d: o.date });
  }
  rows.sort((a, b) => a.d.localeCompare(b.d));
  const byDate = new Map<string, typeof rows>();
  for (const r of rows) byDate.set(r.d, [...(byDate.get(r.d) ?? []), r]);

  return (
    <div className="page">
      <section className="hello">
        <h1>Calendar</h1>
        <div className="controls">
          <div className="seg" role="group" aria-label="Period">
            <button
              aria-pressed={mode === 'month'}
              onClick={() => {
                setMode('month');
                setOffset(0);
              }}
            >
              This month
            </button>
            <button
              aria-pressed={mode === 'year'}
              onClick={() => {
                setMode('year');
                setOffset(0);
              }}
            >
              This year
            </button>
          </div>
          <div className="stepper">
            <button aria-label="Previous" onClick={() => setOffset(offset - 1)}>
              ‹
            </button>
            <span>{mode === 'month' ? `${MONTHS[m - 1]} ${y}` : y}</span>
            <button aria-label="Next" onClick={() => setOffset(offset + 1)}>
              ›
            </button>
          </div>
        </div>
      </section>
      {byDate.size === 0 && (
        <div className="empty">
          <p>
            <b>Nothing is scheduled in this period.</b>
          </p>
          <p className="muted">Enjoy the quiet.</p>
        </div>
      )}
      {[...byDate.entries()].map(([d, list]) => (
        <div className="dategroup" key={d}>
          <h3>{formatDate(d)}</h3>
          {list.map(({ c }) => (
            <button
              key={c.id + d}
              className="cal"
              onClick={() => nav.go({ name: 'edit', id: c.id })}
            >
              <span>
                <b>{c.nickname || c.provider}</b>
                <br />
                <span className="muted small">
                  {TYPE_SINGULAR[c.type]}
                  {linked.has(c.id) ? ' · included in your card statement' : ''}
                </span>
              </span>
              <span className="amt">
                {c.amountPaise === null ? 'not entered' : formatINR(c.amountPaise)}
              </span>
            </button>
          ))}
        </div>
      ))}
      <p className="muted small">
        Items already inside a card statement are shown with a note and are not added again to
        what’s planned.
      </p>
    </div>
  );
}
