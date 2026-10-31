import { useCallback, useState } from 'react';
import { AccountApiError } from '../../lib/account/client';
import type { IntakeAlias, UserEvent as ServerUserEvent } from '../../lib/account/types';
import { addImportItems } from '../../lib/imports';
import { EMAIL_INTAKE_CONSENT_VERSION } from '../../content/privacy';
import { useApp } from '../store';
import { useToast } from '../components/Toast';
import { importItemFromServerEvent, serverRef } from '../lib/serverEvents';
import { useAccount } from './AccountContext';

export type AliasPhase =
  | 'idle'
  | 'loading'
  | 'none'
  | 'ready'
  | 'not_live'
  | 'unreachable'
  | 'needs_session'
  | 'needs_plus'
  | 'error';

export function describeApiError(e: unknown): string {
  if (e instanceof AccountApiError) {
    if (e.status === 0 || e.code === 'invalid_response' || e.code === 'http_error')
      return 'Due’s server can’t be reached right now.';
    return e.message;
  }
  return 'Something went wrong.';
}

function isUnreachable(e: unknown): boolean {
  return (
    e instanceof AccountApiError &&
    (e.status === 0 ||
      e.code === 'invalid_response' ||
      (e.status >= 404 && e.code === 'http_error'))
  );
}

/** Forwarding alias and server intake events, mapped into the local review queue. */
export function useIntake() {
  const { client, status } = useAccount();
  const { mutate, ctx, current } = useApp();
  const toast = useToast();
  const [phase, setPhase] = useState<AliasPhase>('idle');
  const [alias, setAlias] = useState<IntakeAlias | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [events, setEvents] = useState<ServerUserEvent[]>([]);
  const [rawStorage, setRawStorage] = useState<'encrypted' | 'disabled' | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [eventsError, setEventsError] = useState<string | null>(null);

  const take = useCallback((a: IntakeAlias) => {
    // A guest session answers without an address: forwarding needs a signed-in Plus account.
    if ((a as { forwarding?: string }).forwarding === 'sign_in_required') {
      setAlias(null);
      setMessage(null);
      setPhase('needs_session');
      return;
    }
    setAlias(a);
    setMessage(a.liveReason ?? null);
    setPhase(!a.live ? 'not_live' : a.alias ? 'ready' : 'none');
  }, []);

  const fail = useCallback((e: unknown) => {
    if (e instanceof AccountApiError && (e.isPremiumRequired || e.status === 402)) {
      // Forwarding is a Plus feature (server-side entitlement).
      setPhase('needs_plus');
      setMessage(null);
    } else if (e instanceof AccountApiError && (e.isUnavailable || e.status === 503)) {
      setPhase('not_live');
      setMessage(e.message);
    } else if (e instanceof AccountApiError && (e.status === 401 || e.status === 403)) {
      setPhase('needs_session');
      setMessage(null);
    } else if (isUnreachable(e)) {
      setPhase('unreachable');
      setMessage(describeApiError(e));
    } else {
      setPhase('error');
      setMessage(describeApiError(e));
    }
  }, []);

  const load = useCallback(async () => {
    setPhase('loading');
    try {
      take(await client.getIntakeAlias());
    } catch (e) {
      fail(e);
    }
  }, [client, take, fail]);

  /** Creates an address after the user agreed to the shown copy (consent is recorded server-side). */
  const create = useCallback(async () => {
    // Guests cannot get a forwarding address (the server refuses); they sign in first.
    if (status !== 'signed_in') {
      setPhase('needs_session');
      return;
    }
    setPhase('loading');
    try {
      take(await client.createIntakeAlias(EMAIL_INTAKE_CONSENT_VERSION));
    } catch (e) {
      fail(e);
    }
  }, [client, status, take, fail]);

  const act = useCallback(
    async (fn: () => Promise<IntakeAlias>, done: string) => {
      try {
        take(await fn());
        toast.show({ message: done, tone: 'success' });
      } catch (e) {
        toast.show({ message: describeApiError(e), tone: 'error' });
      }
    },
    [take, toast],
  );

  /** Lists server events and adds new ones that need review to the local queue. */
  const refreshEvents = useCallback(async () => {
    try {
      const r = await client.listIntakeEvents();
      setEvents(r.items);
      setRawStorage(r.rawStorage);
      setEventsError(null);
      setCheckedAt(new Date().toISOString());
      const known = new Set((current().importQueue ?? []).map((i) => i.raw.ref));
      const fresh = r.items.filter(
        (ev) =>
          ev.intakeType === 'forwarded_email' &&
          ev.reviewStatus === 'needs_review' &&
          !known.has(serverRef(ev.id)),
      );
      if (fresh.length) {
        mutate(
          (d) =>
            addImportItems(
              d,
              fresh.map((ev) => importItemFromServerEvent(d, ev)),
              ctx(),
            ),
          {
            message: `${fresh.length} forwarded email${fresh.length === 1 ? '' : 's'} added to your review queue`,
          },
        );
      }
    } catch (e) {
      setEventsError(describeApiError(e));
    }
  }, [client, current, mutate, ctx]);

  return {
    phase,
    alias,
    message,
    events,
    rawStorage,
    checkedAt,
    eventsError,
    load,
    create,
    refreshEvents,
    rotate: () =>
      act(() => client.rotateIntakeAlias(), 'New address created. The old one no longer works.'),
    pause: () =>
      act(() => client.pauseIntakeAlias(), 'Forwarding paused. New emails will be refused.'),
    resume: () => act(() => client.resumeIntakeAlias(), 'Forwarding resumed.'),
    setEvents,
  };
}
