import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useApi, useAction } from '../lib/useApi';
import { useCan } from '../lib/auth';
import { checkedEvery, formatIST, frequencyToMinutes, minutesToFrequency, type FrequencyUnit } from '../lib/format';
import { Field, LiveStatus, Loadable, PageHeader } from '../components/ui';

type Json = Record<string, unknown>;
interface SettingsMap {
  values: Record<string, Json>;
  meta: Record<string, { updatedAt?: string; updatedBy?: string }>;
  smtpConfigured: boolean;
}

/** Accepts [{key,value}], {settings:[...]}, {settings:{k:v}} or {k:v}. */
export function toSettingsMap(data: unknown): SettingsMap {
  const out: SettingsMap = { values: {}, meta: {}, smtpConfigured: false };
  if (!data || typeof data !== 'object') return out;
  const root = data as Json;
  out.smtpConfigured = root.smtp_configured === true || root.smtpConfigured === true || root.email_available === true;
  const src = Array.isArray(data) ? data : (root.settings ?? root);
  if (Array.isArray(src)) {
    for (const row of src as Json[]) {
      if (row && typeof row.key === 'string') {
        out.values[row.key] = (row.value as Json) ?? {};
        out.meta[row.key] = {
          updatedAt: (row.updated_at ?? row.updatedAt) as string | undefined,
          updatedBy: (row.updated_by ?? row.updatedBy) as string | undefined,
        };
      }
    }
  } else if (src && typeof src === 'object') {
    for (const [k, v] of Object.entries(src as Json)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) out.values[k] = v as Json;
    }
  }
  return out;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function SettingCard({
  title,
  settingKey,
  meta,
  canEdit,
  onSave,
  children,
  description,
}: {
  title: string;
  settingKey: string;
  meta?: { updatedAt?: string };
  canEdit: boolean;
  onSave: () => Promise<unknown>;
  children: ReactNode;
  description?: string;
}) {
  const action = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    await action.run(onSave, `${title} saved.`);
  }
  return (
    <form className="card" onSubmit={submit} aria-label={title}>
      <h2>{title}</h2>
      {description ? <p className="muted small">{description}</p> : null}
      <fieldset disabled={!canEdit} className="plain">
        <div className="form-grid">{children}</div>
      </fieldset>
      <p className="muted small">
        Key <code>{settingKey}</code>
        {meta?.updatedAt ? ` · last updated ${formatIST(meta.updatedAt)}` : ''}
      </p>
      <LiveStatus status={action.status} />
      {canEdit ? (
        <button className="btn btn-primary" type="submit" disabled={action.busy}>
          Save
        </button>
      ) : null}
    </form>
  );
}

function FreqInput({ label, minutes, onChange }: { label: string; minutes: number; onChange: (m: number) => void }) {
  const init = minutesToFrequency(minutes);
  const [amount, setAmount] = useState(String(init.amount));
  const [unit, setUnit] = useState<FrequencyUnit>(init.unit);
  useEffect(() => {
    onChange(frequencyToMinutes(Number(amount), unit));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, unit]);
  const m = frequencyToMinutes(Number(amount), unit);
  return (
    <fieldset className="freq">
      <legend>{label}</legend>
      <div className="row">
        <Field label="Every">{(id) => <input id={id} type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Unit">
          {(id) => (
            <select id={id} value={unit} onChange={(e) => setUnit(e.target.value as FrequencyUnit)}>
              <option value="hours">Hours</option>
              <option value="days">Days</option>
            </select>
          )}
        </Field>
      </div>
      <p className="hint">{checkedEvery(m)}</p>
    </fieldset>
  );
}

function NumberField({ label, value, onChange, hint }: { label: string; value: number; onChange: (n: number) => void; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      {(id, h) => <input id={id} type="number" min={0} aria-describedby={h} value={String(value)} onChange={(e) => onChange(Number(e.target.value))} />}
    </Field>
  );
}

function SettingsForms({ map, canEdit }: { map: SettingsMap; canEdit: boolean }) {
  const v = map.values;
  const [freq, setFreq] = useState<Json>({ ...(v.frequency_defaults ?? {}) });
  const [retry, setRetry] = useState<Json>({ ...(v.retry ?? {}) });
  const [retention, setRetention] = useState<Json>({ ...(v.retention ?? {}) });
  const [notif, setNotif] = useState<Json>({ ...(v.notifications ?? {}) });
  const [business, setBusiness] = useState<Json>({ ...(v.business ?? {}) });
  const [recipients, setRecipients] = useState(Array.isArray(notif.recipients) ? (notif.recipients as string[]).join(', ') : '');

  const save = (key: string, value: unknown) => api.patch('/admin/settings', { key, value });
  const emailEnabled = notif.email_enabled === true;
  const emailAvailable = map.smtpConfigured || emailEnabled;

  return (
    <>
      <SettingCard
        title="Frequency defaults"
        settingKey="frequency_defaults"
        meta={map.meta.frequency_defaults}
        canEdit={canEdit}
        description="Default check interval for new sources by priority. Sources are polled on this schedule."
        onSave={() => save('frequency_defaults', freq)}
      >
        {(['critical', 'regular', 'secondary'] as const).map((p) => (
          <FreqInput key={p} label={`${p[0].toUpperCase()}${p.slice(1)} sources`} minutes={num(freq[p], 10080)} onChange={(m) => setFreq((f) => ({ ...f, [p]: m }))} />
        ))}
      </SettingCard>

      <SettingCard
        title="Retry and backoff"
        settingKey="retry"
        meta={map.meta.retry}
        canEdit={canEdit}
        description="Failed sources wait base × 2^(failures − 1) minutes, capped at the maximum."
        onSave={() => save('retry', retry)}
      >
        <NumberField label="Base wait (minutes)" value={num(retry.base_minutes)} onChange={(n) => setRetry((r) => ({ ...r, base_minutes: n }))} />
        <NumberField label="Maximum wait (minutes)" value={num(retry.max_minutes)} onChange={(n) => setRetry((r) => ({ ...r, max_minutes: n }))} />
        <NumberField
          label="Failures before marking inaccessible"
          value={num(retry.max_attempts_before_inaccessible)}
          onChange={(n) => setRetry((r) => ({ ...r, max_attempts_before_inaccessible: n }))}
        />
      </SettingCard>

      <SettingCard title="Retention" settingKey="retention" meta={map.meta.retention} canEdit={canEdit} onSave={() => save('retention', retention)}>
        <NumberField label="Keep snapshots (days)" value={num(retention.snapshots_days)} onChange={(n) => setRetention((r) => ({ ...r, snapshots_days: n }))} />
        <NumberField label="Keep login history (days)" value={num(retention.login_events_days)} onChange={(n) => setRetention((r) => ({ ...r, login_events_days: n }))} />
      </SettingCard>

      <SettingCard
        title="Notifications"
        settingKey="notifications"
        meta={map.meta.notifications}
        canEdit={canEdit}
        description="Alerts always appear in-app. Email delivery requires SMTP credentials on the server."
        onSave={() =>
          save('notifications', {
            ...notif,
            recipients: recipients
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          })
        }
      >
        <div className="span-2">
          <p>
            Email: <strong>{emailAvailable ? (emailEnabled ? 'Enabled' : 'Available, off') : 'Needs SMTP credentials'}</strong>
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={emailEnabled}
              disabled={!emailAvailable}
              onChange={(e) => setNotif((n) => ({ ...n, email_enabled: e.target.checked }))}
            />{' '}
            Send email alerts
          </label>
        </div>
        <Field label="Email recipients" hint="Comma-separated addresses.">
          {(id, h) => <input id={id} aria-describedby={h} value={recipients} onChange={(e) => setRecipients(e.target.value)} />}
        </Field>
      </SettingCard>

      <SettingCard title="Business" settingKey="business" meta={map.meta.business} canEdit={canEdit} onSave={() => save('business', business)}>
        <Field label="App name">
          {(id) => <input id={id} value={typeof business.app_name === 'string' ? business.app_name : ''} onChange={(e) => setBusiness((b) => ({ ...b, app_name: e.target.value }))} />}
        </Field>
        <Field label="Support email">
          {(id) => (
            <input
              id={id}
              type="email"
              value={typeof business.support_email === 'string' ? business.support_email : ''}
              onChange={(e) => setBusiness((b) => ({ ...b, support_email: e.target.value || null }))}
            />
          )}
        </Field>
      </SettingCard>
    </>
  );
}

export function SettingsPage() {
  const res = useApi<unknown>('/admin/settings', { raw: true });
  const canEdit = useCan('admin');
  const map = res.data ? toSettingsMap(res.data) : null;
  return (
    <>
      <PageHeader title="Settings">{canEdit ? null : 'Read-only. Admins can change settings.'}</PageHeader>
      <Loadable loading={res.loading} error={res.error} empty={!map || Object.keys(map.values).length === 0}>
        {map ? <SettingsForms map={map} canEdit={canEdit} /> : null}
      </Loadable>
    </>
  );
}
