import { pendingImports, describeImportItem } from '../../lib/imports';
import { findDuplicateSuggestions, mergeDuplicates, dismissDuplicate } from '../../lib/duplicates';
import { findObligation } from '../../lib/obligations';
import { exportStructuredRecord } from '../../lib/intake';
import { EMAIL_INGESTION_COPY } from '../../content/privacy';
import { useApp } from '../store';
import { ReviewCard } from '../components/ReviewCard';
import { useImportActions } from '../components/importActions';
import { Badge } from '../components/ui';
import { Glyph, type GlyphName } from '../components/Glyph';
import { download } from '../common';
import { localDateTime } from '../lib/format';

const SOURCES: { href: string; icon: GlyphName; title: string; body: string }[] = [
  {
    href: '#/upload',
    icon: 'upload',
    title: 'Upload a bill or letter',
    body: 'PDF or text, read in your browser',
  },
  { href: '#/forward', icon: 'mail', title: 'Forward an email', body: 'To your own Due address' },
  { href: '#/sms', icon: 'sms', title: 'Share one SMS', body: 'Paste a single message' },
  { href: '#/csv', icon: 'grid', title: 'CSV file', body: 'Several items at once' },
];

/** Import hub and review queue: Approve, Edit, Ignore, Undo, raw provenance, duplicate merges. */
export function ImportScreen() {
  const { data, mutate, ctx } = useApp();
  const actions = useImportActions();
  const pending = pendingImports(data);
  const dupes = findDuplicateSuggestions(data);
  const handled = (data.importQueue ?? [])
    .filter((i) => i.status === 'approved' || i.status === 'ignored')
    .slice(-10)
    .reverse();

  return (
    <div className="page2">
      <header className="page-head">
        <h1>Import</h1>
        <p className="muted">
          Nothing is saved until you approve it. Every field shows how sure Due is.
        </p>
      </header>

      <ul className="paths paths-compact" aria-label="Ways to import">
        {SOURCES.map((s) => (
          <li key={s.href}>
            <a className="path press" href={s.href}>
              <span className="path-icon">
                <Glyph name={s.icon} />
              </span>
              <span className="path-text">
                <strong>{s.title}</strong>
                <span className="muted small">{s.body}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
      <p className="muted small ingest-inline">{EMAIL_INGESTION_COPY}</p>

      <section aria-labelledby="queue-title" className="stack-16">
        <div className="section-head">
          <h2 id="queue-title">Review queue</h2>
          <Badge>{pending.length} to review</Badge>
        </div>
        {pending.length === 0 ? (
          <p className="muted">Nothing waiting. Imported items appear here for approval.</p>
        ) : (
          pending.map((item) => {
            const ue = (data.userEvents ?? []).find((u) => u.id === item.userEventId) ?? null;
            return (
              <ReviewCard
                key={item.id}
                item={item}
                userEvent={ue}
                headingLevel={3}
                actions={{
                  confirmLabel: 'Approve',
                  onConfirm: (edits, opts) => actions.approve(item, edits, opts),
                  onSaveEdits: (edits) => actions.saveEdits(item, edits),
                  onIgnore: () => actions.ignore(item),
                  onDelete:
                    item.raw.text || item.raw.row ? () => actions.deleteRaw(item) : undefined,
                  deleteLabel: 'Delete raw text',
                  onExport: ue
                    ? () =>
                        download(
                          `due-record-${item.id}.json`,
                          exportStructuredRecord(ue, { exportedAt: new Date().toISOString() }),
                          'application/json',
                        )
                    : undefined,
                }}
              />
            );
          })
        )}
      </section>

      <section aria-labelledby="dup-title" className="stack-16">
        <h2 id="dup-title">Possible duplicates</h2>
        {dupes.length === 0 ? (
          <p className="muted">No duplicates or merchant aliases to review.</p>
        ) : (
          <ul className="attn-list">
            {dupes.map((s) => {
              const obs = s.ids.map((id) => findObligation(data, id));
              return (
                <li key={s.key} className="attn">
                  <div>
                    <strong>{obs.map((o) => o?.nickname || o?.provider).join(' and ')}</strong>
                    <p className="muted small">
                      {s.reason} <Badge>{s.confidence} confidence</Badge>
                    </p>
                  </div>
                  <div className="btn-row">
                    {obs.map((o) =>
                      o ? (
                        <button
                          key={o.id}
                          type="button"
                          className="btn btn-secondary btn-sm press"
                          onClick={() => mutate((d) => mergeDuplicates(d, s, o.id, ctx()))}
                        >
                          Merge, keep “{o.nickname || o.provider}”
                        </button>
                      ) : null,
                    )}
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm press"
                      onClick={() => mutate((d) => dismissDuplicate(d, s, ctx()))}
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {handled.length > 0 && (
        <section aria-labelledby="done-title" className="stack-16">
          <h2 id="done-title">Recently handled</h2>
          <ul className="plain-list">
            {handled.map((i) => (
              <li key={i.id}>
                <span>{describeImportItem(i)}</span>{' '}
                <Badge tone={i.status === 'approved' ? 'calm' : 'plain'}>
                  {i.status === 'approved' ? 'Approved' : 'Ignored'}
                </Badge>{' '}
                <span className="muted small">
                  {i.resolvedAt ? localDateTime(i.resolvedAt, data.settings.timezone) : ''}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">
            Use Undo right after an action, or open an item’s history to undo later.
          </p>
        </section>
      )}
    </div>
  );
}
