import { useApp } from './store';
import { monthPeriod, parseISO } from '../lib/dates';
import { cashForecast, linkedParentMap, runRate } from '../lib/totals';
import { formatINR } from '../lib/money';

export function CalcView() {
  const { data, today } = useApp();
  const t = parseISO(today);
  const n = t.m === 12 ? { y: t.y + 1, m: 1 } : { y: t.y, m: t.m + 1 };
  const months = [monthPeriod(t.y, t.m), monthPeriod(n.y, n.m)];
  const rr = runRate(data);
  const linked = linkedParentMap(data);
  const linkedNames = data.commitments
    .filter((c) => linked.has(c.id))
    .map((c) => c.nickname || c.provider);
  return (
    <div className="page">
      <h1>How this is calculated</h1>
      {months.map((p) => {
        const c = cashForecast(data, p);
        return (
          <section className="panel" key={p.start}>
            <h2>Planned (cash due), {p.start.slice(0, 7)}</h2>
            <p className="bignum amt">{formatINR(c.totalPaise)}</p>
            <p className="muted">
              Amounts scheduled for their due dates in this month. A card statement counts once.
              {c.unknownAmountCount
                ? ` ${c.unknownAmountCount} item(s) have no amount yet, so they aren’t included.`
                : ''}
              {c.estimateCount ? ` ${c.estimateCount} amount(s) are estimates.` : ''}
            </p>
          </section>
        );
      })}
      <section className="panel">
        <h2>Monthly run-rate</h2>
        <p className="bignum amt">{formatINR(rr.totalPaise)}</p>
        <p className="muted">
          A planning figure. Quarterly and yearly plans are spread across their months, so it isn’t
          what leaves your account in any one month. One-time items stay at their real dates and
          aren’t included.
        </p>
      </section>
      {linkedNames.length > 0 && (
        <section className="panel">
          <h2>Not counted twice</h2>
          <p className="note">
            {linkedNames.join(', ')} {linkedNames.length === 1 ? 'is' : 'are'} already included in a
            card statement, so {linkedNames.length === 1 ? 'it isn’t' : 'they aren’t'} added again.
          </p>
        </section>
      )}
      <p className="muted small">
        Everything comes from what you entered. Nothing is checked with a lender, school, merchant
        or card issuer.
      </p>
    </div>
  );
}
