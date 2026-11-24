import { useEffect, useState, type FormEvent } from 'react';
import { api, request } from '../lib/api';
import { useCan } from '../lib/auth';
import { formatIST, humanize } from '../lib/format';
import { useAction, useApi } from '../lib/useApi';
import { Badge, Field, LiveStatus, Loadable, PageHeader, TableWrap, Tabs, statusTone } from '../components/ui';

/* ---------- types (mirror of server/src/savings/types.ts; responses are requested raw, keys stay camelCase) ---------- */

export interface SavingsSource {
  url: string;
  label: string;
  kind: 'official' | 'press' | 'aggregator' | 'regulator' | 'user_shared';
  lastVerifiedAt: string | null;
}
export interface SavingsModuleRow {
  id: string;
  version: number;
  status: 'research' | 'verified' | 'retired';
  detect: { merchantAliases: string[]; senderDomains: string[]; keywords: string[] };
  provider: string;
  product: string;
  category: string;
  country: string;
  cityPack: string | null;
  rules: Record<string, unknown>;
  valueKind: string;
  proof: { signal: string; description: string };
  nudge: { trigger: string; leadDays: number };
  legalRole: string;
  sources: SavingsSource[];
  actionUrl: string | null;
  actionLabel: string | null;
  updatedAt: string;
}
interface PackRow {
  id: string;
  name: string;
  status: string;
  passes: unknown[];
  localities: string[];
  updatedAt: string;
}
interface ResearchItem {
  id: number;
  providerLabel: string;
  category: string;
  cityPack: string | null;
  requestCount: number;
  lastSeen: string;
  status: string;
  moduleId: string | null;
}

export const CATEGORIES = ['mobility', 'food', 'telecom', 'ott', 'music', 'cloud', 'shopping', 'card', 'loan', 'utility', 'other'];
export const VALUE_KINDS = ['membership_breakeven', 'period_switch', 'overlap', 'commute_pass', 'debt_rate', 'loan_switch', 'price_change', 'trial_end'];
export const PROOF_SIGNALS = ['amount_drop', 'charge_stopped', 'new_plan_charge', 'fewer_charges', 'user_confirmed'];
export const NUDGE_TRIGGERS = ['before_renewal', 'before_expiry', 'usage_drop', 'on_detect'];
export const LEGAL_ROLES = ['information', 'sponsored_disclosed', 'regulated_partner'];
export const SOURCE_KINDS = ['official', 'press', 'aggregator', 'regulator', 'user_shared'];
const RESEARCH_STATUSES = ['open', 'researching', 'done', 'rejected'];

/* ---------- form <-> module ---------- */

export interface SourceForm {
  url: string;
  label: string;
  kind: string;
  lastVerifiedAt: string; // YYYY-MM-DD or ''
}
export interface ModuleForm {
  id: string;
  provider: string;
  product: string;
  category: string;
  country: string;
  cityPack: string;
  merchantAliases: string;
  senderDomains: string;
  keywords: string;
  rulesJson: string;
  valueKind: string;
  proofSignal: string;
  proofDescription: string;
  nudgeTrigger: string;
  nudgeLeadDays: string;
  legalRole: string;
  sources: SourceForm[];
  actionUrl: string;
  actionLabel: string;
}

export const emptyForm = (): ModuleForm => ({
  id: '', provider: '', product: '', category: 'other', country: 'IN', cityPack: '',
  merchantAliases: '', senderDomains: '', keywords: '',
  rulesJson: '{}', valueKind: 'membership_breakeven',
  proofSignal: 'charge_stopped', proofDescription: '',
  nudgeTrigger: 'before_renewal', nudgeLeadDays: '3',
  legalRole: 'information',
  sources: [{ url: '', label: '', kind: 'official', lastVerifiedAt: '' }],
  actionUrl: '', actionLabel: '',
});

const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

export function moduleToForm(m: SavingsModuleRow): ModuleForm {
  return {
    id: m.id, provider: m.provider, product: m.product, category: m.category, country: m.country, cityPack: m.cityPack ?? '',
    merchantAliases: m.detect.merchantAliases.join('\n'), senderDomains: m.detect.senderDomains.join('\n'), keywords: m.detect.keywords.join('\n'),
    rulesJson: JSON.stringify(m.rules ?? {}, null, 2), valueKind: m.valueKind,
    proofSignal: m.proof.signal, proofDescription: m.proof.description,
    nudgeTrigger: m.nudge.trigger, nudgeLeadDays: String(m.nudge.leadDays),
    legalRole: m.legalRole,
    sources: m.sources.map((s) => ({ url: s.url, label: s.label, kind: s.kind, lastVerifiedAt: s.lastVerifiedAt ? s.lastVerifiedAt.slice(0, 10) : '' })),
    actionUrl: m.actionUrl ?? '', actionLabel: m.actionLabel ?? '',
  };
}

/** Request body for create/update, or an error message. Status is never sent: verification has its own action. */
export function formToModule(f: ModuleForm): { body: Record<string, unknown> } | { error: string } {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(f.id.trim())) return { error: 'Id must be a lowercase slug, like uber-one-in.' };
  if (!f.provider.trim() || !f.product.trim()) return { error: 'Provider and product are required.' };
  let rules: unknown;
  try {
    rules = JSON.parse(f.rulesJson || '{}');
  } catch {
    return { error: 'Rules must be valid JSON.' };
  }
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return { error: 'Rules must be a JSON object.' };
  const lead = Number(f.nudgeLeadDays);
  if (!Number.isInteger(lead) || lead < 0 || lead > 365) return { error: 'Lead days must be a whole number from 0 to 365.' };
  if (f.sources.length === 0) return { error: 'Add at least one source.' };
  for (const s of f.sources) {
    if (!/^https?:\/\//i.test(s.url.trim()) || !s.label.trim()) return { error: 'Every source needs an http(s) URL and a label.' };
    if (s.lastVerifiedAt && !/^\d{4}-\d{2}-\d{2}$/.test(s.lastVerifiedAt)) return { error: 'Last checked must be a date.' };
  }
  const action = f.actionUrl.trim();
  if (action && !/^https?:\/\//i.test(action)) return { error: 'Action URL must start with http:// or https://.' };
  return {
    body: {
      id: f.id.trim(),
      detect: { merchantAliases: lines(f.merchantAliases), senderDomains: lines(f.senderDomains), keywords: lines(f.keywords) },
      provider: f.provider.trim(), product: f.product.trim(), category: f.category, country: f.country.trim().toUpperCase(),
      cityPack: f.cityPack.trim() || null,
      rules,
      valueKind: f.valueKind,
      proof: { signal: f.proofSignal, description: f.proofDescription.trim() },
      nudge: { trigger: f.nudgeTrigger, leadDays: lead },
      legalRole: f.legalRole,
      sources: f.sources.map((s) => ({ url: s.url.trim(), label: s.label.trim(), kind: s.kind, lastVerifiedAt: s.lastVerifiedAt ? `${s.lastVerifiedAt}T00:00:00Z` : null })),
      actionUrl: action || null,
      actionLabel: f.actionLabel.trim() || null,
    },
  };
}

/* ---------- page ---------- */

type Tab = 'modules' | 'packs' | 'research';

export function SavingsPage() {
  const [tab, setTab] = useState<Tab>('modules');
  return (
    <>
      <PageHeader title="Savings">
        Public rules the savings engine uses. Information only: Due never pays, switches or cancels for anyone. Verified needs an official source checked in the last 30 days.
      </PageHeader>
      <Tabs
        label="Savings sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'modules', label: 'Modules' },
          { value: 'packs', label: 'City packs' },
          { value: 'research', label: 'Research queue' },
        ]}
      />
      {tab === 'modules' ? <ModulesTab /> : tab === 'packs' ? <PacksTab /> : <ResearchTab />}
    </>
  );
}

function ModulesTab() {
  const res = useApi<{ items: SavingsModuleRow[] }>('/admin/savings/modules', { raw: true });
  const canEdit = useCan('edit');
  const [editing, setEditing] = useState<{ module: SavingsModuleRow | null } | null>(null);
  const items = res.data?.items ?? [];
  return (
    <section aria-label="Modules">
      {canEdit ? (
        <p>
          <button className="btn" type="button" onClick={() => setEditing({ module: null })}>
            New module
          </button>
        </p>
      ) : null}
      <Loadable loading={res.loading} error={res.error} empty={items.length === 0} emptyText="No modules yet.">
        <TableWrap label="Savings modules">
          <thead>
            <tr>
              <th scope="col">Module</th>
              <th scope="col">Value</th>
              <th scope="col">Status</th>
              <th scope="col">Version</th>
              <th scope="col">Updated</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.product}
                  <div className="muted small">{m.id}</div>
                </td>
                <td>{humanize(m.valueKind)}</td>
                <td>
                  <Badge tone={statusTone(m.status)}>{humanize(m.status)}</Badge>
                </td>
                <td>{m.version}</td>
                <td>{formatIST(m.updatedAt)}</td>
                <td>
                  <button className="btn btn-ghost" type="button" onClick={() => setEditing({ module: m })} aria-label={`${canEdit ? 'Edit' : 'View'} ${m.product}`}>
                    {canEdit ? 'Edit' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
      {editing ? (
        <ModuleEditor
          key={editing.module?.id ?? 'new'}
          module={editing.module}
          canEdit={canEdit}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            res.reload();
          }}
          onChanged={res.reload}
        />
      ) : null}
    </section>
  );
}

function Select({ id, value, onChange, options, disabled }: { id: string; value: string; onChange: (v: string) => void; options: string[]; disabled?: boolean }) {
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {humanize(o)}
        </option>
      ))}
    </select>
  );
}

function ModuleEditor({
  module: m, canEdit, onClose, onSaved, onChanged,
}: { module: SavingsModuleRow | null; canEdit: boolean; onClose: () => void; onSaved: () => void; onChanged: () => void }) {
  const [f, setF] = useState<ModuleForm>(() => (m ? moduleToForm(m) : emptyForm()));
  const [current, setCurrent] = useState<SavingsModuleRow | null>(m);
  const action = useAction();
  const set = <K extends keyof ModuleForm>(k: K, v: ModuleForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const ro = !canEdit;
  const setSource = (i: number, patch: Partial<SourceForm>) => setF((p) => ({ ...p, sources: p.sources.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  async function save(e: FormEvent) {
    e.preventDefault();
    const r = formToModule(f);
    if ('error' in r) return action.setStatus({ kind: 'error', text: r.error });
    const saved = await action.run(
      () => (current ? request<SavingsModuleRow>(`/admin/savings/modules/${current.id}`, { method: 'PUT', body: r.body, raw: true }) : api.post<SavingsModuleRow>('/admin/savings/modules', r.body, { raw: true })),
      'Saved.',
    );
    if (saved) {
      setCurrent(saved);
      setF(moduleToForm(saved));
      onChanged();
    }
  }
  async function transition(kind: 'verify' | 'retire') {
    if (!current) return;
    const saved = await action.run(
      () => api.post<SavingsModuleRow>(`/admin/savings/modules/${current.id}/${kind}`, {}, { raw: true }),
      kind === 'verify' ? 'Marked verified.' : 'Retired. It no longer appears in the public catalog.',
    );
    if (saved) {
      setCurrent(saved);
      onChanged();
    }
  }

  return (
    <form className="card" onSubmit={save} aria-label={current ? `Module ${current.id}` : 'New module'}>
      <h2>{current ? current.product : 'New module'}</h2>
      {current ? (
        <p className="muted">
          Version {current.version} · <Badge tone={statusTone(current.status)}>{humanize(current.status)}</Badge>
        </p>
      ) : null}
      <fieldset disabled={ro}>
        <legend>Identify</legend>
        <Field label="Id" hint="Lowercase slug, cannot change later.">{(id) => <input id={id} value={f.id} disabled={ro || !!current} onChange={(e) => set('id', e.target.value)} />}</Field>
        <Field label="Provider">{(id) => <input id={id} value={f.provider} onChange={(e) => set('provider', e.target.value)} />}</Field>
        <Field label="Product">{(id) => <input id={id} value={f.product} onChange={(e) => set('product', e.target.value)} />}</Field>
        <Field label="Category">{(id) => <Select id={id} value={f.category} onChange={(v) => set('category', v)} options={CATEGORIES} />}</Field>
        <Field label="Country">{(id) => <input id={id} value={f.country} maxLength={2} onChange={(e) => set('country', e.target.value)} />}</Field>
        <Field label="City pack" hint="Leave empty for all cities.">{(id) => <input id={id} value={f.cityPack} onChange={(e) => set('cityPack', e.target.value)} />}</Field>
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Detect</legend>
        <Field label="Merchant aliases" hint="One per line.">{(id) => <textarea id={id} rows={3} value={f.merchantAliases} onChange={(e) => set('merchantAliases', e.target.value)} />}</Field>
        <Field label="Sender domains">{(id) => <textarea id={id} rows={2} value={f.senderDomains} onChange={(e) => set('senderDomains', e.target.value)} />}</Field>
        <Field label="Keywords">{(id) => <textarea id={id} rows={2} value={f.keywords} onChange={(e) => set('keywords', e.target.value)} />}</Field>
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Rules</legend>
        <Field label="Rules (JSON)" hint="Unknown numbers stay null; never guess a price.">
          {(id, d) => <textarea id={id} aria-describedby={d} rows={10} spellCheck={false} value={f.rulesJson} onChange={(e) => set('rulesJson', e.target.value)} />}
        </Field>
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Value</legend>
        <Field label="Value kind">{(id) => <Select id={id} value={f.valueKind} onChange={(v) => set('valueKind', v)} options={VALUE_KINDS} />}</Field>
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Proof</legend>
        <Field label="Proof signal">{(id) => <Select id={id} value={f.proofSignal} onChange={(v) => set('proofSignal', v)} options={PROOF_SIGNALS} />}</Field>
        <Field label="Proof description">{(id) => <input id={id} value={f.proofDescription} onChange={(e) => set('proofDescription', e.target.value)} />}</Field>
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Nudge</legend>
        <Field label="Nudge trigger">{(id) => <Select id={id} value={f.nudgeTrigger} onChange={(v) => set('nudgeTrigger', v)} options={NUDGE_TRIGGERS} />}</Field>
        <Field label="Lead days">{(id) => <input id={id} inputMode="numeric" value={f.nudgeLeadDays} onChange={(e) => set('nudgeLeadDays', e.target.value)} />}</Field>
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Legal</legend>
        <Field label="Legal role" hint="Phase 1: information only.">{(id) => <Select id={id} value={f.legalRole} onChange={(v) => set('legalRole', v)} options={LEGAL_ROLES} />}</Field>
        <Field label="Action URL" hint="Official page the person is sent to.">{(id) => <input id={id} value={f.actionUrl} onChange={(e) => set('actionUrl', e.target.value)} />}</Field>
        <Field label="Action label">{(id) => <input id={id} value={f.actionLabel} onChange={(e) => set('actionLabel', e.target.value)} />}</Field>
      </fieldset>
      <fieldset disabled={ro}>
        <legend>Sources</legend>
        {f.sources.map((s, i) => (
          <div key={i} className="source-row">
            <Field label={`Source ${i + 1} URL`}>{(id) => <input id={id} value={s.url} onChange={(e) => setSource(i, { url: e.target.value })} />}</Field>
            <Field label={`Source ${i + 1} label`}>{(id) => <input id={id} value={s.label} onChange={(e) => setSource(i, { label: e.target.value })} />}</Field>
            <Field label={`Source ${i + 1} kind`}>{(id) => <Select id={id} value={s.kind} onChange={(v) => setSource(i, { kind: v })} options={SOURCE_KINDS} />}</Field>
            <Field label={`Source ${i + 1} last checked`}>{(id) => <input id={id} type="date" value={s.lastVerifiedAt} onChange={(e) => setSource(i, { lastVerifiedAt: e.target.value })} />}</Field>
            {f.sources.length > 1 ? (
              <button className="btn btn-ghost" type="button" onClick={() => set('sources', f.sources.filter((_, j) => j !== i))}>
                Remove source {i + 1}
              </button>
            ) : null}
          </div>
        ))}
        <button className="btn btn-ghost" type="button" onClick={() => set('sources', [...f.sources, { url: '', label: '', kind: 'official', lastVerifiedAt: '' }])}>
          Add source
        </button>
      </fieldset>
      <LiveStatus status={action.status} />
      <div className="actions">
        {canEdit ? (
          <button className="btn" type="submit" disabled={action.busy}>
            Save module
          </button>
        ) : null}
        {canEdit && current && current.status !== 'verified' && current.status !== 'retired' ? (
          <button className="btn" type="button" disabled={action.busy} onClick={() => void transition('verify')}>
            Verify
          </button>
        ) : null}
        {canEdit && current && current.status !== 'retired' ? (
          <button className="btn btn-ghost" type="button" disabled={action.busy} onClick={() => void transition('retire')}>
            Retire
          </button>
        ) : null}
        <button className="btn btn-ghost" type="button" onClick={current ? onSaved : onClose}>
          Close
        </button>
      </div>
    </form>
  );
}

function PacksTab() {
  const res = useApi<{ items: PackRow[] }>('/admin/savings/city-packs', { raw: true });
  const canEdit = useCan('edit');
  const action = useAction();
  const [pick, setPick] = useState<string | null>(null); // pack id being edited, '' = new
  const [id, setId] = useState('');
  const [json, setJson] = useState('');
  const items = res.data?.items ?? [];

  function open(p: PackRow | null) {
    setPick(p ? p.id : '');
    setId(p ? p.id : '');
    const rest: Record<string, unknown> = { ...(p ?? { name: '', country: 'IN', localities: [], passes: [], typicalFareInr: {}, status: 'research' }) };
    delete rest.id;
    delete rest.updatedAt;
    setJson(JSON.stringify(rest, null, 2));
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id.trim())) return action.setStatus({ kind: 'error', text: 'Id must be a lowercase slug, like in-mmr.' });
    let body: unknown;
    try {
      body = JSON.parse(json);
    } catch {
      return action.setStatus({ kind: 'error', text: 'City pack must be valid JSON.' });
    }
    const r = await action.run(() => request(`/admin/savings/city-packs/${id.trim()}`, { method: 'PUT', body, raw: true }), 'City pack saved.');
    if (r) res.reload();
  }
  return (
    <section aria-label="City packs">
      {canEdit ? (
        <p>
          <button className="btn" type="button" onClick={() => open(null)}>
            New city pack
          </button>
        </p>
      ) : null}
      <Loadable loading={res.loading} error={res.error} empty={items.length === 0} emptyText="No city packs yet.">
        <TableWrap label="City packs">
          <thead>
            <tr>
              <th scope="col">Pack</th>
              <th scope="col">Status</th>
              <th scope="col">Localities</th>
              <th scope="col">Passes</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>
                  {p.name}
                  <div className="muted small">{p.id}</div>
                </td>
                <td>
                  <Badge tone={statusTone(p.status)}>{humanize(p.status)}</Badge>
                </td>
                <td>{p.localities.length}</td>
                <td>{p.passes.length}</td>
                <td>
                  <button className="btn btn-ghost" type="button" onClick={() => open(p)} aria-label={`${canEdit ? 'Edit' : 'View'} ${p.name}`}>
                    {canEdit ? 'Edit' : 'View'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
      {pick !== null ? (
        <form className="card" onSubmit={save} aria-label="City pack editor">
          <h2>{pick ? `City pack ${pick}` : 'New city pack'}</h2>
          <Field label="Pack id">{(fid) => <input id={fid} value={id} disabled={!canEdit || !!pick} onChange={(e) => setId(e.target.value)} />}</Field>
          <Field label="City pack (JSON)" hint="name, country, localities, passes, typicalFareInr, status. Unknown prices stay null.">
            {(fid, d) => <textarea id={fid} aria-describedby={d} rows={16} spellCheck={false} value={json} readOnly={!canEdit} onChange={(e) => setJson(e.target.value)} />}
          </Field>
          <LiveStatus status={action.status} />
          <div className="actions">
            {canEdit ? (
              <button className="btn" type="submit" disabled={action.busy}>
                Save city pack
              </button>
            ) : null}
            <button className="btn btn-ghost" type="button" onClick={() => setPick(null)}>
              Close
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

function ResearchRowEditor({ row, canEdit, onSaved }: { row: ResearchItem; canEdit: boolean; onSaved: () => void }) {
  const [status, setStatus] = useState(row.status);
  const [moduleId, setModuleId] = useState(row.moduleId ?? '');
  const action = useAction();
  useEffect(() => {
    setStatus(row.status);
    setModuleId(row.moduleId ?? '');
  }, [row.status, row.moduleId]);
  async function save() {
    const r = await action.run(() => api.patch(`/admin/savings/research/${row.id}`, { status, moduleId: moduleId.trim() || null }, { raw: true }), 'Saved.');
    if (r) onSaved();
  }
  return (
    <tr>
      <td>
        {row.providerLabel}
        <div className="muted small">{humanize(row.category)}{row.cityPack ? ` · ${row.cityPack}` : ''}</div>
      </td>
      <td>{row.requestCount}</td>
      <td>{formatIST(row.lastSeen)}</td>
      <td>
        <select aria-label={`Status for ${row.providerLabel}`} value={status} disabled={!canEdit} onChange={(e) => setStatus(e.target.value)}>
          {RESEARCH_STATUSES.map((s) => (
            <option key={s} value={s}>
              {humanize(s)}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input aria-label={`Module for ${row.providerLabel}`} value={moduleId} disabled={!canEdit} placeholder="module id" onChange={(e) => setModuleId(e.target.value)} />
        <LiveStatus status={action.status} />
      </td>
      <td>
        {canEdit ? (
          <button className="btn btn-ghost" type="button" disabled={action.busy} onClick={() => void save()} aria-label={`Save ${row.providerLabel}`}>
            Save
          </button>
        ) : null}
      </td>
    </tr>
  );
}

function ResearchTab() {
  const [status, setStatus] = useState('');
  const res = useApi<{ items: ResearchItem[] }>(`/admin/savings/research${status ? `?status=${status}` : ''}`, { raw: true });
  const canEdit = useCan('edit');
  const items = res.data?.items ?? [];
  return (
    <section aria-label="Research queue">
      <p className="muted">Providers people have in their data that no module covers yet, most requested first. Labels are anonymous and number-free.</p>
      <div className="filters">
        <Field label="Status">
          {(id) => (
            <select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {RESEARCH_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Loadable loading={res.loading} error={res.error} empty={items.length === 0} emptyText="Nothing in the research queue.">
        <TableWrap label="Research queue">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Requests</th>
              <th scope="col">Last seen</th>
              <th scope="col">Status</th>
              <th scope="col">Linked module</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((r) => (
              <ResearchRowEditor key={r.id} row={r} canEdit={canEdit} onSaved={res.reload} />
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
    </section>
  );
}
