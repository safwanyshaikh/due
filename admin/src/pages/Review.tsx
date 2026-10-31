import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { formatIST, humanize } from '../lib/format';
import { show, type ReviewItem } from '../lib/offers';
import { useAction, useApi } from '../lib/useApi';
import { Badge, ExternalLink, Field, LiveStatus, Loadable, PageHeader, Tabs, statusTone } from '../components/ui';

type Tab = 'pending' | 'approved' | 'rejected';

function ReviewCard({ item, canDecide, onDone }: { item: ReviewItem; canDecide: boolean; onDone: () => void }) {
  const [note, setNote] = useState('');
  const action = useAction();
  async function decide(kind: 'approve' | 'reject') {
    const r = await action.run(
      () => api.post(`/admin/review/${item.id}/${kind}`, { note: note.trim() || null }),
      kind === 'approve' ? 'Approved and applied to the offer.' : 'Rejected. The offer is unchanged.',
    );
    if (r !== undefined) onDone();
  }
  const keys = Object.keys(item.proposed);
  return (
    <article className="card" aria-label={`Change ${item.id}`}>
      <h2>
        {humanize(item.changeKind)} change ·{' '}
        {item.offerId ? <Link to={`/offers/${item.offerId}`}>{item.offerName ?? item.offerId}</Link> : 'New offer'}{' '}
        <Badge tone={statusTone(item.status)}>{humanize(item.status)}</Badge>
      </h2>
      <table className="diff">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Current</th>
            <th scope="col">Observed</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <th scope="row">{humanize(k)}</th>
              <td>{show(item.current[k])}</td>
              <td>{show(item.proposed[k])}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        From <ExternalLink href={item.sourceUrl}>{item.sourceLabel ?? item.sourceUrl ?? 'unknown source'}</ExternalLink>
        {item.parserVersion ? ` · parser ${item.parserVersion}` : ''} · queued {formatIST(item.createdAt)}
      </p>
      {item.status !== 'pending' ? (
        <p className="small">
          {humanize(item.status)} by {item.decidedByEmail ?? 'unknown'} on {formatIST(item.decidedAt)}
          {item.note ? ` — ${item.note}` : ''}
        </p>
      ) : canDecide ? (
        <div className="inline-form">
          <Field label="Note (kept in the audit log)">{(id) => <input id={id} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />}</Field>
          <button className="btn btn-primary" type="button" disabled={action.busy} onClick={() => decide('approve')}>
            Approve
          </button>
          <button className="btn" type="button" disabled={action.busy} onClick={() => decide('reject')}>
            Reject
          </button>
        </div>
      ) : (
        <p className="muted small">Read-only. Editors can approve or reject changes.</p>
      )}
      <LiveStatus status={action.status} />
    </article>
  );
}

export function ReviewPage() {
  const [params] = useSearchParams();
  const offerId = params.get('offerId') ?? undefined;
  const [tab, setTab] = useState<Tab>('pending');
  const res = useApi<{ items: ReviewItem[]; total: number; counts: Record<string, number> }>(`/admin/review${qs({ status: tab, offerId, limit: 100 })}`);
  const canDecide = useCan('edit');
  const items = res.data?.items ?? [];
  return (
    <>
      <PageHeader title="Change review">
        Price, eligibility, expiry and status changes found by the engine wait here. Nothing is applied until an Editor approves it; every decision is audited.
      </PageHeader>
      <Tabs
        label="Review status"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'pending', label: `Pending${res.data?.counts?.pending ? ` (${res.data.counts.pending})` : ''}` },
          { value: 'approved', label: 'Approved' },
          { value: 'rejected', label: 'Rejected' },
        ]}
      />
      {offerId ? (
        <p className="muted">
          Showing changes for <code>{offerId}</code>. <Link to="/review">Show all</Link>
        </p>
      ) : null}
      <Loadable loading={res.loading} error={res.error} empty={items.length === 0} emptyText="Nothing here.">
        {items.map((i) => (
          <ReviewCard key={i.id} item={i} canDecide={canDecide} onDone={res.reload} />
        ))}
      </Loadable>
    </>
  );
}
