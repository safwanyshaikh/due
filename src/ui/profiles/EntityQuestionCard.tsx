import { useId, useState } from 'react';
import {
  addProfile,
  canAddBusinessProfile,
  openQuestions,
  recordDecision,
  rolesFor,
  ProfileError,
  type EntityQuestion,
  type EntityType,
  type ProfileRole,
  type QuestionAnswer,
} from '../../lib/profiles';
import {
  ANSWERS,
  ENTITY_CHOICES,
  GST_CHOICES,
  NAME_SAYS,
  ROLE_EXPLAIN,
  ROLE_LABEL,
  UPSELL_TEXT,
  questionText,
} from '../../content/profiles';
import { useApp } from '../store';
import { useAccount } from '../account/AccountContext';
import { Notice } from '../components/ui';
import './profiles.css';

/** A radio list where each choice carries one line saying what it changes. */
function ChoiceList<T extends string>({
  legend,
  name,
  value,
  choices,
  onChange,
}: {
  legend: string;
  name: string;
  value: T | null;
  choices: { value: T; label: string; explain: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="pf-choices">
      <legend className="label-like">{legend}</legend>
      {choices.map((c) => (
        <label key={c.value} className="pf-choice press">
          <input
            type="radio"
            name={name}
            value={c.value}
            checked={value === c.value}
            onChange={() => onChange(c.value)}
          />
          <span className="pf-choice-text">
            <strong>{c.label}</strong>
            <span className="muted small">{c.explain}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

type GstKey = 'yes' | 'no' | 'unsure';
const GST_KEY = (v: boolean | null): GstKey => (v === true ? 'yes' : v === false ? 'no' : 'unsure');
const GST_VALUE: Record<GstKey, boolean | null> = { yes: true, no: false, unsure: null };

/** Entity type, role and GST for a name the person said is (their family's) business. */
function DetailsStep({
  q,
  family,
  onSave,
  onBack,
  onLater,
}: {
  q: EntityQuestion;
  family: boolean;
  onSave: (entityType: EntityType, role: ProfileRole, gst: boolean | null) => string | null;
  onBack: () => void;
  onLater: () => void;
}) {
  const id = useId();
  const { data } = useApp();
  const { entitlement } = useAccount();
  const [entity, setEntity] = useState<EntityType | null>(null);
  const [role, setRole] = useState<ProfileRole | null>(null);
  const [gst, setGst] = useState<GstKey | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const allowed = canAddBusinessProfile(data, entitlement);
  const roles = entity ? rolesFor(entity) : [];
  const effectiveRole = roles.length === 1 ? roles[0] : role && roles.includes(role) ? role : null;
  const ready = entity !== null && effectiveRole !== null && gst !== null;

  if (!allowed)
    return (
      <div className="stack-16">
        <Notice tone="info" title="One business is included">
          {UPSELL_TEXT}
        </Notice>
        <div className="btn-row">
          <a className="btn btn-primary press jelly" href="#/plans">
            See plans
          </a>
          <button type="button" className="btn btn-secondary press" onClick={onLater}>
            Ask later
          </button>
          <button type="button" className="btn btn-quiet press" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );

  return (
    <form
      className="stack-16"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) {
          setErr('Choose one answer in each group.');
          return;
        }
        setErr(onSave(entity!, effectiveRole!, GST_VALUE[gst!]));
      }}
      noValidate
    >
      {q.nameSays && (
        <p className="muted small">
          Its name includes “{NAME_SAYS[q.nameSays]}”. Check its papers if you’re not sure.
        </p>
      )}
      <ChoiceList
        legend={`What kind of business is ‘${q.name}’?`}
        name={`${id}-entity`}
        value={entity}
        choices={ENTITY_CHOICES[family ? 'family' : 'own'].map((c) => ({
          value: c.type,
          label: c.label,
          explain: c.explain,
        }))}
        onChange={(v) => {
          setEntity(v);
          setErr(null);
        }}
      />
      {entity && roles.length > 1 && (
        <ChoiceList
          legend="How are you linked to it?"
          name={`${id}-role`}
          value={effectiveRole}
          choices={roles.map((r) => ({ value: r, label: ROLE_LABEL[r], explain: ROLE_EXPLAIN[r] }))}
          onChange={(v) => {
            setRole(v);
            setErr(null);
          }}
        />
      )}
      <ChoiceList
        legend="GST registered?"
        name={`${id}-gst`}
        value={gst}
        choices={GST_CHOICES.map((c) => ({
          value: GST_KEY(c.value),
          label: c.label,
          explain: c.explain,
        }))}
        onChange={(v) => {
          setGst(v);
          setErr(null);
        }}
      />
      {err && <Notice tone="warn">{err}</Notice>}
      <div className="btn-row">
        <button type="submit" className="btn btn-primary press jelly">
          Save business
        </button>
        <button type="button" className="btn btn-quiet press" onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  );
}

/**
 * One question at a time: "We see regular payments with ‘NAME’. Is this your business?" Answers are
 * kept so the same name is not asked again ("Ask later" keeps it in Settings → Profiles).
 */
export function EntityQuestionCard({
  questions,
  title = 'One question',
}: {
  questions: EntityQuestion[];
  title?: string;
}) {
  const { data, update } = useApp();
  const headingId = useId();
  const [handled, setHandled] = useState<Set<string>>(() => new Set());
  const [step, setStep] = useState<null | 'own' | 'family'>(null);
  const [said, setSaid] = useState<string | null>(null);
  const pending = openQuestions(data, questions).filter((q) => !handled.has(q.key));
  const q = pending[0];
  const total = handled.size + pending.length;

  const done = (key: string, message: string) => {
    setHandled((h) => new Set(h).add(key));
    setStep(null);
    setSaid(message);
  };

  const answer = (a: QuestionAnswer) => {
    if (!q) return;
    if (a === 'own' || a === 'family') {
      setStep(a);
      setSaid(null);
      return;
    }
    const at = new Date().toISOString();
    update((d) => recordDecision(d, { key: q.key, name: q.name, reason: q.reason, answer: a, at }));
    done(
      q.key,
      a === 'later'
        ? `Saved for later. Find it in Settings → Profiles.`
        : `Got it. Due won’t ask about ‘${q.name}’ again.`,
    );
  };

  const noneMine = () => {
    const at = new Date().toISOString();
    update((d) =>
      pending.reduce(
        (acc, x) =>
          recordDecision(acc, {
            key: x.key,
            name: x.name,
            reason: x.reason,
            answer: 'not_mine',
            at,
          }),
        d,
      ),
    );
    setHandled((h) => new Set([...h, ...pending.map((x) => x.key)]));
    setStep(null);
    setSaid('Got it. Due won’t ask about these names again.');
  };

  const save = (entityType: EntityType, role: ProfileRole, gst: boolean | null): string | null => {
    if (!q || !step) return null;
    const at = new Date().toISOString();
    try {
      update((d) => {
        const r = addProfile(d, { name: q.name, entityType, role, gstRegistered: gst }, at);
        return recordDecision(r.data, {
          key: q.key,
          name: q.name,
          reason: q.reason,
          answer: step,
          profileId: r.profile.id,
          at,
        });
      });
    } catch (e) {
      return e instanceof ProfileError ? e.message : 'This couldn’t be saved. Try again.';
    }
    done(q.key, `Added ‘${q.name}’ as a business. Choose it under “Belongs to” on its dues.`);
    return null;
  };

  if (!q)
    return said ? (
      <p className="muted small" role="status" data-testid="entity-question-done">
        {said}
      </p>
    ) : null;

  return (
    <section
      className="panel2 stack-16 pf-question"
      aria-labelledby={headingId}
      data-testid="entity-question"
    >
      <div className="section-head">
        <h2 id={headingId} className="eyebrow">
          {title}
        </h2>
        {total > 1 && (
          <span className="muted small">
            {handled.size + 1} of {total}
          </span>
        )}
      </div>
      {said && (
        <p className="muted small" role="status">
          {said}
        </p>
      )}
      {pending.length > 1 && !step && (
        <div className="stack-8" data-testid="entity-group">
          <p className="muted small">
            {pending.length} names found: {pending.map((x) => `‘${x.name}’`).join(', ')}. Which are
            yours? Answer one at a time, or skip them all.
          </p>
          <button
            type="button"
            className="btn btn-quiet btn-sm press align-start"
            onClick={noneMine}
          >
            None of these are mine
          </button>
        </div>
      )}
      <p className="pf-question-text">{questionText(q)}</p>
      {step ? (
        <DetailsStep
          key={`${q.key}:${step}`}
          q={q}
          family={step === 'family'}
          onSave={save}
          onBack={() => setStep(null)}
          onLater={() => answer('later')}
        />
      ) : (
        <ul className="pf-answers">
          {ANSWERS.map((a) => (
            <li key={a.answer}>
              <button
                type="button"
                className={`pf-answer press jelly ${a.answer === 'own' ? 'pf-answer-main' : ''}`}
                onClick={() => answer(a.answer)}
                data-answer={a.answer}
              >
                <strong>{a.label}</strong>
                <span className="muted small">{a.explain}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">
        Due asks; it never decides. Information only, not legal or tax advice.
      </p>
    </section>
  );
}
