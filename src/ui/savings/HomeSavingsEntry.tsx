import { useSavings } from './SavingsProvider';
import { perMonth } from './format';
import './savings.css';

/** One compact link in Home's summary card. It never adds a row, so the eight tiles stay in view. */
export function HomeSavingsEntry() {
  const { foundMonthlyInr, open } = useSavings();
  const found = open.length > 0 && foundMonthlyInr > 0;
  return (
    <a className="sv-home-entry press" href="#/savings" data-testid="home-savings">
      {found ? (
        <>
          <span className="amt">{perMonth(foundMonthlyInr)}</span> found
        </>
      ) : (
        'Savings'
      )}
    </a>
  );
}
