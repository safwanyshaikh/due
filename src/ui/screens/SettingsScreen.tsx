import { useState } from 'react';
import { exportCSV, exportJSON } from '../../lib/data';
import { PRIVACY_SUMMARY } from '../../content/privacy';
import { STATUS_NOTE } from '../../lib/status';
import { useApp } from '../store';
import { useUiPrefs } from '../App';
import { ConfirmButton, Field, Panel } from '../components/ui';
import { Glyph, type GlyphName } from '../components/Glyph';
import { download } from '../common';
import { setTelemetryOptOut, telemetryOptedOut } from '../lib/telemetrySink';
import type { ThemeChoice } from '../lib/motion';

const LINKS: { href: string; icon: GlyphName; label: string }[] = [
  { href: '#/account', icon: 'user', label: 'Account, sync and devices' },
  { href: '#/plans', icon: 'shield', label: 'Plans and purchases' },
  { href: '#/reminders', icon: 'clock', label: 'Reminders' },
  { href: '#/connections', icon: 'link', label: 'Connections' },
  { href: '#/import', icon: 'upload', label: 'Import' },
  { href: '#/all', icon: 'grid', label: 'All items and categories' },
];

export function SettingsScreen() {
  const { data, wipe } = useApp();
  const { reduceMotion, setReduceMotion, theme, setTheme } = useUiPrefs();
  const [optOut, setOptOut] = useState(() => telemetryOptedOut());
  return (
    <div className="page2">
      <header className="page-head">
        <h1>Settings</h1>
      </header>
      <nav aria-label="Settings sections">
        <ul className="link-list">
          {LINKS.map((l) => (
            <li key={l.href}>
              <a className="link-row press" href={l.href}>
                <Glyph name={l.icon} />
                <span>{l.label}</span>
                <Glyph name="chevron" size={18} />
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Panel title="More planning tools" id="st-more">
        <div className="btn-row">
          <a className="btn btn-quiet press" href="#/offers">
            Due &amp; Offers
          </a>
          <a className="btn btn-quiet press" href="#/budget">
            Limits
          </a>
          <a className="btn btn-quiet press" href="#/seasons">
            Seasons
          </a>
          <a className="btn btn-quiet press" href="#/calendar">
            Calendar
          </a>
          <a className="btn btn-quiet press" href="#/calc">
            How totals work
          </a>
        </div>
      </Panel>

      <Panel title="Display" id="st-display">
        <Field label="Theme" htmlFor="st-theme">
          <select
            id="st-theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeChoice)}
          >
            <option value="system">Match my device</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </Field>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={reduceMotion}
            onChange={(e) => setReduceMotion(e.target.checked)}
          />
          <span>Reduce motion (also follows your device setting)</span>
        </label>
      </Panel>

      <Panel title="Privacy" id="st-privacy">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={!optOut}
            onChange={(e) => {
              setTelemetryOptOut(!e.target.checked);
              setOptOut(!e.target.checked);
            }}
          />
          <span>Share anonymous usage events (no names, amounts or text)</span>
        </label>
        <details className="more">
          <summary className="press">{PRIVACY_SUMMARY.heading}</summary>
          <p className="muted small">{PRIVACY_SUMMARY.banner}</p>
          <ul>
            {PRIVACY_SUMMARY.points.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <p className="muted small">{PRIVACY_SUMMARY.contact}</p>
          <p className="muted small">{STATUS_NOTE}</p>
        </details>
      </Panel>

      <Panel title="Your data on this device" id="st-data">
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-secondary press"
            onClick={() => download('due-export.json', exportJSON(data), 'application/json')}
          >
            Export everything (JSON)
          </button>
          <button
            type="button"
            className="btn btn-secondary press"
            onClick={() => download('due-export.csv', exportCSV(data), 'text/csv')}
          >
            Export list (CSV)
          </button>
          <a className="btn btn-quiet press" href="#/csv">
            Import a CSV
          </a>
        </div>
        <ConfirmButton
          label="Delete all data on this device"
          confirmLabel="Yes, delete everything"
          message="This removes every item, setting and import from this browser. It can’t be undone. Your account (if any) is not affected."
          onConfirm={wipe}
        />
      </Panel>
    </div>
  );
}
