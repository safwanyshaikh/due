import { useMemo } from 'react';
import { obligationViews } from '../../lib/home';
import { forecastObligations } from '../../lib/obligations';
import type { CommitmentType } from '../../lib/types';
import { useApp } from '../store';
import { TILES } from '../tiles';
import { Icon } from '../Icon';
import { ObligationList } from '../components/lists';
import { offersTileText } from '../lib/offersTile';
import { useCatalog } from '../offers/catalogStore';

/** The dedicated All page: compact category tiles (secondary) and the full filterable list. */
export function AllPage({ type }: { type?: CommitmentType }) {
  const { data, today } = useApp();
  const { offers } = useCatalog();
  const views = useMemo(() => obligationViews(data, today, data.settings.timezone), [data, today]);
  const counted = forecastObligations(data);
  const offersTile = offersTileText(data, today, offers);
  return (
    <div className="page2">
      <header className="page-head">
        <h1>All due items</h1>
        <p className="muted">Ordered by date. Categories are filters, not a hierarchy.</p>
      </header>

      <section aria-labelledby="all-list" className="stack-16">
        <h2 id="all-list" className="sr-only">
          Every item
        </h2>
        <ObligationList views={views} initialType={type ?? ''} idPrefix="all" />
      </section>

      <section aria-labelledby="cat-title" className="stack-16">
        <h2 id="cat-title">Categories</h2>
        <nav className="ctiles" aria-label="Categories">
          {TILES.map((tile) => {
            const n = counted.filter((c) => c.type === tile.type).length;
            const on = type === tile.type;
            return (
              <a
                key={tile.type}
                className={`ctile c-${tile.color} press ${on ? 'is-on' : ''}`}
                href={on ? '#/all' : `#/all/${tile.type}`}
                aria-current={on ? 'page' : undefined}
              >
                <span className="ctile-ic">
                  <Icon name={tile.icon} />
                </span>
                <strong>{tile.name}</strong>
                <span className="small">
                  {n ? `${n} ${n === 1 ? tile.one : tile.many}` : tile.emptySub}
                </span>
              </a>
            );
          })}
          <a className="ctile c-coral press" href="#/seasons">
            <span className="ctile-ic">
              <Icon name="sun" />
            </span>
            <strong>Seasonal plans</strong>
            <span className="small">
              {data.seasons.length
                ? `${data.seasons.length} planned`
                : 'Plan only when you need it'}
            </span>
          </a>
          <a className="ctile c-sky press" href="#/offers">
            <span className="ctile-ic">
              <Icon name="gift" />
            </span>
            <strong>Due &amp; Offers</strong>
            <span className="small">{offersTile.line}</span>
          </a>
        </nav>
      </section>

      <nav className="more-links" aria-label="Planning tools">
        <a className="btn btn-quiet press" href="#/calendar">
          Calendar
        </a>
        <a className="btn btn-quiet press" href="#/budget">
          Limits
        </a>
        <a className="btn btn-quiet press" href="#/calc">
          How totals are calculated
        </a>
      </nav>
    </div>
  );
}
