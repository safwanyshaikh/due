import { useApp } from './store';
import { Icon } from './Icon';
import { TILE_BY_TYPE } from './tiles';
import type { Nav } from './App';
import type { Commitment, CommitmentType } from '../lib/types';
import { addDays, formatDate } from '../lib/dates';
import { linkedParentMap } from '../lib/totals';
import { countsTowardForecast } from '../lib/status';
import { formatINR } from '../lib/money';

const CYCLE: Record<Commitment['frequency'], string> = {
  one_time: 'One time',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  half_yearly: 'Every 6 months',
  annual: 'Yearly',
  custom_months: 'Custom',
};

export function CategoryView({ type, nav }: { type: CommitmentType; nav: Nav }) {
  const { data, today } = useApp();
  const tile = TILE_BY_TYPE[type] ?? TILE_BY_TYPE.subscription;
  const linked = linkedParentMap(data);
  const items = data.commitments
    .filter((c) => c.type === type)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
  const seasonal = items.filter((c) =>
    [
      'seasonal_plan',
      'pause_planned',
      'pause_confirmed_by_user',
      'cancelled_confirmed_by_user',
      'cancel_pending',
    ].includes(c.status),
  );
  const rest = items.filter((c) => !seasonal.includes(c));
  const horizon = addDays(today, 30);
  const groups: [string, Commitment[]][] = [
    ['Coming up', rest.filter((c) => c.nextDue <= horizon)],
    ['Later', rest.filter((c) => c.nextDue > horizon)],
    ['Seasonal and paused plans', seasonal],
  ];

  const card = (c: Commitment) => {
    const kids = data.commitments.filter((k) => linked.get(k.id) === c.id);
    const passed = c.nextDue < today && countsTowardForecast(c.status);
    return (
      <button key={c.id} className="item" onClick={() => nav.go({ name: 'edit', id: c.id })}>
        <span className="row">
          <strong>{c.nickname || c.provider}</strong>
          <span className="big amt">
            {c.amountPaise === null ? 'Amount not entered' : formatINR(c.amountPaise)}
          </span>
        </span>
        <span className="muted">
          {type === 'subscription' ? 'Renews' : 'Due'} {formatDate(c.nextDue)} ·{' '}
          {CYCLE[c.frequency]}
        </span>
        {linked.has(c.id) && (
          <span className="small">Included in your card statement, so not counted twice.</span>
        )}
        {kids.length > 0 && (
          <span className="small">
            Includes {kids.map((k) => k.nickname || k.provider).join(', ')}
          </span>
        )}
        {passed && (
          <span className="small muted">
            This date has passed. Update it when you know the next one.
          </span>
        )}
        <span className="foot2">
          <span className="badge soft">
            {c.amountConfidence === 'confirmed' ? 'You entered this' : 'Estimated'}
          </span>
          <span className="go">Review details ›</span>
        </span>
      </button>
    );
  };

  return (
    <div className="page">
      <section className={`banner c-${tile.color}`}>
        <div className="cathead">
          <span className="ic">
            <Icon name={tile.icon} />
          </span>
          <div>
            <h1>{tile.name}</h1>
            <p>
              {tile.lead}
              {items.length ? ` · ${items.length} listed` : ''}
            </p>
          </div>
        </div>
        <div>
          <button className="btn primary quiet" onClick={() => nav.go({ name: 'add', type })}>
            + {tile.add}
          </button>
        </div>
      </section>
      {!items.length && (
        <div className="empty">
          <p>
            <b>Nothing here yet.</b>
          </p>
          <p className="muted">Add one whenever you’re ready. There’s no rush.</p>
          <button className="btn primary" onClick={() => nav.go({ name: 'add', type })}>
            {tile.emptyAct}
          </button>
        </div>
      )}
      {groups.map(([title, list]) =>
        list.length ? (
          <section className="group" key={title}>
            <h2>{title}</h2>
            <div className="cards">{list.map(card)}</div>
          </section>
        ) : null,
      )}
    </div>
  );
}
