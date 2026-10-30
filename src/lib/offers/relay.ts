import { fingerprint } from './observations';
import type { OfferRecord, RelayClass, RelayState, ServiceProvider, UserEvent } from './types';

export const PARSER_VERSION = 'generic-0.1';
export const RELAY_DOMAIN = 'inbox.due.app';

export function newToken(rand: () => number = Math.random): string {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let t = '';
  for (let i = 0; i < 6; i++) t += a[Math.floor(rand() * a.length)];
  return t;
}

export function relayAddress(token: string): string {
  return `u_${token}@${RELAY_DOMAIN}`;
}

export function emptyRelay(): RelayState {
  return { status: 'not_connected', token: null, retentionDays: 7, events: [] };
}

/** The message must be addressed to this user's current token, and Relay must be connected. */
export function verifyForwardingToken(to: string, state: RelayState): boolean {
  if (state.status !== 'connected' || !state.token) return false;
  return to.trim().toLowerCase() === relayAddress(state.token);
}

const PROVIDERS: [ServiceProvider, RegExp][] = [
  ['jio', /\bjio\b/i],
  ['airtel', /\bairtel\b/i],
  ['vi', /\b(vi|vodafone idea|myvi)\b/i],
  ['amazon', /\b(amazon|prime video|prime)\b/i],
  ['google', /\b(google one|google ai|gemini)\b/i],
];

export function classify(text: string): RelayClass {
  const t = text.toLowerCase();
  if (/trial/.test(t)) return 'trial';
  if (/recharge/.test(t)) return 'recharge';
  if (/statement|credit card/.test(t)) return 'card_statement';
  if (/\bemi\b|loan/.test(t)) return 'emi_loan';
  if (/school|tuition|term fee/.test(t)) return 'school_fee';
  if (/electricity|water bill|gas bill|broadband bill/.test(t)) return 'utility';
  if (/renew|renewal|subscription/.test(t)) return 'renewal';
  if (/offer|cashback|benefit/.test(t)) return 'offer';
  if (/receipt|invoice|payment received/.test(t)) return 'receipt';
  return 'irrelevant';
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function findDate(text: string): string | null {
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
  if (iso) return iso[0];
  const dmy =
    /\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(20\d{2})\b/i.exec(
      text,
    );
  if (dmy)
    return `${dmy[3]}-${String(MONTHS[dmy[2].toLowerCase()]).padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  return null;
}

export interface ForwardedMessage {
  messageId: string;
  to: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

export function extract(msg: ForwardedMessage) {
  const text = `${msg.subject}\n${msg.body}`;
  const prov = PROVIDERS.find(([, re]) => re.test(text));
  const amt = /(?:₹|rs\.?|inr)\s?([\d,]+(?:\.\d{1,2})?)/i.exec(text);
  const trial = /trial[^.\n]*?(?:ends?|until|till)\s+(?:on\s+)?([^.\n]+)/i.exec(text);
  const links = [...text.matchAll(/https?:\/\/[^\s)>"']+/g)].map((m) => m[0]).slice(0, 5);
  const domain = /@([a-z0-9.-]+)/i.exec(msg.from)?.[1]?.toLowerCase() ?? null;
  return {
    provider: prov ? prov[0] : null,
    service: prov ? msg.subject.slice(0, 80) : null,
    amountPaise: amt ? Math.round(Number(amt[1].replace(/,/g, '')) * 100) : null,
    currency: amt ? ('INR' as const) : null,
    date: findDate(text),
    trialEnd: trial ? findDate(trial[1]) : null,
    benefit: /prime|ott|cloud|storage|cashback/i.exec(text)?.[0] ?? null,
    senderDomain: domain,
    links,
  };
}

function matchCatalog(
  c: ReturnType<typeof extract>,
  text: string,
  catalog: OfferRecord[],
): string[] {
  if (!c.provider) return [];
  const words = text.toLowerCase();
  return catalog
    .filter((o) => o.provider === c.provider)
    .filter(
      (o) =>
        (o.skuOrPlanCode && words.includes(o.skuOrPlanCode)) ||
        words.includes(o.productFamily.toLowerCase()),
    )
    .map((o) => o.offerId);
}

export type ProcessResult =
  { ok: true; event: UserEvent } | { ok: false; reason: 'bad_token' | 'duplicate' | 'paused' };

/**
 * Pipeline for an explicitly forwarded message. It only proposes a candidate. Nothing is saved as a
 * service until the user confirms. Sender identity alone is never treated as proof.
 * Not wired to any mailbox yet: forwarding needs an inbound email service on the server.
 */
export function processForwarded(
  msg: ForwardedMessage,
  state: RelayState,
  catalog: OfferRecord[],
  now: string,
): ProcessResult {
  if (state.status === 'paused') return { ok: false, reason: 'paused' };
  if (!verifyForwardingToken(msg.to, state)) return { ok: false, reason: 'bad_token' };
  return buildEvent(msg, state, catalog, now);
}

/**
 * Organises one message the user pasted into this browser. It is processed locally only: nothing is
 * sent anywhere, and no forwarding address or connection is involved.
 */
export function organisePastedMessage(
  text: string,
  state: RelayState,
  catalog: OfferRecord[],
  now: string,
): ProcessResult {
  const [subject, ...rest] = text.split('\n');
  return buildEvent(
    {
      messageId: `local-${now}`,
      to: '',
      from: '',
      subject: subject.trim() || '(no subject)',
      body: rest.join('\n'),
      receivedAt: now,
    },
    state,
    catalog,
    now,
  );
}

function buildEvent(
  msg: ForwardedMessage,
  state: RelayState,
  catalog: OfferRecord[],
  now: string,
): ProcessResult {
  const fp = fingerprint(`${msg.subject}\n${msg.body}`);
  if (state.events.some((e) => e.messageId === msg.messageId || e.fingerprint === fp))
    return { ok: false, reason: 'duplicate' };
  const classification = classify(`${msg.subject} ${msg.body}`);
  const candidate = extract(msg);
  const matchedOfferIds = matchCatalog(candidate, `${msg.subject} ${msg.body}`, catalog);
  const recognised =
    classification !== 'irrelevant' &&
    (candidate.provider !== null || candidate.amountPaise !== null);
  const filled = [candidate.provider, candidate.amountPaise, candidate.date].filter(
    (x) => x !== null,
  ).length;
  const purge = new Date(Date.parse(now) + state.retentionDays * 86_400_000).toISOString();
  return {
    ok: true,
    event: {
      id: `ev_${fp}`,
      messageId: msg.messageId,
      fingerprint: fp,
      receivedAt: msg.receivedAt,
      subject: msg.subject.slice(0, 140),
      classification,
      candidate,
      matchedOfferIds,
      verification: matchedOfferIds.length ? 'source_supported' : 'unverified',
      state: recognised ? 'needs_confirmation' : 'could_not_identify',
      parserVersion: PARSER_VERSION,
      confidence: filled >= 3 ? 'medium' : 'low',
      extractedAt: now,
      rawExcerpt: msg.body.slice(0, 400),
      rawPurgeAfter: purge,
    },
  };
}

export function setEventState(state: RelayState, id: string, next: UserEvent['state']): RelayState {
  return {
    ...state,
    events: state.events.map((e) =>
      e.id === id
        ? { ...e, state: next, verification: next === 'saved' ? 'user_confirmed' : e.verification }
        : e,
    ),
  };
}

export function deleteEvent(state: RelayState, id: string): RelayState {
  return { ...state, events: state.events.filter((e) => e.id !== id) };
}

/** Removes raw text after the retention date. Structured fields stay until the user deletes them. */
export function purgeRaw(state: RelayState, now: string): RelayState {
  return {
    ...state,
    events: state.events.map((e) =>
      e.rawExcerpt && e.rawPurgeAfter <= now ? { ...e, rawExcerpt: null } : e,
    ),
  };
}

export function deleteAllIntake(state: RelayState): RelayState {
  return { ...state, events: [] };
}

export function rotateToken(state: RelayState, rand?: () => number): RelayState {
  return { ...state, token: newToken(rand) };
}

/** An event can only feed the "benefits" list after a user confirmation AND a public catalog match. */
export function canSurfaceAsBenefit(e: UserEvent, catalog: OfferRecord[]): boolean {
  if (e.verification !== 'user_confirmed') return false;
  return e.matchedOfferIds.some((id) => {
    const o = catalog.find((x) => x.offerId === id);
    return !!o && (o.computedStatus === 'active' || o.computedStatus === 'active_verify');
  });
}

/**
 * Shared public layer: one normalised observation per campaign fingerprint, reused across users.
 * Private events stay in each user's own store and never pass through here.
 */
export class PublicObservationCache {
  private byCampaign = new Map<string, { offerIds: string[]; firstSeen: string; hits: number }>();
  record(campaignKey: string, offerIds: string[], now: string): { reused: boolean } {
    const k = fingerprint(campaignKey);
    const hit = this.byCampaign.get(k);
    if (hit) {
      hit.hits++;
      return { reused: true };
    }
    this.byCampaign.set(k, { offerIds, firstSeen: now, hits: 1 });
    return { reused: false };
  }
  size(): number {
    return this.byCampaign.size;
  }
}

export class PrivateEventStore {
  private byUser = new Map<string, UserEvent[]>();
  add(userId: string, e: UserEvent): void {
    this.byUser.set(userId, [...(this.byUser.get(userId) ?? []), e]);
  }
  list(userId: string): UserEvent[] {
    return [...(this.byUser.get(userId) ?? [])];
  }
}
