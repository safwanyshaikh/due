import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { API_BASE, api, asList, asObject, qs } from '../lib/api';
import { useApi, useAction } from '../lib/useApi';
import { useCan } from '../lib/auth';
import type { Company, DataRecord, RecordVersion } from '../lib/types';
import { formatIST, humanize } from '../lib/format';
import { Badge, ExternalLink, Field, JsonBlock, LiveStatus, Loadable, PageHeader, TableWrap, statusTone } from '../components/ui';

const RECORD_TYPES = ['page', 'rss_item', 'announcement', 'price_mention'];

export function RecordsPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const companyId = params.get('companyId') ?? '';
  const type = params.get('type') ?? '';
  const [search, setSearch] = useState(q);
  const companies = asList<Company>(useApi<unknown>('/admin/companies?limit=500').data, 'companies');
  const list = useApi<unknown>(`/admin/records${qs({ q, status, companyId, type, limit: '500' })}`);
  const records = asList<DataRecord>(list.data, 'records');
  const nameOf = (id: string) => companies.find((c) => c.id === id)?.name;

  function setFilter(k: string, v: string) {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next);
  }

  return (
    <>
      <PageHeader
        title="Data"
        actions={
          <>
            <a className="btn" href={`${API_BASE}/admin/export/records.csv`} download>
              Export CSV
            </a>
            <a className="btn" href={`${API_BASE}/admin/export/records.json`} download>
              Export JSON
            </a>
          </>
        }
      >
        Collected records with source attribution. Exports include approved and pending records.
      </PageHeader>
      <form
        className="filters"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setFilter('q', search.trim());
        }}
      >
        <Field label="Search">{(id) => <input id={id} type="search" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
        <Field label="Review status">
          {(id) => (
            <select id={id} value={status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">All</option>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          )}
        </Field>
        <Field label="Company or vendor">
          {(id) => (
            <select id={id} value={companyId} onChange={(e) => setFilter('companyId', e.target.value)}>
              <option value="">All</option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Type">
          {(id) => (
            <select id={id} value={type} onChange={(e) => setFilter('type', e.target.value)}>
              <option value="">All</option>
              {RECORD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <button className="btn" type="submit">
          Search
        </button>
      </form>
      <Loadable
        loading={list.loading}
        error={list.error}
        empty={records.length === 0}
        emptyText={q || status || companyId || type ? 'No records match these filters.' : 'Data unavailable — no records collected yet.'}
      >
        <TableWrap label="Records">
          <thead>
            <tr>
              <th scope="col">Title</th>
              <th scope="col">Company</th>
              <th scope="col">Type</th>
              <th scope="col">First seen</th>
              <th scope="col">Last seen</th>
              <th scope="col">Review</th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link to={`/records/${r.id}`}>{r.title || r.url || 'Untitled'}</Link>
                </td>
                <td>{r.companyName || nameOf(r.companyId) || '—'}</td>
                <td>{humanize(r.recordType)}</td>
                <td>{formatIST(r.firstSeenAt)}</td>
                <td>{formatIST(r.lastSeenAt)}</td>
                <td>
                  <Badge tone={statusTone(r.verificationStatus)}>{humanize(r.verificationStatus)}</Badge>
                  {r.sensitive ? <Badge tone="review">Sensitive</Badge> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
    </>
  );
}

export function RecordDetailPage() {
  const { id = '' } = useParams();
  const detail = useApi<unknown>(`/admin/records/${id}`);
  const canEdit = useCan('edit');
  const review = useAction();
  const correct = useAction();
  const [note, setNote] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [corrNote, setCorrNote] = useState('');

  const r = detail.data ? asObject<DataRecord>(detail.data, 'record') : null;
  const versions = asList<RecordVersion>(r?.versions ?? (detail.data as { versions?: unknown } | null)?.versions)
    .slice()
    .sort((a, b) => b.version - a.version);

  async function decide(decision: 'approved' | 'rejected') {
    const ok = await review.run(() => api.post(`/admin/records/${id}/review`, { decision, note }), decision === 'approved' ? 'Record approved.' : 'Record rejected.');
    if (ok !== undefined) {
      setNote('');
      detail.reload();
    }
  }

  function startCorrect() {
    setTitle(r?.title ?? '');
    setSummary(r?.summary ?? '');
    setCorrNote('');
    setCorrecting(true);
  }

  async function submitCorrection(e: FormEvent) {
    e.preventDefault();
    if (!corrNote.trim()) {
      correct.setStatus({ kind: 'error', text: 'Add a note explaining the correction.' });
      return;
    }
    const ok = await correct.run(() => api.patch(`/admin/records/${id}`, { title, summary, note: corrNote }), 'Correction saved as a new version.');
    if (ok !== undefined) {
      setCorrecting(false);
      detail.reload();
    }
  }

  return (
    <Loadable loading={detail.loading} error={detail.error} empty={!r}>
      {r ? (
        <>
          <p className="small">
            <Link to="/records">← Back to data</Link>
          </p>
          <PageHeader title={r.title || 'Untitled record'}>
            {humanize(r.recordType)} · <Badge tone={statusTone(r.verificationStatus)}>{humanize(r.verificationStatus)}</Badge>
            {r.verificationStatus === 'pending' ? ' Verification pending' : ''}
          </PageHeader>
          <section className="card">
            <dl className="kv">
              <dt>Company</dt>
              <dd>
                <Link to={`/companies/${r.companyId}`}>{r.companyName || 'View company'}</Link>
              </dd>
              <dt>URL</dt>
              <dd className="break">
                <ExternalLink href={r.url} />
              </dd>
              <dt>Source</dt>
              <dd className="break">{r.sourceId ? <Link to={`/sources/${r.sourceId}`}>{r.sourceUrl || 'View source'}</Link> : '—'}</dd>
              <dt>Summary</dt>
              <dd>{r.summary || '—'}</dd>
              <dt>Published</dt>
              <dd>{formatIST(r.publishedAt, 'Not stated by source')}</dd>
              <dt>First seen</dt>
              <dd>{formatIST(r.firstSeenAt)}</dd>
              <dt>Last seen</dt>
              <dd>{formatIST(r.lastSeenAt)}</dd>
              <dt>Reviewed</dt>
              <dd>
                {r.reviewedAt ? formatIST(r.reviewedAt) : 'Not reviewed'}
                {r.reviewNote ? <div className="muted small">{r.reviewNote}</div> : null}
              </dd>
            </dl>
          </section>

          {canEdit ? (
            <section className="card">
              <h2>Review</h2>
              <Field label="Review note">{(fid) => <textarea id={fid} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
              <div className="actions">
                <button className="btn btn-primary" type="button" onClick={() => decide('approved')} disabled={review.busy}>
                  Approve
                </button>
                <button className="btn btn-danger" type="button" onClick={() => decide('rejected')} disabled={review.busy}>
                  Reject
                </button>
                <button className="btn" type="button" onClick={startCorrect} aria-expanded={correcting}>
                  Correct
                </button>
              </div>
              <LiveStatus status={review.status} />
              {correcting ? (
                <form className="subcard" onSubmit={submitCorrection} noValidate aria-label="Correct record">
                  <h3>Manual correction</h3>
                  <Field label="Title">{(fid) => <input id={fid} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
                  <Field label="Summary">{(fid) => <textarea id={fid} rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />}</Field>
                  <Field label="Correction note" hint="Required. Stored with the manual_correction version.">
                    {(fid, hint) => <input id={fid} aria-describedby={hint} value={corrNote} onChange={(e) => setCorrNote(e.target.value)} />}
                  </Field>
                  <LiveStatus status={correct.status} />
                  <div className="actions">
                    <button className="btn btn-primary" type="submit" disabled={correct.busy}>
                      Save correction
                    </button>
                    <button className="btn" type="button" onClick={() => setCorrecting(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : null}
            </section>
          ) : null}

          <section className="card">
            <h2>Version history</h2>
            {versions.length === 0 ? (
              <div className="empty">Data unavailable</div>
            ) : (
              <ol className="versions">
                {versions.map((v) => (
                  <li key={v.id}>
                    <div className="row">
                      <strong>Version {v.version}</strong>
                      <Badge tone={v.changeType === 'manual_correction' ? 'review' : 'neutral'}>{humanize(v.changeType)}</Badge>
                      <span className="muted small">
                        {formatIST(v.capturedAt)}
                        {v.changedByName ? ` · by ${v.changedByName}` : ''}
                      </span>
                    </div>
                    <JsonBlock value={v.data} />
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      ) : null}
    </Loadable>
  );
}
