import { useEffect } from 'react';
import { useApp } from './store';
import { Card, download } from './common';
import {
  activeReminders,
  allReminders,
  CHANNEL_AVAILABILITY,
  reminderLocalTime,
} from '../lib/reminders';
import { formatDate } from '../lib/dates';
import { buildICS } from '../lib/ics';

export function RemindersView() {
  const { data, today, update } = useApp();
  const items = allReminders(data.commitments, data.seasons);
  const active = activeReminders(items, today);
  const cooling = data.commitments.filter((c) => c.coolingOffUntil && c.coolingOffUntil <= today);
  const upcoming = items
    .filter((r) => r.remindOn > today)
    .sort((a, b) => a.remindOn.localeCompare(b.remindOn))
    .slice(0, 15);

  // Log what is shown on screen. Only "shown in app" is ever recorded; nothing is claimed as sent.
  useEffect(() => {
    const fresh = active.filter((r) => !data.deliveryLog.some((d) => d.key === r.key));
    if (fresh.length === 0) return;
    update((d) => ({
      ...d,
      deliveryLog: [
        ...d.deliveryLog,
        ...fresh
          .filter((r) => !d.deliveryLog.some((x) => x.key === r.key))
          .map((r) => ({
            key: r.key,
            channel: 'in_app' as const,
            status: 'shown_in_app' as const,
            at: new Date().toISOString(),
            label: r.label,
          })),
      ],
    }));
  }, [active, data.deliveryLog, update]);

  const offerRems = data.offerReminders
    .filter((r) => r.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  function exportIcs() {
    const events = [
      ...items.map((r) => ({
        uid: r.key.replace(/[^a-zA-Z0-9]/g, '-'),
        date: r.remindOn,
        summary: `Reminder: ${r.label} on ${formatDate(r.targetDate)}`,
        description: 'Created by Due. Amounts and dates are what you entered.',
      })),
      ...offerRems.map((r) => ({
        uid: r.id.replace(/[^a-zA-Z0-9]/g, '-'),
        date: r.date,
        summary: `Due: ${r.label}`,
        description:
          'A reminder you set in Due & Offers. Verify in the official provider app/site.',
      })),
    ];
    download('due-reminders.ics', buildICS(events), 'text/calendar');
  }

  return (
    <div className="page">
      <h1>Reminders</h1>
      <p className="muted">
        Reminders appear here when you open the app, and you can add them to your calendar. Email
        and WhatsApp reminders are unavailable in this beta.
      </p>
      <Card title="For you today">
        {active.length === 0 && cooling.length === 0 && (
          <p className="muted">Nothing needs a look today.</p>
        )}
        {active.map((r) => (
          <div className="line" key={r.key}>
            <span>{r.label}</span>
            <span>
              {formatDate(r.targetDate)}
              {r.offset === 0 ? ' (today)' : ` · in ${r.offset} day(s)`}
            </span>
          </div>
        ))}
        {cooling.map((c) => (
          <div className="line" key={c.id}>
            <span>You asked to revisit: {c.nickname || c.provider}</span>
            <span>no due date was changed</span>
          </div>
        ))}
      </Card>
      {offerRems.length > 0 && (
        <Card title="Due & Offers reminders">
          {offerRems.map((r) => (
            <div className="line" key={r.id}>
              <span>{r.label}</span>
              <span>on {formatDate(r.date)}</span>
            </div>
          ))}
        </Card>
      )}
      <Card title="Coming reminders">
        {upcoming.length === 0 && <p className="muted">None scheduled.</p>}
        {upcoming.map((r) => (
          <div className="line" key={r.key}>
            <span>{r.label}</span>
            <span>
              remind {formatDate(r.remindOn)} · {reminderLocalTime(data.settings)}
            </span>
          </div>
        ))}
        <div className="actions">
          <button onClick={exportIcs}>Download calendar file (.ics)</button>
        </div>
      </Card>
      <Card title="Delivery channels">
        {(Object.keys(CHANNEL_AVAILABILITY) as (keyof typeof CHANNEL_AVAILABILITY)[]).map((k) => (
          <div className="line" key={k}>
            <span>{k.replace('_', ' ')}</span>
            <span className={CHANNEL_AVAILABILITY[k].available ? '' : 'muted'}>
              {CHANNEL_AVAILABILITY[k].note}
            </span>
          </div>
        ))}
      </Card>
      <Card title="Delivery log">
        {data.deliveryLog.length === 0 && <p className="muted">Nothing shown yet.</p>}
        {data.deliveryLog
          .slice(-20)
          .reverse()
          .map((d) => (
            <div className="line" key={d.key}>
              <span>{d.label}</span>
              <span className="muted">
                shown in app · {d.at.slice(0, 16).replace('T', ' ')} UTC
              </span>
            </div>
          ))}
        <p className="muted">
          “Shown in app” is the only status this release records. Nothing is marked “sent”.
        </p>
      </Card>
    </div>
  );
}
