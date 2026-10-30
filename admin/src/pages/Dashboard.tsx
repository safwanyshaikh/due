import { Link } from 'react-router-dom';
import { api, asList } from '../lib/api';
import { useApi, useAction } from '../lib/useApi';
import { useCan } from '../lib/auth';
import type { Alert, Dashboard, Job, JobRun } from '../lib/types';
import { checkedEvery, formatIST, humanize } from '../lib/format';
import { Badge, LiveStatus, Loadable, PageHeader, TableWrap, statusTone } from '../components/ui';

const COUNTERS: { key: keyof Dashboard; label: string }[] = [
  { key: 'companies', label: 'Companies' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'activeSources', label: 'Active sources' },
  { key: 'monitoredSources', label: 'Monitored sources' },
  { key: 'newRecords7d', label: 'New records (7 days)' },
  { key: 'updatedRecords7d', label: 'Updated records (7 days)' },
  { key: 'failedFetches7d', label: 'Failed fetches (7 days)' },
  { key: 'pendingVerification', label: 'Pending verification' },
];

function counterValue(v: unknown): string {
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  return 'Data unavailable';
}

export function jobLastStatus(j: Job): string | null {
  return j.lastStatus ?? j.lastRun?.status ?? null;
}

export function DashboardPage() {
  const dash = useApi<Dashboard>('/admin/dashboard');
  const alerts = useApi<unknown>('/admin/alerts?unread=1');
  const canEdit = useCan('edit');
  const action = useAction();

  const d = dash.data;
  const runs = asList<JobRun>(d?.latestRuns);
  const jobs = asList<Job>(d?.automation?.jobs ?? d?.automation);
  const alertList = asList<Alert>(alerts.data, 'alerts');

  async function markRead(id: Alert['id']) {
    await action.run(() => api.post(`/admin/alerts/${id}/read`), 'Alert marked as read.');
    alerts.reload();
  }

  return (
    <>
      <PageHeader title="Dashboard">Counts come straight from the database. Monitoring is periodic polling on a schedule.</PageHeader>
      <Loadable loading={dash.loading} error={dash.error}>
        {d ? (
          <>
            <section aria-label="Counters" className="stats">
              {COUNTERS.map((c) => (
                <div className="stat" key={c.key} data-testid={`stat-${c.key}`}>
                  <div className="stat-value">{counterValue(d[c.key])}</div>
                  <div className="stat-label">{c.label}</div>
                </div>
              ))}
            </section>

            <div className="grid-2">
              <section className="card">
                <h2>Automation health</h2>
                {jobs.length === 0 ? (
                  <div className="empty">Data unavailable</div>
                ) : (
                  <TableWrap label="Automation jobs">
                    <thead>
                      <tr>
                        <th scope="col">Job</th>
                        <th scope="col">Enabled</th>
                        <th scope="col">Schedule</th>
                        <th scope="col">Last run</th>
                        <th scope="col">Next run</th>
                        <th scope="col">Last status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map((j) => (
                        <tr key={j.id}>
                          <td>{humanize(j.id)}</td>
                          <td>{j.enabled ? 'Yes' : 'No'}</td>
                          <td>{checkedEvery(j.intervalMinutes)}</td>
                          <td>{formatIST(j.lastRunAt)}</td>
                          <td>{j.enabled ? formatIST(j.nextRunAt, 'Not scheduled') : 'Paused'}</td>
                          <td>{jobLastStatus(j) ? <Badge tone={statusTone(jobLastStatus(j))}>{humanize(jobLastStatus(j))}</Badge> : 'No runs yet'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </TableWrap>
                )}
              </section>

              <section className="card">
                <h2>Latest monitoring runs</h2>
                {runs.length === 0 ? (
                  <div className="empty">No runs recorded yet.</div>
                ) : (
                  <TableWrap label="Latest runs">
                    <thead>
                      <tr>
                        <th scope="col">Job</th>
                        <th scope="col">Started</th>
                        <th scope="col">Trigger</th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={r.id}>
                          <td>{humanize(r.jobId)}</td>
                          <td>{formatIST(r.startedAt)}</td>
                          <td>{humanize(r.triggeredBy)}</td>
                          <td>
                            <Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge>
                            {r.error ? <div className="small error-text">{r.error}</div> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </TableWrap>
                )}
                <p className="small">
                  <Link to="/automation">View all job runs</Link>
                </p>
              </section>
            </div>
          </>
        ) : null}
      </Loadable>

      <section className="card">
        <h2>Unread alerts</h2>
        <LiveStatus status={action.status} />
        <Loadable loading={alerts.loading} error={alerts.error} empty={alertList.length === 0} emptyText="No unread alerts.">
          <ul className="alert-list">
            {alertList.map((a) => (
              <li key={a.id} className={a.level === 'important' ? 'alert important' : 'alert'}>
                <div>
                  <strong>{a.title}</strong> {a.level === 'important' ? <Badge tone="review">Important</Badge> : null}
                  {a.body ? <p>{a.body}</p> : null}
                  <span className="muted small">{formatIST(a.createdAt)}</span>
                </div>
                {canEdit ? (
                  <button type="button" className="btn btn-small" onClick={() => markRead(a.id)} disabled={action.busy}>
                    Mark read
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </Loadable>
      </section>
    </>
  );
}
