import { z } from 'zod';
import { addMinutes } from '../clock.js';
import { computeEntitlement } from '../consumer/entitlements.js';
import { one, withTransaction } from '../db.js';
import { encryptText } from '../intake/crypto.js';
import { parseMessage } from '../intake/parser.js';
import { activeTemplates } from '../intake/service.js';
import type { IdentityRow } from '../identities/service.js';
import { sha256 } from '../util.js';
import { getAttachment, getMessage, GoogleError, listMessages } from './google.js';
import { classifyMessage, extractMessage, MAX_BODY_CHARS } from './mime.js';
import { accessTokenFor, GMAIL_FEATURE, GmailStop, markScopeMismatch, requireGmailConfigured, SCAN_LOCK_STALE_MS, type GmailDeps } from './service.js';

/** Search terms (spec). Quoted phrases stay together; Gmail's `{a b}` means OR. */
export const SCAN_KEYWORDS = [
  'subscription',
  'renewal',
  'trial',
  'invoice',
  'bill',
  'EMI',
  'loan',
  'statement',
  'recharge',
  'payment',
  'due',
  'auto-renew',
  'mandate',
  'card',
  '"school fee"',
  'insurance',
  'utility',
];
export const SCAN_CATEGORIES = ['category:updates', 'category:promotions', 'category:personal'];
export const INITIAL_WINDOW_DAYS = 365;
export const MAX_MESSAGES_INITIAL = 500;
export const MAX_MESSAGES_INCREMENTAL = 300;
const MAX_PAGES_PER_QUERY = 10;
/** Encrypted excerpt length and retention (only when DATA_ENCRYPTION_KEY is set). */
export const EXCERPT_CHARS = 2000;
export const GMAIL_EXCERPT_RETENTION_DAYS = 3;

const SENDER_FILTER_RE = /^(?:[a-z0-9._%+-]+@)?[a-z0-9.-]+\.[a-z]{2,}$/;

/** Gmail search queries for one scan. Categories are never the only filter: a keyword-only query always runs. */
export function buildQueries(opts: { since: Date | null; senderFilters: string[] }): string[] {
  const window = opts.since ? `after:${Math.floor(opts.since.getTime() / 1000)}` : `newer_than:${INITIAL_WINDOW_DAYS}d`;
  const kw = `{${SCAN_KEYWORDS.join(' ')}}`;
  const queries = [`{${SCAN_CATEGORIES.join(' ')}} ${kw} ${window}`, `${kw} ${window}`];
  const senders = opts.senderFilters.map((s) => s.trim().toLowerCase()).filter((s) => SENDER_FILTER_RE.test(s));
  if (senders.length) queries.push(`{${senders.map((s) => `from:${s}`).join(' ')}} ${window}`);
  return queries;
}

export const ScanPayload = z.object({ identityId: z.string().uuid(), runId: z.string().uuid() });

export interface ScanSummary {
  status: 'succeeded' | 'cancelled' | 'skipped' | 'failed';
  code?: string;
  listed: number;
  fresh: number;
  events: number;
  duplicates: number;
  attachmentsSkipped: number;
}

function normaliseMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, '').toLowerCase();
}

/**
 * The `gmail.scan` job. Reads only (list + get); dedupes by (identity, Gmail id) and by normalised
 * fingerprint / RFC Message-ID across the account; writes review candidates (intake_type 'gmail').
 * Stops as soon as the identity is no longer active (disconnect, pause, error, deletion).
 */
export async function runGmailScan(deps: GmailDeps, rawPayload: unknown): Promise<ScanSummary> {
  const payload = ScanPayload.parse(rawPayload);
  const summary: ScanSummary = { status: 'succeeded', listed: 0, fresh: 0, events: 0, duplicates: 0, attachmentsSkipped: 0 };
  const { pool } = deps;
  const startedAt = deps.clock();

  const run = await one<{ id: string }>(
    pool,
    `UPDATE gmail_scan_runs SET status = 'running', started_at = $3, error_code = NULL
      WHERE id = $1 AND identity_id = $2 AND status IN ('queued','failed') RETURNING id`,
    [payload.runId, payload.identityId, startedAt],
  );
  if (!run) return { ...summary, status: 'cancelled', code: 'run_not_pending' };

  const finishRun = async (s: ScanSummary) => {
    await pool.query(
      `UPDATE gmail_scan_runs SET status = $2, finished_at = $3, error_code = $4, messages_listed = $5, messages_new = $6,
         events_created = $7, duplicates = $8, attachments_skipped = $9 WHERE id = $1 AND status = 'running'`,
      [payload.runId, s.status, deps.clock(), s.code ?? null, s.listed, s.fresh, s.events, s.duplicates, s.attachmentsSkipped],
    );
  };

  // Per-identity lock: one running scan per identity; only active identities are scanned.
  const ident = await one<IdentityRow>(
    pool,
    `UPDATE email_identities SET scan_running_since = $2
      WHERE id = $1 AND kind = 'gmail' AND status = 'active' AND (scan_running_since IS NULL OR scan_running_since < $3) RETURNING *`,
    [payload.identityId, startedAt, new Date(startedAt.getTime() - SCAN_LOCK_STALE_MS)],
  );
  if (!ident) {
    const cur = await one<{ status: string }>(pool, 'SELECT status FROM email_identities WHERE id = $1', [payload.identityId]);
    const s: ScanSummary = cur?.status === 'active' ? { ...summary, status: 'skipped', code: 'scan_in_progress' } : { ...summary, status: 'cancelled', code: 'identity_not_active' };
    await finishRun(s);
    return s;
  }

  const stillActive = async () => {
    const r = await one<{ status: string }>(pool, 'SELECT status FROM email_identities WHERE id = $1', [ident.id]);
    return r?.status === 'active';
  };
  const release = async (lastStatus: 'ok' | 'error' | 'cancelled', code: string | null, markScanned: boolean) => {
    await pool.query(
      `UPDATE email_identities SET scan_running_since = NULL, last_scan_status = $2, last_scan_error_code = $3,
         last_scan_at = CASE WHEN $4 THEN $5 ELSE last_scan_at END, updated_at = $6 WHERE id = $1`,
      [ident.id, lastStatus, code, markScanned, startedAt, deps.clock()],
    );
  };

  try {
    const g = requireGmailConfigured(deps.config);
    const ent = await computeEntitlement(pool, ident.account_id, startedAt);
    if (!ent.features.includes(GMAIL_FEATURE)) throw new GmailStop('premium_required');

    let token = await accessTokenFor(deps, ident.id);
    let refreshed = false;
    /** Runs one Gmail GET; on a 401 refreshes the token once and retries. */
    const withToken = async <T>(fn: (t: string) => Promise<T>): Promise<T> => {
      try {
        return await fn(token);
      } catch (err) {
        if (err instanceof GoogleError && err.code === 'unauthorized' && !refreshed) {
          refreshed = true;
          token = await accessTokenFor(deps, ident.id, true);
          return fn(token);
        }
        if (err instanceof GoogleError && err.code === 'scope_mismatch') {
          await markScopeMismatch(deps, ident.id);
          throw new GmailStop('scope_mismatch');
        }
        throw err;
      }
    };

    const incremental = ident.last_scan_status === 'ok' && ident.last_scan_at !== null;
    const since = incremental ? addMinutes(ident.last_scan_at!, -24 * 60) : null;
    const cap = incremental ? MAX_MESSAGES_INCREMENTAL : MAX_MESSAGES_INITIAL;
    const ids: string[] = [];
    const seenIds = new Set<string>();
    for (const q of buildQueries({ since, senderFilters: ident.sender_filters })) {
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES_PER_QUERY && ids.length < cap; page++) {
        const r = await withToken((t) => listMessages(g.endpoints.gmailApiBase, t, q, pageToken));
        for (const id of r.ids) {
          if (!seenIds.has(id) && ids.length < cap) {
            seenIds.add(id);
            ids.push(id);
          }
        }
        if (!r.nextPageToken) break;
        pageToken = r.nextPageToken;
      }
      if (ids.length >= cap) break;
    }
    summary.listed = ids.length;

    const templates = await activeTemplates(pool);
    const key = deps.config.dataEncryptionKey;
    for (const id of ids) {
      const known = await one(pool, 'SELECT 1 FROM gmail_messages_seen WHERE identity_id = $1 AND gmail_message_id = $2', [ident.id, id]);
      if (known) {
        summary.duplicates++;
        continue;
      }
      if (!(await stillActive())) throw new GmailStop('identity_not_active');
      let msg;
      try {
        msg = await withToken((t) => getMessage(g.endpoints.gmailApiBase, t, id));
      } catch (err) {
        if (err instanceof GoogleError && err.code === 'not_found') continue;
        throw err;
      }
      summary.fresh++;
      const ex = extractMessage(msg);
      let text = ex.text;
      if (ident.attachments_enabled) {
        for (const a of ex.readableAttachments) {
          if (text.length >= MAX_BODY_CHARS) break;
          const data = a.inlineData ?? (a.attachmentId ? await withToken((t) => getAttachment(g.endpoints.gmailApiBase, t, id, a.attachmentId!)) : null);
          if (data) text += `\n${Buffer.from(data, 'base64url').toString('utf8')}`.slice(0, MAX_BODY_CHARS - text.length);
        }
        summary.attachmentsSkipped += ex.attachmentCount - ex.readableAttachments.length;
      } else {
        summary.attachmentsSkipped += ex.attachmentCount;
      }
      const parsed = parseMessage({ text, subject: ex.subject, envelopeSenderDomain: ex.fromDomain }, templates);
      const cls = classifyMessage(ex.subject, parsed.redactedText, !parsed.unreadable);
      const messageIdHash = ex.rfcMessageId ? sha256(normaliseMessageId(ex.rfcMessageId)) : null;
      const now = deps.clock();
      const outcome = await withTransaction(pool, async (c) => {
        // Same per-account lock as forwarded-email ingest, so the two paths cannot double-insert one message.
        await c.query('SELECT pg_advisory_xact_lock(724190010, hashtext($1))', [`account:${ident.account_id}`]);
        const ins = await c.query(
          `INSERT INTO gmail_messages_seen (identity_id, gmail_message_id, fingerprint, seen_at) VALUES ($1,$2,$3,$4)
           ON CONFLICT (identity_id, gmail_message_id) DO NOTHING`,
          [ident.id, id, parsed.fingerprint, now],
        );
        if ((ins.rowCount ?? 0) === 0) return 'duplicate';
        if (cls === 'irrelevant') return 'irrelevant';
        const dup = await one(
          c,
          `SELECT 1 FROM user_events WHERE account_id = $1 AND review_status <> 'deleted'
             AND (message_fingerprint = $2 OR ($3::text IS NOT NULL AND message_id_hash = $3)) LIMIT 1`,
          [ident.account_id, parsed.fingerprint, messageIdHash],
        );
        if (dup) return 'duplicate';
        const excerpt = parsed.redactedText.trim().slice(0, EXCERPT_CHARS);
        const raw = key && excerpt ? encryptText(key, excerpt) : null;
        const internal = Number(msg.internalDate);
        const sourceMeta = {
          source: 'gmail',
          identityId: ident.id,
          gmailMessageId: id,
          fromDomain: ex.fromDomain,
          subjectHash: ex.subject ? sha256(ex.subject.trim().toLowerCase()) : null,
          date: Number.isFinite(internal) && internal > 0 ? new Date(internal).toISOString() : null,
          messageClass: cls,
          textSource: ex.textSource,
          attachmentsSkipped: ident.attachments_enabled ? ex.attachmentCount - ex.readableAttachments.length : ex.attachmentCount,
        };
        await c.query(
          `INSERT INTO user_events (account_id, identity_id, intake_type, message_fingerprint, message_id_hash, source_domain, extracted_fields,
              confidence, review_status, raw_text, raw_retention_until, parser_version, source_meta, created_at, updated_at)
           VALUES ($1,$2,'gmail',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)`,
          [
            ident.account_id,
            ident.id,
            parsed.fingerprint,
            messageIdHash,
            parsed.sourceDomain ?? ex.fromDomain,
            JSON.stringify(parsed.fields),
            JSON.stringify(parsed.confidence),
            parsed.unreadable ? 'unreadable' : 'needs_review',
            raw,
            raw ? addMinutes(now, GMAIL_EXCERPT_RETENTION_DAYS * 1440) : null,
            parsed.parserVersion,
            JSON.stringify(sourceMeta),
            now,
          ],
        );
        return 'created';
      });
      if (outcome === 'created') summary.events++;
      else if (outcome === 'duplicate') summary.duplicates++;
    }
    await release('ok', null, true);
    await finishRun(summary);
    deps.log?.info({ identityId: ident.id, listed: summary.listed, fresh: summary.fresh, events: summary.events }, 'gmail scan finished');
    return summary;
  } catch (err) {
    if (err instanceof GmailStop) {
      const s: ScanSummary = { ...summary, status: 'cancelled', code: err.code };
      await release(err.code === 'identity_not_active' ? 'cancelled' : 'error', err.code, false);
      await finishRun(s);
      deps.log?.warn({ identityId: ident.id, code: err.code }, 'gmail scan stopped');
      return s;
    }
    const code = err instanceof GoogleError ? err.code : 'internal_error';
    const s: ScanSummary = { ...summary, status: 'failed', code };
    await release('error', code, false);
    await finishRun(s);
    deps.log?.error({ identityId: ident.id, code }, 'gmail scan failed');
    // Transient Google/network errors are retried by the queue with backoff.
    if (err instanceof GoogleError && !err.retryable) return s;
    throw err;
  }
}
