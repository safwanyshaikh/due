import { useSavings } from './SavingsProvider';
import { rupees } from './format';
import { useT } from '../lib/lang';
import './savings.css';

/** What Home shows about savings: the monthly figure and how many moves, or nothing yet. */
export function useFoundSummary(): { found: boolean; monthly: number; moves: number } {
  const { foundMonthlyInr, open } = useSavings();
  const found = open.length > 0 && foundMonthlyInr > 0;
  return { found, monthly: foundMonthlyInr, moves: open.length };
}

/** Small "Savings" link, shown in Home's summary card while no move has been found. */
export function HomeSavingsEntry() {
  return (
    <a className="sv-home-entry press" href="#/savings" data-testid="home-savings">
      Savings
    </a>
  );
}

/**
 * The hero of Home once a move exists: the number first, always visible on a phone (never just "Savings").
 * Information only: "you could save", never a promise.
 */
export function HomeSavingsHero() {
  const { found, monthly, moves } = useFoundSummary();
  const t = useT();
  if (!found) return null;
  return (
    <a className="sv-hero press" href="#/savings" data-testid="home-savings">
      <span className="sv-hero-text">
        <span className="sv-hero-fig amt">
          {rupees(monthly)}
          {t('home.perMonth')}
        </span>
        <span className="sv-hero-lbl">
          {moves === 1 ? t('home.found1') : t('home.foundN', { n: moves })}
        </span>
      </span>
      <span className="sv-hero-go">{t('home.seeHow')}</span>
    </a>
  );
}
