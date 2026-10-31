import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { formatIST, humanize } from '../lib/format';
import {
  familyLabel,
  freshnessText,
  OFFER_STATUSES,
  offerStatusLabel,
  offerStatusTone,
  show,
  type Observation,
  type OfferRow,
  type Transition,
} from '../lib/offers';
import { useAction, useApi } from '../lib/useApi';
import { Badge, ExternalLink, Field, LiveStatus, Loadable, PageHeader, TableWrap } from '../components/ui';

export function OfferStatusBadge({ status }: { status: string }) {
  return <Badge tone={offerStatusTone(status)}>{offerStatusLabel(status)}</Badge>;
}

export function OffersPage() {
  const [status, setStatus] = useState('');
  const res = useApi<{ items: OfferRow[]; total: number }>(`/admin/offers${qs({ status })}`);
  const canEdit = useCan('edit');
  const action = useAction();
  const items = res.data?.items ?? [];

  async function recompute() {
    const r = await action.run(() => api.post<{ checked: number; transitions: number }>('/admin/offers/recompute-status'));
    if (r) {
      action.setStatus({ kind: 'ok', text: `Checked ${r.checked} offers; ${r.transitions} status changes recorded.` });
      res.reload();
    }
  }

  return (
    <>
      <PageHeader
        title="Offers"
        actions={
          canEdit ? (
            <button className="btn" type="button" onClick={recompute} disabled={action.busy}>
              Recompute statuses
            </button>
          ) : null
        }
      >
        Status is computed on the server from official terms, landing pages and the freshness window. A visible landing page alone never makes an offer active.
      </PageHeader>
      <LiveStatus status={action.status} />
      <div className="filters">
        <Field label="Status">
          {(id) => (
            <select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {OFFER_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {offerStatusLabel(s)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <Loadable loading={res.loading} error={res.error} empty={items.length === 0} emptyText="No offers match.">
        <TableWrap label="Offers">
          <thead>
            <tr>
              <th scope="col">Offer</th>
              <th scope="col">Family</th>
              <th scope="col">Status</th>
              <th scope="col">Freshness</th>
              <th scope="col">Last successful check</th>
              <th scope="col">Last attempted check</th>
              <th scope="col">Pending changes</th>
            </tr>
          </thead>
          <tbody>
            {items.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link to={`/offers/${o.id}`}>{o.name}</Link>
                  <div className="muted small">{o.id}</div>
                </td>
                <td>{familyLabel(o.providerFamily)}</td>
                <td>
                  <OfferStatusBadge status={o.status} />
                  <div className="muted small">{humanize(o.statusReason)}</div>
                </td>
                <td>{freshnessText(o.freshness)}</td>
                <td>{formatIST(o.lastSuccessfulCheckAt)}</td>
                <td>
                  {formatIST(o.lastAttemptedCheckAt)}
                  {o.lastCheckError ? <div className="msg-error small">Last attempt failed</div> : null}
                </td>
                <td>{o.pendingReviews ? <Link to={`/review?offerId=${o.id}`}>{o.pendingReviews} to review</Link> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
    </>
  );
}

interface OfferDetail extends OfferRow {
  transitions: Transition[];
  monitoredSources: { id: string; url: string; label: string; sourceCategory: string; status: string; lastSuccessAt: string | null; lastCheckedAt: string | null; candidate: boolean }[];
}

export interface OfferEditForm {
  name: string;
  priceInr: string;
  officialEndAt: string;
  termsStatus: string;
  pageStatus: string;
  confidence: string;
  freshnessWindowHours: string;
  sku: string;
  geography: string;
}

/** PATCH body for an offer edit, or an error message. Status is never sent: the server computes it. */
export function offerEditPatch(f: OfferEditForm): { body: Record<string, unknown> } | { error: string } {
  const price = f.priceInr.trim();
  if (price && !/^\d{1,8}(\.\d{1,2})?$/.test(price)) return { error: 'Price must be an amount in rupees, like 699 or 1029.00.' };
  const end = f.officialEndAt.trim();
  if (end && !/^\d{4}-\d{2}-\d{2}$/.test(end)) return { error: 'Official end date must be YYYY-MM-DD.' };
  const hours = Number(f.freshnessWindowHours);
  if (!Number.isInteger(hours) || hours < 1 || hours > 8760) return { error: 'Freshness window must be 1 to 8760 hours.' };
  if (!f.name.trim()) return { error: 'Name is required.' };
  return {
    body: {
      name: f.name.trim(),
      priceInr: price ? Number(price) : null,
      officialEndAt: end || null,
      termsStatus: f.termsStatus,
      pageStatus: f.pageStatus,
      confidence: f.confidence,
      freshnessWindowHours: hours,
      sku: f.sku.trim() || null,
      geography: f.geography.trim() || null,
    },
  };
}

function EditOffer({ o, onSaved }: { o: OfferRow; onSaved: () => void }) {
  const [f, setF] = useState<OfferEditForm>({
    name: o.name,
    priceInr: o.priceInr === null ? '' : String(o.priceInr),
    officialEndAt: o.officialEndAt ?? '',
    termsStatus: o.termsStatus,
    pageStatus: o.pageStatus,
    confidence: o.confidence,
    freshnessWindowHours: String(o.freshnessWindowHours),
    sku: o.sku ?? '',
    geography: o.geography ?? '',
  });
  const action = useAction();
  const set = (k: keyof OfferEditForm, v: string) => setF((x) => ({ ...x, [k]: v }));
  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = offerEditPatch(f);
    if ('error' in p) return action.setStatus({ kind: 'error', text: p.error });
    const r = await action.run(() => api.patch(`/admin/offers/${o.id}`, p.body), 'Saved. The change is in the audit log.');
    if (r !== undefined) onSaved();
  }
  return (
    <form className="card form-grid" onSubmit={submit} aria-label="Edit offer" noValidate>
      <h2 className="span-2">Edit offer</h2>
      <Field label="Name">{(id) => <input id={id} value={f.name} onChange={(e) => set('name', e.target.value)} />}</Field>
      <Field label="Price (₹)">{(id) => <input id={id} inputMode="decimal" value={f.priceInr} onChange={(e) => set('priceInr', e.target.value)} />}</Field>
      <Field label="Official end date" hint="YYYY-MM-DD, from the official terms only.">
        {(id, h) => <input id={id} aria-describedby={h} value={f.officialEndAt} onChange={(e) => set('officialEndAt', e.target.value)} />}
      </Field>
      <Field label="Freshness window (hours)">
        {(id) => <input id={id} inputMode="numeric" value={f.freshnessWindowHours} onChange={(e) => set('freshnessWindowHours', e.target.value)} />}
      </Field>
      <Field label="Terms status">
        {(id) => (
          <select id={id} value={f.termsStatus} onChange={(e) => set('termsStatus', e.target.value)}>
            {['active', 'expired', 'unavailable', 'conflicting', 'unknown'].map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Landing page status">
        {(id) => (
          <select id={id} value={f.pageStatus} onChange={(e) => set('pageStatus', e.target.value)}>
            {['visible', 'unavailable', 'login_required', 'dynamic', 'unknown'].map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Confidence">
        {(id) => (
          <select id={id} value={f.confidence} onChange={(e) => set('confidence', e.target.value)}>
            {['high', 'medium', 'low'].map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field label="SKU / plan code">{(id) => <input id={id} value={f.sku} onChange={(e) => set('sku', e.target.value)} />}</Field>
      <Field label="Geography">{(id) => <input id={id} value={f.geography} onChange={(e) => set('geography', e.target.value)} />}</Field>
      <div className="span-2">
        <LiveStatus status={action.status} />
        <button className="btn btn-primary" type="submit" disabled={action.busy}>
          Save
        </button>
      </div>
    </form>
  );
}

export function OfferDetailPage() {
  const { id = '' } = useParams();
  const detail = useApi<OfferDetail>(`/admin/offers/${encodeURIComponent(id)}`);
  const obs = useApi<{ items: Observation[]; total: number }>(`/admin/offers/${encodeURIComponent(id)}/observations?limit=100`);
  const canEdit = useCan('edit');
  const action = useAction();
  const [editing, setEditing] = useState(false);
  const o = detail.data;

  async function refresh() {
    const r = await action.run(() => api.post<{ jobs: unknown[] }>(`/admin/offers/${encodeURIComponent(id)}/refresh`));
    if (r) action.setStatus({ kind: 'ok', text: `Refresh queued for ${r.jobs.length} source(s). Results appear here and in the review queue.` });
  }

  return (
    <Loadable loading={detail.loading} error={detail.error}>
      {o ? (
        <>
          <PageHeader
            title={o.name}
            actions={
              canEdit ? (
                <>
                  <button className="btn" type="button" onClick={refresh} disabled={action.busy}>
                    Refresh now
                  </button>
                  <button className="btn" type="button" onClick={() => setEditing((x) => !x)}>
                    {editing ? 'Close editor' : 'Edit'}
                  </button>
                </>
              ) : null
            }
          >
            <OfferStatusBadge status={o.status} /> {humanize(o.statusReason)} · {familyLabel(o.providerFamily)}
          </PageHeader>
          <LiveStatus status={action.status} />
          {editing && canEdit ? (
            <EditOffer
              o={o}
              onSaved={() => {
                setEditing(false);
                detail.reload();
              }}
            />
          ) : null}
          <section className="card">
            <dl className="kv">
              <dt>Price</dt>
              <dd>{o.priceInr === null ? '—' : `₹${o.priceInr}${o.billingPeriod && o.billingPeriod !== 'none' ? ` / ${o.billingPeriod}` : ''}`}</dd>
              <dt>Benefit</dt>
              <dd>{show(o.benefitValue)}</dd>
              <dt>Official start / end</dt>
              <dd>
                {o.officialStartAt ?? '—'} / {o.officialEndAt ?? '—'}
              </dd>
              <dt>Terms / landing page</dt>
              <dd>
                {humanize(o.termsStatus)} / {humanize(o.pageStatus)}
              </dd>
              <dt>Confidence</dt>
              <dd>
                {humanize(o.confidence)} stored · {humanize(o.effectiveConfidence)} effective
              </dd>
              <dt>Freshness</dt>
              <dd>{freshnessText(o.freshness)}</dd>
              <dt>Last successful check</dt>
              <dd>{formatIST(o.lastSuccessfulCheckAt)}</dd>
              <dt>Last attempted check</dt>
              <dd>
                {formatIST(o.lastAttemptedCheckAt)}
                {o.lastCheckError ? <span className="msg-error"> · {o.lastCheckError}</span> : null}
              </dd>
              <dt>Superseded by</dt>
              <dd>{o.supersededBy ? <Link to={`/offers/${o.supersededBy}`}>{o.supersededBy}</Link> : '—'}</dd>
            </dl>
          </section>
          <h2>Sources</h2>
          <TableWrap label="Offer sources">
            <thead>
              <tr>
                <th scope="col">Source</th>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Last success</th>
              </tr>
            </thead>
            <tbody>
              {o.monitoredSources.map((s) => (
                <tr key={s.id}>
                  <td>
                    <ExternalLink href={s.url}>{s.label}</ExternalLink>
                  </td>
                  <td>{humanize(s.sourceCategory)}</td>
                  <td>{s.candidate ? 'Unverified candidate' : humanize(s.status)}</td>
                  <td>{formatIST(s.lastSuccessAt)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <h2>Status history</h2>
          <TableWrap label="Status transitions">
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Change</th>
                <th scope="col">Reason</th>
                <th scope="col">By</th>
              </tr>
            </thead>
            <tbody>
              {o.transitions.map((t) => (
                <tr key={t.id}>
                  <td>{formatIST(t.at)}</td>
                  <td>
                    {offerStatusLabel(t.fromStatus)} → {offerStatusLabel(t.toStatus)}
                  </td>
                  <td>{humanize(t.reason)}</td>
                  <td>{t.actor === 'system' ? 'System' : (t.actorEmail ?? 'Admin')}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <h2>Observations</h2>
          <Loadable loading={obs.loading} error={obs.error} empty={(obs.data?.items.length ?? 0) === 0} emptyText="No observations yet.">
            <TableWrap label="Offer observations">
              <thead>
                <tr>
                  <th scope="col">Observed</th>
                  <th scope="col">Source</th>
                  <th scope="col">Parser</th>
                  <th scope="col">Changes from previous</th>
                </tr>
              </thead>
              <tbody>
                {(obs.data?.items ?? []).map((ob) => (
                  <tr key={ob.id}>
                    <td>{formatIST(ob.observedAt)}</td>
                    <td>
                      <ExternalLink href={ob.sourceUrl} />
                      {ob.httpStatus ? <div className="muted small">HTTP {ob.httpStatus}</div> : null}
                    </td>
                    <td>{ob.parserVersion}</td>
                    <td>
                      {ob.firstForSource ? (
                        <span className="muted">First observation</span>
                      ) : (
                        <ul className="plain">
                          {ob.diff.map((d) => (
                            <li key={d.field}>
                              {humanize(d.field)}: {show(d.from)} → {show(d.to)}
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Loadable>
        </>
      ) : null}
    </Loadable>
  );
}
