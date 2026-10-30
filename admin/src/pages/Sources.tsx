import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, asList, asObject, qs } from '../lib/api';
import { useApi, useAction } from '../lib/useApi';
import { useCan } from '../lib/auth';
import { sourcePayload, type SourceInput } from '../lib/payloads';
import type { Company, FetchRun, Snapshot, Source } from '../lib/types';
import { checkedEvery, formatIST, frequencyToMinutes, humanize, minutesToFrequency, type FrequencyUnit } from '../lib/format';
import { Badge, ExternalLink, Field, JsonBlock, LiveStatus, Loadable, PageHeader, TableWrap, statusTone } from '../components/ui';
import { SourceStatusCell } from './Companies';

export const SOURCE_CATEGORIES = [
  'official_site',
  'product_page',
  'pricing',
  'terms',
  'press',
  'news',
  'rss',
  'help',
  'api',
  'document',
  'social',
  'secondary',
] as const;
export const EXTRACTION_METHODS = ['html_text', 'rss', 'json', 'sitemap'] as const;
export const PRIORITIES = ['critical', 'regular', 'secondary'] as const;
const STATUSES = ['active', 'failing', 'blocked_robots', 'inaccessible', 'disabled'] as const;

function useCompanies() {
  const r = useApi<unknown>('/admin/companies?limit=500');
  return asList<Company>(r.data, 'companies');
}

export function SourceForm({
  source,
  companies,
  defaultCompanyId,
  onSubmit,
  onCancel,
}: {
  source?: Source;
  companies: Company[];
  defaultCompanyId?: string;
  onSubmit: (body: ReturnType<typeof sourcePayload>) => Promise<boolean>;
  onCancel: () => void;
}) {
  const initialFreq = source ? minutesToFrequency(source.frequencyMinutes) : { amount: 7, unit: 'days' as FrequencyUnit };
  const [f, setF] = useState({
    companyId: source?.companyId ?? defaultCompanyId ?? '',
    url: source?.url ?? '',
    label: source?.label ?? '',
    sourceCategory: source?.sourceCategory ?? 'official_site',
    isOfficial: source?.isOfficial ?? true,
    extractionMethod: source?.extractionMethod ?? 'html_text',
    cssSelector: source?.cssSelector ?? '',
    priority: source?.priority ?? 'regular',
    enabled: source?.enabled ?? true,
  });
  const [amount, setAmount] = useState(String(initialFreq.amount));
  const [unit, setUnit] = useState<FrequencyUnit>(initialFreq.unit);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!f.companyId) return setError('Choose a company or vendor.');
    if (!/^https?:\/\//i.test(f.url.trim())) return setError('URL must start with http:// or https://');
    const minutes = frequencyToMinutes(Number(amount), unit);
    if (minutes < 60) return setError('Frequency must be at least 1 hour.');
    const input: SourceInput = { ...f, frequencyMinutes: minutes };
    setBusy(true);
    const ok = await onSubmit(sourcePayload(input));
    setBusy(false);
    if (!ok) return;
  }

  const minutesPreview = frequencyToMinutes(Number(amount), unit);
  return (
    <form className="card form-grid" onSubmit={submit} noValidate aria-label={source ? 'Edit source' : 'Add source'}>
      <h2 className="span-2">{source ? 'Edit source' : 'Add source'}</h2>
      <Field label="Company or vendor">
        {(id) => (
          <select id={id} value={f.companyId} onChange={(e) => set('companyId', e.target.value)} disabled={!!source}>
            <option value="">Choose…</option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind})
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="URL">{(id) => <input id={id} type="url" value={f.url} onChange={(e) => set('url', e.target.value)} placeholder="https://" required />}</Field>
      <Field label="Label">{(id) => <input id={id} value={f.label} onChange={(e) => set('label', e.target.value)} />}</Field>
      <Field label="Category">
        {(id) => (
          <select id={id} value={f.sourceCategory} onChange={(e) => set('sourceCategory', e.target.value)}>
            {SOURCE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Extraction method">
        {(id) => (
          <select id={id} value={f.extractionMethod} onChange={(e) => set('extractionMethod', e.target.value as Source['extractionMethod'])}>
            {EXTRACTION_METHODS.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="CSS selector" hint="Optional. Limits HTML text extraction to matching elements.">
        {(id, hint) => <input id={id} aria-describedby={hint} value={f.cssSelector} onChange={(e) => set('cssSelector', e.target.value)} />}
      </Field>
      <Field label="Priority">
        {(id) => (
          <select id={id} value={f.priority} onChange={(e) => set('priority', e.target.value as Source['priority'])}>
            {PRIORITIES.map((c) => (
              <option key={c} value={c}>
                {humanize(c)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <fieldset className="freq">
        <legend>Check frequency</legend>
        <div className="row">
          <Field label="Every">
            {(id) => <input id={id} type="number" min={1} step={1} value={amount} onChange={(e) => setAmount(e.target.value)} />}
          </Field>
          <Field label="Unit">
            {(id) => (
              <select id={id} value={unit} onChange={(e) => setUnit(e.target.value as FrequencyUnit)}>
                <option value="hours">Hours</option>
                <option value="days">Days</option>
              </select>
            )}
          </Field>
        </div>
        <p className="hint" data-testid="freq-preview">
          {minutesPreview > 0 ? `${checkedEvery(minutesPreview)} (${minutesPreview} minutes)` : 'Enter a positive number.'}
        </p>
      </fieldset>
      <div className="span-2 checks">
        <label className="check">
          <input type="checkbox" checked={f.isOfficial} onChange={(e) => set('isOfficial', e.target.checked)} /> Official source
        </label>
        <label className="check">
          <input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled
        </label>
      </div>
      <div className="span-2">
        <div role="status" aria-live="polite">
          {error ? <p className="msg msg-error">{error}</p> : null}
        </div>
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : 'Save source'}
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}

function SourceActions({ s, onChanged, setResult }: { s: Source; onChanged: () => void; setResult?: (v: unknown) => void }) {
  const action = useAction();
  async function validate() {
    const r = await action.run(() => api.post(`/admin/sources/${s.id}/validate`), 'Validation finished.');
    if (r !== undefined) setResult?.(r);
    onChanged();
  }
  async function run(label: string) {
    await action.run(() => api.post(`/admin/sources/${s.id}/run`), `${label} requested. Results refreshed.`);
    onChanged();
  }
  async function toggle() {
    await action.run(() => api.patch(`/admin/sources/${s.id}`, { enabled: !s.enabled }), s.enabled ? 'Source disabled.' : 'Source enabled.');
    onChanged();
  }
  return (
    <div className="row-actions">
      <button className="btn btn-small" type="button" onClick={validate} disabled={action.busy}>
        Validate
      </button>
      <button className="btn btn-small" type="button" onClick={() => run('Run')} disabled={action.busy}>
        Run now
      </button>
      {s.status === 'failing' || s.status === 'inaccessible' ? (
        <button className="btn btn-small" type="button" onClick={() => run('Retry')} disabled={action.busy}>
          Retry
        </button>
      ) : null}
      <button className="btn btn-small" type="button" onClick={toggle} disabled={action.busy}>
        {s.enabled ? 'Disable' : 'Enable'}
      </button>
      <LiveStatus status={action.status} />
    </div>
  );
}

export function SourcesPage() {
  const [params, setParams] = useSearchParams();
  const companyId = params.get('companyId') ?? '';
  const status = params.get('status') ?? '';
  const [adding, setAdding] = useState(params.get('add') === '1');
  const [editing, setEditing] = useState<Source | null>(null);
  const canEdit = useCan('edit');
  const companies = useCompanies();
  const list = useApi<unknown>(`/admin/sources${qs({ companyId, status, limit: '500' })}`);
  const sources = asList<Source>(list.data, 'sources');
  const nameOf = (id: string) => companies.find((c) => c.id === id)?.name;
  const action = useAction();

  function setFilter(k: string, v: string) {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete('add');
    setParams(next);
  }

  async function save(body: ReturnType<typeof sourcePayload>, id?: string) {
    const r = await action.run(() => (id ? api.patch(`/admin/sources/${id}`, body) : api.post('/admin/sources', body)), 'Source saved.');
    if (r === undefined) return false;
    setAdding(false);
    setEditing(null);
    list.reload();
    return true;
  }

  return (
    <>
      <PageHeader
        title="Sources"
        actions={
          canEdit ? (
            <button className="btn btn-primary" type="button" onClick={() => setAdding(true)}>
              Add source
            </button>
          ) : null
        }
      >
        Sources are polled on a schedule. Each one shows how often it is checked.
      </PageHeader>
      <LiveStatus status={action.status} />
      {canEdit && (adding || editing) ? (
        <SourceForm
          key={editing?.id ?? 'new'}
          source={editing ?? undefined}
          companies={companies}
          defaultCompanyId={companyId}
          onSubmit={(b) => save(b, editing?.id)}
          onCancel={() => {
            setAdding(false);
            setEditing(null);
          }}
        />
      ) : null}
      <div className="filters">
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
        <Field label="Status">
          {(id) => (
            <select id={id} value={status} onChange={(e) => setFilter('status', e.target.value)}>
              <option value="">All</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Loadable
        loading={list.loading}
        error={list.error}
        empty={sources.length === 0}
        emptyText={companyId || status ? 'No sources match these filters.' : 'No sources yet — add the first one'}
      >
        <TableWrap label="Sources">
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Company</th>
              <th scope="col">Priority</th>
              <th scope="col">Schedule</th>
              <th scope="col">Status</th>
              <th scope="col">Last checked</th>
              {canEdit ? <th scope="col">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/sources/${s.id}`}>{s.label || s.url}</Link>
                  <div className="small muted break">{s.url}</div>
                </td>
                <td>{s.companyName || nameOf(s.companyId) || '—'}</td>
                <td>{humanize(s.priority)}</td>
                <td>{s.enabled ? checkedEvery(s.frequencyMinutes) : 'Disabled'}</td>
                <td>
                  <SourceStatusCell s={s} />
                </td>
                <td>{formatIST(s.lastCheckedAt)}</td>
                {canEdit ? (
                  <td>
                    <button className="btn btn-small" type="button" onClick={() => setEditing(s)}>
                      Edit
                    </button>
                    <SourceActions s={s} onChanged={list.reload} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
    </>
  );
}

function DiffView({ a, b }: { a: string; b: string }) {
  const diff = useApi<{ added?: string[]; removed?: string[] }>(`/admin/snapshots/${b}/diff${qs({ against: a })}`);
  const added = asList<string>(diff.data?.added);
  const removed = asList<string>(diff.data?.removed);
  return (
    <Loadable loading={diff.loading} error={diff.error}>
      {added.length === 0 && removed.length === 0 ? (
        <div className="empty">No line differences between these snapshots.</div>
      ) : (
        <div className="diff" aria-label="Snapshot differences">
          <p className="small muted">
            {added.length} added, {removed.length} removed
          </p>
          <ul>
            {removed.map((l, i) => (
              <li key={`r${i}`} className="diff-removed">
                <span className="sr-only">Removed: </span>− {l}
              </li>
            ))}
            {added.map((l, i) => (
              <li key={`a${i}`} className="diff-added">
                <span className="sr-only">Added: </span>+ {l}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Loadable>
  );
}

function SnapshotView({ id }: { id: string }) {
  const snap = useApi<unknown>(`/admin/snapshots/${id}`);
  const s = snap.data ? asObject<Snapshot>(snap.data, 'snapshot') : null;
  return (
    <Loadable loading={snap.loading} error={snap.error} empty={!s}>
      {s ? (
        <div>
          <p className="small muted">
            {s.title || 'Untitled'} · fetched {formatIST(s.fetchedAt)} · HTTP {s.httpStatus ?? '—'}
          </p>
          <pre className="json snapshot-text">{s.textContent || 'No text captured.'}</pre>
        </div>
      ) : null}
    </Loadable>
  );
}

export function SourceDetailPage() {
  const { id = '' } = useParams();
  const canEdit = useCan('edit');
  const list = useApi<unknown>(`/admin/sources/${id}`);
  const runs = useApi<unknown>(`/admin/sources/${id}/runs`);
  const snaps = useApi<unknown>(`/admin/sources/${id}/snapshots`);
  const companies = useCompanies();
  const [validateResult, setValidateResult] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [diffA, setDiffA] = useState('');
  const [diffB, setDiffB] = useState('');
  const [showDiff, setShowDiff] = useState<{ a: string; b: string } | null>(null);
  const [viewSnap, setViewSnap] = useState<string | null>(null);
  const action = useAction();

  const source = list.data && typeof list.data === 'object' && 'id' in list.data ? (list.data as Source) : null;
  const runList = asList<FetchRun>(runs.data, 'runs');
  const snapList = asList<Snapshot>(snaps.data, 'snapshots');
  const company = source ? companies.find((c) => c.id === source.companyId) : undefined;

  function refresh() {
    list.reload();
    runs.reload();
    snaps.reload();
  }

  async function save(body: ReturnType<typeof sourcePayload>) {
    const r = await action.run(() => api.patch(`/admin/sources/${id}`, body), 'Source saved.');
    if (r === undefined) return false;
    setEditing(false);
    refresh();
    return true;
  }

  return (
    <Loadable loading={list.loading} error={list.error} empty={!source} emptyText="That source could not be found.">
      {source ? (
        <>
          <p className="small">
            <Link to="/sources">← Back to sources</Link>
          </p>
          <PageHeader
            title={source.label || source.url}
            actions={
              canEdit ? (
                <button className="btn" type="button" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
                  Edit
                </button>
              ) : null
            }
          >
            {company ? <Link to={`/companies/${company.id}`}>{company.name}</Link> : source.companyName} ·{' '}
            {source.enabled ? checkedEvery(source.frequencyMinutes) : 'Disabled'}
          </PageHeader>
          <LiveStatus status={action.status} />
          {editing && canEdit ? <SourceForm source={source} companies={companies} onSubmit={save} onCancel={() => setEditing(false)} /> : null}
          <section className="card">
            <dl className="kv">
              <dt>URL</dt>
              <dd className="break">
                <ExternalLink href={source.url} />
              </dd>
              <dt>Category</dt>
              <dd>
                {humanize(source.sourceCategory)} {source.isOfficial ? <Badge tone="accent">Official</Badge> : <Badge>Unofficial</Badge>}
              </dd>
              <dt>Extraction</dt>
              <dd>
                {humanize(source.extractionMethod)}
                {source.cssSelector ? ` · selector ${source.cssSelector}` : ''}
              </dd>
              <dt>Priority</dt>
              <dd>{humanize(source.priority)}</dd>
              <dt>Status</dt>
              <dd>
                <SourceStatusCell s={source} />
              </dd>
              <dt>Last checked</dt>
              <dd>{formatIST(source.lastCheckedAt)}</dd>
              <dt>Last success</dt>
              <dd>{formatIST(source.lastSuccessAt)}</dd>
              <dt>Last change</dt>
              <dd>{formatIST(source.lastChangeAt)}</dd>
              <dt>Next check</dt>
              <dd>{source.enabled ? formatIST(source.nextCheckAt, 'Not scheduled') : 'Disabled'}</dd>
              <dt>Consecutive failures</dt>
              <dd>{source.consecutiveFailures ?? 0}</dd>
              {source.lastError ? (
                <>
                  <dt>Last error</dt>
                  <dd className="error-text">{source.lastError}</dd>
                </>
              ) : null}
            </dl>
            {canEdit ? <SourceActions s={source} onChanged={refresh} setResult={setValidateResult} /> : null}
            {validateResult ? (
              <div>
                <h3>Validation result</h3>
                <JsonBlock value={validateResult} />
              </div>
            ) : null}
          </section>

          <section className="card">
            <h2>Fetch runs</h2>
            <Loadable loading={runs.loading} error={runs.error} empty={runList.length === 0} emptyText="No fetch runs yet.">
              <TableWrap label="Fetch runs">
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Finished</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">HTTP</th>
                    <th scope="col">Attempt</th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {runList.map((r) => (
                    <tr key={r.id}>
                      <td>{formatIST(r.startedAt)}</td>
                      <td>{formatIST(r.finishedAt, '—')}</td>
                      <td>
                        <Badge tone={statusTone(r.outcome)}>{humanize(r.outcome)}</Badge>
                      </td>
                      <td>{r.httpStatus ?? '—'}</td>
                      <td>{r.attempt ?? '—'}</td>
                      <td className="error-text">{r.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </Loadable>
          </section>

          <section className="card">
            <h2>Snapshots</h2>
            <p className="muted small">A snapshot is stored only when the content changes.</p>
            <Loadable loading={snaps.loading} error={snaps.error} empty={snapList.length === 0} emptyText="No snapshots yet.">
              <TableWrap label="Snapshots">
                <thead>
                  <tr>
                    <th scope="col">Fetched</th>
                    <th scope="col">Title</th>
                    <th scope="col">HTTP</th>
                    <th scope="col">Size</th>
                    <th scope="col">View</th>
                  </tr>
                </thead>
                <tbody>
                  {snapList.map((s) => (
                    <tr key={s.id}>
                      <td>{formatIST(s.fetchedAt)}</td>
                      <td>{s.title || '—'}</td>
                      <td>{s.httpStatus ?? '—'}</td>
                      <td>{s.bytes != null ? `${s.bytes} bytes` : '—'}</td>
                      <td>
                        <button className="btn btn-small" type="button" onClick={() => setViewSnap(String(s.id))}>
                          View text
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
              {viewSnap ? (
                <div className="subcard">
                  <div className="row between">
                    <h3>Snapshot text</h3>
                    <button className="btn btn-small" type="button" onClick={() => setViewSnap(null)}>
                      Close
                    </button>
                  </div>
                  <SnapshotView id={viewSnap} />
                </div>
              ) : null}
              {snapList.length >= 2 ? (
                <form
                  className="filters"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (diffA && diffB && diffA !== diffB) setShowDiff({ a: diffA, b: diffB });
                  }}
                >
                  <Field label="Compare older snapshot">
                    {(fid) => (
                      <select id={fid} value={diffA} onChange={(e) => setDiffA(e.target.value)}>
                        <option value="">Choose…</option>
                        {snapList.map((s) => (
                          <option key={s.id} value={String(s.id)}>
                            {formatIST(s.fetchedAt)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <Field label="With newer snapshot">
                    {(fid) => (
                      <select id={fid} value={diffB} onChange={(e) => setDiffB(e.target.value)}>
                        <option value="">Choose…</option>
                        {snapList.map((s) => (
                          <option key={s.id} value={String(s.id)}>
                            {formatIST(s.fetchedAt)}
                          </option>
                        ))}
                      </select>
                    )}
                  </Field>
                  <button className="btn" type="submit" disabled={!diffA || !diffB || diffA === diffB}>
                    Show differences
                  </button>
                </form>
              ) : null}
              {showDiff ? <DiffView key={`${showDiff.a}-${showDiff.b}`} a={showDiff.a} b={showDiff.b} /> : null}
            </Loadable>
          </section>
        </>
      ) : null}
    </Loadable>
  );
}
