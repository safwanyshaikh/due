import { useEffect, useState } from 'react';
import { getPlatform, isNative, type NotificationPermission } from '../../lib/platform';
import { deviceNotificationsOn, setDeviceNotifications } from '../lib/localReminders';
import { Badge, Panel } from './ui';
import { useToast } from './Toast';

/** Native app only: opt in to reminders as notifications on this device (works offline, no account needed). */
export function DeviceNotificationsPanel() {
  const toast = useToast();
  const [on, setOn] = useState(deviceNotificationsOn);
  const [perm, setPerm] = useState<NotificationPermission>('prompt');
  const [busy, setBusy] = useState(false);
  const native = isNative();
  useEffect(() => {
    if (native) void getPlatform().notifications.permission().then(setPerm);
  }, [native]);
  if (!native) return null;

  const turnOn = async () => {
    setBusy(true);
    const p = await getPlatform().notifications.request();
    setPerm(p);
    if (p === 'granted') {
      setDeviceNotifications(true);
      setOn(true);
      toast.show({ message: 'Notifications on for this device.', tone: 'success' });
    }
    setBusy(false);
  };
  const turnOff = () => {
    setDeviceNotifications(false);
    setOn(false);
    toast.show({ message: 'Notifications on this device turned off.' });
  };

  return (
    <Panel title="Notifications on this device" id="rm-device">
      <p className="muted">
        Get a notification on this phone before a payment is due. They are scheduled on the device
        from the reminders below, with your lead times and quiet hours, and need no account or
        internet.
      </p>
      {on && perm === 'granted' ? (
        <div className="stack-8" data-testid="device-notifications-on">
          <p>
            <Badge tone="calm">On</Badge>
          </p>
          <button type="button" className="btn btn-secondary press" onClick={turnOff}>
            Turn off
          </button>
        </div>
      ) : perm === 'denied' ? (
        <p className="muted" role="status">
          Notifications are blocked for Due in your phone’s settings. Allow them there, then come
          back.
        </p>
      ) : (
        <button
          type="button"
          className="btn btn-primary press"
          disabled={busy}
          onClick={() => void turnOn()}
        >
          Turn on notifications
        </button>
      )}
    </Panel>
  );
}
