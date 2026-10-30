import { useState } from 'react';
import { useApp } from './store';
import { Card, download } from './common';
import type { Nav } from './App';
import {
  deleteLabel,
  exportCSV,
  exportJSON,
  newId,
  upsertLabel,
  removeSampleData,
} from '../lib/data';
import { ALL_ADAPTERS } from '../lib/adapters';
import { LABEL_NOTE, PRIVACY_SUMMARY } from '../content/privacy';
import { CHANNEL_AVAILABILITY } from '../lib/reminders';
import type { ReminderChannel } from '../lib/types';
import { STATUS_NOTE } from '../lib/status';

export function SettingsView({ nav }: { nav: Nav }) {
  const { data, update, wipe } = useApp();
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const s = data.settings;
  return (
    <>
      <h1>Settings</h1>

      <Card title="Reminders">
        <label className="field">
          <span>Channel</span>
          <select
            value={s.channel}
            onChange={(e) =>
              update((d) => ({
                ...d,
                settings: { ...d.settings, channel: e.target.value as ReminderChannel },
              }))
            }
          >
            {(Object.keys(CHANNEL_AVAILABILITY) as ReminderChannel[]).map((k) => (
              <option key={k} value={k} disabled={!CHANNEL_AVAILABILITY[k].available}>
                {k.replace('_', ' ')}
                {CHANNEL_AVAILABILITY[k].available ? '' : ' (unavailable)'}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Quiet hours from</span>
          <input
            type="time"
            value={s.quietHours.start}
            onChange={(e) =>
              update((d) => ({
                ...d,
                settings: {
                  ...d.settings,
                  quietHours: { ...d.settings.quietHours, start: e.target.value },
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>to</span>
          <input
            type="time"
            value={s.quietHours.end}
            onChange={(e) =>
              update((d) => ({
                ...d,
                settings: {
                  ...d.settings,
                  quietHours: { ...d.settings.quietHours, end: e.target.value },
                },
              }))
            }
          />
        </label>
        <label className="field">
          <span>Timezone</span>
          <select
            value={s.timezone}
            onChange={(e) =>
              update((d) => ({ ...d, settings: { ...d.settings, timezone: e.target.value } }))
            }
          >
            <option value="Asia/Kolkata">India Standard Time (IST)</option>
          </select>
        </label>
        <p className="muted">
          Quiet hours decide the time shown for calendar and in-app reminders. Per-item reminder
          days are set on each item (default 7, 3, 1).
        </p>
      </Card>

      <Card title="Billing-email labels">
        <p className="muted">{LABEL_NOTE}</p>
        {data.labels.map((l) => (
          <div className="line" key={l.id}>
            <span>
              {l.displayName ? `${l.displayName} · ` : ''}
              {l.label}
            </span>
            <button onClick={() => update((d) => deleteLabel(d, l.id))}>Remove</button>
          </div>
        ))}
        <div className="inline">
          <input
            placeholder="Email or label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Email or label"
          />
          <input
            placeholder="Display name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Display name"
          />
          <button
            onClick={() => {
              if (!label.trim()) return;
              update((d) =>
                upsertLabel(d, {
                  id: newId('lbl'),
                  label: label.trim(),
                  displayName: name.trim() || undefined,
                }),
              );
              setLabel('');
              setName('');
            }}
          >
            Add
          </button>
        </div>
      </Card>

      <Card title="Your data">
        <div className="actions">
          <button
            onClick={() => download('payables-export.json', exportJSON(data), 'application/json')}
          >
            Export everything (JSON)
          </button>
          <button onClick={() => download('payables-export.csv', exportCSV(data), 'text/csv')}>
            Export list (CSV)
          </button>
          <button onClick={() => nav.go({ name: 'import' })}>Import a CSV</button>
        </div>
        {data.commitments.some((c) => c.isSample) && (
          <div className="actions">
            <button onClick={() => update(removeSampleData)}>Remove sample data only</button>
          </div>
        )}
        <div className="actions">
          <button
            className="danger"
            onClick={() => {
              if (confirm('Delete ALL your data on this device? This cannot be undone.')) wipe();
            }}
          >
            Delete all my data
          </button>
        </div>
        <p className="muted">
          Data is stored in this browser only. Deleting removes it from this device.
        </p>
      </Card>

      <Card title="Data connections">
        <p className="muted">
          Only manual entry and CSV files you choose are live. Everything else is switched off in
          this release.
        </p>
        {ALL_ADAPTERS.map((a) => (
          <div className="adapter" key={a.id}>
            <strong>{a.label}</strong>{' '}
            <span className={`badge ${a.status === 'live' ? 'badge-calm' : 'badge-plain'}`}>
              {a.status === 'live' ? 'On' : 'Off'}
            </span>
            <small className="muted">{a.note}</small>
          </div>
        ))}
        <p className="muted">
          Switching any future connection off later will never delete the commitments you entered by
          hand.
        </p>
      </Card>

      <Card title={PRIVACY_SUMMARY.heading}>
        <p className="notice">{PRIVACY_SUMMARY.banner}</p>
        <ul>
          {PRIVACY_SUMMARY.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p className="muted">{PRIVACY_SUMMARY.contact}</p>
        <label className="check">
          <input
            type="checkbox"
            checked={s.consents.acknowledgedEstimates}
            onChange={(e) =>
              update((d) => ({
                ...d,
                settings: {
                  ...d.settings,
                  consents: { ...d.settings.consents, acknowledgedEstimates: e.target.checked },
                },
              }))
            }
          />{' '}
          I understand totals are estimates from what I entered.
        </label>
        <p className="muted">{STATUS_NOTE}</p>
      </Card>
    </>
  );
}
