import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api';
import { useApi, useAction } from '../lib/useApi';
import { useCan } from '../lib/auth';
import { checkedEvery, formatIST, frequencyToMinutes, minutesToFrequency, type FrequencyUnit } from '../lib/format';
import { Field, LiveStatus, Loadable, PageHeader } from '../components/ui';

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Same rule as the server: state code 01-38, PAN pattern, entity number, Z, mod-36 check character. */
export function isValidGstin(v: string): boolean {
  if (!/^(0[1-9]|[12]\d|3[0-8])[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(v)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = GSTIN_CHARS.indexOf(v[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GSTIN_CHARS[(36 - (sum % 36)) % 36] === v[14];
}

type Json = Record<string, unknown>;
interface SettingsMap {
  values: Record<string, Json>;
  /** Scalar settings (booleans, strings, null) such as beta.plus_free, keyed as stored. */
  raw: Record<string, unknown>;
  meta: Record<string, { updatedAt?: string; updatedBy?: string }>;
  smtpConfigured: boolean;
}

/** Accepts [{key,value}], {settings:[...]}, {settings:{k:v}} or {k:v}. */
export function toSettingsMap(data: unknown): SettingsMap {
  const out: SettingsMap = { values: {}, raw: {}, meta: {}, smtpConfigured: false };
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
      out.raw[k] = v;
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

  const betaOn = map.raw['beta.plus_free'] === true;
  const [plusFree, setPlusFree] = useState(betaOn);
  const [endsOn, setEndsOn] = useState(typeof map.raw['beta.ends_on'] === 'string' ? (map.raw['beta.ends_on'] as string) : '');

  const [androidUrl, setAndroidUrl] = useState(typeof map.raw['app.android_url'] === 'string' ? (map.raw['app.android_url'] as string) : '');
  const [iosUrl, setIosUrl] = useState(typeof map.raw['app.ios_url'] === 'string' ? (map.raw['app.ios_url'] as string) : '');

  const [gstReg, setGstReg] = useState(map.raw['billing.gst_registered'] === true);
  const [gstin, setGstin] = useState(typeof map.raw['billing.gstin'] === 'string' ? (map.raw['billing.gstin'] as string) : '');

  const save = (key: string, value: unknown) => api.patch('/admin/settings', { key, value });
  const emailEnabled = notif.email_enabled === true;
  const emailAvailable = map.smtpConfigured || emailEnabled;

  return (
    <>
      <SettingCard
        title="Free public beta"
        settingKey="beta.plus_free"
        meta={map.meta['beta.plus_free']}
        canEdit={canEdit}
        description="While on, every signed-in account gets Plus features and checkout is refused. Turn it off to return to the normal paid flow. Changes are audit-logged."
        onSave={async () => {
          const date = endsOn.trim();
          if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Use the date format YYYY-MM-DD, like 2026-12-31.');
          await save('beta.ends_on', date || null);
          await save('beta.plus_free', plusFree);
        }}
      >
        <label className="check span-2">
          <input type="checkbox" checked={plusFree} onChange={(e) => setPlusFree(e.target.checked)} /> Plus is free for everyone (beta on)
        </label>
        <Field label="Beta ends on (optional)" hint="Last day of the beta, YYYY-MM-DD (IST). Leave empty for no end date. The beta also stops by itself after this day.">
          {(id, h) => <input id={id} aria-describedby={h} type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />}
        </Field>
      </SettingCard>

      <SettingCard
        title="GST"
        settingKey="billing.gst_registered"
        meta={map.meta['billing.gst_registered']}
        canEdit={canEdit}
        description="If registered, prices show “incl. 18% GST” and invoices carry your GSTIN. If not, no GST is charged or shown and invoices say “Not registered under GST”. Enter your own GSTIN here; it is never stored in the code."
        onSave={async () => {
          const g = gstin.trim().toUpperCase();
          if (gstReg && !isValidGstin(g)) throw new Error('Enter a valid 15-character GSTIN (state code, PAN pattern and check character).');
          await save('billing.gstin', gstReg ? g : g && isValidGstin(g) ? g : null);
          await save('billing.gst_registered', gstReg);
        }}
      >
        <label className="check span-2">
          <input type="checkbox" checked={gstReg} onChange={(e) => setGstReg(e.target.checked)} /> We are registered under GST
        </label>
        <Field label="GSTIN" hint="15 characters, for example 27AAAAA0000A1Z2 (a made-up example).">
          {(id, h) => <input id={id} aria-describedby={h} value={gstin} maxLength={15} onChange={(e) => setGstin(e.target.value.toUpperCase())} />}
        </Field>
      </SettingCard>

      <SettingCard
        title="App store links"
        settingKey="app.android_url"
        meta={map.meta['app.android_url']}
        canEdit={canEdit}
        description="The landing page shows a Google Play or App Store button only when the matching link is filled in. Leave empty to hide the button. Links must start with https://."
        onSave={async () => {
          for (const v of [androidUrl.trim(), iosUrl.trim()]) if (v && !/^https:\/\//.test(v)) throw new Error('Store links must start with https://');
          await save('app.android_url', androidUrl.trim() || null);
          await save('app.ios_url', iosUrl.trim() || null);
        }}
      >
        <Field label="Google Play link (app.android_url)">
          {(id) => <input id={id} type="url" placeholder="https://play.google.com/store/apps/details?id=..." value={androidUrl} onChange={(e) => setAndroidUrl(e.target.value)} />}
        </Field>
        <Field label="App Store link (app.ios_url)">
          {(id) => <input id={id} type="url" placeholder="https://apps.apple.com/in/app/..." value={iosUrl} onChange={(e) => setIosUrl(e.target.value)} />}
        </Field>
      </SettingCard>

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
