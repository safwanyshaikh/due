/**
 * Value vs provenance helpers, and the bridge between v1 flat fields and v2 tracked fields.
 *
 * v2 fields (`amount`, `date`, `rule`) are authoritative. The v1 flat fields (`amountPaise`,
 * `amountConfidence`, `nextDue`, `dueConfidence`, `frequency`, `intervalMonths`,
 * `remainingOccurrences`) are kept as mirrors so older screens keep working. If something
 * edits only the flat fields (an older form), `reconcileObligation` rebuilds the v2 fields from
 * them; v2 mutations always rewrite the mirrors via `withMirrors`.
 */
import { canonicalMerchant } from './merchants';
import { cadenceMonths, rules, ruleAnchor, type RecurrenceRule } from './recurrence';
import type {
  Commitment,
  CommitmentV1,
  Confidence,
  Frequency,
  ISODate,
  Provenance,
  SourceKind,
  Tracked,
  ValueConfidence,
} from './types';

export const SOURCE_LABELS: Record<SourceKind, string> = {
  manual: 'Entered by you',
  csv: 'CSV import',
  email_forward: 'Forwarded email',
  statement: 'Statement import',
  calendar: 'Calendar',
};

export const CONFIDENCE_LABELS: Record<ValueConfidence, string> = {
  confirmed: 'Confirmed',
  estimated: 'Estimated',
  user_entered: 'Entered by you',
  imported: 'Imported',
};

export function manualSource(label = SOURCE_LABELS.manual): Provenance {
  return { kind: 'manual', label };
}

export function tracked<T>(
  value: T,
  confidence: ValueConfidence,
  source: Provenance,
  updatedAt: string,
): Tracked<T> {
  return { value, confidence, source, updatedAt };
}

/** v1 → v2 confidence. 'unknown' has no v2 equivalent; it is treated as an estimate. */
export function fromLegacyConfidence(
  c: Confidence,
  source: Commitment['source'] = 'manual',
): ValueConfidence {
  if (c === 'confirmed') return 'confirmed';
  return source === 'csv_import' ? 'imported' : 'estimated';
}

/** v2 → v1 confidence mirror. */
export function toLegacyConfidence(t: Tracked<unknown>): Confidence {
  if (t.value === null) return 'unknown';
  return t.confidence === 'confirmed' || t.confidence === 'user_entered' ? 'confirmed' : 'estimate';
}

export function legacySourceToProvenance(
  c: Pick<CommitmentV1, 'source' | 'createdAt'>,
): Provenance {
  return c.source === 'csv_import'
    ? { kind: 'csv', label: SOURCE_LABELS.csv, importedAt: c.createdAt }
    : manualSource();
}

/** Rule from v1 frequency fields. Invalid custom intervals become one-time (as v1 treated them). */
export function ruleFromLegacy(
  c: Pick<CommitmentV1, 'frequency' | 'intervalMonths' | 'nextDue' | 'remainingOccurrences'>,
): RecurrenceRule {
  const count = c.remainingOccurrences ?? null;
  const bounded = <T extends RecurrenceRule>(r: T): T =>
    count === null ? r : ({ ...r, count } as T);
  switch (c.frequency) {
    case 'monthly':
      return bounded(rules.monthly(c.nextDue));
    case 'quarterly':
      return bounded(rules.quarterly(c.nextDue));
    case 'half_yearly':
      return bounded(rules.halfYearly(c.nextDue));
    case 'annual':
      return bounded(rules.annual(c.nextDue));
    case 'custom_months':
      return c.intervalMonths && c.intervalMonths >= 1
        ? bounded(rules.customMonths(c.nextDue, Math.floor(c.intervalMonths)))
        : rules.oneTime(c.nextDue);
    default:
      return rules.oneTime(c.nextDue);
  }
}

/** Closest v1 frequency for a v2 rule (display mirror only). */
export function legacyFrequency(rule: RecurrenceRule): {
  frequency: Frequency;
  intervalMonths: number | null;
} {
  switch (rule.kind) {
    case 'monthly':
    case 'quarterly':
    case 'half_yearly':
    case 'annual':
      return { frequency: rule.kind, intervalMonths: null };
    case 'custom_months':
      return { frequency: 'custom_months', intervalMonths: rule.intervalMonths };
    case 'trial_to_paid':
      return legacyFrequency(rule.paid);
    case 'end_of_month':
    case 'weekday': {
      const m = cadenceMonths(rule);
      if (m === null) return { frequency: 'one_time', intervalMonths: null };
      const r = Math.max(1, Math.round(m));
      return r === 1
        ? { frequency: 'monthly', intervalMonths: null }
        : { frequency: 'custom_months', intervalMonths: r };
    }
    default:
      return { frequency: 'one_time', intervalMonths: null };
  }
}

function ruleCount(rule: RecurrenceRule): number | null {
  if (rule.kind === 'trial_to_paid') return ruleCount(rule.paid);
  if (rule.kind === 'one_time' || rule.kind === 'irregular') return null;
  return rule.count ?? null;
}

type MirrorFields = Pick<
  Commitment,
  | 'amountPaise'
  | 'amountConfidence'
  | 'nextDue'
  | 'dueConfidence'
  | 'frequency'
  | 'intervalMonths'
  | 'remainingOccurrences'
>;

/** v1 mirror values derived from the v2 fields. */
export function mirrorsOf(c: Commitment): MirrorFields {
  const f = legacyFrequency(c.rule);
  return {
    amountPaise: c.amount.value,
    amountConfidence: toLegacyConfidence(c.amount),
    nextDue: ruleAnchor(c.rule) ?? c.nextDue,
    dueConfidence: toLegacyConfidence(c.date),
    frequency: f.frequency,
    intervalMonths: f.intervalMonths,
    remainingOccurrences: ruleCount(c.rule),
  };
}

function fingerprint(m: MirrorFields): string {
  return JSON.stringify([
    m.amountPaise,
    m.amountConfidence,
    m.nextDue,
    m.dueConfidence,
    m.frequency,
    m.frequency === 'custom_months' ? (m.intervalMonths ?? null) : null,
    m.remainingOccurrences ?? null,
  ]);
}

/** Rewrites the v1 mirrors from the v2 fields. Call after every v2 change. */
export function withMirrors(c: Commitment): Commitment {
  return { ...c, ...mirrorsOf(c) };
}

function hasV2(c: Partial<Commitment>): c is Commitment {
  return !!(c.amount && c.date && c.rule && Array.isArray(c.overrides) && Array.isArray(c.history));
}

/**
 * Lossless v1 → v2 upgrade of one record. All v1 fields are kept as they were; v2 fields
 * are added from them. Records that already have v2 fields are reconciled instead.
 */
export function upgradeCommitment(c: CommitmentV1 | Commitment): Commitment {
  if (hasV2(c)) return reconcileObligation(c);
  const at = c.updatedAt || c.createdAt;
  const source = legacySourceToProvenance(c);
  return {
    ...c,
    canonicalProvider: canonicalMerchant(c.provider)?.key ?? null,
    amount: tracked(c.amountPaise, fromLegacyConfidence(c.amountConfidence, c.source), source, at),
    date: tracked(c.nextDue, fromLegacyConfidence(c.dueConfidence, c.source), source, at),
    rule: ruleFromLegacy(c),
    overrides: [],
    history: [],
    pendingChanges: [],
    deletedAt: null,
    mergedInto: null,
  };
}

const memo = new WeakMap<Commitment, Commitment>();

/**
 * If the v1 flat fields were edited without the v2 fields (older screens), rebuild the v2
 * fields from them (as user-entered values). Otherwise returns the same object. Pure; memoised.
 */
export function reconcileObligation(c: Commitment): Commitment {
  const hit = memo.get(c);
  if (hit) return hit;
  let out = c;
  if (!hasV2(c)) {
    out = upgradeCommitment(c);
  } else if (fingerprint(c) !== fingerprint(mirrorsOf(c))) {
    const m = mirrorsOf(c);
    const at = c.updatedAt;
    const next: Commitment = { ...c };
    if (c.amountPaise !== m.amountPaise || c.amountConfidence !== m.amountConfidence) {
      // An older form edited the flat fields: the person typed this value.
      const conf: ValueConfidence = c.amountConfidence === 'confirmed' ? 'confirmed' : 'estimated';
      next.amount =
        c.amountPaise === c.amount.value && toLegacyConfidence(c.amount) === c.amountConfidence
          ? c.amount
          : c.amountPaise === c.amount.value && conf === c.amount.confidence
            ? c.amount
            : tracked(c.amountPaise, conf, manualSource(), at);
    }
    const ruleChanged =
      c.nextDue !== m.nextDue ||
      c.frequency !== m.frequency ||
      (c.frequency === 'custom_months' && (c.intervalMonths ?? null) !== m.intervalMonths) ||
      (c.remainingOccurrences ?? null) !== m.remainingOccurrences;
    if (ruleChanged) next.rule = ruleFromLegacy(c);
    if (ruleChanged || c.dueConfidence !== m.dueConfidence) {
      const conf: ValueConfidence = c.dueConfidence === 'confirmed' ? 'confirmed' : 'estimated';
      next.date =
        c.nextDue === c.date.value && conf === c.date.confidence
          ? c.date
          : tracked(c.nextDue, conf, manualSource(), at);
    }
    out = next;
  }
  if (out.canonicalProvider === undefined) {
    out = { ...out, canonicalProvider: canonicalMerchant(out.provider)?.key ?? null };
  }
  memo.set(c, out);
  return out;
}

/** Fresh v2 fields for a manual record. */
export function manualV2Fields(
  nextDue: ISODate,
  amountPaise: number | null,
  now: string,
  confidence: ValueConfidence = 'user_entered',
): Pick<
  Commitment,
  | 'amount'
  | 'date'
  | 'rule'
  | 'overrides'
  | 'history'
  | 'pendingChanges'
  | 'deletedAt'
  | 'mergedInto'
> {
  return {
    amount: tracked(amountPaise, confidence, manualSource(), now),
    date: tracked(nextDue, confidence, manualSource(), now),
    rule: rules.monthly(nextDue),
    overrides: [],
    history: [],
    pendingChanges: [],
    deletedAt: null,
    mergedInto: null,
  };
}
