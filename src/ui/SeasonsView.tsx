import { useState } from 'react';
import { useApp } from './store';
import { Card } from './common';
import { newId, upsertSeason, deleteSeason } from '../lib/data';
import { formatDate, isValidISO } from '../lib/dates';
import { remindersForSeason } from '../lib/reminders';
import type { Season } from '../lib/types';

export function SeasonsView() {
  const { data, today, update } = useApp();
  const [draft, setDraft] = useState<Season | null>(null);
  const [err, setErr] = useState('');
  const subs = data.commitments.filter((c) => c.type === 'subscription');

  function save() {
    if (!draft) return;
    if (!draft.name.trim()) return setErr('Give the season a name.');
    if (!isValidISO(draft.start) || !isValidISO(draft.end) || draft.start > draft.end)
      return setErr('Start must be on or before end.');
    if (draft.restartDate && !isValidISO(draft.restartDate))
      return setErr('Restart date is not valid.');
    setErr('');
    update((d) => upsertSeason(d, draft));
    setDraft(null);
  }

  return (
    <div className="page">
      <h1>Seasonal plans</h1>
      <p className="muted">
        Plan a window, for example a sports tournament. We only set your own reminders. We don’t
        assume which service has rights, buy a plan, pause a mandate or restart anything for you.
      </p>
      <button
        className="primary"
        onClick={() =>
          setDraft({
            id: newId('s'),
            name: '',
            start: today,
            end: today,
            linkedCommitmentIds: [],
            considerLeadDays: 7,
            reviewLeadDays: 3,
            restartDate: null,
          })
        }
      >
        + New season
      </button>

      {draft && (
        <Card title="Season">
          <label className="field">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Starts</span>
            <input
              type="date"
              value={draft.start}
              onChange={(e) => setDraft({ ...draft, start: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Ends</span>
            <input
              type="date"
              value={draft.end}
              onChange={(e) => setDraft({ ...draft, end: e.target.value })}
            />
          </label>
          <label className="field">
            <span>“Consider subscribing” reminder, days before start</span>
            <input
              type="number"
              min={0}
              max={60}
              value={draft.considerLeadDays}
              onChange={(e) => setDraft({ ...draft, considerLeadDays: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>“Review before renewal” reminder, days before</span>
            <input
              type="number"
              min={0}
              max={60}
              value={draft.reviewLeadDays}
              onChange={(e) => setDraft({ ...draft, reviewLeadDays: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>Planning a pause? Restart reminder date (optional)</span>
            <input
              type="date"
              value={draft.restartDate ?? ''}
              onChange={(e) => setDraft({ ...draft, restartDate: e.target.value || null })}
            />
          </label>
          <fieldset>
            <legend>Link subscriptions (optional)</legend>
            {subs.length === 0 && <p className="muted">Add a subscription first.</p>}
            {subs.map((s) => (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={draft.linkedCommitmentIds.includes(s.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      linkedCommitmentIds: e.target.checked
                        ? [...draft.linkedCommitmentIds, s.id]
                        : draft.linkedCommitmentIds.filter((x) => x !== s.id),
                    })
                  }
                />{' '}
                {s.nickname || s.provider}
              </label>
            ))}
          </fieldset>
          {err && (
            <p className="errors" role="alert">
              {err}
            </p>
          )}
          <div className="actions">
            <button className="primary" onClick={save}>
              Save season
            </button>
            <button onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </Card>
      )}

      {data.seasons.map((s) => {
        const rems = remindersForSeason(s, data.commitments);
        return (
          <Card key={s.id} title={s.name}>
            <p>
              {formatDate(s.start)} to {formatDate(s.end)}
            </p>
            {rems.map((r) => (
              <div className="line" key={r.key}>
                <span>{r.label}</span>
                <span>remind {formatDate(r.remindOn)}</span>
              </div>
            ))}
            <p className="muted">
              Status of a linked subscription stays whatever you set it to: seasonal plan, pause
              planned, or confirmed by you. Nothing changes with the provider.
            </p>
            <div className="actions">
              <button onClick={() => setDraft(s)}>Edit</button>
              <button className="danger" onClick={() => update((d) => deleteSeason(d, s.id))}>
                Delete
              </button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
