import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, asList, asObject, qs } from '../lib/api';
import { useApi, useAction } from '../lib/useApi';
import { useCan } from '../lib/auth';
import { companyPayload, type CompanyInput } from '../lib/payloads';
import type { Category, Company, CompanyKind, DataRecord, Intel, Source } from '../lib/types';
import { checkedEvery, formatIST, humanize, inaccessibleReason, sourceStatusText } from '../lib/format';
import { PROVIDER_FAMILIES, familyLabel } from '../lib/offers';
import { Badge, ExternalLink, Field, JsonBlock, LiveStatus, Loadable, PageHeader, TableWrap, Tabs, statusTone } from '../components/ui';

const KIND_LABEL: Record<CompanyKind, { one: string; many: string }> = {
  company: { one: 'company', many: 'Companies' },
  vendor: { one: 'vendor', many: 'Vendors' },
};

const emptyCompany = (kind: CompanyKind): CompanyInput => ({
  kind,
  name: '',
  officialWebsite: '',
  country: '',
  categoryId: '',
  description: '',
  monitoringEnabled: true,
  providerFamily: '',
});

function fromCompany(c: Company): CompanyInput {
  return {
    kind: c.kind,
    name: c.name ?? '',
    officialWebsite: c.officialWebsite ?? '',
    country: c.country ?? '',
    categoryId: c.categoryId ?? '',
    description: c.description ?? '',
    monitoringEnabled: !!c.monitoringEnabled,
    providerFamily: c.providerFamily ?? '',
  };
}

export function CompanyForm({
  initial,
  existingId,
  onDone,
  onCancel,
}: {
  initial: CompanyInput;
  existingId?: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<CompanyInput>(initial);
  const cats = useApi<unknown>('/admin/categories?limit=500');
  const categories = asList<Category>(cats.data, 'categories');
  const action = useAction();
  const set = <K extends keyof CompanyInput>(k: K, v: CompanyInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      action.setStatus({ kind: 'error', text: 'Name is required.' });
      return;
    }
    if (form.officialWebsite.trim() && !/^https?:\/\//i.test(form.officialWebsite.trim())) {
      action.setStatus({ kind: 'error', text: 'Website must start with http:// or https://' });
      return;
    }
    const body = companyPayload(form);
    const ok = await action.run(
      () => (existingId ? api.patch(`/admin/companies/${existingId}`, body) : api.post('/admin/companies', body)),
      'Saved.',
    );
    if (ok !== undefined) onDone();
  }

  const label = KIND_LABEL[form.kind].one;
  return (
    <form className="card form-grid" onSubmit={submit} noValidate aria-label={existingId ? `Edit ${label}` : `Add ${label}`}>
      <h2 className="span-2">{existingId ? `Edit ${label}` : `Add ${label}`}</h2>
      <Field label="Name">{(id) => <input id={id} value={form.name} onChange={(e) => set('name', e.target.value)} required />}</Field>
      <Field label="Official website">
        {(id) => <input id={id} type="url" placeholder="https://" value={form.officialWebsite} onChange={(e) => set('officialWebsite', e.target.value)} />}
      </Field>
      <Field label="Country">{(id) => <input id={id} value={form.country} onChange={(e) => set('country', e.target.value)} />}</Field>
      <Field label="Category">
        {(id) => (
          <select id={id} value={form.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Provider family" hint="Groups providers for offer intelligence and plan matching.">
        {(id, h) => (
          <select id={id} aria-describedby={h} value={form.providerFamily ?? ''} onChange={(e) => set('providerFamily', e.target.value)}>
            <option value="">No family</option>
            {PROVIDER_FAMILIES.map((f) => (
              <option key={f} value={f}>
                {familyLabel(f)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <div className="span-2">
        <Field label="Description">
          {(id) => <textarea id={id} rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />}
        </Field>
      </div>
      <label className="check span-2">
        <input type="checkbox" checked={form.monitoringEnabled} onChange={(e) => set('monitoringEnabled', e.target.checked)} /> Monitoring on
      </label>
      <div className="span-2">
        <LiveStatus status={action.status} />
        <div className="actions">
          <button className="btn btn-primary" type="submit" disabled={action.busy}>
            {action.busy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </form>
  );
}

export function VerifyForm({ id, current, onDone }: { id: string; current: string; onDone: () => void }) {
  const [status, setStatus] = useState(current === 'unverified' ? 'pending' : current);
  const [note, setNote] = useState('');
  const action = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await action.run(() => api.post(`/admin/companies/${id}/verify`, { status, note }), 'Verification updated.');
    if (r !== undefined) onDone();
  }
  return (
    <form className="inline-form" onSubmit={submit}>
      <Field label="Verification status">
        {(fid) => (
          <select id={fid} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="pending">Pending</option>
            <option value="verified">Verified</option>
            <option value="rejected">Rejected</option>
            <option value="unverified">Unverified</option>
          </select>
        )}
      </Field>
      <Field label="Note">{(fid) => <input id={fid} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
      <button className="btn btn-primary" type="submit" disabled={action.busy}>
        Save verification
      </button>
      <LiveStatus status={action.status} />
    </form>
  );
}

export function CompaniesPage() {
  const [params, setParams] = useSearchParams();
  const kind: CompanyKind = params.get('kind') === 'vendor' ? 'vendor' : 'company';
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [editing, setEditing] = useState<{ id?: string; input: CompanyInput } | null>(null);
  const canEdit = useCan('edit');
  const action = useAction();
  const list = useApi<unknown>(`/admin/companies${qs({ kind, q: query, status, limit: '500' })}`);
  const items = asList<Company>(list.data, 'companies');
  const labels = KIND_LABEL[kind];

  useEffect(() => setEditing(null), [kind]);

  async function archive(c: Company) {
    if (!window.confirm(`Archive ${c.name}? Monitoring stops for archived ${labels.many.toLowerCase()}.`)) return;
    await action.run(() => api.post(`/admin/companies/${c.id}/archive`), `${c.name} archived.`);
    list.reload();
  }

  return (
    <>
      <PageHeader
        title="Companies & vendors"
        actions={
          canEdit ? (
            <button className="btn btn-primary" type="button" onClick={() => setEditing({ input: emptyCompany(kind) })}>
              Add {labels.one}
            </button>
          ) : null
        }
      />
      <Tabs
        label="Kind"
        value={kind}
        onChange={(v) => setParams(v === 'vendor' ? { kind: 'vendor' } : {})}
        options={[
          { value: 'company', label: 'Companies' },
          { value: 'vendor', label: 'Vendors' },
        ]}
      />
      {editing && canEdit ? (
        <CompanyForm
          key={editing.id ?? 'new'}
          initial={editing.input}
          existingId={editing.id}
          onCancel={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            list.reload();
          }}
        />
      ) : null}
      <form
        className="filters"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim());
        }}
      >
        <Field label="Search">{(id) => <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name or website" />}</Field>
        <Field label="Status">
          {(id) => (
            <select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="active">Active</option>
              <option value="archived">Archived</option>
            </select>
          )}
        </Field>
        <button className="btn" type="submit">
          Search
        </button>
      </form>
      <LiveStatus status={action.status} />
      <Loadable
        loading={list.loading}
        error={list.error}
        empty={items.length === 0}
        emptyText={query || status ? `No ${labels.many.toLowerCase()} match these filters.` : `No ${labels.many.toLowerCase()} yet — add the first one`}
      >
        <TableWrap label={labels.many}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Website</th>
              <th scope="col">Country</th>
              <th scope="col">Family</th>
              <th scope="col">Status</th>
              <th scope="col">Verification</th>
              <th scope="col">Monitoring</th>
              {canEdit ? <th scope="col">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link to={`/companies/${c.id}`}>{c.name}</Link>
                </td>
                <td>
                  <ExternalLink href={c.officialWebsite} />
                </td>
                <td>{c.country || '—'}</td>
                <td>{c.providerFamily ? familyLabel(c.providerFamily) : '—'}</td>
                <td>{humanize(c.status)}</td>
                <td>
                  <Badge tone={statusTone(c.verificationStatus)}>{humanize(c.verificationStatus)}</Badge>
                </td>
                <td>{c.monitoringEnabled ? 'On' : 'Off'}</td>
                {canEdit ? (
                  <td className="row-actions">
                    <button className="btn btn-small" type="button" onClick={() => setEditing({ id: c.id, input: fromCompany(c) })}>
                      Edit
                    </button>
                    {c.status !== 'archived' ? (
                      <button className="btn btn-small" type="button" onClick={() => archive(c)} disabled={action.busy}>
                        Archive
                      </button>
                    ) : null}
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

type CompanyDetail = Company & { sources?: Source[]; records?: DataRecord[]; recentRecords?: DataRecord[]; intel?: Intel[] };

export function SourceStatusCell({ s }: { s: Source }) {
  return (
    <>
      <Badge tone={statusTone(s.status)}>{sourceStatusText(s.status, s.lastError)}</Badge>
      {s.status === 'inaccessible' ? (
        <div className="small muted">
          Source inaccessible: {inaccessibleReason(s.lastError)}, last checked {formatIST(s.lastCheckedAt)}
        </div>
      ) : null}
    </>
  );
}

export function CompanyDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const detail = useApi<unknown>(`/admin/companies/${id}`);
  const canEdit = useCan('edit');
  const [editing, setEditing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const action = useAction();
  const c = detail.data ? asObject<CompanyDetail>(detail.data, 'company') : null;
  const sources = asList<Source>(c?.sources);
  const records = asList<DataRecord>(c?.recentRecords ?? c?.records);
  const intel = asList<Intel>(c?.intel);

  async function archive() {
    if (!c || !window.confirm(`Archive ${c.name}?`)) return;
    await action.run(() => api.post(`/admin/companies/${c.id}/archive`), 'Archived.');
    detail.reload();
  }

  return (
    <Loadable loading={detail.loading} error={detail.error} empty={!c}>
      {c ? (
        <>
          <p className="small">
            <Link to={c.kind === 'vendor' ? '/companies?kind=vendor' : '/companies'}>← Back to {KIND_LABEL[c.kind]?.many ?? 'list'}</Link>
          </p>
          <PageHeader
            title={c.name}
            actions={
              canEdit ? (
                <>
                  <button className="btn" type="button" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
                    Edit
                  </button>
                  <button className="btn" type="button" onClick={() => setVerifying((v) => !v)} aria-expanded={verifying}>
                    Verify
                  </button>
                  {c.status !== 'archived' ? (
                    <button className="btn" type="button" onClick={archive} disabled={action.busy}>
                      Archive
                    </button>
                  ) : null}
                  <button className="btn btn-primary" type="button" onClick={() => navigate(`/sources?companyId=${c.id}&add=1`)}>
                    Add source
                  </button>
                </>
              ) : null
            }
          >
            {humanize(c.kind)} · {humanize(c.status)} · <Badge tone={statusTone(c.verificationStatus)}>{humanize(c.verificationStatus)}</Badge>
          </PageHeader>
          <LiveStatus status={action.status} />
          {editing && canEdit ? (
            <CompanyForm
              initial={fromCompany(c)}
              existingId={c.id}
              onCancel={() => setEditing(false)}
              onDone={() => {
                setEditing(false);
                detail.reload();
              }}
            />
          ) : null}
          {verifying && canEdit ? (
            <div className="card">
              <VerifyForm
                id={c.id}
                current={c.verificationStatus}
                onDone={() => {
                  setVerifying(false);
                  detail.reload();
                }}
              />
            </div>
          ) : null}
          <section className="card">
            <dl className="kv">
              <dt>Website</dt>
              <dd>
                <ExternalLink href={c.officialWebsite} />
              </dd>
              <dt>Country</dt>
              <dd>{c.country || '—'}</dd>
              <dt>Category</dt>
              <dd>{c.categoryName || '—'}</dd>
              <dt>Provider family</dt>
              <dd>{c.providerFamily ? familyLabel(c.providerFamily) : '—'}</dd>
              <dt>Monitoring</dt>
              <dd>{c.monitoringEnabled ? 'On' : 'Off'}</dd>
              <dt>Verification</dt>
              <dd>
                {c.verificationStatus === 'verified' ? `Verified ${formatIST(c.verifiedAt, '')}` : c.verificationStatus === 'pending' ? 'Verification pending' : humanize(c.verificationStatus)}
                {c.verificationNote ? <div className="muted small">{c.verificationNote}</div> : null}
              </dd>
              <dt>Description</dt>
              <dd>{c.description || '—'}</dd>
            </dl>
          </section>

          <section className="card">
            <h2>Sources</h2>
            {sources.length === 0 ? (
              <div className="empty">No sources yet{canEdit ? ' — add the first one' : ''}.</div>
            ) : (
              <TableWrap label="Sources">
                <thead>
                  <tr>
                    <th scope="col">Source</th>
                    <th scope="col">Category</th>
                    <th scope="col">Schedule</th>
                    <th scope="col">Status</th>
                    <th scope="col">Last checked</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((s) => (
                    <tr key={s.id}>
                      <td>
                        <Link to={`/sources/${s.id}`}>{s.label || s.url}</Link>
                        <div className="small muted break">{s.url}</div>
                      </td>
                      <td>
                        {humanize(s.sourceCategory)}
                        {s.isOfficial ? ' · Official' : ''}
                      </td>
                      <td>{s.enabled ? checkedEvery(s.frequencyMinutes) : 'Disabled'}</td>
                      <td>
                        <SourceStatusCell s={s} />
                      </td>
                      <td>{formatIST(s.lastCheckedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </section>

          <section className="card">
            <h2>Recently collected records</h2>
            {records.length === 0 ? (
              <div className="empty">Data unavailable — nothing collected yet.</div>
            ) : (
              <TableWrap label="Recent records">
                <thead>
                  <tr>
                    <th scope="col">Title</th>
                    <th scope="col">Type</th>
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
                      <td>{humanize(r.recordType)}</td>
                      <td>{formatIST(r.lastSeenAt)}</td>
                      <td>
                        <Badge tone={statusTone(r.verificationStatus)}>{humanize(r.verificationStatus)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </section>

          <section className="card">
            <h2>Research intelligence (verification pending)</h2>
            <p className="muted small">Research-derived notes. Read-only and not yet verified against the official source.</p>
            {intel.length === 0 ? (
              <div className="empty">Data unavailable</div>
            ) : (
              <ul className="intel-list">
                {intel.map((it) => (
                  <li key={it.id} className="intel">
                    <div className="intel-head">
                      <Badge tone="accent">{humanize(it.kind)}</Badge>
                      <Badge tone={statusTone(it.verificationStatus ?? 'pending')}>{humanize(it.verificationStatus ?? 'pending')}</Badge>
                    </div>
                    <JsonBlock value={it.data} />
                    <p className="small muted">
                      Source: <ExternalLink href={it.sourceUrl} /> · fetched {formatIST(it.fetchedAt, 'time not recorded')}
                      {it.method ? ` · method: ${humanize(it.method)}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </Loadable>
  );
}
