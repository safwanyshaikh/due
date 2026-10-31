import { useMemo } from 'react';
import { obligationViews } from '../../lib/home';
import type { CommitmentType } from '../../lib/types';
import { useApp } from '../store';
import { TILE_BY_TYPE } from '../tiles';
import { ObligationList } from '../components/lists';

/**
 * The list view behind each Home tile (#/all/<type>) and the full list (#/all). The category tiles
 * themselves live on Home; this page is only the filterable list.
 */
export function AllPage({ type }: { type?: CommitmentType }) {
  const { data, today } = useApp();
  const views = useMemo(() => obligationViews(data, today, data.settings.timezone), [data, today]);
  const tile = type ? TILE_BY_TYPE[type] : undefined;
  return (
    <div className="page2">
      <header className="page-head">
        <h1>{tile ? tile.name : 'All due items'}</h1>
        <p className="muted">Ordered by date. Use the filters to narrow the list.</p>
        <div className="btn-row">
          <a className="btn btn-primary press jelly" href={type ? `#/add/${type}` : '#/add'}>
            {tile ? tile.add : 'Add due item'}
          </a>
          <a className="btn btn-quiet press" href="#/">
            Back to Home
          </a>
        </div>
      </header>

      <section aria-labelledby="all-list" className="stack-16">
        <h2 id="all-list" className="sr-only">
          Every item
        </h2>
        <ObligationList key={type ?? ''} views={views} initialType={type ?? ''} idPrefix="all" />
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
