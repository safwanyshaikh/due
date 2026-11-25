import { useState, type FormEvent } from 'react';
import { api, request } from '../lib/api';
import { useCan } from '../lib/auth';
import { formatIST, humanize } from '../lib/format';
import { useAction, useApi } from '../lib/useApi';
import { Badge, Field, LiveStatus, Loadable, PageHeader, TableWrap, Tabs } from '../components/ui';

export interface WatchRow {
  slug: string;
  displayName: string;
  senderDomains: string[];
  category: string;
  signupUrl: string | null;
  researchAddress: string | null;
  status: 'subscribed' | 'pending' | 'unsubscribed';
  lastEmailAt: string | null;
  messageCount: number;
  stale: boolean;
}
interface Candidate {
  kind: string;
  planName: string | null;
  priceInr: number | null;
  discountPct: number | null;
  validUntil: string | null;
  free: boolean;
  cashback: boolean;
}
interface MessageRow {
  id: string;
  receivedAt: string;
  fromDomain: string | null;
  subject: string | null;
  status: string;
  reason: string | null;
  personalised: boolean;
  providerSlug: string | null;
  providerName: string | null;
  candidates: Candidate[];
  reviewsQueued: number;
}
interface Unmatched {
  domain: string;
  messages: number;
  lastReceivedAt: string;
  sampleSubject: string | null;
}

export const parseDomains = (s: string): string[] => [...new Set(s.split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

export function candidateText(c: Candidate): string {
  const parts = [c.planName ?? humanize(c.kind)];
  if (c.priceInr !== null) parts.push(`₹${c.priceInr}`);
  if (c.discountPct !== null) parts.push(`${c.discountPct}% off`);
  if (c.cashback) parts.push('cashback');
  if (c.free) parts.push('free');
  if (c.validUntil) parts.push(`until ${c.validUntil}`);
  return parts.join(' · ');
}

const statusTone = (s: string) => (s === 'subscribed' || s === 'parsed' ? 'ok' : s === 'quarantined' || s === 'failed' ? 'error' : 'neutral');

export function OfferInboxPage() {
  const [tab, setTab] = useState<'watch' | 'inbox'>('watch');
  return (
    <>
      <PageHeader title="Offer inbox">
        Provider newsletters arrive at the company research mailboxes (Settings: offers.research_addresses). Only DKIM-verified, non-personalised mail becomes a change for review; approve it under Change review.
      </PageHeader>
      <Tabs
        label="Offer inbox sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'watch', label: 'Watchlist' },
          { value: 'inbox', label: 'Inbox' },
        ]}
      />
      {tab === 'watch' ? <WatchTab /> : <InboxTab />}
    </>
  );
}

function WatchTab() {
  const [stale, setStale] = useState(false);
  const [status, setStatus] = useState('');
  const res = useApi<{ items: WatchRow[]; staleDays: number }>(`/admin/offer-inbox/watch?${new URLSearchParams({ ...(stale ? { stale: 'true' } : {}), ...(status ? { status } : {}) })}`, { raw: true });
  const canEdit = useCan('edit');
  const action = useAction();
  const [form, setForm] = useState({ slug: '', displayName: '', category: 'other', domains: '' });
  const items = res.data?.items ?? [];

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(form.slug.trim()) || !form.displayName.trim()) return action.setStatus({ kind: 'error', text: 'Slug (lowercase letters, digits, hyphens) and name are required.' });
    const r = await action.run(
      () => api.post('/admin/offer-inbox/watch', { slug: form.slug.trim(), displayName: form.displayName.trim(), category: form.category.trim() || 'other', senderDomains: parseDomains(form.domains) }, { raw: true }),
      'Provider added.',
    );
    if (r) {
      setForm({ slug: '', displayName: '', category: 'other', domains: '' });
      res.reload();
    }
  }
  async function subscribe(p: WatchRow) {
    if (await action.run(() => api.post(`/admin/offer-inbox/watch/${p.slug}/mark-subscribed`, {}, { raw: true }), `${p.displayName} marked subscribed.`)) res.reload();
  }
  async function remove(p: WatchRow) {
    if (await action.run(() => request(`/admin/offer-inbox/watch/${p.slug}`, { method: 'DELETE', raw: true }).then(() => true), `${p.displayName} removed.`)) res.reload();
  }
  async function addDomains(p: WatchRow, text: string) {
    if (await action.run(() => api.patch(`/admin/offer-inbox/watch/${p.slug}`, { senderDomains: parseDomains(`${p.senderDomains.join(' ')} ${text}`) }, { raw: true }), 'Sender domains saved.')) res.reload();
  }

  return (
    <section aria-label="Watchlist">
      <div className="filters">
        <label>
          <input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} /> Stale: subscribed, no email in {res.data?.staleDays ?? 30} days
        </label>
        <Field label="Status">
          {(id) => (
            <select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              {['subscribed', 'pending', 'unsubscribed'].map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <LiveStatus status={action.status} />
      <Loadable loading={res.loading} error={res.error} empty={items.length === 0} emptyText="No providers match.">
        <TableWrap label="Provider watchlist">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Sender domains</th>
              <th scope="col">Status</th>
              <th scope="col">Last email</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <WatchRowView key={p.slug} p={p} canEdit={canEdit} busy={action.busy} onSubscribe={subscribe} onRemove={remove} onDomains={addDomains} />
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
      {canEdit ? (
        <form className="card" onSubmit={add} aria-label="Add provider">
          <h2>Add provider</h2>
          <Field label="Slug">{(id) => <input id={id} value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value })} />}</Field>
          <Field label="Display name">{(id) => <input id={id} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />}</Field>
          <Field label="Category">{(id) => <input id={id} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />}</Field>
          <Field label="Sender domains" hint="Separated by spaces or commas.">{(id, d) => <input id={id} aria-describedby={d} value={form.domains} onChange={(e) => setForm({ ...form, domains: e.target.value })} />}</Field>
          <button className="btn" type="submit" disabled={action.busy}>
            Add provider
          </button>
        </form>
      ) : null}
    </section>
  );
}

function WatchRowView({ p, canEdit, busy, onSubscribe, onRemove, onDomains }: { p: WatchRow; canEdit: boolean; busy: boolean; onSubscribe: (p: WatchRow) => void; onRemove: (p: WatchRow) => void; onDomains: (p: WatchRow, text: string) => void }) {
  const [more, setMore] = useState('');
  return (
    <tr>
      <td>
        {p.displayName}
        <div className="muted small">
          {p.slug} · {humanize(p.category)}
        </div>
      </td>
      <td>
        {p.senderDomains.length ? p.senderDomains.join(', ') : <span className="muted">None yet: cannot be matched automatically</span>}
        {canEdit ? (
          <div>
            <input aria-label={`Add sender domain for ${p.displayName}`} value={more} placeholder="mail.example.com" onChange={(e) => setMore(e.target.value)} />{' '}
            <button className="btn btn-ghost" type="button" disabled={busy || !more.trim()} onClick={() => { onDomains(p, more); setMore(''); }} aria-label={`Save domains for ${p.displayName}`}>
              Add domain
            </button>
          </div>
        ) : null}
      </td>
      <td>
        <Badge tone={statusTone(p.status)}>{humanize(p.status)}</Badge>
        {p.stale ? <div className="msg-error small">Stale</div> : null}
      </td>
      <td>{formatIST(p.lastEmailAt, 'Never')}</td>
      <td>
        {canEdit ? (
          <>
            {p.status !== 'subscribed' ? (
              <button className="btn" type="button" disabled={busy} onClick={() => onSubscribe(p)} aria-label={`Mark ${p.displayName} subscribed`}>
                Mark subscribed
              </button>
            ) : null}{' '}
            <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => onRemove(p)} aria-label={`Remove ${p.displayName}`}>
              Remove
            </button>
          </>
        ) : null}
      </td>
    </tr>
  );
}

function InboxTab() {
  const msgs = useApi<{ items: MessageRow[] }>('/admin/offer-inbox/messages', { raw: true });
  const un = useApi<{ items: Unmatched[] }>('/admin/offer-inbox/unmatched', { raw: true });
  const providers = useApi<{ items: WatchRow[] }>('/admin/offer-inbox/watch', { raw: true });
  const canEdit = useCan('edit');
  const action = useAction();
  const [pick, setPick] = useState<Record<string, string>>({});
  const items = msgs.data?.items ?? [];
  const unmatched = un.data?.items ?? [];

  async function attach(domain: string) {
    const providerSlug = pick[domain];
    if (!providerSlug) return action.setStatus({ kind: 'error', text: 'Choose a provider first.' });
    const r = await action.run(() => api.post<{ requeued: number }>('/admin/offer-inbox/unmatched/attach', { domain, providerSlug }, { raw: true }), `${domain} attached.`);
    if (r) {
      un.reload();
      msgs.reload();
    }
  }

  return (
    <section aria-label="Inbox">
      <LiveStatus status={action.status} />
      {unmatched.length > 0 ? (
        <div className="card">
          <h2>Unmatched senders</h2>
          <p className="muted">DKIM-verified mail from domains no provider owns yet. Attach the domain to a provider and its mail is processed.</p>
          <TableWrap label="Unmatched senders">
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">Emails</th>
                <th scope="col">Latest subject</th>
                <th scope="col">Provider</th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((u) => (
                <tr key={u.domain}>
                  <td>{u.domain}</td>
                  <td>{u.messages}</td>
                  <td>{u.sampleSubject}</td>
                  <td>
                    {canEdit ? (
                      <>
                        <select aria-label={`Provider for ${u.domain}`} value={pick[u.domain] ?? ''} onChange={(e) => setPick({ ...pick, [u.domain]: e.target.value })}>
                          <option value="">Choose…</option>
                          {(providers.data?.items ?? []).map((p) => (
                            <option key={p.slug} value={p.slug}>
                              {p.displayName}
                            </option>
                          ))}
                        </select>{' '}
                        <button className="btn" type="button" disabled={action.busy} onClick={() => void attach(u.domain)} aria-label={`Attach ${u.domain}`}>
                          Attach
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      ) : null}
      <Loadable loading={msgs.loading} error={msgs.error} empty={items.length === 0} emptyText="No offer emails received yet.">
        <TableWrap label="Offer emails">
          <thead>
            <tr>
              <th scope="col">Provider</th>
              <th scope="col">Subject</th>
              <th scope="col">Received</th>
              <th scope="col">Status</th>
              <th scope="col">Extracted candidates</th>
            </tr>
          </thead>
          <tbody>
            {items.map((m) => (
              <tr key={m.id}>
                <td>{m.providerName ?? <span className="muted">{m.fromDomain ?? 'Unknown'}</span>}</td>
                <td>{m.subject}</td>
                <td>{formatIST(m.receivedAt)}</td>
                <td>
                  <Badge tone={statusTone(m.status)}>{humanize(m.status)}</Badge>
                  {m.reason ? <div className="muted small">{humanize(m.reason)}</div> : null}
                </td>
                <td>
                  {m.personalised ? (
                    <span className="muted">Personalised: research only</span>
                  ) : m.candidates.length ? (
                    <ul>
                      {m.candidates.map((c, i) => (
                        <li key={i}>{candidateText(c)}</li>
                      ))}
                      <li className="muted small">{m.reviewsQueued} sent to review</li>
                    </ul>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
    </section>
  );
}
