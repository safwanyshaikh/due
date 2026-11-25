import { useEffect, useState } from 'react';
import { getPlatform, isNative } from '../../lib/platform';
import { Badge, Panel } from './ui';

/** Native only: turn the biometric / passcode app lock on or off. Off by default. */
export function AppLockPanel() {
  const native = isNative();
  const [on, setOn] = useState(false);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!native) return;
    const lock = getPlatform().appLock;
    void lock.isEnabled().then(setOn);
    void lock.available().then(setAvailable);
  }, [native]);
  if (!native) return null;
  const toggle = async () => {
    setBusy(true);
    setOn(await getPlatform().appLock.setEnabled(!on));
    setBusy(false);
  };
  return (
    <Panel title="App lock" id="st-lock">
      <p className="muted">
        Ask for Face ID, fingerprint or your device passcode when you open Due and when you come
        back after a short while away. Off unless you turn it on.
      </p>
      {!available && !on ? (
        <p className="muted" role="status">
          Set up a screen lock, Face ID or fingerprint in your phone’s settings first.
        </p>
      ) : (
        <div className="stack-8">
          <p>
            <Badge tone={on ? 'calm' : 'plain'}>{on ? 'On' : 'Off'}</Badge>
          </p>
          <button
            type="button"
            className="btn btn-secondary press"
            disabled={busy}
            onClick={() => void toggle()}
          >
            {on ? 'Turn off app lock' : 'Turn on app lock'}
          </button>
        </div>
      )}
    </Panel>
  );
}
