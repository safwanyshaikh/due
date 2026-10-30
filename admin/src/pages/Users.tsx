import { useState, type FormEvent } from 'react';
import { api, asList, qs } from '../lib/api';
import { useApi, useAction } from '../lib/useApi';
import { can, useAuth, ROLES } from '../lib/auth';
import { extractLink } from '../lib/payloads';
import type { AuditEntry, LoginEvent, Role, SessionRow, UserRow } from '../lib/types';
import { formatIST, humanize } from '../lib/format';
import { Badge, Field, JsonBlock, LiveStatus, Loadable, PageHeader, TableWrap, Tabs } from '../components/ui';

type Tab = 'users' | 'logins' | 'sessions' | 'audit';

function OneTimeLink({ link, onClose }: { link: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="card link-box" role="region" aria-label="One-time link">
      <h3>One-time link</h3>
      <p className="small muted">Share this link privately. It works once and expires. It will not be shown again.</p>
      <Field label="Link">{(id) => <input id={id} readOnly value={link} onFocus={(e) => e.currentTarget.select()} />}</Field>
      <div className="actions">
        <button className="btn btn-primary" type="button" onClick={copy}>
          Copy link
        </button>
        <button className="btn" type="button" onClick={onClose}>
          Done
        </button>
      </div>
      <div role="status" aria-live="polite">
        {copied ? <p className="msg msg-ok">Copied to clipboard.</p> : null}
      </div>
    </div>
  );
}

function UsersTab() {
  const { me } = useAuth();
  const list = useApi<unknown>('/admin/users?limit=500');
  const users = asList<UserRow>(list.data, 'users');
  const action = useAction();
  const [link, setLink] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const isOwner = can(me?.role, 'owner');
  const assignable = ROLES.filter((r) => isOwner || r !== 'owner');
  const canManage = (u: UserRow) => u.id !== me?.id && (isOwner || u.role !== 'owner');

  async function invite(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !name.trim()) return action.setStatus({ kind: 'error', text: 'Email and name are required.' });
    const r = await action.run(() => api.post('/admin/users', { email: email.trim(), name: name.trim(), role }), 'User invited.');
    if (r !== undefined) {
      setLink(extractLink(r));
      setEmail('');
      setName('');
      setInviting(false);
      list.reload();
    }
  }

  async function patch(u: UserRow, body: Partial<Pick<UserRow, 'role' | 'status'>>, msg: string) {
    await action.run(() => api.patch(`/admin/users/${u.id}`, body), msg);
    list.reload();
  }

  async function resetLink(u: UserRow) {
    const r = await action.run(() => api.post(`/admin/users/${u.id}/reset-link`), `Reset link created for ${u.email}.`);
    if (r !== undefined) setLink(extractLink(r));
  }

  async function revoke(u: UserRow) {
    if (!window.confirm(`Sign ${u.email} out of all sessions?`)) return;
    await action.run(() => api.post(`/admin/users/${u.id}/revoke-sessions`), `Sessions revoked for ${u.email}.`);
  }

  return (
    <>
      <div className="actions">
        <button className="btn btn-primary" type="button" onClick={() => setInviting((v) => !v)} aria-expanded={inviting}>
          Invite user
        </button>
      </div>
      {inviting ? (
        <form className="card form-grid" onSubmit={invite} noValidate aria-label="Invite user">
          <Field label="Email">{(id) => <input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Field label="Name">{(id) => <input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Role">
            {(id) => (
              <select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {assignable.map((r) => (
                  <option key={r} value={r}>
                    {humanize(r)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="actions span-2">
            <button className="btn btn-primary" type="submit" disabled={action.busy}>
              Create invite link
            </button>
          </div>
        </form>
      ) : null}
      {link ? <OneTimeLink link={link} onClose={() => setLink(null)} /> : null}
      <LiveStatus status={action.status} />
      <Loadable loading={list.loading} error={list.error} empty={users.length === 0} emptyText="No users yet.">
        <TableWrap label="Users">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Email</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Last sign-in</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  {canManage(u) ? (
                    <select
                      aria-label={`Role for ${u.email}`}
                      value={u.role}
                      onChange={(e) => patch(u, { role: e.target.value as Role }, `Role updated for ${u.email}.`)}
                    >
                      {assignable.map((r) => (
                        <option key={r} value={r}>
                          {humanize(r)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    humanize(u.role)
                  )}
                </td>
                <td>
                  <Badge tone={u.status === 'active' ? 'ok' : 'error'}>{humanize(u.status)}</Badge>
                </td>
                <td>{formatIST(u.lastLoginAt)}</td>
                <td className="row-actions">
                  {canManage(u) ? (
                    <>
                      <button
                        className="btn btn-small"
                        type="button"
                        onClick={() =>
                          patch(u, { status: u.status === 'active' ? 'disabled' : 'active' }, u.status === 'active' ? `${u.email} disabled.` : `${u.email} enabled.`)
                        }
                      >
                        {u.status === 'active' ? 'Disable' : 'Enable'}
                      </button>
                      <button className="btn btn-small" type="button" onClick={() => resetLink(u)}>
                        Reset link
                      </button>
                      <button className="btn btn-small" type="button" onClick={() => revoke(u)}>
                        Revoke sessions
                      </button>
                    </>
                  ) : (
                    <span className="muted small">{u.id === me?.id ? 'You' : 'Owner only'}</span>
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

function LoginsTab() {
  const list = useApi<unknown>('/admin/users/login-events');
  const events = asList<LoginEvent>(list.data, 'events', 'loginEvents');
  return (
    <Loadable loading={list.loading} error={list.error} empty={events.length === 0} emptyText="No sign-in attempts recorded.">
      <TableWrap label="Login history">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Email</th>
            <th scope="col">Result</th>
            <th scope="col">Reason</th>
            <th scope="col">IP</th>
            <th scope="col">Browser</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td>{formatIST(e.at)}</td>
              <td>{e.email || '—'}</td>
              <td>
                <Badge tone={e.success ? 'ok' : 'error'}>{e.success ? 'Success' : 'Failed'}</Badge>
              </td>
              <td>{humanize(e.reason) || '—'}</td>
              <td>{e.ip || '—'}</td>
              <td className="small break">{e.userAgent || '—'}</td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </Loadable>
  );
}

function SessionsTab() {
  const list = useApi<unknown>('/admin/users/sessions');
  const sessions = asList<SessionRow>(list.data, 'sessions');
  return (
    <Loadable loading={list.loading} error={list.error} empty={sessions.length === 0} emptyText="No active sessions.">
      <TableWrap label="Active sessions">
        <thead>
          <tr>
            <th scope="col">User</th>
            <th scope="col">Started</th>
            <th scope="col">Last seen</th>
            <th scope="col">Expires</th>
            <th scope="col">IP</th>
            <th scope="col">Browser</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s, i) => (
            <tr key={s.idHash ?? s.id ?? i}>
              <td>{s.userEmail || s.email || s.userId || '—'}</td>
              <td>{formatIST(s.createdAt)}</td>
              <td>{formatIST(s.lastSeenAt)}</td>
              <td>{formatIST(s.expiresAt)}</td>
              <td>{s.ip || '—'}</td>
              <td className="small break">{s.userAgent || '—'}</td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </Loadable>
  );
}

function AuditTab() {
  const [entityType, setEntityType] = useState('');
  const [actor, setActor] = useState('');
  const [applied, setApplied] = useState({ entityType: '', actor: '' });
  const list = useApi<unknown>(`/admin/audit${qs(applied)}`);
  const entries = asList<AuditEntry>(list.data, 'entries', 'audit');
  const [open, setOpen] = useState<string | number | null>(null);
  return (
    <>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied({ entityType: entityType.trim(), actor: actor.trim() });
        }}
      >
        <Field label="Entity type">
          {(id) => (
            <select id={id} value={entityType} onChange={(e) => setEntityType(e.target.value)}>
              <option value="">All</option>
              {['user', 'company', 'source', 'record', 'category', 'job', 'setting', 'session', 'offer'].map((t) => (
                <option key={t} value={t}>
                  {humanize(t)}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Actor (user ID or email)">{(id) => <input id={id} value={actor} onChange={(e) => setActor(e.target.value)} />}</Field>
        <button className="btn" type="submit">
          Apply filters
        </button>
      </form>
      <Loadable loading={list.loading} error={list.error} empty={entries.length === 0} emptyText="No audit entries match.">
        <TableWrap label="Audit log">
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Actor</th>
              <th scope="col">Action</th>
              <th scope="col">Entity</th>
              <th scope="col">IP</th>
              <th scope="col">Details</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((a) => (
              <tr key={a.id}>
                <td>{formatIST(a.at)}</td>
                <td>{a.actorEmail || a.actorName || a.actorUserId || 'System'}</td>
                <td>{a.action}</td>
                <td>
                  {humanize(a.entityType)} <span className="small muted break">{a.entityId}</span>
                </td>
                <td>{a.ip || '—'}</td>
                <td>
                  <button className="btn btn-small" type="button" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                    {open === a.id ? 'Hide' : 'Show'}
                  </button>
                  {open === a.id ? (
                    <div className="audit-detail">
                      <p className="small">Before</p>
                      <JsonBlock value={a.before} />
                      <p className="small">After</p>
                      <JsonBlock value={a.after} />
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Loadable>
    </>
  );
}

export function UsersPage() {
  const [tab, setTab] = useState<Tab>('users');
  return (
    <>
      <PageHeader title="Users & access" />
      <Tabs
        label="Access sections"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'users', label: 'Users' },
          { value: 'logins', label: 'Login history' },
          { value: 'sessions', label: 'Active sessions' },
          { value: 'audit', label: 'Audit log' },
        ]}
      />
      {tab === 'users' ? <UsersTab /> : tab === 'logins' ? <LoginsTab /> : tab === 'sessions' ? <SessionsTab /> : <AuditTab />}
    </>
  );
}
