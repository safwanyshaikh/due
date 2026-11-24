/**
 * Obligation → savings module. Matching order: canonical provider key, merchant aliases,
 * keywords, then (cards and loans only) a generic rule module with no aliases.
 * Verified modules win over research ones; retired modules never match.
 */
import { canonicalMerchant, merchantKey, normaliseMerchant } from '../merchants';
import type { Commitment } from '../types';
import type { SavingsModule } from './types';

export interface ModuleMatch {
  module: SavingsModule;
  via: 'canonical' | 'alias' | 'keyword' | 'generic';
}

function tokens(s: string): string[] {
  return normaliseMerchant(s).split(' ').filter(Boolean);
}

function containsRun(hay: string[], needle: string[]): boolean {
  if (!needle.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** Text Due may read to recognise an obligation: names only, never notes with numbers. */
function nameTokens(ob: Commitment): string[] {
  return tokens(
    `${ob.provider} ${ob.nickname} ${ob.loan?.loanType ?? ''} ${ob.loan?.lenderNickname ?? ''}`,
  );
}

const STATUS_RANK: Record<SavingsModule['status'], number> = {
  verified: 0,
  research: 1,
  retired: 9,
};

function better(
  a: { m: SavingsModule; len: number },
  b: { m: SavingsModule; len: number },
): boolean {
  if (a.len !== b.len) return a.len > b.len;
  return STATUS_RANK[a.m.status] < STATUS_RANK[b.m.status];
}

const GENERIC_KIND: Partial<Record<Commitment['type'], SavingsModule['valueKind']>> = {
  credit_card: 'debt_rate',
  emi: 'loan_switch',
  other_loan: 'loan_switch',
};

/** The module that describes this obligation, or null (→ a research need). */
export function matchModule(ob: Commitment, modules: SavingsModule[]): ModuleMatch | null {
  const live = modules.filter((m) => m.status !== 'retired');
  const name = nameTokens(ob);
  const canon =
    ob.canonicalProvider ?? canonicalMerchant(`${ob.provider} ${ob.nickname}`)?.key ?? null;
  let best: { m: SavingsModule; len: number; via: ModuleMatch['via'] } | null = null;
  const offer = (m: SavingsModule, len: number, via: ModuleMatch['via']) => {
    const cand = { m, len, via };
    if (!best || better(cand, best)) best = cand;
  };
  for (const m of live) {
    // An alias spelled exactly like the user's name for it is the strongest signal.
    for (const a of m.detect.merchantAliases) {
      const t = tokens(a);
      if (t.length && containsRun(name, t)) offer(m, 100 + t.length, 'alias');
    }
    for (const k of m.detect.keywords) {
      const t = tokens(k);
      if (t.length && containsRun(name, t)) offer(m, 50 + t.length, 'keyword');
    }
    if (canon && m.detect.merchantAliases.some((a) => merchantKey(a) === canon))
      offer(m, 10, 'canonical');
  }
  if (best) {
    const b = best as { m: SavingsModule; via: ModuleMatch['via'] };
    return { module: b.m, via: b.via };
  }
  const kind = GENERIC_KIND[ob.type];
  if (kind) {
    const generic = live
      .filter(
        (m) =>
          m.valueKind === kind &&
          m.detect.merchantAliases.length === 0 &&
          (m.category === 'card' || m.category === 'loan'),
      )
      .filter((m) => kind === 'debt_rate' || !m.detect.keywords.length)
      .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.id.localeCompare(b.id));
    if (generic[0]) return { module: generic[0], via: 'generic' };
  }
  return null;
}

/**
 * Whether an obligation is the product named by an `includes` key: the key is its module's id,
 * its canonical merchant key, or the key's words appear in its name.
 */
export function matchesKey(ob: Commitment, key: string, obModule: SavingsModule | null): boolean {
  const k = key.trim().toLowerCase();
  if (!k) return false;
  if (obModule && obModule.id.toLowerCase() === k) return true;
  const canon =
    ob.canonicalProvider ?? canonicalMerchant(`${ob.provider} ${ob.nickname}`)?.key ?? null;
  if (canon && canon === k) return true;
  const kt = tokens(k.replace(/[_-]+/g, ' '));
  if (!kt.length) return false;
  if (containsRun(nameTokens(ob), kt)) return true;
  // "jiohotstar" vs "jio hotstar"
  return nameTokens(ob).join('') === kt.join('');
}
