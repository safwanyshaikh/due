import { useState } from 'react';
import { api, asList, qs } from '../lib/api';
import { useApi, useAction } from '../lib/useApi';
import { useCan } from '../lib/auth';
import { jobPayload } from '../lib/payloads';
import type { Alert, Job, JobRun } from '../lib/types';
import { checkedEvery, formatIST, frequencyToMinutes, humanize, minutesToFrequency, type FrequencyUnit } from '../lib/format';
import { Badge, Field, JsonBlock, LiveStatus, Loadable, PageHeader, TableWrap, Tabs, statusTone } from '../components/ui';
import { jobLastStatus } from './Dashboard';

function IntervalEditor({ job, onSave, busy }: { job: Job; onSave: (minutes: number) => void; busy: boolean }) {
  const init = minutesToFrequency(job.intervalMinutes);
  const [amount, setAmount] = useState(String(init.amount));
  const [unit, setUnit] = useState<FrequencyUnit>(init.unit);
  const minutes = frequencyToMinutes(Number(amount), unit);
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (minutes >= 60) onSave(minutes);
      }}
      aria-label={`Interval for ${humanize(job.id)}`}
    >
      <Field label="Every">{(id) => <input id={id} type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} className="w-num" />}</Field>
      <Field label="Unit">
        {(id) => (
          <select id={id} value={unit} onChange={(e) => setUnit(e.target.value as FrequencyUnit)}>
            <option value="hours">Hours</option>
            <option value="days">Days</option>
          </select>
        )}
      </Field>
      <button className="btn btn-small" type="submit" disabled={busy || minutes < 60 || minutes === job.intervalMinutes}>
        Save interval
      </button>
    </form>
  );
}

function JobsTab() {
  const jobs = useApi<unknown>('/admin/jobs');
  const [jobFilter, setJobFilter] = useState('');
  const runs = useApi<unknown>(`/admin/jobs/job-runs${qs({ jobId: jobFilter })}`);
  const jobList = asList<Job>(jobs.data, 'jobs');
  const runList = asList<JobRun>(runs.data, 'runs', 'jobRuns');
  const canEdit = useCan('edit');
  const canAdmin = useCan('admin');
  const action = useAction();

  async function patch(j: Job, body: { enabled?: boolean; intervalMinutes?: number }, msg: string) {
    await action.run(() => api.patch(`/admin/jobs/${j.id}`, jobPayload(body)), msg);
    jobs.reload();
  }
  async function runNow(j: Job) {
    await action.run(() => api.post(`/admin/jobs/${j.id}/run`), `${humanize(j.id)} run requested.`);
    jobs.reload();
    runs.reload();
  }

  return (
    <>
      <LiveStatus status={action.status} />
      <Loadable loading={jobs.loading} error={jobs.error} empty={jobList.length === 0}>
        <div className="job-cards">
          {jobList.map((j) => (
            <section key={j.id} className="card">
              <div className="row between">
                <h2>{humanize(j.id)}</h2>
                <Badge tone={j.enabled ? 'ok' : 'neutral'}>{j.enabled ? 'Enabled' : 'Paused'}</Badge>
              </div>
              <dl className="kv">
                <dt>Schedule</dt>
                <dd>{checkedEvery(j.intervalMinutes)}</dd>
                <dt>Last run</dt>
                <dd>{formatIST(j.lastRunAt)}</dd>
                <dt>Next run</dt>
                <dd>{j.enabled ? formatIST(j.nextRunAt, 'Not scheduled') : 'Paused'}</dd>
                <dt>Last status</dt>
                <dd>{jobLastStatus(j) ? <Badge tone={statusTone(jobLastStatus(j))}>{humanize(jobLastStatus(j))}</Badge> : 'No runs yet'}</dd>
              </dl>
              {canAdmin ? (
                <IntervalEditor job={j} busy={action.busy} onSave={(m) => patch(j, { intervalMinutes: m }, `Interval updated: ${checkedEvery(m)}.`)} />
              ) : null}
              <div className="actions">
                {canEdit ? (
                  <button className="btn btn-primary btn-small" type="button" onClick={() => runNow(j)} disabled={action.busy}>
                    Run now
                  </button>
                ) : null}
                {canAdmin ? (
                  <button className="btn btn-small" type="button" onClick={() => patch(j, { enabled: !j.enabled }, j.enabled ? 'Job paused.' : 'Job enabled.')} disabled={action.busy}>
                    {j.enabled ? 'Disable' : 'Enable'}
                  </button>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      </Loadable>

      <section className="card">
        <div className="row between">
          <h2>Job runs</h2>
          <Field label="Job">
            {(id) => (
              <select id={id} value={jobFilter} onChange={(e) => setJobFilter(e.target.value)}>
                <option value="">All jobs</option>
                {jobList.map((j) => (
                  <option key={j.id} value={j.id}>
                    {humanize(j.id)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Loadable loading={runs.loading} error={runs.error} empty={runList.length === 0} emptyText="No job runs yet.">
          <TableWrap label="Job runs">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Trigger</th>
                <th scope="col">Started</th>
                <th scope="col">Finished</th>
                <th scope="col">Status</th>
                <th scope="col">Stats</th>
                <th scope="col">Error</th>
              </tr>
            </thead>
            <tbody>
              {runList.map((r) => (
                <tr key={r.id}>
                  <td>{humanize(r.jobId)}</td>
                  <td>{humanize(r.triggeredBy)}</td>
                  <td>{formatIST(r.startedAt)}</td>
                  <td>{formatIST(r.finishedAt, '—')}</td>
                  <td>
                    <Badge tone={statusTone(r.status)}>{humanize(r.status)}</Badge>
                  </td>
                  <td>
                    {r.stats && typeof r.stats === 'object' ? (
                      <ul className="stats-inline">
                        {Object.entries(r.stats).map(([k, v]) => (
                          <li key={k}>
                            {humanize(k)}: {typeof v === 'object' ? JSON.stringify(v) : String(v)}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="error-text">{r.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Loadable>
      </section>
    </>
  );
}

function AlertsTab() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const list = useApi<unknown>(`/admin/alerts${unreadOnly ? '?unread=1' : ''}`);
  const alerts = asList<Alert>(list.data, 'alerts');
  const canEdit = useCan('edit');
  const action = useAction();
  async function markRead(a: Alert) {
    await action.run(() => api.post(`/admin/alerts/${a.id}/read`), 'Alert marked as read.');
    list.reload();
  }
  return (
    <section className="card">
      <label className="check">
        <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
      </label>
      <LiveStatus status={action.status} />
      <Loadable loading={list.loading} error={list.error} empty={alerts.length === 0} emptyText="No alerts.">
        <ul className="alert-list">
          {alerts.map((a) => (
            <li key={a.id} className={`alert${a.level === 'important' ? ' important' : ''}${a.readAt ? ' read' : ''}`}>
              <div>
                <strong>{a.title}</strong> {a.level === 'important' ? <Badge tone="review">Important</Badge> : null}
                {a.body ? <p>{a.body}</p> : null}
                <span className="muted small">
                  {formatIST(a.createdAt)}
                  {a.readAt ? ` · read ${formatIST(a.readAt)}` : ' · unread'}
                </span>
                {a.entityType ? <JsonBlock value={`${a.entityType} ${a.entityId ?? ''}`} /> : null}
              </div>
              {canEdit && !a.readAt ? (
                <button className="btn btn-small" type="button" onClick={() => markRead(a)} disabled={action.busy}>
                  Mark read
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </Loadable>
    </section>
  );
}

export function AutomationPage() {
  const [tab, setTab] = useState<'jobs' | 'alerts'>('jobs');
  return (
    <>
      <PageHeader title="Automation">Jobs run on a schedule (periodic polling).</PageHeader>
      <Tabs
        label="Automation sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'jobs', label: 'Jobs' },
          { value: 'alerts', label: 'Alerts' },
        ]}
      />
      {tab === 'jobs' ? <JobsTab /> : <AlertsTab />}
    </>
  );
}
