import { useEffect } from 'react';
import {
  COMPARE_AS_OF,
  COMPARE_COLUMNS,
  COMPARE_ROWS,
  MARK_LABEL,
  MARK_SYMBOL,
  WHY_DUE,
} from '../../content/compare';
import { usePublicLegal } from '../lib/platform';
import './compare.css';

/** Simple original illustrations (inline SVG, no external images). */
function Art({ kind }: { kind: 'phone' | 'ranked' | 'both' }) {
  const common = {
    width: 56,
    height: 56,
    viewBox: '0 0 56 56',
    role: 'img',
    'aria-hidden': true,
  } as const;
  if (kind === 'phone')
    return (
      <svg {...common}>
        <rect
          x="16"
          y="6"
          width="24"
          height="44"
          rx="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
        />
        <rect x="21" y="14" width="14" height="3" rx="1.5" fill="currentColor" opacity=".5" />
        <rect x="21" y="21" width="14" height="3" rx="1.5" fill="currentColor" opacity=".5" />
        <path
          d="M22 35l4 4 8-9"
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  if (kind === 'ranked')
    return (
      <svg {...common}>
        <rect x="8" y="30" width="10" height="18" rx="3" fill="currentColor" opacity=".45" />
        <rect x="23" y="20" width="10" height="28" rx="3" fill="currentColor" opacity=".7" />
        <rect x="38" y="8" width="10" height="40" rx="3" fill="currentColor" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="19" cy="24" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <rect
        x="27"
        y="22"
        width="22"
        height="20"
        rx="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      <path
        d="M12 46c1-6 6-9 12-9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CompareScreen() {
  const legal = usePublicLegal();
  const support = legal.state === 'ok' ? legal.value.supportEmail : null;
  useEffect(() => {
    const prev = document.title;
    document.title =
      'How Due is different: Due compared with CRED, INDmoney, Rocket Money and Monarch Money';
    return () => {
      document.title = prev;
    };
  }, []);
  return (
    <div className="page2 compare" data-testid="compare">
      <header className="compare-hero">
        <p className="eyebrow">Compare</p>
        <h1>How Due is different</h1>
        <p className="hero-sub">
          Same life. Smaller bills. Here is how Due sits next to four well-known apps, in plain
          words.
        </p>
      </header>

      <div
        className="compare-scroll"
        tabIndex={0}
        role="region"
        aria-label="Comparison table, scrolls sideways"
      >
        <table className="compare-table">
          <caption className="sr-only">
            Due compared with CRED, INDmoney, Rocket Money and Monarch Money, as of {COMPARE_AS_OF}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="compare-sticky">
                As of {COMPARE_AS_OF}
              </th>
              {COMPARE_COLUMNS.map((c) => (
                <th key={c} scope="col" className={c === 'Due' ? 'compare-due' : undefined}>
                  {c}
                  {c === 'Due' && <span className="compare-chip">Due</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COMPARE_ROWS.map((r) => (
              <tr key={r.id}>
                <th scope="row" className="compare-sticky">
                  {r.label}
                </th>
                {COMPARE_COLUMNS.map((c) => {
                  const cell = r.cells[c];
                  return (
                    <td
                      key={c}
                      className={c === 'Due' ? 'compare-due' : undefined}
                      data-mark={cell.mark}
                    >
                      <span className={`mark mark-${cell.mark}`}>
                        <span aria-hidden="true">{MARK_SYMBOL[cell.mark]}</span>
                        <span className="sr-only">{MARK_LABEL[cell.mark]}: </span>
                      </span>
                      <span className="note">{cell.note}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small compare-foot" data-testid="compare-footnote">
        Comparison based on public information as of {COMPARE_AS_OF}; features change.{' '}
        {support ? (
          <>
            Write to us to correct anything: <a href={`mailto:${support}`}>{support}</a>.
          </>
        ) : (
          'Write to us to correct anything, using the support contact under Settings, Legal.'
        )}{' '}
        “Not stated” means we have not found it in public information. Names belong to their owners.
      </p>
      <p className="muted small" data-testid="compare-sources">
        Sources: Due’s research notes of 23 Nov 2026 (competitor audit; “our rating” is Due’s own 0
        to 5 judgment from public information, not a measurement) and a first-run check of each app
        on 26 Nov 2026, using public pages, store listings and press reviews.
      </p>

      <section className="why-grid" aria-labelledby="why-h">
        <h2 id="why-h">Why Due</h2>
        <ul>
          {WHY_DUE.map((w) => (
            <li key={w.id} className="why-card">
              <span className="why-art">
                <Art kind={w.id as 'phone' | 'ranked' | 'both'} />
              </span>
              <h3>{w.title}</h3>
              <p>{w.body}</p>
            </li>
          ))}
        </ul>
        <div className="btn-row">
          <a className="btn btn-primary press" href="/#/start">
            Open Due
          </a>
        </div>
      </section>
    </div>
  );
}
