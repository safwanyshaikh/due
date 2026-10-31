import type { AuditActor } from '../audit.js';
import { writeAudit } from '../audit.js';
import { addMinutes } from '../clock.js';
import { many, one, withTransaction, type Pool, type PoolClient, type Queryable } from '../db.js';
import { badRequest, conflict, notFound } from '../http/errors.js';
import { enqueue } from '../queue/index.js';
import { canonicalJson, sha256 } from '../util.js';
import { checkSource, type MonitorContext } from './engine.js';
import { BUILTIN_PARSER_VERSION, observationFingerprint, parseObservation, ParserRules, type ObservationFields } from './parser.js';
import { computeStatus, type OfferStatus, type StatusResult } from './status.js';

/**
 * Offer intelligence engine (LAUNCH_SPEC "Offer intelligence operations").
 *
 * `offers.refresh` (one job per source) fetches through the robots-aware monitor, parses the page with the
 * source's active parser version, appends an observation when its fingerprint changed, and queues
 * price/eligibility/expiry/status differences for manual review. Nothing observed is applied automatically.
 * A failed refresh records only the attempt: the last good observation and offer values stay as they were.
 */

export interface OfferRow {
  id: string;
  provider: string;
  product_family: string;
  name: string;
  benefit_type: string;
  price_inr: number | null;
  billing_period: string | null;
  benefit_value: Record<string, unknown>;
  source_ids: string[];
  source_urls: string[];
  official_start_at: string | null;
  official_end_at: string | null;
  terms_status: string;
  page_status: string;
  computed_status: string;
  status_reason: string | null;
  status_changed_at: Date | null;
  confidence: string;
  notes: string[];
  details: Record<string, unknown>;
  verification_status: string;
  observed_at: Date | null;
  last_confirmed_at: Date | null;
  last_successful_check_at: Date | null;
  last_attempted_check_at: Date | null;
  last_check_error: string | null;
  freshness_window_hours: number;
  sku: string | null;
  geography: string | null;
  superseded_by: string | null;
  provider_family: string | null;
  updated_at: Date;
}

export type TransitionActor = { kind: 'system' } | { kind: 'admin'; userId: string | null; email?: string | null };

export function statusOf(o: OfferRow, now: Date): StatusResult {
  return computeStatus(o, now);
}

/** Records a computed-status change (append-only) and stores it on the offer. */
export async function recordTransition(
  c: Queryable,
  offerId: string,
  from: string | null,
  to: OfferStatus,
  reason: string,
  actor: TransitionActor,
  now: Date,
): Promise<void> {
  let email: string | null = null;
  if (actor.kind === 'admin') {
    email = actor.email ?? (actor.userId ? ((await one<{ email: string }>(c, 'SELECT email FROM users WHERE id = $1', [actor.userId]))?.email ?? null) : null);
  }
  await c.query(
    `INSERT INTO offer_status_transitions (offer_id, from_status, to_status, reason, actor, actor_user_id, actor_email, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [offerId, from, to, reason, actor.kind, actor.kind === 'admin' ? actor.userId : null, email, now],
  );
  await c.query(`UPDATE offers SET computed_status = $2, status_reason = $3, status_changed_at = $4 WHERE id = $1`, [offerId, to, reason, now]);
}

/** Recomputes one offer's status; records a transition when it changed (or only the reason when that changed). */
export async function recomputeOfferStatus(c: PoolClient, offerId: string, now: Date, actor: TransitionActor): Promise<{ changed: boolean; result: StatusResult } | null> {
  const o = await one<OfferRow>(c, 'SELECT * FROM offers WHERE id = $1 FOR UPDATE', [offerId]);
  if (!o) return null;
  const r = statusOf(o, now);
  if (r.status !== o.computed_status) {
    await recordTransition(c, o.id, o.computed_status, r.status, r.reason, actor, now);
    return { changed: true, result: r };
  }
  if (r.reason !== o.status_reason) await c.query('UPDATE offers SET status_reason = $2 WHERE id = $1', [o.id, r.reason]);
  return { changed: false, result: r };
}

/** Periodic stale-data policy: persists every status the rules now compute, with a transition row each. */
export async function recomputeAllStatuses(pool: Pool, now: Date): Promise<{ checked: number; transitions: number }> {
  const ids = (await many<{ id: string }>(pool, `SELECT id FROM offers WHERE verification_status <> 'rejected' ORDER BY id`)).map((r) => r.id);
  let transitions = 0;
  for (const id of ids) {
    const r = await withTransaction(pool, (c) => recomputeOfferStatus(c, id, now, { kind: 'system' }));
    if (r?.changed) transitions++;
  }
  return { checked: ids.length, transitions };
}

// ---- Parser versions ---------------------------------------------------------------------------------

export interface ParserChoice {
  id: number | null;
  version: string;
  rules: ParserRules;
}

/** The active parser for a source: a source-scoped version wins over a provider-scoped one; else built-in. */
export async function activeParser(q: Queryable, sourceId: string, provider: string): Promise<ParserChoice> {
  const row = await one<{ id: number; version: string; rules: unknown }>(
    q,
    `SELECT id, version, rules FROM parser_versions
      WHERE active AND (source_id = $1 OR (source_id IS NULL AND provider = $2))
      ORDER BY (source_id IS NOT NULL) DESC LIMIT 1`,
    [sourceId, provider],
  );
  if (!row) return { id: null, version: BUILTIN_PARSER_VERSION, rules: {} };
  const parsed = ParserRules.safeParse(row.rules);
  return { id: row.id, version: row.version, rules: parsed.success ? parsed.data : {} };
}

// ---- Change detection --------------------------------------------------------------------------------

export type ChangeKind = 'price' | 'eligibility' | 'expiry' | 'status' | 'new_offer';
export interface ProposedChange {
  kind: ChangeKind;
  proposed: Record<string, unknown>;
  current: Record<string, unknown>;
}

/** Differences between observed fields and the offer's current values. Unobserved (null) fields never count. */
export function proposeChanges(o: OfferRow, f: ObservationFields): ProposedChange[] {
  const out: ProposedChange[] = [];
  const add = (kind: ChangeKind, key: string, proposed: unknown, current: unknown) => {
    let item = out.find((x) => x.kind === kind);
    if (!item) out.push((item = { kind, proposed: {}, current: {} }));
    item.proposed[key] = proposed;
    item.current[key] = current;
  };
  const price = o.price_inr === null ? null : Number(o.price_inr);
  if (f.price !== null && f.price !== price) add('price', 'price', f.price, price);
  if (f.billing_period !== null && f.billing_period !== o.billing_period) add('price', 'billing_period', f.billing_period, o.billing_period);
  if (f.benefit_value) {
    const cur = o.benefit_value ?? {};
    const diff = Object.entries(f.benefit_value).filter(([k, v]) => canonicalJson(cur[k] ?? null) !== canonicalJson(v));
    if (diff.length) {
      add('eligibility', 'benefit_value', Object.fromEntries(diff), Object.fromEntries(diff.map(([k]) => [k, cur[k] ?? null])));
    }
  }
  if (f.official_start !== null && f.official_start !== o.official_start_at) add('expiry', 'official_start', f.official_start, o.official_start_at);
  if (f.official_end !== null && f.official_end !== o.official_end_at) add('expiry', 'official_end', f.official_end, o.official_end_at);
  if (f.page_status !== null && f.page_status !== o.page_status) add('status', 'page_status', f.page_status, o.page_status);
  if (f.terms_status !== null && f.terms_status !== o.terms_status) add('status', 'terms_status', f.terms_status, o.terms_status);
  return out;
}

async function queueReview(c: Queryable, offerId: string | null, observationId: number | null, sourceId: string | null, ch: ProposedChange, now: Date): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO offer_review_queue (offer_id, observation_id, source_id, change_kind, proposed, current, proposed_hash, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT ((COALESCE(offer_id, '')), change_kind, proposed_hash) WHERE status = 'pending' DO NOTHING`,
    [offerId, observationId, sourceId, ch.kind, JSON.stringify(ch.proposed), JSON.stringify(ch.current), sha256(canonicalJson(ch.proposed)), now],
  );
  return (r.rowCount ?? 0) > 0;
}

// ---- Refresh -----------------------------------------------------------------------------------------

export interface RefreshResult {
  sourceId: string;
  ok: boolean;
  fetchOutcome: string;
  error: string | null;
  /** True when the failure will not go away on retry (robots disallow, monitoring disabled). */
  permanent: boolean;
  offers: number;
  observationsAdded: number;
  reviewsQueued: number;
  transitions: number;
}

interface SourceInfo {
  id: string;
  url: string;
  source_category: string;
}

/** Refreshes every live offer that cites one source. Never deletes or rewrites an observation. */
export async function refreshOfferSource(ctx: MonitorContext, sourceId: string): Promise<RefreshResult> {
  const src = await one<SourceInfo>(ctx.pool, 'SELECT id, url, source_category FROM sources WHERE id = $1', [sourceId]);
  if (!src) throw notFound('Source not found');
  const result: RefreshResult = { sourceId, ok: false, fetchOutcome: 'error', error: null, permanent: false, offers: 0, observationsAdded: 0, reviewsQueued: 0, transitions: 0 };
  const offerIds = (
    await many<{ id: string }>(
      ctx.pool,
      `SELECT id FROM offers WHERE $1 = ANY(source_ids) AND verification_status <> 'rejected' AND superseded_by IS NULL ORDER BY id`,
      [sourceId],
    )
  ).map((r) => r.id);
  result.offers = offerIds.length;

  const check = await checkSource(ctx, sourceId, { mode: 'run' });
  result.fetchOutcome = check.outcome;
  const gone = check.outcome === 'error' && (check.httpStatus === 404 || check.httpStatus === 410);
  const fetched = check.outcome === 'changed' || check.outcome === 'unchanged' || check.outcome === 'not_modified';
  const now = ctx.clock();

  if (!fetched && !gone) {
    result.error = check.error ?? check.outcome;
    result.permanent = check.outcome === 'skipped_robots' || check.outcome === 'skipped_disabled';
    // Record the attempt only: last_successful_check_at, observations and offer values are kept.
    await ctx.pool.query(
      `UPDATE offers SET last_attempted_check_at = $2, last_check_error = $3 WHERE id = ANY($1)`,
      [offerIds, now, `${src.url}: ${result.error}`.slice(0, 1000)],
    );
    return result;
  }

  let text: string | null = null;
  let contentHash: string | null = null;
  let snapshotId: number | null = null;
  if (fetched) {
    const snap = await one<{ id: number; content_hash: string; text_content: string | null }>(
      ctx.pool,
      'SELECT id, content_hash, text_content FROM snapshots WHERE source_id = $1 ORDER BY id DESC LIMIT 1',
      [sourceId],
    );
    text = snap?.text_content ?? null;
    contentHash = check.contentHash ?? snap?.content_hash ?? null;
    snapshotId = snap?.id ?? null;
  }

  for (const offerId of offerIds) {
    await withTransaction(ctx.pool, async (c) => {
      const o = await one<OfferRow>(c, 'SELECT * FROM offers WHERE id = $1 FOR UPDATE', [offerId]);
      if (!o) return;
      const parser = await activeParser(c, sourceId, o.provider);
      const fields = parseObservation({ offerId, sourceCategory: src.source_category, httpStatus: gone ? check.httpStatus : 200, text, rules: parser.rules });
      const fingerprint = observationFingerprint(fields);
      const last = await one<{ fingerprint: string }>(
        c,
        'SELECT fingerprint FROM offer_observations WHERE offer_id = $1 AND source_id = $2 ORDER BY id DESC LIMIT 1',
        [offerId, sourceId],
      );
      let queued = 0;
      if (last?.fingerprint !== fingerprint) {
        const obs = await one<{ id: number }>(
          c,
          `INSERT INTO offer_observations (offer_id, source_id, source_url, observed_at, parser_version_id, parser_version, fingerprint,
                                           fields, content_hash, snapshot_id, http_status, origin)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'engine') RETURNING id`,
          [offerId, sourceId, src.url, now, parser.id, parser.version, fingerprint, JSON.stringify(fields), contentHash, snapshotId, check.httpStatus],
        );
        result.observationsAdded++;
        for (const ch of proposeChanges(o, fields)) if (await queueReview(c, offerId, obs!.id, sourceId, ch, now)) queued++;
        result.reviewsQueued += queued;
      }
      const pendingFromSource = Number(
        (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM offer_review_queue WHERE offer_id = $1 AND source_id = $2 AND status = 'pending'`, [offerId, sourceId]))
          .rows[0]!.n,
      );
      await c.query(
        // Clear only this source's error: another source of the same offer may still be failing.
        `UPDATE offers SET last_successful_check_at = $2, last_attempted_check_at = $2,
                last_check_error = CASE WHEN starts_with(last_check_error, $4) THEN NULL ELSE last_check_error END,
                last_confirmed_at = CASE WHEN $3 THEN $2 ELSE last_confirmed_at END WHERE id = $1`,
        [offerId, now, pendingFromSource === 0, `${src.url}: `],
      );
      const st = await recomputeOfferStatus(c, offerId, now, { kind: 'system' });
      if (st?.changed) result.transitions++;
    });
  }
  result.ok = true;
  return result;
}

/** Scheduler step: one `offers.refresh` job per due source that live offers cite (source cadence = frequency_minutes). */
export async function enqueueDueOfferRefreshes(pool: Pool, now: Date, config: Record<string, unknown> = {}): Promise<Record<string, number>> {
  const limit = Math.min(Math.max(Number(config.batch_size ?? 50) || 50, 1), 500);
  const due = await many<{ id: string; frequency_minutes: number }>(
    pool,
    `SELECT s.id, s.frequency_minutes FROM sources s JOIN companies c ON c.id = s.company_id
      WHERE s.enabled AND c.monitoring_enabled AND c.status = 'active'
        AND (s.offer_next_refresh_at IS NULL OR s.offer_next_refresh_at <= $1)
        AND EXISTS (SELECT 1 FROM offers o WHERE s.id = ANY(o.source_ids) AND o.verification_status <> 'rejected' AND o.superseded_by IS NULL)
      ORDER BY s.offer_next_refresh_at ASC NULLS FIRST, s.id LIMIT $2`,
    [now, limit],
  );
  let enqueued = 0;
  for (const s of due) {
    const slot = Math.floor(now.getTime() / (s.frequency_minutes * 60_000));
    const r = await enqueue(pool, { type: 'offers.refresh', payload: { sourceId: s.id }, idempotencyKey: `offers.refresh:${s.id}:${slot}`, maxAttempts: 3, now });
    if (!r.deduped) enqueued++;
    await pool.query('UPDATE sources SET offer_next_refresh_at = $2 WHERE id = $1', [s.id, addMinutes(now, s.frequency_minutes)]);
  }
  return { due: due.length, enqueued };
}

/** Manual "refresh now" for one offer: one job per cited source (deduped per minute). */
export async function enqueueOfferRefresh(pool: Pool, offerId: string, now: Date): Promise<{ jobs: { sourceId: string; jobId: string; deduped: boolean }[] }> {
  const o = await one<{ source_ids: string[] }>(pool, 'SELECT source_ids FROM offers WHERE id = $1', [offerId]);
  if (!o) throw notFound('Offer not found');
  if (o.source_ids.length === 0) throw badRequest('This offer cites no monitored source; add the URL as a source first');
  const minute = now.toISOString().slice(0, 16);
  const jobs = [];
  for (const sourceId of o.source_ids) {
    const r = await enqueue(pool, { type: 'offers.refresh', payload: { sourceId }, idempotencyKey: `offers.refresh:${sourceId}:manual:${minute}`, maxAttempts: 3, now });
    jobs.push({ sourceId, jobId: r.id, deduped: r.deduped });
  }
  return { jobs };
}

// ---- Review decisions ----------------------------------------------------------------------------------

interface ReviewRow {
  id: number;
  offer_id: string | null;
  change_kind: ChangeKind;
  proposed: Record<string, unknown>;
  current: Record<string, unknown>;
  status: string;
}

const FIELD_COLUMNS: Record<string, string> = {
  price: 'price_inr',
  billing_period: 'billing_period',
  official_start: 'official_start_at',
  official_end: 'official_end_at',
  page_status: 'page_status',
  terms_status: 'terms_status',
};

/** Approve applies the proposed values to the offer (audited, with a status transition); reject records the decision. */
export async function decideReview(
  pool: Pool,
  id: number,
  decision: 'approved' | 'rejected',
  note: string | null,
  actor: AuditActor,
  now: Date,
): Promise<{ review: Record<string, unknown>; offer: OfferRow | null }> {
  return withTransaction(pool, async (c) => {
    const rv = await one<ReviewRow>(c, 'SELECT * FROM offer_review_queue WHERE id = $1 FOR UPDATE', [id]);
    if (!rv) throw notFound('Review item not found');
    if (rv.status !== 'pending') throw conflict(`This change was already ${rv.status}`);
    let offer: OfferRow | null = null;
    if (decision === 'approved') {
      if (rv.change_kind === 'new_offer') {
        offer = await createOfferFromProposal(c, rv.proposed, now);
      } else {
        const before = await one<OfferRow>(c, 'SELECT * FROM offers WHERE id = $1 FOR UPDATE', [rv.offer_id]);
        if (!before) throw notFound('Offer not found');
        const sets: string[] = [];
        const values: unknown[] = [before.id];
        for (const [k, v] of Object.entries(rv.proposed)) {
          if (k === 'benefit_value') {
            values.push(JSON.stringify({ ...(before.benefit_value ?? {}), ...(v as Record<string, unknown>) }));
            sets.push(`benefit_value = $${values.length}`);
          } else if (FIELD_COLUMNS[k]) {
            values.push(v);
            sets.push(`${FIELD_COLUMNS[k]} = $${values.length}`);
          }
        }
        if (sets.length === 0) throw badRequest('Nothing to apply in this change');
        values.push(now);
        sets.push(`updated_at = $${values.length}`, `last_confirmed_at = $${values.length}`);
        offer = await one<OfferRow>(c, `UPDATE offers SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, values);
        await writeAudit(c, actor, 'offer.review.apply', 'offer', before.id, before, offer);
      }
      await recomputeOfferStatus(c, offer!.id, now, { kind: 'admin', userId: actor.userId });
      offer = await one<OfferRow>(c, 'SELECT * FROM offers WHERE id = $1', [offer!.id]);
    }
    const review = await one(
      c,
      `UPDATE offer_review_queue SET status = $2, decided_by = $3, decided_at = $4, note = $5 WHERE id = $1 RETURNING *`,
      [id, decision, actor.userId, now, note],
    );
    await writeAudit(c, actor, `offer.review.${decision === 'approved' ? 'approve' : 'reject'}`, 'offer_review', id, rv, review);
    return { review: review!, offer };
  });
}

async function createOfferFromProposal(c: PoolClient, p: Record<string, unknown>, now: Date): Promise<OfferRow> {
  const str = (k: string) => (typeof p[k] === 'string' && (p[k] as string).trim() ? (p[k] as string).trim() : null);
  const id = str('id');
  const urls = Array.isArray(p.source_urls) ? (p.source_urls as unknown[]).filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)) : [];
  if (!id || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(id) || !str('provider') || !str('product_family') || !str('name') || !str('benefit_type') || urls.length === 0) {
    throw badRequest('A new-offer proposal needs id, provider, product_family, name, benefit_type and source_urls');
  }
  if (await one(c, 'SELECT id FROM offers WHERE id = $1', [id])) throw conflict('Offer id already exists');
  const ids = (await c.query<{ id: string }>('SELECT id FROM sources WHERE url = ANY($1)', [urls])).rows.map((r) => r.id);
  return (await one<OfferRow>(
    c,
    `INSERT INTO offers (id, provider, product_family, name, benefit_type, price_inr, billing_period, source_ids, source_urls,
                         verification_status, observed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$10) RETURNING *`,
    [id, str('provider'), str('product_family'), str('name'), str('benefit_type'), typeof p.price === 'number' ? p.price : null, str('billing_period'), ids, urls, now],
  ))!;
}
