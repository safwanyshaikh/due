import { commit, type MutationContext, type MutationResult } from './audit';
import { canonicalMerchant, merchantKey } from './merchants';
import { formatINR } from './money';
import { activeObligations } from './obligations';
import { cadenceMonths } from './recurrence';
import type { AppData, Commitment, CommitmentLink, Rail } from './types';

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

export interface DuplicateCandidate {
  id?: string;
  provider: string;
  type: Commitment['type'];
  amountPaise: number | null;
}

/** Suggestions only. The user decides; nothing is merged automatically. Aliases count as the same provider. */
export function findDuplicates(cand: DuplicateCandidate, existing: Commitment[]): Commitment[] {
  const p = norm(cand.provider);
  if (!p) return [];
  const key = merchantKey(cand.provider);
  return existing.filter(
    (e) =>
      e.id !== cand.id &&
      !e.deletedAt &&
      (norm(e.provider) === p || (key !== '' && merchantKey(e.provider) === key)) &&
      (e.type === cand.type || (cand.amountPaise !== null && e.amountPaise === cand.amountPaise)),
  );
}

/** If an item says it is charged to a card, suggest the matching statement so it isn't counted twice. */
export function suggestStatementLinks(
  cand: { id?: string; type: Commitment['type']; rail: Rail; accountNickname: string },
  existing: Commitment[],
): Commitment[] {
  if (cand.type === 'credit_card' || cand.rail !== 'credit_card') return [];
  const nick = norm(cand.accountNickname);
  return existing.filter(
    (e) =>
      e.type === 'credit_card' &&
      e.id !== cand.id &&
      !e.deletedAt &&
      (nick === '' || norm(e.statement?.cardNickname ?? '') === nick),
  );
}

/* ---------- v2: reviewable suggestions ---------- */

export type SuggestionConfidence = 'high' | 'medium' | 'low';

export interface DuplicateSuggestion {
  /** Stable key: sorted ids joined with '+'. */
  key: string;
  ids: string[];
  reason: string;
  confidence: SuggestionConfidence;
}

export interface DuplicateDecision {
  key: string;
  ids: string[];
  decision: 'dismissed' | 'merged';
  at: string;
  keptId?: string;
}

export function suggestionKey(ids: string[]): string {
  return [...ids].sort().join('+');
}

function displayProvider(c: Commitment): string {
  return canonicalMerchant(c.provider)?.displayName ?? (c.provider || c.nickname);
}

/**
 * Pairs of active obligations that look like the same thing (same canonical merchant after
 * alias normalisation). Dismissed/merged pairs and card-statement links are excluded.
 */
export function findDuplicateSuggestions(data: AppData): DuplicateSuggestion[] {
  const obs = activeObligations(data);
  const decided = new Set((data.duplicateDecisions ?? []).map((d) => d.key));
  const linked = new Set(data.links.map((l) => suggestionKey([l.parentId, l.componentId])));
  const out: DuplicateSuggestion[] = [];
  for (let i = 0; i < obs.length; i++) {
    for (let j = i + 1; j < obs.length; j++) {
      const a = obs[i];
      const b = obs[j];
      const ka = a.canonicalProvider ?? merchantKey(a.provider);
      const kb = b.canonicalProvider ?? merchantKey(b.provider);
      if (!ka || ka !== kb) continue;
      const key = suggestionKey([a.id, b.id]);
      if (decided.has(key) || linked.has(key)) continue;
      const sameAmount = a.amount.value !== null && a.amount.value === b.amount.value;
      const sameCadence = cadenceMonths(a.rule) === cadenceMonths(b.rule);
      const sameType = a.type === b.type;
      if (!sameAmount && !sameType) continue;
      const aliasNote =
        norm(a.provider) !== norm(b.provider) ? ` ("${a.provider}" and "${b.provider}")` : '';
      const parts = [`Same provider: ${displayProvider(a)}${aliasNote}`];
      if (sameAmount) parts.push(`same amount ${formatINR(a.amount.value!)}`);
      if (sameCadence) parts.push('same schedule');
      out.push({
        key,
        ids: [a.id, b.id],
        reason: parts.join(', '),
        confidence:
          sameAmount && sameCadence ? 'high' : sameAmount || sameCadence ? 'medium' : 'low',
      });
    }
  }
  return out;
}

const linkKey = (l: Pick<CommitmentLink, 'parentId' | 'componentId' | 'relation'>) =>
  `${l.parentId}>${l.componentId}>${l.relation}`;

/**
 * Re-points card-statement links from merged-away ids to the survivor. Links that become
 * duplicates are folded into one (confirmed if either was), and a link from the survivor to
 * itself is dropped. Returns the new list and the ids of every link that changed or was removed.
 */
function moveLinks(
  links: CommitmentLink[],
  removedIds: Set<string>,
  keepId: string,
): { links: CommitmentLink[]; touched: string[] } {
  const remap = (id: string) => (removedIds.has(id) ? keepId : id);
  const touched = new Set<string>();
  const byKey = new Map<string, CommitmentLink>();
  const order: string[] = [];
  const put = (l: CommitmentLink) => {
    const k = linkKey(l);
    const existing = byKey.get(k);
    if (!existing) {
      byKey.set(k, l);
      order.push(k);
      return;
    }
    // Same statement link twice: keep the first, confirmed if either one was.
    touched.add(l.id);
    if (l.confirmedByUser && !existing.confirmedByUser) {
      byKey.set(k, { ...existing, confirmedByUser: true });
      touched.add(existing.id);
    }
  };
  // Links that do not involve a merged-away id keep their place and win over moved ones.
  for (const l of links) if (!removedIds.has(l.parentId) && !removedIds.has(l.componentId)) put(l);
  for (const l of links) {
    if (!removedIds.has(l.parentId) && !removedIds.has(l.componentId)) continue;
    touched.add(l.id);
    const moved = { ...l, parentId: remap(l.parentId), componentId: remap(l.componentId) };
    if (moved.parentId === moved.componentId) continue;
    put(moved);
  }
  return { links: order.map((k) => byKey.get(k)!), touched: [...touched] };
}

/**
 * Explicit user action: keep one obligation and soft-delete the others (marked `mergedInto`).
 * Their history and overrides are copied onto the kept record, and their card-statement links
 * (as statement or as component) move to the kept record, so nothing is counted twice. Undoable:
 * undo restores the original links.
 */
export function mergeDuplicates(
  data: AppData,
  suggestion: Pick<DuplicateSuggestion, 'ids'>,
  keepId: string,
  ctx: MutationContext,
): MutationResult {
  if (!suggestion.ids.includes(keepId)) throw new Error('keepId must be one of the suggestion ids');
  const obs = activeObligations(data);
  const keep = obs.find((c) => c.id === keepId);
  const others = obs.filter((c) => suggestion.ids.includes(c.id) && c.id !== keepId);
  if (!keep || !others.length) throw new Error('Those items are no longer available to merge.');
  const merged: Commitment = {
    ...keep,
    history: [...keep.history, ...others.flatMap((o) => o.history)],
    overrides: [...keep.overrides, ...others.flatMap((o) => o.overrides)],
    updatedAt: ctx.now,
  };
  const key = suggestionKey(suggestion.ids);
  const decision: DuplicateDecision = {
    key,
    ids: [...suggestion.ids],
    decision: 'merged',
    at: ctx.now,
    keptId: keepId,
  };
  const removed = new Map(
    others.map((o) => [o.id, { ...o, deletedAt: ctx.now, mergedInto: keepId, updatedAt: ctx.now }]),
  );
  const moved = moveLinks(data.links ?? [], new Set(removed.keys()), keepId);
  const next: AppData = {
    ...data,
    commitments: data.commitments.map((c) => (c.id === keepId ? merged : (removed.get(c.id) ?? c))),
    duplicateDecisions: [...(data.duplicateDecisions ?? []).filter((d) => d.key !== key), decision],
    links: moved.links,
  };
  return commit(
    data,
    next,
    {
      commitments: suggestion.ids,
      duplicateDecisions: [key],
      ...(moved.touched.length ? { links: moved.touched } : {}),
    },
    {
      action: 'duplicate_merged',
      entity: 'duplicate',
      entityId: key,
      summary: `Merged duplicates into ${keep.nickname || keep.provider}`,
    },
    ctx,
  );
}

/** Explicit user action: "these are different". The pair is not suggested again. Undoable. */
export function dismissDuplicate(
  data: AppData,
  suggestion: Pick<DuplicateSuggestion, 'ids'>,
  ctx: MutationContext,
): MutationResult {
  const key = suggestionKey(suggestion.ids);
  const decision: DuplicateDecision = {
    key,
    ids: [...suggestion.ids],
    decision: 'dismissed',
    at: ctx.now,
  };
  const next: AppData = {
    ...data,
    duplicateDecisions: [...(data.duplicateDecisions ?? []).filter((d) => d.key !== key), decision],
  };
  return commit(
    data,
    next,
    { duplicateDecisions: [key] },
    {
      action: 'duplicate_dismissed',
      entity: 'duplicate',
      entityId: key,
      summary: 'Kept items separate',
    },
    ctx,
  );
}
