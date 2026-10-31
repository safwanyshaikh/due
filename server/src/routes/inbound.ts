import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { consentWithdrawn } from '../consumer/consents.js';
import { computeEntitlement } from '../consumer/entitlements.js';
import { withTransaction, one } from '../db.js';
import { AppError } from '../http/errors.js';
import { ALIAS_RE, MAX_EVENTS_PER_DAY, messageIdHashOf, ownerWhere, type Owner } from '../intake/service.js';
import { metrics } from '../observability/metrics.js';
import { enqueue } from '../queue/index.js';
import { sealInbound } from '../queue/handlers.js';
import { safeEqual } from '../util.js';

export interface InboundMessage {
  provider: 'postmark' | 'mailgun';
  recipients: string[];
  from: string | null;
  subject: string | null;
  messageId: string | null;
  text: string;
}

/** Largest message text accepted for parsing (attachments are never stored). */
export const MAX_INBOUND_TEXT_BYTES = 512 * 1024;

/** Requests per IP and minute that may name an unknown alias before the webhook answers 429. */
export const UNKNOWN_ALIAS_LIMIT_PER_MIN = 30;

/** Fixed one-minute window counter per IP for deliveries addressed to unknown aliases (alias probing). */
export class UnknownAliasLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();
  constructor(private readonly limit = UNKNOWN_ALIAS_LIMIT_PER_MIN) {}
  /** Records one unknown-alias hit; returns false once the IP is over the limit for the current minute. */
  hit(ip: string, nowMs: number): boolean {
    const cur = this.hits.get(ip);
    if (!cur || nowMs - cur.windowStart >= 60_000) {
      if (this.hits.size > 10_000) this.prune(nowMs);
      this.hits.set(ip, { windowStart: nowMs, count: 1 });
      return true;
    }
    cur.count++;
    return cur.count <= this.limit;
  }
  private prune(nowMs: number) {
    for (const [ip, v] of this.hits) if (nowMs - v.windowStart >= 60_000) this.hits.delete(ip);
  }
}

function hexEqual(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a.toLowerCase(), 'hex'), Buffer.from(b.toLowerCase(), 'hex'));
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8377;|&#x20b9;/gi, '₹')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n');
}

function emails(s: unknown): string[] {
  if (typeof s !== 'string') return [];
  return [...s.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => m[0].toLowerCase());
}

/** Postmark inbound JSON -> InboundMessage. */
export function fromPostmark(b: Record<string, unknown>): InboundMessage {
  const full = (k: string) => (Array.isArray(b[k]) ? (b[k] as { Email?: string }[]).map((x) => x.Email ?? '').join(',') : '');
  const headers = Array.isArray(b.Headers) ? (b.Headers as { Name?: string; Value?: string }[]) : [];
  const mid = headers.find((h) => h.Name?.toLowerCase() === 'message-id')?.Value ?? (typeof b.MessageID === 'string' ? b.MessageID : null);
  const text = typeof b.TextBody === 'string' && b.TextBody.trim() ? b.TextBody : typeof b.HtmlBody === 'string' ? htmlToText(b.HtmlBody) : '';
  return {
    provider: 'postmark',
    recipients: [...new Set([...emails(b.OriginalRecipient), ...emails(b.To), ...emails(full('ToFull')), ...emails(full('CcFull')), ...emails(full('BccFull'))])],
    from: emails((b.FromFull as { Email?: string } | undefined)?.Email ?? b.From)[0] ?? null,
    subject: typeof b.Subject === 'string' ? b.Subject : null,
    messageId: mid,
    text,
  };
}

/** Mailgun routes (form fields) -> InboundMessage. */
export function fromMailgun(f: Record<string, string>): InboundMessage {
  const text = f['body-plain']?.trim() ? f['body-plain'] : f['body-html'] ? htmlToText(f['body-html']) : '';
  return {
    provider: 'mailgun',
    recipients: [...new Set([...emails(f.recipient), ...emails(f.To)])],
    from: emails(f.sender ?? f.from)[0] ?? null,
    subject: f.subject ?? f.Subject ?? null,
    messageId: f['Message-Id'] ?? f['message-id'] ?? null,
    text,
  };
}

/** Minimal multipart/form-data reader for text fields (file parts are skipped and never stored). */
export function parseMultipart(body: Buffer, contentType: string): Record<string, string> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return {};
  const boundary = `--${m[1] ?? m[2]}`;
  const out: Record<string, string> = {};
  for (const part of body.toString('utf8').split(boundary)) {
    const idx = part.indexOf('\r\n\r\n');
    if (idx < 0) continue;
    const head = part.slice(0, idx);
    const name = /name="([^"]*)"/i.exec(head)?.[1];
    if (!name || /filename=/i.test(head)) continue;
    out[name] = part.slice(idx + 4).replace(/\r\n$/, '');
  }
  return out;
}

/**
 * Provider-agnostic inbound e-mail webhook. Authenticated by HTTP Basic (password = INBOUND_WEBHOOK_SECRET,
 * Postmark), Mailgun's timestamp/token signature (signing key = secret) or X-Due-Signature (HMAC of raw body).
 * Routes only by the unique alias of a Plus account, stores a minimal sealed message, dedupes by Message-ID and
 * enqueues inbound.parse (which also dedupes by fingerprint). Never follows links and never replies.
 */
export async function inboundRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock, config } = app.deps;
  const unknownAliases = new UnknownAliasLimiter();

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    req.rawBody = text;
    done(null, Object.fromEntries(new URLSearchParams(text)));
  });
  app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, parseMultipart(body as Buffer, String(req.headers['content-type'] ?? '')));
  });

  function authenticated(req: FastifyRequest, secret: string, fields: Record<string, unknown>): boolean {
    const auth = req.headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Basic ')) {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const pass = decoded.slice(decoded.indexOf(':') + 1);
      if (decoded.includes(':') && safeEqual(pass, secret)) return true;
    }
    const sigHeader = req.headers['x-due-signature'];
    if (typeof sigHeader === 'string' && req.rawBody !== null) {
      if (hexEqual(sigHeader, createHmac('sha256', secret).update(req.rawBody).digest('hex'))) return true;
    }
    const { timestamp, token, signature } = fields as { timestamp?: unknown; token?: unknown; signature?: unknown };
    if (typeof timestamp === 'string' && typeof token === 'string' && typeof signature === 'string') {
      const ts = Number(timestamp);
      const fresh = Number.isFinite(ts) && Math.abs(clock().getTime() / 1000 - ts) <= 15 * 60;
      if (fresh && hexEqual(signature, createHmac('sha256', secret).update(timestamp + token).digest('hex'))) return true;
    }
    return false;
  }

  app.post('/api/inbound/email', { bodyLimit: 15 * 1024 * 1024, config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!config.inboundWebhookSecret || !config.inboundEmailDomain) {
      throw new AppError(503, 'intake_unavailable', 'Inbound email is not configured on this server');
    }
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    if (!authenticated(req, config.inboundWebhookSecret, body)) {
      metrics.inc('inbound.rejected', { reason: 'invalid_signature' });
      throw new AppError(401, 'invalid_signature', 'Webhook authentication failed');
    }
    const ct = String(req.headers['content-type'] ?? '');
    const msg = ct.includes('application/json') ? fromPostmark(body) : fromMailgun(body as Record<string, string>);
    // Mailgun stops retrying on 406; Postmark on 403.
    const rejectCode = msg.provider === 'mailgun' ? 406 : 403;
    const reject = (code: string, message: string) => reply.code(rejectCode).send({ error: { code, message } });

    const domain = config.inboundEmailDomain;
    const local = msg.recipients
      .filter((r) => r.endsWith(`@${domain}`))
      .map((r) => r.slice(0, r.indexOf('@')).split('+')[0]!)
      .find((l) => ALIAS_RE.test(l));
    const now = clock();
    const unknown = () => {
      if (!unknownAliases.hit(req.ip, now.getTime())) {
        req.log.warn({ ip: req.ip }, 'inbound email: too many unknown aliases from this IP');
        reply.header('Retry-After', '60');
        return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many messages for unknown recipients' } });
      }
      return reject('alias_rejected', 'Unknown recipient');
    };
    if (!local) return unknown();
    const alias = await one<{ id: string; status: string; account_id: string | null }>(
      pool,
      `SELECT a.id, a.status, a.account_id FROM intake_aliases a WHERE a.alias = $1`,
      [local],
    );
    if (!alias) return unknown();
    if (alias.status !== 'active') return reject('alias_rejected', 'Unknown or paused recipient');
    // Forwarding belongs to signed-in Plus accounts; guest (temporary) aliases issued earlier no longer route.
    if (!alias.account_id) return reject('alias_rejected', 'Unknown or expired recipient');
    const accountId = alias.account_id;
    const ent = await computeEntitlement(pool, accountId, now);
    if (!ent.features.includes('email_import')) {
      metrics.inc('inbound.rejected', { reason: 'premium_required' });
      return reject('premium_required', 'Email forwarding needs a Plus plan');
    }
    if (await consentWithdrawn(pool, accountId, 'forwarding')) return reject('consent_withdrawn', 'Forwarding consent was withdrawn');
    if (Buffer.byteLength(msg.text, 'utf8') > MAX_INBOUND_TEXT_BYTES) {
      metrics.inc('inbound.rejected', { reason: 'too_large' });
      return reject('message_too_large', 'Message text is too large');
    }
    const owner: Owner = { kind: 'account', id: accountId };
    const recent = (
      await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM user_events WHERE ${ownerWhere(owner, 1)} AND created_at > $2`, [
        owner.id,
        new Date(now.getTime() - 86_400_000),
      ])
    ).rows[0]!.n;
    if (recent >= MAX_EVENTS_PER_DAY) return reject('quota_exceeded', 'Daily intake limit reached');

    // Store the minimal message (sealed) and parse it on the queue; the webhook never parses inline.
    const out = await withTransaction(pool, async (c) => {
      const ins = await c.query<{ id: string }>(
        `INSERT INTO inbound_messages (alias_id, account_id, provider, message_id_hash, sender_domain, body, status, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,'received',$7)
         ON CONFLICT (account_id, message_id_hash) WHERE message_id_hash IS NOT NULL DO NOTHING RETURNING id`,
        [
          alias.id,
          accountId,
          msg.provider,
          messageIdHashOf(msg.messageId),
          msg.from ? msg.from.slice(msg.from.indexOf('@') + 1) : null,
          sealInbound(config.dataEncryptionKey, { subject: msg.subject, text: msg.text }),
          now,
        ],
      );
      const row = ins.rows[0];
      if (!row) return { duplicate: true as const, inboundMessageId: null, jobId: null };
      const job = await enqueue(c, {
        type: 'inbound.parse',
        payload: { inboundMessageId: row.id },
        accountId,
        idempotencyKey: `inbound.parse:${row.id}`,
        correlationId: req.id,
        now,
      });
      return { duplicate: false as const, inboundMessageId: row.id, jobId: job.id };
    });
    metrics.inc('inbound.received', { duplicate: String(out.duplicate) });
    return reply.code(200).send({ ok: true, queued: !out.duplicate, ...out });
  });
}
