import { useId, useState, type FormEvent } from 'react';
import {
  ENTITY_TYPES,
  addProfile,
  canAddBusinessProfile,
  deleteProfile,
  entityTypeFromName,
  forgetDecision,
  laterQuestions,
  mergeProfiles,
  profileTotals,
  profilesOf,
  rolesFor,
  updateProfile,
  ProfileError,
  type EntityQuestion,
  type EntityType,
  type Profile,
  type ProfileRole,
} from '../../lib/profiles';
import {
  ENTITY_EXPLAIN,
  ENTITY_LABEL,
  GST_CHOICES,
  PROFILES_NOTE,
  ROLE_EXPLAIN,
  ROLE_LABEL,
  UPSELL_TEXT,
} from '../../content/profiles';
import { useApp } from '../store';
import { useAccount } from '../account/AccountContext';
import { ConfirmButton, Field, Notice } from '../components/ui';
import { inr } from '../lib/format';
import { EntityQuestionCard } from './EntityQuestionCard';
import './profiles.css';

const ANSWER_TEXT = {
  own: 'Your business',
  family: 'Family business',
  employee: 'You work there',
  not_mine: 'Not yours',
  later: 'Ask later',
} as const;

function gstText(v: boolean | null): string {
  return v === true ? 'GST registered' : v === false ? 'Not GST registered' : 'GST: not sure';
}

interface Draft {
  name: string;
  entityType: EntityType;
  role: ProfileRole;
  gst: 'yes' | 'no' | 'unsure';
}

const toGst = (g: Draft['gst']) => (g === 'yes' ? true : g === 'no' ? false : null);
const fromGst = (v: boolean | null): Draft['gst'] =>
  v === true ? 'yes' : v === false ? 'no' : 'unsure';

/** Name, entity type, role and GST. Personal can only change GST. */
function ProfileForm({
  initial,
  personal,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: Draft;
  personal?: boolean;
  submitLabel: string;
  onSubmit: (d: Draft) => string | null;
  onCancel?: () => void;
}) {
  const id = useId();
  const [d, setD] = useState<Draft>(initial);
  const [err, setErr] = useState<string | null>(null);
  const roles = rolesFor(d.entityType);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const role = roles.includes(d.role) ? d.role : roles[0];
    setErr(onSubmit({ ...d, role }));
  };
  return (
    <form className="stack-16" onSubmit={submit} noValidate>
      {err && <Notice tone="warn">{err}</Notice>}
      {!personal && (
        <>
          <Field label="Business name" htmlFor={`${id}-name`}>
            <input
              id={`${id}-name`}
              value={d.name}
              maxLength={60}
              autoComplete="organization"
              onChange={(e) => setD({ ...d, name: e.target.value })}
            />
          </Field>
          <Field
            label="What kind of business?"
            htmlFor={`${id}-entity`}
            hint={ENTITY_EXPLAIN[d.entityType]}
          >
            <select
              id={`${id}-entity`}
              value={d.entityType}
              onChange={(e) => {
                const entityType = e.target.value as EntityType;
                setD({ ...d, entityType, role: rolesFor(entityType)[0] });
              }}
            >
              {ENTITY_TYPES.filter((t) => t !== 'individual').map((t) => (
                <option key={t} value={t}>
                  {ENTITY_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="How are you linked to it?"
            htmlFor={`${id}-role`}
            hint={ROLE_EXPLAIN[roles.includes(d.role) ? d.role : roles[0]]}
          >
            <select
              id={`${id}-role`}
              value={roles.includes(d.role) ? d.role : roles[0]}
              onChange={(e) => setD({ ...d, role: e.target.value as ProfileRole })}
            >
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
      <fieldset className="pf-choices">
        <legend className="label-like">GST registered?</legend>
        <div className="seg2">
          {GST_CHOICES.map((c) => {
            const k = fromGst(c.value);
            return (
              <label key={k} className="pf-seg press">
                <input
                  type="radio"
                  name={`${id}-gst`}
                  checked={d.gst === k}
                  onChange={() => setD({ ...d, gst: k })}
                />
                <span>{c.label}</span>
              </label>
            );
          })}
        </div>
        <small className="hint">
          {GST_CHOICES.find((c) => fromGst(c.value) === d.gst)?.explain}
        </small>
      </fieldset>
      <div className="btn-row">
        <button type="submit" className="btn btn-primary press jelly">
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-quiet press" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function errText(e: unknown): string {
  return e instanceof ProfileError ? e.message : 'This couldn’t be saved. Try again.';
}

function ProfileCard({ p, others }: { p: Profile; others: Profile[] }) {
  const { data, update } = useApp();
  const [editing, setEditing] = useState(false);
  const [mergeChoice, setMergeInto] = useState<string>(others[0]?.id ?? '');
  const mergeInto = others.some((o) => o.id === mergeChoice) ? mergeChoice : (others[0]?.id ?? '');
  const id = useId();
  const t = profileTotals(data).find((x) => x.profileId === p.id);
  const business = p.kind === 'business';
  return (
    <li className="panel2 stack-12 pf-card" data-profile-card={p.id}>
      <div className="section-head">
        <h3 className="pf-card-title">{p.name}</h3>
        {!editing && (
          <button
            type="button"
            className="btn btn-quiet btn-sm press"
            onClick={() => setEditing(true)}
            aria-label={`Edit ${p.name}`}
          >
            Edit
          </button>
        )}
      </div>
      <p className="muted small">
        {business
          ? `${ENTITY_LABEL[p.entityType]} · ${ROLE_LABEL[p.role]} · ${gstText(p.gstRegistered)}`
          : `Your own dues · ${gstText(p.gstRegistered)}`}
      </p>
      {business && <p className="small">{ENTITY_EXPLAIN[p.entityType]}</p>}
      {t && (
        <p className="small" data-testid="profile-total">
          {t.count} due{t.count === 1 ? '' : 's'} · about{' '}
          <span className="amt">{inr(t.monthlyPaise)}</span> a month
          {t.unknownCount > 0 ? ` + ${t.unknownCount} without amount` : ''}
          {business && t.exposurePaise > 0 && (
            <>
              {' '}
              · <span className="amt">{inr(t.exposurePaise)}</span> can come to you
            </>
          )}
        </p>
      )}
      {editing && (
        <ProfileForm
          personal={!business}
          initial={{
            name: p.name,
            entityType: p.entityType,
            role: p.role,
            gst: fromGst(p.gstRegistered),
          }}
          submitLabel="Save changes"
          onCancel={() => setEditing(false)}
          onSubmit={(d) => {
            try {
              update((x) =>
                updateProfile(x, p.id, {
                  name: d.name,
                  entityType: d.entityType,
                  role: d.role,
                  gstRegistered: toGst(d.gst),
                }),
              );
              setEditing(false);
              return null;
            } catch (e) {
              return errText(e);
            }
          }}
        />
      )}
      {business && !editing && (
        <div className="stack-12">
          {others.length > 0 && (
            <div className="inline-row pf-merge">
              <Field label="Merge into" htmlFor={`${id}-merge`}>
                <select
                  id={`${id}-merge`}
                  value={mergeInto}
                  onChange={(e) => setMergeInto(e.target.value)}
                >
                  {others.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </Field>
              <ConfirmButton
                label={`Merge ${p.name}`}
                confirmLabel="Yes, merge"
                className="btn btn-secondary press"
                message={`All of ${p.name}’s dues move to ${others.find((o) => o.id === mergeInto)?.name ?? 'the other profile'}, then ${p.name} is removed.`}
                onConfirm={() =>
                  update((x) => mergeProfiles(x, p.id, mergeInto, new Date().toISOString()))
                }
              />
            </div>
          )}
          <ConfirmButton
            label={`Delete ${p.name}`}
            confirmLabel="Yes, delete it"
            className="btn btn-quiet press"
            message={`${p.name} is removed. Its dues move to Personal; nothing else is deleted.`}
            onConfirm={() => update((x) => deleteProfile(x, p.id, new Date().toISOString()))}
          />
        </div>
      )}
    </li>
  );
}

export function ProfilesScreen() {
  const { data, update } = useApp();
  const { entitlement } = useAccount();
  const [adding, setAdding] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const profiles = profilesOf(data);
  const later: EntityQuestion[] = laterQuestions(data).map((d) => ({
    key: d.key,
    name: d.name,
    reason: d.reason,
    occurrences: 0,
    direction: null,
    nameSays: entityTypeFromName(d.name),
  }));
  const answered = (data.profileDecisions ?? []).filter((d) => d.answer !== 'later');
  const allowed = canAddBusinessProfile(data, entitlement);

  return (
    <div className="page2 pf-page">
      <header className="page-head">
        <a className="text-btn press" href="#/settings">
          ‹ Back to Settings
        </a>
        <h1>Profiles</h1>
        <p className="muted">{PROFILES_NOTE}</p>
      </header>

      {later.length > 0 && <EntityQuestionCard questions={later} title="Questions you saved" />}

      <section className="stack-12" aria-labelledby="pf-list-h">
        <h2 id="pf-list-h">Your profiles</h2>
        <ul className="pf-list">
          {profiles.map((p) => (
            <ProfileCard key={p.id} p={p} others={profiles.filter((o) => o.id !== p.id)} />
          ))}
        </ul>
      </section>

      <section className="panel2 stack-16" aria-labelledby="pf-add-h">
        <h2 id="pf-add-h">Add a business</h2>
        {!allowed ? (
          <>
            <Notice title="One business is included">{UPSELL_TEXT}</Notice>
            <a className="btn btn-secondary press align-start" href="#/plans">
              See plans
            </a>
          </>
        ) : adding ? (
          <ProfileForm
            key={formKey}
            initial={{ name: '', entityType: 'proprietorship', role: 'proprietor', gst: 'unsure' }}
            submitLabel="Add business"
            onCancel={() => setAdding(false)}
            onSubmit={(d) => {
              try {
                update(
                  (x) =>
                    addProfile(
                      x,
                      {
                        name: d.name,
                        entityType: d.entityType,
                        role: d.role,
                        gstRegistered: toGst(d.gst),
                      },
                      new Date().toISOString(),
                    ).data,
                );
                setAdding(false);
                setFormKey((k) => k + 1);
                return null;
              } catch (e) {
                return errText(e);
              }
            }}
          />
        ) : (
          <>
            <p className="muted small">
              For a shop, firm or company whose dues you track. A proprietorship runs on your PAN; a
              firm, LLP or company has its own.
            </p>
            <button
              type="button"
              className="btn btn-secondary press jelly align-start"
              onClick={() => setAdding(true)}
            >
              Add a business
            </button>
          </>
        )}
      </section>

      {answered.length > 0 && (
        <section className="panel2 stack-12" aria-labelledby="pf-answers-h">
          <h2 id="pf-answers-h">Names you answered</h2>
          <ul className="pf-answered">
            {answered.map((d) => (
              <li key={d.key}>
                <span>
                  <strong>{d.name}</strong>
                  <span className="muted small"> · {ANSWER_TEXT[d.answer]}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm press"
                  aria-label={`Ask again about ${d.name}`}
                  onClick={() => update((x) => forgetDecision(x, d.key))}
                >
                  Ask again
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">Due asks again the next time it sees the name.</p>
        </section>
      )}
    </div>
  );
}
