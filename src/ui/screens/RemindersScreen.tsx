import { useEffect, useMemo, useState } from 'react';
import type { RemindersResponse } from '../../lib/account/types';
import {
  acknowledgeReminder,
  deliveryStatus,
  planReminders,
  snoozeReminder,
  type DeliveryChannel,
} from '../../lib/reminderPlan';
import { monthlySummary, retentionAlerts, weeklyDigest } from '../../lib/retention';
import { buildICS } from '../../lib/ics';
import { formatDate, parseISO } from '../../lib/dates';
import { track } from '../../lib/telemetry';
import { useApp } from '../store';
import { useAccount } from '../account/AccountContext';
import { describeApiError } from '../account/useIntake';
import { Badge, Field, Notice, Panel } from '../components/ui';
import { download } from '../common';
import { localDateTime } from '../lib/format';

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
];

const STATUS_COPY = {
  scheduled: 'Scheduled',
  shown: 'Shown in the app',
  sent: 'Sent (confirmed by server)',
  failed: 'Delivery failed',
  unavailable: 'Channel not available',
} as const;

export function RemindersScreen() {
  const { data, today, update, mutate, ctx } = useApp();
  const { client, status } = useAccount();
  const s = data.settings;
  const [server, setServer] = useState<RemindersResponse | null>(null);
  const [serverErr, setServerErr] = useState<string | null>(null);
  const [now] = useState(() => new Date().toISOString());

  useEffect(() => {
    if (status !== 'signed_in') return;
    client
      .getReminders()
      .then(setServer)
      .catch((e) => setServerErr(describeApiError(e)));
  }, [client, status]);

  const emailOn = server?.emailDelivery === 'active';
  const plan = useMemo(
    () => planReminders(data, now, { available: { email: emailOn, push: false } }).slice(0, 30),
    [data, now, emailOn],
  );
  const state = (key: string) => (data.reminderStates ?? []).find((x) => x.key === key);
  const digest = weeklyDigest(data, today);
  const alerts = retentionAlerts(data, today);
  const t = parseISO(today);
  const prev = t.m === 1 ? { y: t.y - 1, m: 12 } : { y: t.y, m: t.m - 1 };
  const summary = monthlySummary(data, t.y, t.m) ?? monthlySummary(data, prev.y, prev.m);
  const tzOptions = TIMEZONES.includes(s.timezone) ? TIMEZONES : [s.timezone, ...TIMEZONES];
  const setSettings = (patch: Partial<typeof s>) =>
    update((d) => ({ ...d, settings: { ...d.settings, ...patch } }));

  return (
    <div className="page2">
      <header className="page-head">
        <h1>Reminders</h1>
        <p className="muted">
          Due reminds you only about real dates. It never sends messages just to bring you back.
        </p>
      </header>

      {digest && (
        <Panel title="This week" id="rm-week">
          <p>{digest.text}</p>
        </Panel>
      )}
      {alerts.length > 0 && (
        <Panel title="Worth a look" id="rm-alerts">
          <ul className="plain-list">
            {alerts.map((a) => (
              <li key={a.key}>
                <strong>{a.title}</strong> <span className="muted small">{a.detail}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {summary && (
        <Panel title="Covered, saved and avoided surprises" id="rm-month">
          <p>{summary.text}</p>
        </Panel>
      )}

      <Panel title="Settings" id="rm-settings">
        <div className="inline-row">
          <Field label="Quiet hours from" htmlFor="rm-q1">
            <input
              id="rm-q1"
              type="time"
              value={s.quietHours.start}
              onChange={(e) =>
                setSettings({ quietHours: { ...s.quietHours, start: e.target.value } })
              }
            />
          </Field>
          <Field label="Quiet hours until" htmlFor="rm-q2">
            <input
              id="rm-q2"
              type="time"
              value={s.quietHours.end}
              onChange={(e) =>
                setSettings({ quietHours: { ...s.quietHours, end: e.target.value } })
              }
            />
          </Field>
        </div>
        <div className="inline-row">
          <Field label="Timezone" htmlFor="rm-tz">
            <select
              id="rm-tz"
              value={s.timezone}
              onChange={(e) => setSettings({ timezone: e.target.value })}
            >
              {tzOptions.map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Default channel"
            htmlFor="rm-ch"
            hint={
              status !== 'signed_in'
                ? 'Email needs sign-in. Push isn’t available yet.'
                : server?.emailDelivery === 'email_unavailable'
                  ? 'Email isn’t available on Due’s server yet.'
                  : server?.emailDelivery === 'premium_required'
                    ? 'Email reminders are part of Plus.'
                    : 'Push isn’t available yet.'
            }
          >
            <select
              id="rm-ch"
              value={s.deliveryChannel ?? 'in_app'}
              onChange={(e) => {
                const ch = e.target.value as DeliveryChannel;
                if (ch === 'in_app' && s.deliveryChannel === 'email')
                  track('notification_opt_out', { channel: 'email' });
                setSettings({ deliveryChannel: ch });
              }}
            >
              <option value="in_app">In the app</option>
              <option value="email" disabled={status !== 'signed_in'}>
                Email
              </option>
              <option value="push" disabled>
                Push (not available yet)
              </option>
            </select>
          </Field>
        </div>
        <p className="muted small">
          Lead times, severity and channel can also be set on each item. Reminders that fall in
          quiet hours move to the next allowed time.
        </p>
      </Panel>

      <Panel title="Upcoming reminders" id="rm-plan">
        {plan.length === 0 ? (
          <p className="muted">No reminders planned in the next 60 days.</p>
        ) : (
          <ul className="plain-list">
            {plan.map((r) => {
              const st = deliveryStatus(
                state(r.key),
                r.channel,
                r.channel === 'in_app' || (r.channel === 'email' && emailOn),
              );
              return (
                <li key={r.key} className="event-row">
                  <div>
                    <strong>{r.title}</strong>{' '}
                    <Badge tone={r.severity === 'important' ? 'warm' : 'plain'}>{r.severity}</Badge>
                    <p className="muted small">
                      {formatDate(r.localDate)} at {r.localTime} ({r.timezone})
                      {r.shiftedForQuietHours ? ' · moved out of quiet hours' : ''} · {r.leadDays}{' '}
                      day
                      {r.leadDays === 1 ? '' : 's'} before · {r.channel.replace('_', ' ')} ·{' '}
                      {STATUS_COPY[st]}
                      {r.snoozedUntil
                        ? ` · snoozed until ${localDateTime(r.snoozedUntil, r.timezone)}`
                        : ''}
                    </p>
                  </div>
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm press"
                      onClick={() => {
                        if (mutate((d) => acknowledgeReminder(d, r.key, ctx())))
                          track('reminder_resolved', {
                            action: 'acknowledged',
                            leadDays: r.leadDays,
                          });
                      }}
                    >
                      Got it
                    </button>
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm press"
                      onClick={() => {
                        const until = new Date(
                          Date.parse(r.scheduledFor) + 86_400_000,
                        ).toISOString();
                        if (mutate((d) => snoozeReminder(d, r.key, until, ctx())))
                          track('reminder_resolved', { action: 'snoozed', leadDays: r.leadDays });
                      }}
                    >
                      Snooze a day
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <button
          type="button"
          className="btn btn-quiet press"
          onClick={() =>
            download(
              'due-reminders.ics',
              buildICS(
                plan.map((r) => ({
                  uid: r.key.replace(/[^a-zA-Z0-9]/g, '-'),
                  date: r.localDate,
                  summary: r.title,
                  description: r.body,
                })),
              ),
              'text/calendar',
            )
          }
        >
          Download calendar file (.ics)
        </button>
      </Panel>

      {status === 'signed_in' && (
        <Panel title="Delivery from Due’s server" id="rm-server">
          {serverErr && <Notice tone="warn">{serverErr}</Notice>}
          {server && (
            <>
              <p className="muted small">
                Email delivery:{' '}
                {server.emailDelivery === 'active'
                  ? 'active'
                  : server.emailDelivery === 'premium_required'
                    ? 'needs Plus'
                    : 'not available on this server yet'}
                . Only the server reports “sent”.
              </p>
              {server.deliveries.length === 0 ? (
                <p className="muted">No deliveries yet.</p>
              ) : (
                <ul className="plain-list">
                  {server.deliveries.slice(0, 20).map((d) => (
                    <li key={d.id}>
                      {localDateTime(d.scheduledFor)} · {d.channel} · <Badge>{d.status}</Badge>
                      {d.error ? <span className="muted small"> {d.error}</span> : null}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Panel>
      )}
      <a className="btn btn-quiet press" href="#/reminders-ics">
        Season and offer reminders (calendar file)
      </a>
    </div>
  );
}
