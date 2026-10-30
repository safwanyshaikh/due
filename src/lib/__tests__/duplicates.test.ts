import { describe, expect, it } from 'vitest';
import { emptyData, setStatementLink } from '../data';
import { dismissDuplicate, findDuplicateSuggestions, mergeDuplicates } from '../duplicates';
import {
  canonicalMerchant,
  findMerchantInText,
  merchantKey,
  normaliseMerchant,
} from '../merchants';
import { createObligation, markPaid } from '../mutations';
import { activeObligations } from '../obligations';
import { cashForecast, linkedParentMap } from '../totals';
import { rules } from '../recurrence';
import type { AppData } from '../types';
import { ctx, NOW } from './helpers';

describe('merchant aliases', () => {
  it('normalises well-known brand spellings', () => {
    expect(
      ['Netflix.com', 'NETFLIX INDIA', 'Netflix', 'netflix.com/bill'].map(
        (s) => canonicalMerchant(s)?.key,
      ),
    ).toEqual(['netflix', 'netflix', 'netflix', 'netflix']);
    expect(['Amazon Prime', 'Prime Video', 'AMAZON PRIME VIDEO'].map(merchantKey)).toEqual([
      'amazon_prime',
      'amazon_prime',
      'amazon_prime',
    ]);
    expect(['Jio', 'Reliance Jio', 'JIO FIBER'].map(merchantKey)).toEqual(['jio', 'jio', 'jio']);
    expect(['Airtel', 'Bharti Airtel Ltd'].map(merchantKey)).toEqual(['airtel', 'airtel']);
    expect(merchantKey('JioHotstar')).toBe('jiohotstar');
    expect(merchantKey('Disney+ Hotstar')).toBe('jiohotstar');
    expect(merchantKey('Vodafone Idea')).toBe('vi');
  });
  it('unknown merchants fall back to a normalised name and match whole tokens only', () => {
    expect(canonicalMerchant('Sharma Tuition Classes')).toBeNull();
    expect(merchantKey('Sharma Tuition Pvt. Ltd.')).toBe('sharma tuition');
    expect(normaliseMerchant('  ACME   Broadband!! ')).toBe('acme broadband');
    expect(canonicalMerchant('Jiomart')).toBeNull();
    expect(merchantKey('')).toBe('');
  });
  it('finds a merchant inside free text', () => {
    expect(findMerchantInText('Your Spotify Premium renews soon')?.alias.key).toBe('spotify');
    expect(findMerchantInText('VM-AIRTEL: bill ready')?.alias.key).toBe('airtel');
    expect(findMerchantInText('nothing here')).toBeNull();
  });
});

function two(p1: string, p2: string, a1: number | null, a2: number | null): AppData {
  let d = createObligation(
    emptyData(),
    { type: 'subscription', provider: p1, amountPaise: a1, rule: rules.monthly('2026-11-05') },
    ctx(),
  ).data;
  d = createObligation(
    d,
    { type: 'subscription', provider: p2, amountPaise: a2, rule: rules.monthly('2026-11-06') },
    ctx(),
  ).data;
  return d;
}

describe('duplicate suggestions', () => {
  it('suggests alias duplicates with a reason and confidence; never merges by itself', () => {
    const d = two('Netflix.com', 'NETFLIX INDIA', 64900, 64900);
    const s = findDuplicateSuggestions(d);
    expect(s).toHaveLength(1);
    expect(s[0].reason).toBe(
      'Same provider: Netflix ("Netflix.com" and "NETFLIX INDIA"), same amount ₹649, same schedule',
    );
    expect(s[0].confidence).toBe('high');
    expect(activeObligations(d)).toHaveLength(2);
  });
  it('different providers are not suggested; card-statement links are excluded', () => {
    expect(findDuplicateSuggestions(two('Netflix', 'Spotify', 1, 1))).toEqual([]);
    const d = two('Netflix', 'Netflix', 1, 2);
    const linked = setStatementLink(d, d.commitments[0].id, d.commitments[1].id);
    expect(findDuplicateSuggestions(linked)).toEqual([]);
  });
  it('merge keeps one record, soft-deletes the other, carries history, and is undoable', () => {
    let d = two('Prime Video', 'Amazon Prime', 29900, 29900);
    const [a, b] = d.commitments.map((c) => c.id);
    d = markPaid(d, b, ctx()).data;
    const s = findDuplicateSuggestions(d)[0];
    const r = mergeDuplicates(d, s, a, { now: NOW });
    const active = activeObligations(r.data);
    expect(active.map((c) => c.id)).toEqual([a]);
    expect(active[0].history).toHaveLength(1);
    expect(r.data.commitments.find((c) => c.id === b)?.mergedInto).toBe(a);
    expect(findDuplicateSuggestions(r.data)).toEqual([]);
    expect(r.event.action).toBe('duplicate_merged');
    const back = r.undo();
    expect(activeObligations(back)).toHaveLength(2);
    expect(findDuplicateSuggestions(back)).toHaveLength(1);
    expect(back.audit.at(-1)?.action).toBe('undo');
  });
  it('merge moves card-statement links to the kept record (no double counting); undo restores them', () => {
    // A card statement (₹5,000) that already includes Netflix A; Netflix B is a duplicate of A.
    let d = createObligation(
      emptyData(),
      {
        type: 'credit_card',
        provider: 'HDFC Card',
        amountPaise: 500000,
        rule: rules.monthly('2026-11-10'),
      },
      ctx(),
    ).data;
    d = createObligation(
      d,
      {
        type: 'subscription',
        provider: 'Netflix.com',
        amountPaise: 64900,
        rule: rules.monthly('2026-11-05'),
      },
      ctx(),
    ).data;
    d = createObligation(
      d,
      {
        type: 'subscription',
        provider: 'NETFLIX INDIA',
        amountPaise: 64900,
        rule: rules.monthly('2026-11-05'),
      },
      ctx(),
    ).data;
    const [card, a, b] = d.commitments.map((c) => c.id);
    d = setStatementLink(d, a, card);
    const nov = { start: '2026-11-01', end: '2026-11-30' };
    const s = findDuplicateSuggestions(d)[0];
    expect(s.ids.sort()).toEqual([a, b].sort());

    // Keep B (the unlinked one): A's link must move to B or Netflix is counted twice.
    const r = mergeDuplicates(d, s, b, { now: NOW });
    expect(r.data.links).toHaveLength(1);
    expect(r.data.links[0]).toMatchObject({
      parentId: card,
      componentId: b,
      confirmedByUser: true,
    });
    expect([...linkedParentMap(r.data)]).toEqual([[b, card]]);
    expect(cashForecast(r.data, nov).totalPaise).toBe(500000);

    const back = r.undo();
    expect(back.links).toEqual(d.links);
    expect([...linkedParentMap(back)]).toEqual([[a, card]]);
    expect(activeObligations(back)).toHaveLength(3);
  });
  it('merge dedupes links when both duplicates were linked, and re-points merged statements', () => {
    let d = two('Netflix', 'Netflix', 64900, 64900);
    const [a, b] = d.commitments.map((c) => c.id);
    for (const p of ['HDFC Card', 'HDFC Credit Card'])
      d = createObligation(
        d,
        {
          type: 'credit_card',
          provider: p,
          amountPaise: 500000,
          rule: rules.monthly('2026-11-10'),
        },
        ctx(),
      ).data;
    const [card1, card2] = d.commitments.slice(2).map((c) => c.id);
    d = setStatementLink(d, a, card1);
    d = setStatementLink(d, b, card2);
    // Merge the statements first: both Netflix links now point at card1.
    const cards = mergeDuplicates(d, { ids: [card1, card2] }, card1, { now: NOW });
    expect(cards.data.links.map((l) => [l.componentId, l.parentId])).toEqual([
      [a, card1],
      [b, card1],
    ]);
    // Then merge the Netflix duplicates: one link remains.
    const r = mergeDuplicates(cards.data, { ids: [a, b] }, a, { now: NOW });
    expect(r.data.links.map((l) => [l.componentId, l.parentId])).toEqual([[a, card1]]);
    expect(cashForecast(r.data, { start: '2026-11-01', end: '2026-11-30' }).totalPaise).toBe(
      500000,
    );
    expect(r.undo().links).toEqual(cards.data.links);
  });
  it('dismiss hides the suggestion; undo brings it back', () => {
    const d = two('Jio', 'Reliance Jio', 39900, 39900);
    const s = findDuplicateSuggestions(d)[0];
    const r = dismissDuplicate(d, s, { now: NOW });
    expect(findDuplicateSuggestions(r.data)).toEqual([]);
    expect(activeObligations(r.data)).toHaveLength(2);
    expect(findDuplicateSuggestions(r.undo())).toHaveLength(1);
  });
  it('merge requires keepId from the suggestion', () => {
    const d = two('Jio', 'Jio', 1, 1);
    expect(() =>
      mergeDuplicates(d, findDuplicateSuggestions(d)[0], 'other', { now: NOW }),
    ).toThrow();
  });
});
