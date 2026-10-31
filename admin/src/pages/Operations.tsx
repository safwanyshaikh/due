import { Fragment, useState, type FormEvent } from 'react';
import { api, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { formatIST, humanize } from '../lib/format';
import { useAction, useApi } from '../lib/useApi';
import { Badge, Field, LiveStatus, Loadable, PageHeader, TableWrap, Tabs } from '../components/ui';

// ---- Integration health (Agent A: GET /api/admin/health/integrations) ----------------------------------

interface IntegrationEntry {
  status: 'ok' | 'not_configured' | 'degraded' | 'error';
  detail: string;
}

const INTEGRATION_LABEL: Record<string, string> = {
  db: 'Database',
  queue: 'Job queue',
  encryption: 'Encryption keys',
  smtp: 'Email (SMTP)',
  inbound: 'Inbound email',
  gmailOauth: 'Gmail OAuth',
  'ocr/storage': 'OCR / storage',
  ocrStorage: 'OCR / storage',
  billing: 'Billing (Razorpay)',
  errorTracking: 'Error tracking',
};

const SECRET_LIKE = /(sk_|rzp_live_|rzp_test_|password|secret=|token=|key=)[^\s]*/gi;

/** Defence in depth: never render anything that looks like a credential, even if a detail string carried one. */
export function safeDetail(text: string | null | undefined): string {
  return (text ?? '').replace(SECRET_LIKE, '[hidden]');
}

function integrationTone(s: string): 'ok' | 'review' | 'error' | 'neutral' {
  return s === 'ok' ? 'ok' : s === 'degraded' ? 'review' : s === 'error' ? 'error' : 'neutral';
}

export function IntegrationsPage() {
  const res = useApi<{ integrations: Record<string, IntegrationEntry>; checkedAt: string }>('/admin/health/integrations');
  const entries = Object.entries(res.data?.integrations ?? {});
  return (
    <>
      <PageHeader
        title="Integration health"
        actions={
          <button className="btn" type="button" onClick={res.reload}>
            Check again
          </button>
        }
      >
        A missing optional integration shows “Not configured”; it never counts as healthy. Secrets are never shown.
      </PageHeader>
      <Loadable loading={res.loading} error={res.error} empty={entries.length === 0}>
        <TableWrap label="Integrations">
          <thead>
            <tr>
              <th scope="col">Integration</th>
              <th scope="col">Status</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{INTEGRATION_LABEL[k] ?? humanize(k)}</th>
                <td>
                  <Badge tone={integrationTone(v.status)}>{humanize(v.status)}</Badge>
                </td>
                <td>{safeDetail(v.detail)}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <p className="muted small">Checked {formatIST(res.data?.checkedAt)}</p>
      </Loadable>
    </>
  );
}

// ---- Incident status (Agent A: GET/PATCH /api/admin/incident) ----------------------------------------

interface Incident {
  level: 'info' | 'minor' | 'major' | 'critical';
  message: string;
  updatedAt: string;
}

export function IncidentPage() {
  const res = useApi<{ incident: Incident | null }>('/admin/incident');
  const canEdit = useCan('admin');
  const action = useAction();
  const [level, setLevel] = useState<Incident['level']>('minor');
  const [message, setMessage] = useState('');
  const current = res.data?.incident ?? null;

  async function publish(e: FormEvent) {
    e.preventDefault();
    if (!message.trim()) return action.setStatus({ kind: 'error', text: 'Write a short message for users.' });
    const r = await action.run(() => api.patch('/admin/incident', { level, message: message.trim() }), 'Incident banner published.');
    if (r !== undefined) {
      setMessage('');
      res.reload();
    }
  }
  async function clear() {
    const r = await action.run(() => api.patch('/admin/incident', { clear: true }), 'Incident cleared.');
    if (r !== undefined) res.reload();
  }

  return (
    <>
      <PageHeader title="Incident status">The app shows this banner to users through /api/public/status. Every change is audited.</PageHeader>
      <Loadable loading={res.loading} error={res.error}>
        <section className="card" aria-label="Current incident">
          {current ? (
            <>
              <p>
                <Badge tone={current.level === 'info' ? 'neutral' : 'error'}>{humanize(current.level)}</Badge> {current.message}
              </p>
              <p className="muted small">Updated {formatIST(current.updatedAt)}</p>
              {canEdit ? (
                <button className="btn" type="button" onClick={clear} disabled={action.busy}>
                  Clear incident
                </button>
              ) : null}
            </>
          ) : (
            <p>No incident is published.</p>
          )}
        </section>
        {canEdit ? (
          <form className="card form-grid" onSubmit={publish} aria-label="Publish incident" noValidate>
            <Field label="Level">
              {(id) => (
                <select id={id} value={level} onChange={(e) => setLevel(e.target.value as Incident['level'])}>
                  {(['info', 'minor', 'major', 'critical'] as const).map((l) => (
                    <option key={l} value={l}>
                      {humanize(l)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label="Message shown to users">{(id) => <input id={id} maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
            <div className="span-2">
              <button className="btn btn-primary" type="submit" disabled={action.busy}>
                Publish
              </button>
            </div>
          </form>
        ) : (
          <p className="muted">Read-only. Admins publish and clear incidents.</p>
        )}
        <LiveStatus status={action.status} />
      </Loadable>
    </>
  );
}

// ---- Queue / jobs (Agent A: /api/admin/queue, /queue/stats, /queue/:id/retry) -------------------------

export interface QueueJob {
  id: string;
  type: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
  attempts: number;
  maxAttempts: number;
  runAt: string;
  createdAt: string;
  finishedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  accountId: string | null;
}

interface QueueStats {
  counts: Record<string, number>;
  oldestDueSeconds: number | null;
  lastHeartbeatAt: string | null;
  heartbeatFresh: boolean;
  deadLast24h: number;
}

function jobTone(s: string): 'ok' | 'review' | 'error' | 'neutral' {
  return s === 'succeeded' ? 'ok' : s === 'queued' || s === 'running' ? 'review' : s === 'failed' || s === 'dead' ? 'error' : 'neutral';
}

export function JobsTable({ items, canRetry, onRetried, label }: { items: QueueJob[]; canRetry: boolean; onRetried: () => void; label: string }) {
  const action = useAction();
  async function retry(j: QueueJob) {
    const r = await action.run(() => api.post(`/admin/queue/${j.id}/retry`), `Job ${j.type} queued again.`);
    if (r !== undefined) onRetried();
  }
  return (
    <>
      <LiveStatus status={action.status} />
      <TableWrap label={label}>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
            <th scope="col">Run at</th>
            <th scope="col">Last error</th>
            {canRetry ? <th scope="col">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((j) => (
            <tr key={j.id}>
              <td>
                {j.type}
                <div className="muted small">{j.id}</div>
              </td>
              <td>
                <Badge tone={jobTone(j.status)}>{j.status === 'dead' ? 'Dead letter' : humanize(j.status)}</Badge>
              </td>
              <td>
                {j.attempts} / {j.maxAttempts}
              </td>
              <td>{formatIST(j.runAt)}</td>
              <td>{j.lastErrorCode ? `${j.lastErrorCode}${j.lastErrorMessage ? `: ${safeDetail(j.lastErrorMessage)}` : ''}` : '—'}</td>
              {canRetry ? (
                <td>
                  {j.status === 'failed' || j.status === 'dead' ? (
                    <button className="btn btn-small" type="button" disabled={action.busy} onClick={() => retry(j)}>
                      Retry
                    </button>
                  ) : null}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </>
  );
}

type QueueTab = 'all' | 'queued' | 'running' | 'failed' | 'dead' | 'succeeded';

export function QueuePage() {
  const [tab, setTab] = useState<QueueTab>('all');
  const [type, setType] = useState('');
  const stats = useApi<QueueStats>('/admin/queue/stats');
  const list = useApi<{ items: QueueJob[]; total: number }>(`/admin/queue${qs({ status: tab === 'all' ? undefined : tab, type: type.trim() || undefined, limit: 100 })}`);
  const canRetry = useCan('edit');
  const s = stats.data;
  return (
    <>
      <PageHeader title="Queue & jobs">Background jobs: refreshes, reminders, scans, deletions. Failed jobs retry with backoff; dead letters need a person.</PageHeader>
      <Loadable loading={stats.loading} error={stats.error}>
        {s ? (
          <section className="card" aria-label="Queue stats">
            <dl className="kv">
              {Object.entries(s.counts).map(([k, v]) => (
                <Fragment key={k}>
                  <dt>{k === 'dead' ? 'Dead letter' : humanize(k)}</dt>
                  <dd>{v}</dd>
                </Fragment>
              ))}
              <dt>Oldest due job</dt>
              <dd>{s.oldestDueSeconds === null ? 'None waiting' : `${s.oldestDueSeconds} s`}</dd>
              <dt>Worker heartbeat</dt>
              <dd>
                {formatIST(s.lastHeartbeatAt)} {s.heartbeatFresh ? <Badge tone="ok">Fresh</Badge> : <Badge tone="error">Stale</Badge>}
              </dd>
              <dt>Dead letters (24 h)</dt>
              <dd>{s.deadLast24h}</dd>
            </dl>
          </section>
        ) : null}
      </Loadable>
      <Tabs
        label="Job status"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'all', label: 'All' },
          { value: 'queued', label: 'Queued' },
          { value: 'running', label: 'Running' },
          { value: 'failed', label: 'Failed' },
          { value: 'dead', label: 'Dead letter' },
          { value: 'succeeded', label: 'Succeeded' },
        ]}
      />
      <div className="filters">
        <Field label="Job type">{(id) => <input id={id} placeholder="offers.refresh" value={type} onChange={(e) => setType(e.target.value)} />}</Field>
      </div>
      <Loadable loading={list.loading} error={list.error} empty={(list.data?.items.length ?? 0) === 0} emptyText="No jobs.">
        <JobsTable
          label="Jobs"
          items={list.data?.items ?? []}
          canRetry={canRetry}
          onRetried={() => {
            list.reload();
            stats.reload();
          }}
        />
      </Loadable>
    </>
  );
}

// ---- Privacy / deletion requests (Admin) ---------------------------------------------------------------

interface DeletionRequest {
  id: string;
  accountId: string | null;
  status: string;
  steps: { step?: string; name?: string; status?: string }[];
  requestedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  jobStatus: string | null;
  jobAttempts: number | null;
}

interface PrivacyAuditRow {
  id: number;
  accountId: string | null;
  action: string;
  entity: string;
  at: string;
}

export function PrivacyPage() {
  const deletions = useApi<{ items: DeletionRequest[]; counts: Record<string, number> }>('/admin/privacy/deletions?limit=100');
  const jobs = useApi<{ items: QueueJob[] }>('/admin/queue?type=account.delete&limit=100');
  const audit = useApi<{ items: PrivacyAuditRow[] }>('/admin/privacy/audit?limit=100');
  const canRetry = useCan('edit');
  return (
    <>
      <PageHeader title="Privacy & deletion requests">Progress of account deletions and privacy-related account events. No message content, tokens or emails are shown.</PageHeader>
      <h2>Deletion requests</h2>
      <Loadable loading={deletions.loading} error={deletions.error} empty={(deletions.data?.items.length ?? 0) === 0} emptyText="No deletion requests.">
        <TableWrap label="Deletion requests">
          <thead>
            <tr>
              <th scope="col">Requested</th>
              <th scope="col">Account</th>
              <th scope="col">Status</th>
              <th scope="col">Steps</th>
              <th scope="col">Job</th>
            </tr>
          </thead>
          <tbody>
            {(deletions.data?.items ?? []).map((d) => (
              <tr key={d.id}>
                <td>{formatIST(d.requestedAt)}</td>
                <td>
                  <code>{d.accountId ? `${d.accountId.slice(0, 8)}…` : 'deleted'}</code>
                </td>
                <td>
                  <Badge tone={d.status === 'completed' ? 'ok' : d.status === 'failed' ? 'error' : 'review'}>{humanize(d.status)}</Badge>
                  {d.errorCode ? <div className="msg-error small">{d.errorCode}</div> : null}
                </td>
                <td>{Array.isArray(d.steps) ? `${d.steps.filter((s) => s.status === 'done' || s.status === 'completed').length} / ${d.steps.length}` : '—'}</td>
                <td>{d.jobStatus ? `${humanize(d.jobStatus)} (${d.jobAttempts ?? 0} attempts)` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
      <h2>Deletion jobs</h2>
      <Loadable loading={jobs.loading} error={jobs.error} empty={(jobs.data?.items.length ?? 0) === 0} emptyText="No account.delete jobs.">
        <JobsTable label="Deletion jobs" items={jobs.data?.items ?? []} canRetry={canRetry} onRetried={jobs.reload} />
      </Loadable>
      <h2>Privacy events</h2>
      <Loadable loading={audit.loading} error={audit.error} empty={(audit.data?.items.length ?? 0) === 0} emptyText="No privacy events.">
        <TableWrap label="Privacy events">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Account</th>
              <th scope="col">Event</th>
            </tr>
          </thead>
          <tbody>
            {(audit.data?.items ?? []).map((a) => (
              <tr key={a.id}>
                <td>{formatIST(a.at)}</td>
                <td>
                  <code>{a.accountId ? `${a.accountId.slice(0, 8)}…` : '—'}</code>
                </td>
                <td>{a.action}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
    </>
  );
}
