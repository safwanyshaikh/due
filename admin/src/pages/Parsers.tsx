import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { formatIST } from '../lib/format';
import type { ParserVersion } from '../lib/offers';
import { useAction, useApi } from '../lib/useApi';
import { Badge, Field, JsonBlock, LiveStatus, Loadable, PageHeader, TableWrap } from '../components/ui';

const EXAMPLE = `{
  "price": { "pattern": "₹\\\\s?([\\\\d,]+)" },
  "officialEnd": { "pattern": "valid till (\\\\d{1,2} \\\\w+ \\\\d{4})" },
  "expiredPattern": "offer has ended"
}`;

/** Validates the create form; returns the POST body or an error message. */
export function parserCreateBody(f: { scope: 'source' | 'provider'; target: string; version: string; rules: string; notes: string; activate: boolean }):
  | { body: Record<string, unknown> }
  | { error: string } {
  if (!f.target.trim()) return { error: f.scope === 'source' ? 'Enter the source id.' : 'Enter the provider id (for example airtel).' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(f.version.trim())) return { error: 'Version: letters, digits, dot, dash or underscore (for example v2).' };
  let rules: unknown;
  try {
    rules = JSON.parse(f.rules);
  } catch {
    return { error: 'Rules must be valid JSON.' };
  }
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return { error: 'Rules must be a JSON object.' };
  return {
    body: {
      ...(f.scope === 'source' ? { sourceId: f.target.trim() } : { provider: f.target.trim() }),
      version: f.version.trim(),
      rules,
      notes: f.notes.trim() || null,
      activate: f.activate,
    },
  };
}

function CreateParser({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ scope: 'source' as 'source' | 'provider', target: '', version: '', rules: EXAMPLE, notes: '', activate: false });
  const action = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = parserCreateBody(f);
    if ('error' in p) return action.setStatus({ kind: 'error', text: p.error });
    const r = await action.run(() => api.post('/admin/parser-versions', p.body), 'Parser version created.');
    if (r !== undefined) onDone();
  }
  return (
    <form className="card form-grid" onSubmit={submit} aria-label="New parser version" noValidate>
      <h2 className="span-2">New parser version</h2>
      <Field label="Applies to">
        {(id) => (
          <select id={id} value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as 'source' | 'provider' })}>
            <option value="source">One source</option>
            <option value="provider">Every source of a provider</option>
          </select>
        )}
      </Field>
      <Field label={f.scope === 'source' ? 'Source id' : 'Provider id'}>{(id) => <input id={id} value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} />}</Field>
      <Field label="Version">{(id) => <input id={id} value={f.version} onChange={(e) => setF({ ...f, version: e.target.value })} />}</Field>
      <Field label="Notes">{(id) => <input id={id} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />}</Field>
      <div className="span-2">
        <Field label="Rules (JSON)" hint="Regex rules over the page's public text. Fields not found are recorded as not observed and never propose a change.">
          {(id, h) => <textarea id={id} aria-describedby={h} rows={8} className="mono" value={f.rules} onChange={(e) => setF({ ...f, rules: e.target.value })} />}
        </Field>
      </div>
      <label className="check span-2">
        <input type="checkbox" checked={f.activate} onChange={(e) => setF({ ...f, activate: e.target.checked })} /> Activate now (replaces the active version for this scope)
      </label>
      <div className="span-2">
        <LiveStatus status={action.status} />
        <button className="btn btn-primary" type="submit" disabled={action.busy}>
          Create
        </button>
      </div>
    </form>
  );
}

export function ParsersPage() {
  const res = useApi<{ items: ParserVersion[] }>('/admin/parser-versions');
  const canConfigure = useCan('admin');
  const action = useAction();
  const [creating, setCreating] = useState(false);
  const items = res.data?.items ?? [];
  async function activate(p: ParserVersion) {
    const r = await action.run(() => api.post(`/admin/parser-versions/${p.id}/activate`), `${p.version} is now active.`);
    if (r !== undefined) res.reload();
  }
  return (
    <>
      <PageHeader
        title="Parser versions"
        actions={
          canConfigure ? (
            <button className="btn btn-primary" type="button" onClick={() => setCreating((c) => !c)}>
              {creating ? 'Close' : 'New version'}
            </button>
          ) : null
        }
      >
        {canConfigure ? 'Versions are immutable; create a new one to change rules.' : 'Read-only. Admins create and activate parser versions.'}
      </PageHeader>
      {creating && canConfigure ? (
        <CreateParser
          onDone={() => {
            setCreating(false);
            res.reload();
          }}
        />
      ) : null}
      <LiveStatus status={action.status} />
      <Loadable loading={res.loading} error={res.error} empty={items.length === 0} emptyText="No parser versions yet. Sources use the built-in parser (page status only).">
        <TableWrap label="Parser versions">
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Scope</th>
              <th scope="col">Rules</th>
              <th scope="col">Created</th>
              <th scope="col">State</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.id}>
                <td>{p.version}</td>
                <td>{p.sourceId ? (p.sourceLabel ?? p.sourceUrl ?? p.sourceId) : `Provider: ${p.provider}`}</td>
                <td>
                  <JsonBlock value={p.rules} />
                </td>
                <td>
                  {formatIST(p.createdAt)}
                  {p.createdByEmail ? <div className="muted small">{p.createdByEmail}</div> : null}
                </td>
                <td>
                  {p.active ? (
                    <Badge tone="ok">Active</Badge>
                  ) : canConfigure ? (
                    <button className="btn btn-small" type="button" disabled={action.busy} onClick={() => activate(p)}>
                      Activate {p.version}
                    </button>
                  ) : (
                    <Badge>Inactive</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
    </>
  );
}
