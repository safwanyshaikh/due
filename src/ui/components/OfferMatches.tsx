import { useEffect, useState } from 'react';
import { createRequester } from '../../lib/account/identities';
import type { CommitmentType } from '../../lib/types';
import { formatINR } from '../../lib/money';
import { safeHref } from '../lib/markdown';
import { Badge } from './ui';

/** One possible benefit from GET /api/public/offers/match (Agent D). Fields are optional for safety. */
export interface OfferMatchItem {
  offerId: string;
  provider?: string;
  name: string;
  benefitType?: string;
  possibleBenefit?: unknown;
  status?: string;
  eligibility?: {
    overall?: 'confirmed' | 'missing' | 'provider_only';
    checks?: { kind: string; description: string; state: string }[];
  };
  expiry?: { officialStartAt: string | null; officialEndAt: string | null; note?: string };
  estimate?: { amountInr: number | null; basis?: string };
  confidence?: 'high' | 'medium' | 'low';
  assumptions?: string[];
  doubleCountNote?: string | null;
  sources?: { url: string; label?: string }[];
}

export interface OfferMatchResponse {
  disclaimer?: string;
  matches: OfferMatchItem[];
}

export const OFFER_UNAVAILABLE = 'Offer data unavailable';
export const POSSIBLE_BENEFIT = 'Possible benefit to verify';

/** Plan types where an included benefit is plausible (telecom, OTT, AI/cloud, cards). */
export const MATCHABLE_TYPES: CommitmentType[] = ['subscription', 'bill', 'credit_card', 'other'];

const request = createRequester();

/**
 * Telecom service types the server checks eligibility against. A Due category such as 'subscription' or 'bill'
 * is not a service type: sending it would mark every prepaid/postpaid offer as "not eligible" and hide it.
 */
export const SERVICE_TYPES = ['prepaid', 'postpaid', 'broadband', 'dth'] as const;

export async function fetchOfferMatches(q: {
  provider: string;
  serviceType?: string;
  price?: number;
}): Promise<OfferMatchResponse> {
  const p = new URLSearchParams({ provider: q.provider.slice(0, 60) });
  if (q.serviceType && (SERVICE_TYPES as readonly string[]).includes(q.serviceType))
    p.set('serviceType', q.serviceType);
  if (q.price !== undefined) p.set('price', String(q.price));
  const r = await request<OfferMatchResponse>('GET', `/api/public/offers/match?${p}`);
  return { disclaimer: r?.disclaimer, matches: Array.isArray(r?.matches) ? r.matches : [] };
}

/** Removes words like "guaranteed" from provider copy so nothing is presented as certain. */
export function soften(text: string): string {
  return text.replace(/\bguarantee(d|s)?\b/gi, 'possible');
}

function benefitText(v: unknown): string | null {
  if (typeof v === 'string') return soften(v);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const s = o.description ?? o.label ?? o.summary ?? o.text;
    if (typeof s === 'string') return soften(s);
  }
  return null;
}

const ELIG: Record<string, string> = {
  confirmed: 'Eligibility looks met from what you entered',
  missing: 'Some eligibility details are unknown',
  provider_only: 'Only the provider can confirm eligibility',
};

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; data: OfferMatchResponse }
  | { kind: 'unavailable' };

/**
 * Cross-calculation: when a plan is added or edited, shows benefits it may include, each labelled
 * "Possible benefit to verify" with assumptions, expiry, eligibility, confidence and sources.
 */
export function OfferMatches({
  provider,
  type,
  amountPaise,
}: {
  provider: string;
  type: CommitmentType;
  amountPaise: number | null;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const name = provider.trim();
  const eligible = MATCHABLE_TYPES.includes(type) && name.length >= 2;
  useEffect(() => {
    if (!eligible) return;
    let live = true;
    const t = setTimeout(() => {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setState({ kind: 'unavailable' });
        return;
      }
      setState({ kind: 'loading' });
      fetchOfferMatches({
        provider: name,
        // The plan's service type (prepaid/postpaid) is unknown here, so eligibility stays "to verify".
        price: amountPaise !== null ? Math.round(amountPaise / 100) : undefined,
      }).then(
        (data) => live && setState({ kind: 'ok', data }),
        () => live && setState({ kind: 'unavailable' }),
      );
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [eligible, name, type, amountPaise]);

  if (!eligible || state.kind === 'idle') return null;
  return (
    <section className="panel2 offer-matches" aria-labelledby="om-title" aria-live="polite">
      <h2 id="om-title" className="h-small">
        Benefits this plan may include
      </h2>
      {state.kind === 'loading' && <p className="muted small">Checking Due’s offer catalog…</p>}
      {state.kind === 'unavailable' && (
        <p className="muted small" data-testid="offers-unavailable">
          {OFFER_UNAVAILABLE}. You can still save this plan; check the provider’s own app or site
          for included benefits.
        </p>
      )}
      {state.kind === 'ok' && state.data.matches.length === 0 && (
        <p className="muted small">
          No possible included benefits found in Due’s catalog for this plan.
        </p>
      )}
      {state.kind === 'ok' &&
        state.data.matches.slice(0, 5).map((m) => {
          const benefit = benefitText(m.possibleBenefit);
          const end = m.expiry?.officialEndAt?.slice(0, 10);
          return (
            <article key={m.offerId} className="offer-match">
              <div className="chips">
                <Badge tone="warm">{POSSIBLE_BENEFIT}</Badge>
                {m.confidence && <Badge>{`Confidence: ${m.confidence}`}</Badge>}
              </div>
              <strong>{soften(m.name)}</strong>
              {benefit && <p className="small">{benefit}</p>}
              {m.estimate && (
                <p className="small">
                  {m.estimate.amountInr !== null && m.estimate.amountInr !== undefined
                    ? `May be worth about ${formatINR(Math.round(m.estimate.amountInr * 100))} (estimate). `
                    : ''}
                  <span className="muted">{m.estimate.basis ? soften(m.estimate.basis) : ''}</span>
                </p>
              )}
              <p className="small">
                <span className="muted">Expiry: </span>
                {end ? `ends ${end}` : 'no official end date published'}
                {m.expiry?.note ? ` · ${soften(m.expiry.note)}` : ''}
              </p>
              <p className="small">
                <span className="muted">Eligibility: </span>
                {ELIG[m.eligibility?.overall ?? 'provider_only']}
              </p>
              {m.assumptions && m.assumptions.length > 0 && (
                <ul className="small">
                  {m.assumptions.slice(0, 4).map((a) => (
                    <li key={a}>{soften(a)}</li>
                  ))}
                </ul>
              )}
              {m.doubleCountNote && <p className="muted small">{soften(m.doubleCountNote)}</p>}
              {m.sources && m.sources.length > 0 && (
                <p className="small">
                  Sources:{' '}
                  {m.sources.slice(0, 3).map((s, i) => {
                    const href = safeHref(s.url);
                    return (
                      <span key={s.url}>
                        {i > 0 ? ' · ' : ''}
                        {href ? (
                          <a href={href} rel="noopener noreferrer" target="_blank">
                            {s.label || 'source'}
                          </a>
                        ) : (
                          s.label || 'source'
                        )}
                      </span>
                    );
                  })}
                </p>
              )}
            </article>
          );
        })}
      {state.kind === 'ok' && (
        <p className="muted small">
          {state.data.disclaimer
            ? soften(state.data.disclaimer)
            : 'Possible benefits only, from public provider pages. Confirm with the provider before relying on them.'}
        </p>
      )}
    </section>
  );
}
