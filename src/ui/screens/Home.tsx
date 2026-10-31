import { useEffect, useMemo, useState } from 'react';
import { homeSummary, obligationViews, type ObligationView } from '../../lib/home';
import { cashForecast } from '../../lib/totals';
import { addDays, monthName, monthPeriod, parseISO } from '../../lib/dates';
import { pendingImports } from '../../lib/imports';
import { useApp } from '../store';
import { ReviewSheet, SnoozeSheet, TimelineRow } from '../components/obligation';
import { AttentionList, CashCalendar, TotalsNote } from '../components/lists';
import { Sheet } from '../components/Sheet';
import { Glyph } from '../components/Glyph';
import { Badge, ConfidenceBadge } from '../components/ui';
import { StartChoices } from '../components/StartChoices';
import { Icon } from '../Icon';
import { useCatalog } from '../offers/catalogStore';
import { offersTileText } from '../lib/offersTile';
import { greeting, homeTiles, type HomeTile } from '../lib/homeTiles';
import { inr, weekdayDate } from '../lib/format';
import { readJsonPref, writeJsonPref } from '../lib/prefs';

/** Compact summary card: planned this month, next due item with its confidence and source, actions. */
function SummaryCard({
  monthTotal,
  monthLabel,
  unknown,
  next,
  onWhy,
}: {
  monthTotal: number;
  monthLabel: string;
  unknown: number;
  next: ObligationView | null;
  onWhy: () => void;
}) {
  const [sheet, setSheet] = useState<null | 'review' | 'snooze'>(null);
  const risk = next?.status === 'overdue';
  return (
    <section
      className={`summary ${risk ? 'summary-risk' : ''}`}
      data-block="summary"
      aria-labelledby="summary-title"
    >
      <div className="summary-top">
        <div className="summary-month">
          <h2 id="summary-title" className="eyebrow">
            Planned in {monthLabel}
          </h2>
          <p className="summary-total amt">
            {inr(monthTotal)}
            {unknown > 0 && <span className="muted small"> + {unknown} without amount</span>}
          </p>
        </div>
        <button
          type="button"
          className="text-btn press"
          onClick={onWhy}
          aria-label="How is this worked out?"
        >
          How?
        </button>
      </div>
      {next ? (
        <>
          <div className="summary-next" data-testid="summary-next">
            <p className="summary-next-line">
              <span className="muted">Next due · </span>
              <strong className="summary-name">{next.nickname}</strong>
              <span className="amt"> · {next.amountText}</span>
            </p>
            <p className={`summary-date ${risk ? 'status-risk' : ''}`}>
              {next.date ? weekdayDate(next.date) : 'No date yet'} · {next.statusText}
            </p>
            <div className="chips">
              <ConfidenceBadge field="Date" c={next.dateConfidence} />
              <Badge>{next.sourceBadge}</Badge>
            </div>
          </div>
          <div className="summary-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm press jelly"
              onClick={() => setSheet('review')}
              aria-label={`Review ${next.nickname}`}
            >
              Review
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm press jelly"
              onClick={() => setSheet('snooze')}
              aria-label={`Snooze ${next.nickname}`}
            >
              <Glyph name="clock" size={18} /> Snooze
            </button>
            <a
              className="btn btn-secondary btn-sm press jelly"
              href={`#/edit/${encodeURIComponent(next.id)}`}
              aria-label={`Edit ${next.nickname}`}
            >
              <Glyph name="edit" size={18} /> Edit
            </a>
          </div>
          {sheet === 'review' && <ReviewSheet v={next} onClose={() => setSheet(null)} />}
          {sheet === 'snooze' && <SnoozeSheet v={next} onClose={() => setSheet(null)} />}
        </>
      ) : (
        <div className="summary-empty">
          <p className="muted small">
            Nothing planned yet. Add one subscription, EMI or bill to see what’s next.
          </p>
          <a className="btn btn-primary btn-sm press jelly" href="#/start">
            <Glyph name="plus" size={18} /> Get started
          </a>
        </div>
      )}
    </section>
  );
}

/** Tile that briefly shows the success state when its count went up since the last Home visit. */
function Tile({ t, success }: { t: HomeTile; success: boolean }) {
  return (
    <li>
      <a
        className={`htile c-${t.color} press jelly ${t.empty ? 'htile-empty' : ''} ${success ? 'is-success' : ''}`}
        href={t.href}
        data-tile={t.key}
      >
        <span className="htile-top">
          <span className="htile-ic jelly-ic">
            <Icon name={t.icon} />
          </span>
        </span>
        <strong className="htile-name">{t.name}</strong>{' '}
        <span className="htile-value">{t.value}</span>
        <span className="sr-only">, </span>
        <span className="htile-sub">{t.sub}</span>
        {!t.empty && (
          <span className="htile-count" aria-hidden="true">
            {t.count}
          </span>
        )}
      </a>
    </li>
  );
}

function useTileSuccess(tiles: HomeTile[]): Set<string> {
  const [grown] = useState(() => {
    const prev = readJsonPref<Record<string, number>>('tile-counts', {});
    return new Set(
      tiles.filter((t) => prev[t.key] !== undefined && t.count > prev[t.key]).map((t) => t.key),
    );
  });
  const counts = JSON.stringify(Object.fromEntries(tiles.map((t) => [t.key, t.count])));
  useEffect(() => {
    writeJsonPref('tile-counts', JSON.parse(counts));
  }, [counts]);
  return grown;
}

export function Home() {
  const { data, today } = useApp();
  const { offers } = useCatalog();
  const tz = data.settings.timezone;
  const s = useMemo(() => homeSummary(data, today, tz), [data, today, tz]);
  const views = useMemo(() => obligationViews(data, today, tz), [data, today, tz]);
  const t = parseISO(today);
  const month = useMemo(() => cashForecast(data, monthPeriod(t.y, t.m)), [data, t.y, t.m]);
  const offersLine = offersTileText(data, today, offers).line;
  const tiles = useMemo(
    () => homeTiles(data, views, today, offersLine),
    [data, views, today, offersLine],
  );
  const success = useTileSuccess(tiles);
  const [why, setWhy] = useState(false);
  const hi = greeting(new Date(), tz || 'Asia/Kolkata');
  const empty = views.length === 0 && pendingImports(data).length === 0;
  const week = useMemo(() => {
    const end = addDays(today, 6);
    return views.filter((v) => v.date && v.date <= end && v.id !== s.next?.id).slice(0, 6);
  }, [views, today, s.next]);

  return (
    <div className="home">
      <header className="greet" data-block="header">
        <h1 className="greet-hello">{hi.hello}</h1>
        <p className="greet-date muted">
          {hi.date} · <span title="India Standard Time">IST</span>
        </p>
      </header>

      <SummaryCard
        monthTotal={month.totalPaise}
        monthLabel={monthName(t.y, t.m).split(' ')[0]}
        unknown={month.unknownAmountCount}
        next={s.next}
        onWhy={() => setWhy(true)}
      />

      <section aria-labelledby="tiles-title" data-block="tiles">
        <h2 id="tiles-title" className="sr-only">
          Categories
        </h2>
        <ul className="htiles">
          {tiles.map((x) => (
            <Tile key={x.key} t={x} success={success.has(x.key)} />
          ))}
        </ul>
      </section>

      {empty ? (
        <section aria-labelledby="start-title" className="stack-12">
          <h2 id="start-title">Ways to start</h2>
          <p className="muted small">
            No account needed. What you add stays on this device unless you sign in and turn on
            backup.
          </p>
          <StartChoices headingId="start-title" compact />
        </section>
      ) : (
        <>
          <section
            id="needs-attention"
            aria-labelledby="na-title"
            className="stack-12"
            tabIndex={-1}
          >
            <h2 id="na-title">Needs attention</h2>
            <AttentionList items={s.needsAttention} />
          </section>

          <section aria-labelledby="tl-title" className="stack-12" data-block="timeline">
            <div className="section-head">
              <h2 id="tl-title">Next 7 days</h2>
              <span className="muted small amt">{inr(s.next7Total)}</span>
            </div>
            {week.length ? (
              <ol className="trow-list">
                {week.map((v) => (
                  <TimelineRow key={`${v.id}:${v.occurrenceDate}`} v={v} />
                ))}
              </ol>
            ) : (
              <p className="muted">
                {s.next ? 'Nothing else in the next 7 days.' : 'Nothing due in the next 7 days.'}
              </p>
            )}
          </section>

          <section aria-labelledby="cf-title" className="stack-12">
            <h2 id="cf-title">Next 30 days</h2>
            <p className="muted small">
              {inr(s.next30.totalPaise)} across {s.next30.count} due date
              {s.next30.count === 1 ? '' : 's'}.{' '}
              <TotalsNote
                unknown={s.next30.unknownAmountCount}
                estimated={s.next30.estimatedCount}
              />
            </p>
            <CashCalendar />
          </section>

          <nav className="more-links" aria-label="More">
            <a className="btn btn-secondary press jelly" href="#/add">
              <Glyph name="plus" size={18} /> Add due item
            </a>
            <a className="btn btn-quiet press" href="#/all">
              All items list
            </a>
            <a className="btn btn-quiet press" href="#/import">
              Import
            </a>
            <a className="btn btn-quiet press" href="#/reminders">
              Reminders
            </a>
          </nav>
        </>
      )}

      {why && (
        <Sheet title="How this summary works" onClose={() => setWhy(false)}>
          <dl className="why">
            <div>
              <dt>Planned this month</dt>
              <dd>
                Every unpaid due date in {monthName(t.y, t.m)} from what you entered or approved,
                totalling {inr(month.totalPaise)}.
                {month.unknownAmountCount
                  ? ` ${month.unknownAmountCount} without an amount are not counted as zero.`
                  : ''}
              </dd>
            </div>
            <div>
              <dt>Next due</dt>
              <dd>
                The earliest unpaid date (overdue first). The badges say how sure the date is and
                where it came from.
              </dd>
            </div>
            <div>
              <dt>Card statements</dt>
              <dd>Items you linked to a card statement are counted once, in the statement.</dd>
            </div>
            <div>
              <dt>What Due does not do</dt>
              <dd>Due never pays, cancels or moves money. It plans and reminds.</dd>
            </div>
          </dl>
        </Sheet>
      )}
    </div>
  );
}
