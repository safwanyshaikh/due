import { useMemo, useState } from 'react';
import { homeSummary, obligationViews } from '../../lib/home';
import { cashForecast } from '../../lib/totals';
import { monthPeriod, parseISO, monthName } from '../../lib/dates';
import { weeklyDigest } from '../../lib/retention';
import { useApp } from '../store';
import { HeroCard, TimelineRow } from '../components/obligation';
import { AttentionList, CashCalendar, ObligationList, TotalsNote } from '../components/lists';
import { Sheet } from '../components/Sheet';
import { Glyph } from '../components/Glyph';
import { inr } from '../lib/format';

export const DEFAULT_TITLE = 'Your next commitment is clear.';

export function Home() {
  const { data, today } = useApp();
  const tz = data.settings.timezone;
  const s = useMemo(() => homeSummary(data, today, tz), [data, today, tz]);
  const views = useMemo(() => obligationViews(data, today, tz), [data, today, tz]);
  const digest = useMemo(() => weeklyDigest(data, today), [data, today]);
  const t = parseISO(today);
  const month = useMemo(() => cashForecast(data, monthPeriod(t.y, t.m)), [data, t.y, t.m]);
  const [why, setWhy] = useState(false);
  const title = s.coveredMessage ?? DEFAULT_TITLE;
  const attention = s.needsAttention.length;

  return (
    <div className="home-grid">
      <div className="home-main">
        <section className="reassure" data-block="header" aria-labelledby="home-title">
          <div className="reassure-text">
            <p className="eyebrow">Next 7 days</p>
            <h1 id="home-title" className="reassure-title">
              {title}
            </h1>
          </div>
          <button
            type="button"
            className="text-btn press"
            onClick={() => setWhy(true)}
            aria-label="Why? How this summary is worked out"
          >
            Why?
          </button>
        </section>

        {s.next ? (
          <HeroCard v={s.next} />
        ) : (
          <article className="hero" data-block="hero">
            <h2 className="hero-name">Nothing upcoming</h2>
            <p className="muted">
              Everything you track is paid, paused or has no date yet. Add a date when you know it.
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary press" href="#/all">
                Review all items
              </a>
            </div>
          </article>
        )}

        <section className="strip2" data-block="strip" aria-label="Totals">
          <div className="strip-cell">
            <span className="strip-label">Next 7 days</span>
            <span className="strip-value amt">{inr(s.next7Total)}</span>
          </div>
          <div className="strip-cell">
            <span className="strip-label">Next 30 days</span>
            <span className="strip-value amt">{inr(s.next30Total)}</span>
          </div>
          <a
            className={`strip-cell strip-link press ${attention ? 'strip-attn' : ''}`}
            href="#needs-attention"
          >
            <span className="strip-label">Needs attention</span>
            <span className="strip-value amt">{attention}</span>
          </a>
        </section>

        <section className="timeline" data-block="timeline" aria-labelledby="tl-title">
          <h2 id="tl-title" className="timeline-title">
            Coming up
          </h2>
          {s.timeline.length ? (
            <ol className="trow-list">
              {s.timeline.map((v) => (
                <TimelineRow key={`${v.id}:${v.occurrenceDate}`} v={v} />
              ))}
            </ol>
          ) : (
            <p className="muted timeline-empty">
              Nothing else is scheduled yet. Items you add appear here by date.
            </p>
          )}
        </section>

        <div className="action-row" data-block="actions">
          <a className="btn btn-primary press" href="#/add">
            <Glyph name="plus" size={18} /> Add due item
          </a>
          <a className="btn btn-secondary press" href="#/import">
            <Glyph name="upload" size={18} /> Import
          </a>
        </div>

        <div className="below-fold">
          <section
            id="needs-attention"
            aria-labelledby="na-title"
            className="stack-16"
            tabIndex={-1}
          >
            <h2 id="na-title">Needs attention</h2>
            <AttentionList items={s.needsAttention} />
          </section>

          {digest && (
            <section aria-labelledby="wk-title" className="panel2">
              <h2 id="wk-title">This week</h2>
              <p>{digest.text}</p>
            </section>
          )}

          <section aria-labelledby="cf-title" className="stack-16">
            <h2 id="cf-title">Next 30 days</h2>
            <p className="muted">
              {inr(s.next30.totalPaise)} across {s.next30.count} due date
              {s.next30.count === 1 ? '' : 's'}.{' '}
              <TotalsNote
                unknown={s.next30.unknownAmountCount}
                estimated={s.next30.estimatedCount}
              />
            </p>
            <CashCalendar />
          </section>

          <section aria-labelledby="all-title" className="stack-16">
            <div className="section-head">
              <h2 id="all-title">All obligations</h2>
              <a className="text-btn press" href="#/all">
                Open All
              </a>
            </div>
            <ObligationList views={views} idPrefix="home" />
          </section>

          <nav className="more-links" aria-label="More">
            <a className="btn btn-quiet press" href="#/all">
              Categories
            </a>
            <a className="btn btn-quiet press" href="#/calendar">
              Calendar
            </a>
            <a className="btn btn-quiet press" href="#/reminders">
              Reminders
            </a>
            <a className="btn btn-quiet press" href="#/offers">
              Due &amp; Offers
            </a>
          </nav>
        </div>
      </div>

      <aside className="home-rail" aria-label="Summary">
        <section className="panel2">
          <h2>{monthName(t.y, t.m)}</h2>
          <p className="rail-total amt">{inr(month.totalPaise)}</p>
          <p className="muted small">Planned this month, from what you entered.</p>
        </section>
        <section className="panel2">
          <h2>Filter by</h2>
          <div className="stack-8">
            <a className="btn btn-quiet btn-block press" href="#/all/subscription">
              Subscriptions
            </a>
            <a className="btn btn-quiet btn-block press" href="#/all/emi">
              EMIs
            </a>
            <a className="btn btn-quiet btn-block press" href="#/all/bill">
              Bills
            </a>
            <a className="btn btn-quiet btn-block press" href="#/all">
              Everything
            </a>
          </div>
        </section>
      </aside>

      {why && (
        <Sheet title="How this summary works" onClose={() => setWhy(false)}>
          <dl className="why">
            <div>
              <dt>Next 7 days</dt>
              <dd>
                {s.next7.count} unpaid due date{s.next7.count === 1 ? '' : 's'} from today to 6 days
                ahead, totalling {inr(s.next7.totalPaise)}.
                {s.next7.unknownAmountCount
                  ? ` ${s.next7.unknownAmountCount} ha${s.next7.unknownAmountCount === 1 ? 's' : 've'} no amount and ${s.next7.unknownAmountCount === 1 ? 'is' : 'are'} not counted as zero.`
                  : ''}
                {s.next7.estimatedCount
                  ? ` ${s.next7.estimatedCount} amount(s) are estimates.`
                  : ''}
              </dd>
            </div>
            <div>
              <dt>The headline</dt>
              <dd>
                “You’re covered” appears only when every item in the next 7 days is marked paid by
                you. Otherwise Due shows the next commitment, without guessing.
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
