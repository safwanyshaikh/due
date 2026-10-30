import { useMemo, useState } from 'react';
import type { AttentionItem, ObligationView } from '../../lib/home';
import { RAIL_LABELS, upcomingOccurrences } from '../../lib/home';
import { findObligation } from '../../lib/obligations';
import { dismissDuplicate, mergeDuplicates } from '../../lib/duplicates';
import { addDays, formatDate, parseISO } from '../../lib/dates';
import { TYPE_LABELS, TYPES } from '../../lib/status';
import { CONFIDENCE_LABELS } from '../../lib/provenance';
import type { Importance, Rail, ValueConfidence } from '../../lib/types';
import { useApp } from '../store';
import { ObligationRow } from './obligation';
import { Badge } from './ui';
import { inr } from '../lib/format';

export function AttentionList({ items }: { items: AttentionItem[] }) {
  const { mutate, ctx, data } = useApp();
  if (!items.length) return <p className="muted">Nothing needs your attention right now.</p>;
  return (
    <ul className="attn-list">
      {items.map((a) => {
        const s = a.suggestion;
        const names = s?.ids.map((id) => {
          const ob = findObligation(data, id);
          return ob ? ob.nickname || ob.provider : id;
        });
        return (
          <li key={a.id} className={`attn attn-${a.severity}`}>
            <div>
              <strong>{a.title}</strong>
              <p className="muted small">{a.detail}</p>
            </div>
            <div className="btn-row">
              {a.obligationId && (
                <a
                  className="btn btn-secondary btn-sm press"
                  href={`#/item/${encodeURIComponent(a.obligationId)}`}
                >
                  Review
                </a>
              )}
              {a.kind === 'import_pending' && (
                <a className="btn btn-secondary btn-sm press" href="#/import">
                  Open review queue
                </a>
              )}
              {s && names && (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm press"
                    onClick={() => mutate((d) => mergeDuplicates(d, s, s.ids[0], ctx()))}
                    aria-label={`Merge into ${names[0]}`}
                  >
                    Merge into “{names[0]}”
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm press"
                    onClick={() => mutate((d) => dismissDuplicate(d, s, ctx()))}
                  >
                    Keep both
                  </button>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** 30-day cash-flow calendar: unpaid occurrences per day from today. */
export function CashCalendar() {
  const { data, today } = useApp();
  const end = addDays(today, 29);
  const byDay = useMemo(() => {
    const m = new Map<string, { names: string[]; total: number; unknown: number }>();
    for (const { ob, occ } of upcomingOccurrences(data, today, end, today)) {
      const e = m.get(occ.date) ?? { names: [], total: 0, unknown: 0 };
      e.names.push(ob.nickname || ob.provider);
      if (occ.amountPaise === null) e.unknown++;
      else e.total += occ.amountPaise;
      m.set(occ.date, e);
    }
    return m;
  }, [data, today, end]);
  const start = parseISO(today);
  const lead = new Date(Date.UTC(start.y, start.m - 1, start.d)).getUTCDay();
  const days = Array.from({ length: 30 }, (_, i) => addDays(today, i));
  const busiest = [...byDay.entries()].sort((a, b) => b[1].total - a[1].total)[0];
  return (
    <div>
      <div className="cal2" aria-hidden="true">
        {WD.map((w, i) => (
          <span key={i} className="cal2-wd">
            {w}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`pad${i}`} />
        ))}
        {days.map((d) => {
          const e = byDay.get(d);
          return (
            <span key={d} className={`cal2-day ${e ? 'has' : ''} ${d === today ? 'today' : ''}`}>
              <b>{parseISO(d).d}</b>
              {e && <small className="amt">{e.total ? inr(e.total) : '•'}</small>}
            </span>
          );
        })}
      </div>
      <ul className="cal2-list">
        {[...byDay.entries()].map(([d, e]) => (
          <li key={d}>
            <span>{formatDate(d)}</span>
            <span className="muted">{e.names.join(', ')}</span>
            <span className="amt">
              {inr(e.total)}
              {e.unknown ? ` + ${e.unknown} without amount` : ''}
            </span>
          </li>
        ))}
        {!byDay.size && <li className="muted">Nothing due in the next 30 days.</li>}
      </ul>
      {busiest && (
        <p className="muted small">
          Busiest day: {formatDate(busiest[0])} ({inr(busiest[1].total)}).
        </p>
      )}
    </div>
  );
}

interface Filters {
  type: string;
  owner: string;
  rail: string;
  importance: string;
  confidence: string;
}
const NONE: Filters = { type: '', owner: '', rail: '', importance: '', confidence: '' };

/** All obligations, filterable by type, owner, rail, essential/optional and confidence. */
export function ObligationList({
  views,
  initialType = '',
  idPrefix = 'ol',
}: {
  views: ObligationView[];
  initialType?: string;
  idPrefix?: string;
}) {
  const { data } = useApp();
  const [f, setF] = useState<Filters>({ ...NONE, type: initialType });
  const owners = [...new Set(views.map((v) => v.owner))].sort();
  const imp = (id: string): Importance | undefined => findObligation(data, id)?.importance;
  const shown = views.filter(
    (v) =>
      (!f.type || v.type === f.type) &&
      (!f.owner || v.owner === f.owner) &&
      (!f.rail || v.rail === f.rail) &&
      (!f.importance || imp(v.id) === f.importance) &&
      (!f.confidence || v.dateConfidence === f.confidence || v.amountConfidence === f.confidence),
  );
  const set = (k: keyof Filters) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const active = Object.values(f).some(Boolean);
  return (
    <div className="stack-16">
      <div className="filters2" role="group" aria-label="Filter obligations">
        <label>
          <span>Type</span>
          <select value={f.type} onChange={set('type')} id={`${idPrefix}-type`}>
            <option value="">All types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Owner</span>
          <select value={f.owner} onChange={set('owner')}>
            <option value="">Everyone</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Payment rail</span>
          <select value={f.rail} onChange={set('rail')}>
            <option value="">Any</option>
            {(Object.keys(RAIL_LABELS) as Rail[]).map((r) => (
              <option key={r} value={r}>
                {RAIL_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Essential or optional</span>
          <select value={f.importance} onChange={set('importance')}>
            <option value="">Any</option>
            <option value="essential">Essential</option>
            <option value="important">Important</option>
            <option value="optional">Optional</option>
          </select>
        </label>
        <label>
          <span>Confidence</span>
          <select value={f.confidence} onChange={set('confidence')}>
            <option value="">Any</option>
            {(Object.keys(CONFIDENCE_LABELS) as ValueConfidence[]).map((c) => (
              <option key={c} value={c}>
                {CONFIDENCE_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small" role="status">
        Showing {shown.length} of {views.length}
        {active && (
          <>
            {' '}
            ·{' '}
            <button type="button" className="text-btn press" onClick={() => setF(NONE)}>
              Clear filters
            </button>
          </>
        )}
      </p>
      {shown.length ? (
        <ul className="orow-list">
          {shown.map((v) => (
            <ObligationRow key={v.id} v={v} />
          ))}
        </ul>
      ) : (
        <p className="muted">No items match these filters.</p>
      )}
    </div>
  );
}

export function TotalsNote({ unknown, estimated }: { unknown: number; estimated: number }) {
  if (!unknown && !estimated) return null;
  return (
    <span className="chips">
      {estimated > 0 && <Badge tone="warm">{estimated} estimated</Badge>}
      {unknown > 0 && <Badge>{unknown} without amount</Badge>}
    </span>
  );
}
