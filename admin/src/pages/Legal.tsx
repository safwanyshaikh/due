import { useState, type FormEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { useAction, useApi } from '../lib/useApi';
import { Field, LiveStatus, Loadable, PageHeader } from '../components/ui';

/**
 * Legal content (contract "Legal content"): stored as legal.* settings, served by GET /api/public/legal.
 * The consumer app shows "Legal details are being finalised" until every required field holds real content,
 * and this panel shows "Legal details incomplete" for the same condition (the server decides, not this page).
 */

export interface PublicLegalStatus {
  complete: boolean;
  missing: string[];
}

type Kind = 'text' | 'email' | 'tel' | 'date' | 'textarea' | 'markdown';
export const LEGAL_FIELDS: { key: string; label: string; kind: Kind; hint?: string }[] = [
  { key: 'legal.entity_name', label: 'Legal entity name', kind: 'text' },
  { key: 'legal.address', label: 'Registered address', kind: 'textarea' },
  { key: 'legal.grievance_officer_name', label: 'Grievance officer name', kind: 'text' },
  { key: 'legal.grievance_email', label: 'Grievance officer email', kind: 'email', hint: 'A real, monitored address. Placeholder domains are rejected.' },
  { key: 'legal.grievance_phone', label: 'Grievance officer phone (optional)', kind: 'tel' },
  { key: 'legal.support_email', label: 'Support email', kind: 'email' },
  { key: 'legal.incident_contact', label: 'Security incident contact', kind: 'text' },
  { key: 'legal.effective_date', label: 'Effective date', kind: 'date' },
  { key: 'legal.privacy_policy_md', label: 'Privacy policy (Markdown)', kind: 'markdown' },
  { key: 'legal.terms_md', label: 'Terms of use (Markdown)', kind: 'markdown' },
  { key: 'legal.deletion_policy_md', label: 'Deletion policy (Markdown)', kind: 'markdown' },
];

const LABEL: Record<string, string> = Object.fromEntries([
  ...LEGAL_FIELDS.map((f) => [f.key, f.label]),
  ['legal.subprocessors', 'Subprocessors'],
]);

export interface Subprocessor {
  name: string;
  purpose: string;
  region: string;
}

/** One subprocessor per line: "Name | Purpose | Region". */
export function parseSubprocessors(text: string): { items: Subprocessor[]; error: string | null } {
  const items: Subprocessor[] = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    const [name, purpose, region, ...rest] = line.split('|').map((s) => s.trim());
    if (!name || !purpose || !region || rest.length) return { items: [], error: `Line ${i + 1}: use "Name | Purpose | Region".` };
    items.push({ name, purpose, region });
  }
  return { items, error: null };
}

export function formatSubprocessors(v: unknown): string {
  return Array.isArray(v) ? (v as Subprocessor[]).map((s) => `${s.name} | ${s.purpose} | ${s.region}`).join('\n') : '';
}

/** Value to PATCH for a field, from the form's string (dates: '' clears to null). */
export function legalValue(key: string, text: string): unknown {
  if (key === 'legal.effective_date') return text.trim() === '' ? null : text.trim();
  return text;
}

/** Banner for the admin shell and this page; renders nothing until the server says the details are complete or not. */
export function LegalBanner({ status, link = true }: { status: PublicLegalStatus | null; link?: boolean }) {
  // Only a well-formed answer from the server decides; anything else shows nothing rather than guessing.
  if (!status || status.complete !== false) return null;
  const missing = Array.isArray(status.missing) ? status.missing : [];
  return (
    <div className="msg msg-error" role="status" data-testid="legal-incomplete">
      <strong>Legal details incomplete.</strong> The app shows “Legal details are being finalised” until{' '}
      {missing.length === 0
        ? 'every required field is'
        : missing.length > 3
          ? `${missing.length} required fields are`
          : `${missing.map((k) => LABEL[k] ?? k).join(', ')} ${missing.length === 1 ? 'is' : 'are'}`}{' '}
      filled in. {link ? <NavLink to="/legal">Edit legal details</NavLink> : null}
    </div>
  );
}

function LegalForm({ values, canEdit, onSaved }: { values: Record<string, unknown>; canEdit: boolean; onSaved: () => void }) {
  const initial = Object.fromEntries(LEGAL_FIELDS.map((f) => [f.key, typeof values[f.key] === 'string' ? (values[f.key] as string) : '']));
  const [form, setForm] = useState<Record<string, string>>(initial);
  const [subs, setSubs] = useState(formatSubprocessors(values['legal.subprocessors']));
  const action = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = parseSubprocessors(subs);
    if (parsed.error) {
      action.setStatus({ kind: 'error', text: parsed.error });
      return;
    }
    const ok = await action.run(async () => {
      for (const f of LEGAL_FIELDS) {
        if (form[f.key] !== initial[f.key]) await api.patch('/admin/settings', { key: f.key, value: legalValue(f.key, form[f.key]) });
      }
      if (subs !== formatSubprocessors(values['legal.subprocessors'])) {
        await api.patch('/admin/settings', { key: 'legal.subprocessors', value: parsed.items });
      }
      return true;
    }, 'Legal details saved.');
    if (ok) onSaved();
  }

  return (
    <form className="card" onSubmit={submit} aria-label="Legal details">
      <fieldset disabled={!canEdit} className="plain">
        <div className="form-grid">
          {LEGAL_FIELDS.map((f) => (
            <div key={f.key} className={f.kind === 'markdown' || f.kind === 'textarea' ? 'span-2' : undefined}>
              <Field label={f.label} hint={f.hint}>
                {(id, h) =>
                  f.kind === 'markdown' || f.kind === 'textarea' ? (
                    <textarea
                      id={id}
                      aria-describedby={h}
                      rows={f.kind === 'markdown' ? 10 : 3}
                      value={form[f.key]}
                      onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                    />
                  ) : (
                    <input
                      id={id}
                      aria-describedby={h}
                      type={f.kind}
                      value={form[f.key]}
                      onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                    />
                  )
                }
              </Field>
            </div>
          ))}
          <div className="span-2">
            <Field label="Subprocessors" hint='One per line: "Name | Purpose | Region".'>
              {(id, h) => <textarea id={id} aria-describedby={h} rows={5} value={subs} onChange={(e) => setSubs(e.target.value)} />}
            </Field>
          </div>
        </div>
      </fieldset>
      <LiveStatus status={action.status} />
      {canEdit ? (
        <button className="btn btn-primary" type="submit" disabled={action.busy}>
          Save legal details
        </button>
      ) : null}
    </form>
  );
}

export function LegalPage() {
  const settings = useApi<Record<string, unknown>>('/admin/settings', { raw: true });
  const status = useApi<PublicLegalStatus>('/public/legal', { raw: true });
  const canEdit = useCan('admin');
  return (
    <>
      <PageHeader title="Legal details">
        Shown in the app’s Privacy, Terms, Deletion, Subprocessors and Grievance pages. {canEdit ? null : 'Read-only. Admins can change legal details.'}
      </PageHeader>
      {status.data?.complete === true ? (
        <p className="msg msg-ok" role="status">
          Legal details complete.
        </p>
      ) : (
        <LegalBanner status={status.data} link={false} />
      )}
      <Loadable loading={settings.loading} error={settings.error} empty={!settings.data}>
        {settings.data ? (
          <LegalForm
            values={settings.data}
            canEdit={canEdit}
            onSaved={() => {
              status.reload();
              settings.reload();
            }}
          />
        ) : null}
      </Loadable>
    </>
  );
}
