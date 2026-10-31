/** Values for the eight Home tiles: a simple count · amount and next date, or a helpful empty state. */
import type { ObligationView } from '../../lib/home';
import { cashForecast } from '../../lib/totals';
import { monthPeriod, parseISO } from '../../lib/dates';
import type { AppData, CommitmentType, ISODate } from '../../lib/types';
import { TILE_BY_TYPE, type IconName, type TileColor } from '../tiles';
import { dayMonth, inr } from './format';

export type HomeTileKey = CommitmentType | 'offers' | 'seasons';

/** Launch tile order (LAUNCH_SPEC): never reorder without updating the e2e order test. */
export const HOME_TILE_ORDER: HomeTileKey[] = [
  'subscription',
  'emi',
  'credit_card',
  'other_loan',
  'bill',
  'school_fee',
  'offers',
  'seasons',
];

export interface HomeTile {
  key: HomeTileKey;
  name: string;
  href: string;
  color: TileColor;
  icon: IconName;
  count: number;
  /** "2 · ₹1,298 this month", or the empty-state line. */
  value: string;
  /** "Next 6 Nov", or a short hint for empty tiles. */
  sub: string;
  empty: boolean;
  /** Accessible summary read out for the tile link. */
  label: string;
}

const short = (d: ISODate) => {
  const x = dayMonth(d);
  return `${x.day} ${x.month}`;
};

export function homeTiles(
  data: AppData,
  views: ObligationView[],
  today: ISODate,
  offersLine: string,
): HomeTile[] {
  const t = parseISO(today);
  const month = cashForecast(data, monthPeriod(t.y, t.m));
  return HOME_TILE_ORDER.map((key): HomeTile => {
    if (key === 'offers') {
      const empty = !data.services.length;
      return {
        key,
        name: 'Due & Offers',
        href: '#/offers',
        color: 'sky',
        icon: 'gift',
        count: data.services.length,
        value: empty ? 'See benefits your plans may include' : offersLine,
        sub: empty ? 'Add a phone, OTT or card plan' : `${data.services.length} tracked`,
        empty,
        label: `Due & Offers: ${empty ? 'nothing tracked yet' : offersLine}`,
      };
    }
    if (key === 'seasons') {
      const n = data.seasons.length;
      const next = data.seasons
        .map((s) => s.start)
        .filter((d) => d >= today)
        .sort()[0];
      return {
        key,
        name: 'Seasonal plans',
        href: '#/seasons',
        color: 'coral',
        icon: 'sun',
        count: n,
        value: n ? `${n} planned` : 'Festivals, travel, school year',
        sub: n ? (next ? `Next ${short(next)}` : 'No upcoming dates') : 'Plan only when needed',
        empty: !n,
        label: `Seasonal plans: ${n ? `${n} planned${next ? `, next ${short(next)}` : ''}` : 'none yet'}`,
      };
    }
    const def = TILE_BY_TYPE[key];
    const mine = views.filter((v) => v.type === key);
    const n = mine.length;
    const monthPaise = month.items
      .filter((i) => i.commitment.type === key && i.amountPaise !== null)
      .reduce((a, i) => a + (i.amountPaise ?? 0), 0);
    const hasMonth = month.items.some((i) => i.commitment.type === key);
    const next = mine.find((v) => v.date)?.date ?? null;
    const amount = hasMonth ? `${inr(monthPaise)} this month` : 'nothing this month';
    return {
      key,
      name: def.name,
      href: `#/all/${key}`,
      color: def.color,
      icon: def.icon,
      count: n,
      value: n ? `${n} · ${amount}` : def.emptySub,
      sub: n ? (next ? `Next ${short(next)}` : 'No date yet') : def.emptyAct,
      empty: !n,
      label: n
        ? `${def.name}: ${n} ${n === 1 ? def.one : def.many}, ${amount}${next ? `, next ${short(next)}` : ''}`
        : `${def.name}: none yet. ${def.emptyAct}`,
    };
  });
}

/** Greeting and date context in India time (Asia/Kolkata), e.g. "Good evening" · "Fri, 30 Oct". */
export function greeting(
  now: Date = new Date(),
  tz = 'Asia/Kolkata',
): { hello: string; date: string } {
  let hour = 9;
  let date: string;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(
        now,
      ),
    );
    date = new Intl.DateTimeFormat('en-IN', {
      timeZone: tz,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(now);
  } catch {
    date = now.toDateString();
  }
  const hello =
    hour < 5
      ? 'Good evening'
      : hour < 12
        ? 'Good morning'
        : hour < 17
          ? 'Good afternoon'
          : 'Good evening';
  return { hello, date };
}
