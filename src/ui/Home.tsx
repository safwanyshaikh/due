import { useMemo, useState } from 'react';
import { useApp } from './store';
import { Icon } from './Icon';
import { TILES } from './tiles';
import type { Nav } from './App';
import { addDays, daysBetween, formatDate, monthPeriod, parseISO, yearPeriod } from '../lib/dates';
import { cashForecast, discretionaryRunRatePaise, markedOverdue } from '../lib/totals';
import { countsTowardForecast } from '../lib/status';
import { monthlyEquivalentPaise } from '../lib/schedule';
import { formatINR } from '../lib/money';
import type { AppData, Commitment } from '../lib/types';
import { useCatalog } from './offers/catalogStore';
import type { OfferRecord } from '../lib/offers/types';
import { offersForService } from '../lib/offers/eligibility';
import { isRecommendable, isStale } from '../lib/offers/status';
import { nextServiceDate } from '../lib/offers/services';

const MONTHS_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(d: string) {
  const p = parseISO(d);
  return `${p.d} ${MONTHS[p.m - 1]}`;
}

function hourIST(): number {
  return (
    Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    ) % 24
  );
}

function nextOf(items: Commitment[], today: string): Commitment | null {
  return (
    items.filter((c) => c.nextDue >= today).sort((a, b) => a.nextDue.localeCompare(b.nextDue))[0] ??
    null
  );
}

/** On first open, if this month has nothing planned but next month does, start on next month. */
function initialOffset(data: AppData, today: string): number {
  const t = parseISO(today);
  const now = cashForecast(data, monthPeriod(t.y, t.m)).totalPaise;
  const n = t.m === 12 ? { y: t.y + 1, m: 1 } : { y: t.y, m: t.m + 1 };
  const next = cashForecast(data, monthPeriod(n.y, n.m)).totalPaise;
  return now === 0 && next > 0 ? 1 : 0;
}

export function offersTileText(
  data: AppData,
  today: string,
  catalog: OfferRecord[],
): { sub: string; line: string; tone: '' | 'review' } {
  if (!data.services.length)
    return {
      sub: 'Benefits, renewals, and expiry—kept in one place',
      line: 'Add a provider or recurring service.',
      tone: '',
    };
  const matched = data.services.flatMap((s) => offersForService(s, catalog));
  if (matched.some((o) => o.computedStatus === 'conflicting')) {
    return {
      sub: 'Benefits, renewals, and expiry—kept in one place',
      line: 'Source conflict—verify before relying on this.',
      tone: 'review',
    };
  }
  if (matched.some((o) => isRecommendable(o.computedStatus) && isStale(o, today))) {
    return {
      sub: 'Benefits, renewals, and expiry—kept in one place',
      line: 'Needs a refresh',
      tone: 'review',
    };
  }
  const verify = new Set(
    matched.filter((o) => o.computedStatus === 'active_verify').map((o) => o.offerId),
  ).size;
  const dates = data.services
    .map((s) => nextServiceDate(s, today))
    .filter((x): x is { date: string; label: string } => !!x)
    .sort((a, b) => a.date.localeCompare(b.date));
  const near = dates[0] ? `${dates[0].label} · ${shortDate(dates[0].date)}` : 'No dates added';
  return {
    sub: 'Benefits, renewals, and expiry—kept in one place',
    line: `${near} · ${verify} to verify`,
    tone: '',
  };
}

export function Home({ nav }: { nav: Nav }) {
  const { data, today } = useApp();
  const { offers: catalog } = useCatalog();
  const [mode, setMode] = useState<'month' | 'year'>('month');
  const [offset, setOffset] = useState(() => initialOffset(data, today));
  const t = parseISO(today);
  const { y, m } = useMemo(() => {
    const total = t.y * 12 + (t.m - 1) + (mode === 'month' ? offset : 0);
    return { y: mode === 'year' ? t.y + offset : Math.floor(total / 12), m: (total % 12) + 1 };
  }, [mode, offset, t.y, t.m]);
  const period = mode === 'month' ? monthPeriod(y, m) : yearPeriod(y);
  const short = mode === 'month' ? `${MONTHS[m - 1]} ${y}` : String(y);
  const title =
    mode === 'year'
      ? offset === 0
        ? 'Your plan for this year'
        : `Your plan for ${y}`
      : offset === 0
        ? 'Your plan for this month'
        : `Your plan for ${MONTHS_FULL[m - 1]}`;

  const cash = cashForecast(data, period);
  const soon = cashForecast(data, { start: today, end: addDays(today, 14) }).totalPaise;
  const counted = data.commitments.filter((c) => countsTowardForecast(c.status));
  const nx = nextOf(counted, today);
  const greeting =
    hourIST() < 12 ? 'Good morning' : hourIST() < 17 ? 'Good afternoon' : 'Good evening';
  const phrase = !data.commitments.length
    ? 'Add something whenever you’re ready.'
    : nx && daysBetween(today, nx.nextDue) <= 2
      ? 'A date is close. Everything is here when you want to look.'
      : 'You have time to review everything.';

  // status strip
  const monthCash = cashForecast(data, monthPeriod(t.y, t.m)).totalPaise;
  const b = data.budget;
  const msgs: string[] = [];
  let tone: '' | 'review' | 'flag' = '';
  const overdue = markedOverdue(data);
  if (overdue.length) {
    msgs.push(
      `You marked ${overdue.length} ${overdue.length === 1 ? 'item' : 'items'} as overdue. The dates are listed whenever you want to look.`,
    );
    tone = 'flag';
  }
  const opt = discretionaryRunRatePaise(data);
  if (b.enabled && b.discretionaryMonthlyCapPaise && opt > b.discretionaryMonthlyCapPaise) {
    msgs.push(
      `Your optional plans are ${formatINR(opt - b.discretionaryMonthlyCapPaise)} above your chosen limit. Review them when you’re ready.`,
    );
    tone = tone || 'review';
  }
  if (b.enabled && b.overallMonthlyCapPaise && monthCash > b.overallMonthlyCapPaise) {
    msgs.push(
      'Some commitments are higher than your planning target. We’ll help you see the dates clearly.',
    );
    tone = tone || 'review';
  }
  if (!msgs.length) {
    msgs.push(
      b.enabled && (b.overallMonthlyCapPaise || b.discretionaryMonthlyCapPaise)
        ? 'You’re on track with the limits you set.'
        : 'You’re in control. Nothing will be paid from here.',
    );
  }
  const stripLead = tone === 'flag' ? 'Marked overdue. ' : tone === 'review' ? 'For review. ' : '';

  const offersTile = offersTileText(data, today, catalog);
  const seasonsNext = data.seasons
    .filter((s) => s.end >= today)
    .sort((a, b2) => a.start.localeCompare(b2.start))[0];

  return (
    <div className="page">
      <header className="top">
        <div className="word">
          <span className="mark" aria-hidden="true">
            D
          </span>
          Due
        </div>
        <div className="icons">
          <a
            className="iconbtn"
            href="#/settings"
            aria-label="Privacy and settings"
            title="Privacy and settings"
          >
            <Icon name="shield" />
          </a>
          <a className="iconbtn" href="#/settings" aria-label="Settings" title="Settings">
            <Icon name="gear" />
          </a>
        </div>
      </header>

      <section className="hello">
        <h1>{greeting}. Let’s take one calm look.</h1>
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
            <button aria-label={`Previous ${mode}`} onClick={() => setOffset(offset - 1)}>
              ‹
            </button>
            <span>{short}</span>
            <button aria-label={`Next ${mode}`} onClick={() => setOffset(offset + 1)}>
              ›
            </button>
          </div>
        </div>
      </section>

      {data.commitments.length === 0 ? (
        <section className="summary onboarding" aria-labelledby="onbT">
          <h2 id="onbT">Add your first commitment</h2>
          <p>
            Due starts empty. Add a subscription, EMI, card statement, school fee or bill, and
            you’ll see what is due and when. Nothing is paid from here.
          </p>
          <div className="actions">
            <button
              className="btn primary"
              onClick={() => nav.go({ name: 'add', type: 'subscription' })}
            >
              Add your first commitment
            </button>
            <a className="linkbtn" href="#/import">
              Or import a CSV
            </a>
          </div>
          <p className="muted small">What you enter stays in this browser.</p>
        </section>
      ) : (
        <section className="summary" aria-labelledby="sumT">
          <h2 id="sumT">{title}</h2>
          <div className="planned">
            <b className="amt">{formatINR(cash.totalPaise)}</b>
            <span>planned</span>
          </div>
          <p className="muted">{phrase}</p>
          <div className="facts">
            <div className="fact">
              <b className="amt">{formatINR(soon)}</b>
              <small>due in the next 14 days</small>
            </div>
            <div className="fact">
              <b>{data.commitments.length}</b>
              <small>
                {data.commitments.length === 1 ? 'commitment listed' : 'commitments listed'}
              </small>
            </div>
            <div className="fact">
              <b>
                {nx
                  ? `${nx.nickname || nx.provider} · ${shortDate(nx.nextDue)}`
                  : 'Nothing upcoming'}
              </b>
              <small>next date</small>
            </div>
          </div>
          <div className="softline">
            <span className="muted small">
              Based on what you entered. Some amounts may be estimates.
            </span>
            <a className="linkbtn" href="#/calc">
              How this is calculated
            </a>
          </div>
        </section>
      )}

      <div className={`strip ${tone}`} role="status">
        <Icon name={tone === 'flag' ? 'flag' : tone === 'review' ? 'info' : 'leaf'} />
        <span className="stack">
          {msgs.map((msg, i) => (
            <span key={msg}>
              {i === 0 && stripLead && <b>{stripLead}</b>}
              {msg}
            </span>
          ))}
        </span>
      </div>

      <nav className="tiles" aria-label="Commitment categories">
        {TILES.map((tile) => {
          const items = counted.filter((c) => c.type === tile.type);
          let sub = tile.emptySub;
          let line = tile.emptyAct;
          if (items.length) {
            const n = items.length;
            const amount =
              tile.type === 'subscription'
                ? `${formatINR(items.reduce((a, c) => a + (monthlyEquivalentPaise(c) ?? 0), 0))}/month`
                : formatINR(items.reduce((a, c) => a + (c.amountPaise ?? 0), 0));
            sub = `${n} ${n === 1 ? tile.one : tile.many} · ${amount}`;
            const nn = nextOf(items, today);
            line = nn
              ? `${tile.type === 'subscription' ? 'Next review' : tile.type === 'credit_card' || tile.type === 'school_fee' ? 'Due' : 'Next due'} · ${shortDate(nn.nextDue)}`
              : '';
          }
          return (
            <a key={tile.type} className={`tile c-${tile.color}`} href={`#/category/${tile.type}`}>
              <span className="ic">
                <Icon name={tile.icon} />
              </span>
              <strong>{tile.name}</strong>
              <span className="sub amt">{sub}</span>
              <span className="line">{line}</span>
            </a>
          );
        })}
        <a className="tile c-coral" href="#/seasons">
          <span className="ic">
            <Icon name="sun" />
          </span>
          <strong>Seasonal plans</strong>
          <span className="sub">
            {data.seasons.length
              ? `${data.seasons.length} ${data.seasons.length === 1 ? 'season' : 'seasons'} planned`
              : 'Plan only when you need it'}
          </span>
          <span className="line">
            {seasonsNext
              ? `Starts · ${shortDate(seasonsNext.start)}`
              : data.seasons.length
                ? ''
                : 'Add a season'}
          </span>
        </a>
        <a className={`tile c-sky ${offersTile.tone ? 'tile-review' : ''}`} href="#/offers">
          <span className="ic">
            <Icon name="gift" />
          </span>
          <strong>Due &amp; Offers</strong>
          <span className="sub">{offersTile.sub}</span>
          <span className="line">
            {offersTile.tone && <span aria-hidden="true">△ </span>}
            {offersTile.line}
          </span>
        </a>
      </nav>

      <div className="cta">
        <button
          className="btn primary"
          onClick={() => nav.go({ name: 'add', type: 'subscription' })}
        >
          + Add a commitment
        </button>
        <div className="links">
          <a className="linkbtn" href="#/calendar">
            View calendar
          </a>
          <a className="linkbtn" href="#/budget">
            Set a limit
          </a>
          <a className="linkbtn" href="#/reminders">
            Manage reminders
          </a>
        </div>
      </div>

      <footer className="foot">
        <details className="pnote">
          <summary>
            <Icon name="shield" /> Your information stays under your control
          </summary>
          <p>
            Due does not make payments or connect to your bank in this version. What you enter stays
            in this browser.
          </p>
        </details>
        <span className="muted small">Today is {formatDate(today)} (IST)</span>
      </footer>
    </div>
  );
}
