import { useState } from 'react';
import { useApp } from './store';
import { Card, CommitmentRow, inr } from './common';
import type { Nav } from './App';
import type { CommitmentType, Status } from '../lib/types';
import { STATUS_LABELS, TYPE_LABELS } from '../lib/status';
import { cashForecast, linkedParentMap } from '../lib/totals';
import { formatDate, monthPeriod, parseISO, yearPeriod } from '../lib/dates';

export function CategoryView({ type, nav }: { type: CommitmentType; nav: Nav }) {
  const { data, today } = useApp();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<Status | 'all'>('all');
  const [owner, setOwner] = useState('all');
  const t = parseISO(today);
  const all = data.commitments.filter((c) => c.type === type);
  const owners = [...new Set(all.map((c) => c.ownerLabel).filter(Boolean))];
  const items = all
    .filter((c) => (status === 'all' ? true : c.status === status))
    .filter((c) => (owner === 'all' ? true : c.ownerLabel === owner))
    .filter((c) => `${c.provider} ${c.nickname} ${c.notes}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const scoped = { ...data, commitments: all };
  const month = cashForecast(scoped, monthPeriod(t.y, t.m));
  const year = cashForecast(scoped, yearPeriod(t.y));
  const calendar = yearPeriod(t.y);
  const upcoming = cashForecast(scoped, { start: today, end: calendar.end }).items.slice(0, 12);
  const linked = linkedParentMap(data);

  return (
    <>
      <button className="link" onClick={nav.back}>
        ‹ Back
      </button>
      <h1>{TYPE_LABELS[type]}</h1>
      <div className="grid2">
        <Card title="This month">
          <p className="big">{inr(month.totalPaise)}</p>
        </Card>
        <Card title="This year">
          <p className="big">{inr(year.totalPaise)}</p>
        </Card>
      </div>
      <button className="fab" onClick={() => nav.go({ name: 'add', type })}>
        + Add {TYPE_LABELS[type].toLowerCase()}
      </button>

      <div className="filters">
        <input
          type="search"
          placeholder="Search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as Status | 'all')}
          aria-label="Status filter"
        >
          <option value="all">Any status</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        {owners.length > 0 && (
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            aria-label="Owner filter"
          >
            <option value="all">Whole household</option>
            {owners.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        )}
      </div>

      <Card title="Due calendar (rest of this year)">
        {upcoming.length === 0 && <p className="muted">Nothing scheduled.</p>}
        {upcoming.map((u, i) => (
          <div className="line" key={`${u.commitment.id}${u.date}${i}`}>
            <span>
              {formatDate(u.date)} · {u.commitment.nickname || u.commitment.provider}
            </span>
            <span>{u.amountPaise === null ? 'amount not entered' : inr(u.amountPaise)}</span>
          </div>
        ))}
        {type === 'subscription' && (
          <p className="muted">
            Subscriptions charged to a card statement are not listed here because the statement
            already includes them.
          </p>
        )}
      </Card>

      <Card title={`All ${TYPE_LABELS[type].toLowerCase()}`}>
        {items.length === 0 && <p className="muted">Nothing here yet.</p>}
        {items.map((c) => (
          <CommitmentRow
            key={c.id}
            c={c}
            onOpen={(id) => nav.go({ name: 'edit', id })}
            linkedNote={linked.has(c.id) ? 'included in a card statement' : undefined}
          />
        ))}
      </Card>
    </>
  );
}
