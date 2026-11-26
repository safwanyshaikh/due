import { isMobileOrigin } from '../http/security.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { cookieName } from '../http/cookies.js';
import { addMinutes } from '../clock.js';
import { consumerAudit, currentAccount, entitlementOf, requireAccount, requireFeature, requireRecentSignIn } from '../consumer/context.js';
import { AGE_PURPOSE, hasConsent, recordConsentV2 } from '../consumer/consents.js';
import { getLegal, missingLegal } from '../legal/index.js';
import { decryptText, type DataKeyRing } from '../intake/crypto.js';
import { openDoc, sealDoc, sealedKid } from '../consumer/syncCrypto.js';
import { requestDeletion, RETENTION_EXCEPTIONS } from '../consumer/deletion.js';
import { computeEntitlement } from '../consumer/entitlements.js';
import { cancelSubscriptionForDeletion } from './billing.js';
import { ReminderPlan, replaceSchedule } from '../consumer/reminders.js';
import {
  ACCOUNT_COOKIE,
  createAccountSession,
  hashMagicToken,
  type AccountSessionPolicy,
  type ConsumerAccount,
} from '../consumer/sessions.js';
import { many, one, withTransaction, type Queryable } from '../db.js';
import { AppError, notFound, parse } from '../http/errors.js';
import { camel, camelAll, hmacSha256, normaliseKeys, randomToken, safeEqual } from '../util.js';

export const MAGIC_LINK_TTL_MINUTES = 15;
export const MAGIC_LINK_WINDOW_MINUTES = 15;
export const MAGIC_LINK_MAX_PER_WINDOW = 5;
export const MAGIC_LINK_MAX_PER_EMAIL_HOUR = 10;
/** Per email from any IP (rotating IPs does not help an attacker flood one inbox). */
export const MAGIC_LINK_MAX_PER_EMAIL_DAY = 20;
export const MAX_SYNC_BYTES = 2 * 1024 * 1024;
const DELETE_TOKEN_TTL_MS = 10 * 60 * 1000;

const email = z.string().trim().toLowerCase().email().max(254);
const syncBodyLimit = MAX_SYNC_BYTES + 512 * 1024;

export const emailUnavailable = () =>
  new AppError(503, 'email_unavailable', 'Email sign-in is not available on this server yet. Your data stays on this device.');

export function accountPolicy(app: FastifyInstance): AccountSessionPolicy {
  const c = app.deps.config;
  return { secret: c.sessionSecret, idleMs: c.accountSessionIdleMs, maxMs: c.accountSessionMaxMs };
}

export function publicBase(app: FastifyInstance, req: FastifyRequest): string {
  const configured = app.deps.config.publicBaseUrl;
  if (configured) return configured;
  // Without PUBLIC_BASE_URL / RENDER_EXTERNAL_URL the host would come from Host / X-Forwarded-Host,
  // which the requester controls (link poisoning -> token theft). Never e-mail such links in production.
  if (app.deps.config.isProduction) throw emailUnavailable();
  return `${req.protocol}://${req.host}`;
}

function ua(req: FastifyRequest): string | null {
  const v = req.headers['user-agent'];
  return typeof v === 'string' ? v.slice(0, 512) : null;
}

function setAccountCookie(app: FastifyInstance, reply: FastifyReply, token: string): void {
  // SameSite=Lax so the session survives the top-level navigation from the e-mailed link.
  reply.setCookie(cookieName(ACCOUNT_COOKIE, app.deps.config.isProduction), token, {
    path: '/',
    httpOnly: true,
    secure: app.deps.config.isProduction,
    sameSite: 'lax',
    maxAge: Math.floor(app.deps.config.accountSessionMaxMs / 1000),
  });
}

export function clearAccountCookie(app: FastifyInstance, reply: FastifyReply): void {
  reply.clearCookie(cookieName(ACCOUNT_COOKIE, app.deps.config.isProduction), { path: '/', httpOnly: true, secure: app.deps.config.isProduction, sameSite: 'lax' });
}

function accountView(a: { id: string; email: string; display_name: string | null; created_at: Date; last_login_at: Date | null }) {
  return { id: a.id, email: a.email, displayName: a.display_name, createdAt: a.created_at, lastLoginAt: a.last_login_at };
}

/** Byte size of a JSON document as stored. */
export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), 'utf8');
}

export const SyncDocument = z.record(z.string(), z.unknown());

export const payloadTooLarge = () =>
  new AppError(413, 'payload_too_large', `Synced data is limited to ${MAX_SYNC_BYTES / (1024 * 1024)} MB`);

type DocTable = 'account_data' | 'household_data';

function docScope(table: DocTable, key: string): string {
  return `${table === 'account_data' ? 'account' : 'household'}:${key}`;
}

/** The stored document, decrypted (sealed rows) or as stored (rows from before encryption). */
function openStored(keys: DataKeyRing | null, table: DocTable, key: string, row: { data: unknown; data_enc: string | null }): unknown {
  if (!row.data_enc) return row.data;
  if (!keys) throw new AppError(503, 'sync_key_missing', 'Synced data is encrypted and the server key is not configured');
  return openDoc(keys, docScope(table, key), row.data_enc);
}

/**
 * Optimistic-concurrency write shared by personal and household sync documents. With a key ring the document
 * is stored sealed (see consumer/syncCrypto.ts) and `data` holds '{}'.
 * Returns the conflict (with the server copy) as a 409 AppError.
 */
export async function writeVersionedDoc(
  c: Queryable,
  table: DocTable,
  keyCol: 'account_id' | 'household_id',
  key: string,
  baseVersion: number,
  data: Record<string, unknown>,
  now: Date,
  extra: { updatedBy?: string; keys?: DataKeyRing | null } = {},
): Promise<{ version: number; updatedAt: Date; beforeVersion: number; beforeBytes: number }> {
  const keys = extra.keys ?? null;
  await c.query(`INSERT INTO ${table} (${keyCol}, version, data, updated_at) VALUES ($1, 0, '{}'::jsonb, $2) ON CONFLICT DO NOTHING`, [key, now]);
  const cur = (await one<{ version: number; data: unknown; data_enc: string | null; updated_at: Date }>(
    c,
    `SELECT version, data, data_enc, updated_at FROM ${table} WHERE ${keyCol} = $1 FOR UPDATE`,
    [key],
  ))!;
  const curDoc = cur.version === 0 ? null : openStored(keys, table, key, cur);
  if (cur.version !== baseVersion) {
    throw new AppError(409, 'version_conflict', 'The server copy changed since your last sync', {
      server: { version: cur.version, data: curDoc, updatedAt: cur.version === 0 ? null : cur.updated_at },
    });
  }
  const next = cur.version + 1;
  const plain = keys ? '{}' : JSON.stringify(data);
  const sealed = keys ? sealDoc(keys, docScope(table, key), data) : null;
  if (table === 'household_data') {
    await c.query(`UPDATE household_data SET version = $2, data = $3, data_enc = $6, updated_at = $4, updated_by = $5 WHERE household_id = $1`, [
      key,
      next,
      plain,
      now,
      extra.updatedBy ?? null,
      sealed,
    ]);
  } else {
    await c.query(`UPDATE account_data SET version = $2, data = $3, data_enc = $5, updated_at = $4 WHERE account_id = $1`, [key, next, plain, now, sealed]);
  }
  return { version: next, updatedAt: now, beforeVersion: cur.version, beforeBytes: cur.version === 0 ? 0 : jsonBytes(curDoc) };
}

/**
 * Reads a sync document. A row stored before encryption (or under an older key) is sealed under the current key
 * on this read, so existing synced accounts are migrated on their next sync.
 */
export async function readVersionedDoc(q: Queryable, table: DocTable, keyCol: string, key: string, keys: DataKeyRing | null = null) {
  const row = await one<{ version: number; data: unknown; data_enc: string | null; updated_at: Date }>(
    q,
    `SELECT version, data, data_enc, updated_at FROM ${table} WHERE ${keyCol} = $1`,
    [key],
  );
  if (!row || row.version === 0) return { version: 0, data: null, updatedAt: null };
  const doc = openStored(keys, table, key, row);
  if (keys && (!row.data_enc || sealedKid(row.data_enc) !== keys.current.kid)) {
    // Same version, same content: only the storage form changes (guarded so a concurrent write wins).
    await q.query(`UPDATE ${table} SET data = '{}'::jsonb, data_enc = $3 WHERE ${keyCol} = $1 AND version = $2`, [
      key,
      row.version,
      sealDoc(keys, docScope(table, key), doc),
    ]);
  }
  return { version: row.version, data: doc, updatedAt: row.updated_at };
}

function deleteToken(secret: string, accountId: string, sessionHash: string, exp: number): string {
  return `${exp}.${hmacSha256(secret, `account-delete:${accountId}:${sessionHash}:${exp}`)}`;
}

export async function reminderDeliveryState(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<'active' | 'premium_required' | 'email_unavailable' | 'consent_required'> {
  const ent = await entitlementOf(req);
  if (!ent.features.includes('reminder_email')) return 'premium_required';
  if (!app.deps.mailer) return 'email_unavailable';
  // Reminders are only sent after explicit consent for the channel.
  return (await hasConsent(app.deps.pool, currentAccount(req).id, 'reminders_email')) ? 'active' : 'consent_required';
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const { pool, clock, config } = app.deps;

  // ---- Passwordless e-mail sign-in -------------------------------------------------------------
  app.post(
    '/api/account/magic-link',
    { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (req, reply) => {
      const body = parse(z.object({ email }).strict(), normaliseKeys(req.body));
      const mailer = app.deps.mailer;
      // Never pretend a link was sent: without SMTP the feature is unavailable.
      if (!mailer) throw emailUnavailable();
      const base = publicBase(app, req);
      const now = clock();
      const recent = (
        await pool.query<{ ip_email: number; email_hour: number; email_day: number }>(
          `SELECT count(*) FILTER (WHERE ip IS NOT DISTINCT FROM $2 AND created_at > $3)::int AS ip_email,
                  count(*) FILTER (WHERE created_at > $4)::int AS email_hour,
                  count(*)::int AS email_day
             FROM magic_links WHERE email = $1 AND created_at > $5`,
          [body.email, req.ip, addMinutes(now, -MAGIC_LINK_WINDOW_MINUTES), addMinutes(now, -60), addMinutes(now, -24 * 60)],
        )
      ).rows[0]!;
      if (
        recent.ip_email >= MAGIC_LINK_MAX_PER_WINDOW ||
        recent.email_hour >= MAGIC_LINK_MAX_PER_EMAIL_HOUR ||
        recent.email_day >= MAGIC_LINK_MAX_PER_EMAIL_DAY
      ) {
        reply.header('Retry-After', String(MAGIC_LINK_WINDOW_MINUTES * 60));
        throw new AppError(429, 'rate_limited', 'Too many sign-in links requested. Try again in 15 minutes.');
      }
      const token = randomToken(32);
      const tokenHash = hashMagicToken(config.sessionSecret, token);
      const expiresAt = addMinutes(now, MAGIC_LINK_TTL_MINUTES);
      await pool.query(`INSERT INTO magic_links (token_hash, email, created_at, expires_at, ip) VALUES ($1,$2,$3,$4,$5)`, [
        tokenHash,
        body.email,
        now,
        expiresAt,
        req.ip,
      ]);
      const link = `${base}/api/account/verify?token=${encodeURIComponent(token)}`;
      try {
        await mailer.send(
          [body.email],
          'Your Due sign-in link',
          `Use this link to sign in to Due. It works once and expires in ${MAGIC_LINK_TTL_MINUTES} minutes:\n\n${link}\n\n` +
            `If you did not ask to sign in, you can ignore this email; nothing changes on your account.\n`,
        );
      } catch (err) {
        req.log.error({ err }, 'magic link email failed');
        await pool.query('DELETE FROM magic_links WHERE token_hash = $1', [tokenHash]);
        throw new AppError(502, 'email_send_failed', 'We could not send the sign-in email. Please try again later.');
      }
      // Same response whether or not an account exists for this address (no account enumeration).
      return reply.code(202).send({
        ok: true,
        message: `If this address can receive email, a sign-in link is on its way. It expires in ${MAGIC_LINK_TTL_MINUTES} minutes.`,
        expiresInMinutes: MAGIC_LINK_TTL_MINUTES,
      });
    },
  );

  /**
   * Consumes a magic link (single use, 15 min) and opens a session; creates the account on first sign-in.
   * Every sign-in of an account without a recorded 18+ declaration needs `age.confirmed` (recorded with the
   * notice version); in production, new accounts are refused until the legal details are complete. Refusals
   * roll back, so the link stays usable.
   */
  async function verify(
    req: FastifyRequest,
    reply: FastifyReply,
    token: string,
    deviceLabel: string | null,
    transport: 'cookie' | 'bearer' = 'cookie',
    age: { confirmed: boolean; noticeVersion: string | null } = { confirmed: false, noticeVersion: null },
  ) {
    const now = clock();
    const result = await withTransaction(pool, async (c) => {
      const link = await one<{ email: string }>(
        c,
        `UPDATE magic_links SET used_at = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2 RETURNING email`,
        [hashMagicToken(config.sessionSecret, token), now],
      );
      if (!link) throw new AppError(400, 'invalid_token', 'This sign-in link is invalid, expired or already used');
      let acct = await one<{ id: string; email: string; display_name: string | null; created_at: Date; last_login_at: Date | null; status: string }>(
        c,
        'SELECT * FROM consumer_accounts WHERE email = $1 FOR UPDATE',
        [link.email],
      );
      let created = false;
      const ageRecorded = acct ? await hasConsent(c, acct.id, AGE_PURPOSE) : false;
      if (!ageRecorded && (!age.confirmed || !age.noticeVersion)) {
        throw new AppError(400, 'age_confirmation_required', 'Confirm that you are 18 or older to use a Due account.');
      }
      if (!acct && config.isProduction && missingLegal(await getLegal(c)).length > 0) {
        throw new AppError(503, 'signup_unavailable', 'New accounts are not open yet: the service’s legal and grievance details are still being completed. Your data stays on this device.');
      }
      if (!acct) {
        acct = (await one(
          c,
          `INSERT INTO consumer_accounts (email, created_at, last_login_at, status) VALUES ($1,$2,$2,'active')
           ON CONFLICT (email) DO UPDATE SET last_login_at = EXCLUDED.last_login_at RETURNING *`,
          [link.email, now],
        ))!;
        created = true;
        await consumerAudit(c, acct.id, 'account.created', 'account', acct.id, null, { via: 'magic_link' }, now);
      } else {
        if (acct.status !== 'active') throw new AppError(403, 'account_disabled', 'This account is disabled');
        await c.query('UPDATE consumer_accounts SET last_login_at = $2 WHERE id = $1', [acct.id, now]);
        acct.last_login_at = now;
      }
      if (!ageRecorded) {
        await recordConsentV2(c, { accountId: acct.id }, { purpose: AGE_PURPOSE, granted: true, policyVersion: age.noticeVersion!, scope: { method: 'self_declaration' }, source: 'app' }, now);
        await recordConsentV2(c, { accountId: acct.id }, { purpose: 'account', granted: true, policyVersion: age.noticeVersion!, source: 'app' }, now);
      }
      const s = await createAccountSession(c, accountPolicy(app), acct.id, now, { ip: req.ip, userAgent: ua(req), deviceLabel });
      await consumerAudit(c, acct.id, 'session.created', 'session', s.publicId, null, { via: 'magic_link' }, now);
      return { acct, created, session: s };
    });
    if (transport === 'cookie') setAccountCookie(app, reply, result.session.token);
    return result;
  }

  /**
   * The e-mailed link. It never consumes the token or opens a session: link scanners and prefetchers follow
   * GET links, and a GET that signs in would also allow login CSRF. It sends the browser to the app, which
   * asks the person to confirm sign-in on this device and then POSTs the token (below).
   */
  app.get('/api/account/verify', async (req, reply) => {
    const q = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{16,256}$/) }).safeParse(req.query);
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    if (!q.success) return reply.redirect('/?account=link-invalid', 303);
    const live = await one(pool, 'SELECT 1 AS ok FROM magic_links WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2', [
      hashMagicToken(config.sessionSecret, q.data.token),
      clock(),
    ]);
    if (!live) return reply.redirect('/?account=link-invalid', 303);
    // The token goes in the fragment: browsers never send it to a server, so it is not in access logs or caches (L1).
    return reply.redirect(`/?account=confirm#token=${encodeURIComponent(q.data.token)}`, 303);
  });

  app.post('/api/account/verify', async (req, reply) => {
    const body = parse(
      z
        .object({
          token: z.string().min(16).max(256),
          deviceLabel: z.string().trim().min(1).max(80).optional(),
          tokenTransport: z.enum(['cookie', 'bearer']).optional(),
          /** "I am 18 or older" (DPDP s.9), with the version of the privacy notice shown. */
          ageConfirmed: z.boolean().optional(),
          noticeVersion: z.string().trim().min(1).max(40).optional(),
        })
        .strict(),
      normaliseKeys(req.body),
    );
    // Bearer transport is for the native app only: it must come from a configured Capacitor origin.
    const bearer = body.tokenTransport === 'bearer';
    if (bearer && !isMobileOrigin(req.headers.origin, config.mobileAppOrigins))
      throw new AppError(400, 'bearer_not_allowed', 'Bearer sessions are only issued to the Due mobile app');
    const r = await verify(req, reply, body.token, body.deviceLabel ?? null, bearer ? 'bearer' : 'cookie', {
      confirmed: body.ageConfirmed === true,
      noticeVersion: body.noticeVersion ?? null,
    });
    const ent = await computeEntitlement(pool, r.acct.id, clock());
    return {
      account: accountView(r.acct),
      created: r.created,
      entitlements: ent,
      ...(bearer ? { sessionToken: r.session.token, tokenType: 'Bearer' } : {}),
    };
  });

  // ---- Profile, sessions/devices ---------------------------------------------------------------
  app.get('/api/account/me', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const row = (await one<{ id: string; email: string; display_name: string | null; created_at: Date; last_login_at: Date | null }>(
      pool,
      'SELECT * FROM consumer_accounts WHERE id = $1',
      [a.id],
    ))!;
    return { account: accountView(row), sessionId: req.accountSessionPublicId, entitlements: await entitlementOf(req) };
  });

  app.patch('/api/account/me', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const body = parse(z.object({ displayName: z.string().trim().max(80).nullable() }).strict(), normaliseKeys(req.body));
    const name = body.displayName === '' ? null : body.displayName;
    const row = await withTransaction(pool, async (c) => {
      const r = (await one<{ id: string; email: string; display_name: string | null; created_at: Date; last_login_at: Date | null }>(
        c,
        'UPDATE consumer_accounts SET display_name = $2 WHERE id = $1 RETURNING *',
        [a.id, name],
      ))!;
      await consumerAudit(c, a.id, 'account.update', 'account', a.id, { displayName: a.displayName }, { displayName: name }, clock());
      return r;
    });
    return { account: accountView(row) };
  });

  app.post('/api/account/logout', async (req, reply) => {
    if (req.accountSessionHash && req.account) {
      await pool.query('UPDATE consumer_sessions SET revoked_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL', [req.accountSessionHash, clock()]);
      await consumerAudit(pool, req.account.id, 'session.logout', 'session', req.accountSessionPublicId, null, null, clock());
    }
    clearAccountCookie(app, reply);
    return { ok: true };
  });

  app.get('/api/account/sessions', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const rows = await many<{ public_id: string; device_label: string | null; user_agent: string | null; ip: string | null; created_at: Date; last_seen_at: Date; expires_at: Date }>(
      pool,
      `SELECT public_id, device_label, user_agent, ip, created_at, last_seen_at, expires_at FROM consumer_sessions
        WHERE account_id = $1 AND revoked_at IS NULL AND expires_at > $2 ORDER BY last_seen_at DESC`,
      [a.id, clock()],
    );
    return {
      items: rows.map((r) => ({
        id: r.public_id,
        deviceLabel: r.device_label,
        userAgent: r.user_agent,
        ip: r.ip,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        expiresAt: r.expires_at,
        current: r.public_id === req.accountSessionPublicId,
      })),
    };
  });

  app.post('/api/account/sessions/:id/revoke', { preHandler: requireAccount }, async (req, reply) => {
    const a = currentAccount(req);
    const { id } = parse(z.object({ id: z.string().uuid() }), req.params);
    const r = await pool.query(
      'UPDATE consumer_sessions SET revoked_at = $3 WHERE public_id = $1 AND account_id = $2 AND revoked_at IS NULL',
      [id, a.id, clock()],
    );
    if (!r.rowCount) throw notFound('Session not found');
    await consumerAudit(pool, a.id, 'session.revoked', 'session', id, null, null, clock());
    if (id === req.accountSessionPublicId) clearAccountCookie(app, reply);
    return { ok: true, current: id === req.accountSessionPublicId };
  });

  app.post('/api/account/logout-all', { preHandler: requireAccount }, async (req, reply) => {
    const a = currentAccount(req);
    const r = await pool.query('UPDATE consumer_sessions SET revoked_at = $2 WHERE account_id = $1 AND revoked_at IS NULL', [a.id, clock()]);
    await consumerAudit(pool, a.id, 'session.logout_all', 'account', a.id, null, { revoked: r.rowCount ?? 0 }, clock());
    clearAccountCookie(app, reply);
    return { ok: true, revoked: r.rowCount ?? 0 };
  });

  // ---- Backup / multi-device sync ---------------------------------------------------------------
  app.get('/api/account/data', { preHandler: requireFeature('backup') }, async (req) => {
    return readVersionedDoc(pool, 'account_data', 'account_id', currentAccount(req).id, config.dataEncryptionKey);
  });

  app.put('/api/account/data', { preHandler: requireFeature('backup'), bodyLimit: syncBodyLimit }, async (req) => {
    const a = currentAccount(req);
    const body = parse(
      z.object({ baseVersion: z.number().int().min(0), data: SyncDocument, reminders: ReminderPlan.optional() }).strict(),
      normaliseKeys(req.body),
    );
    // Uploads need an explicit 'sync_backup' grant (turning sync on records it); a withdrawal stops them.
    if (!(await hasConsent(pool, a.id, 'sync_backup'))) {
      throw new AppError(403, 'consent_required', 'Backup and sync is off because it has not been turned on (or consent was withdrawn). Turn it on again to sync.');
    }
    const bytes = jsonBytes(body.data);
    if (bytes > MAX_SYNC_BYTES) throw payloadTooLarge();
    const now = clock();
    const out = await withTransaction(pool, async (c) => {
      const w = await writeVersionedDoc(c, 'account_data', 'account_id', a.id, body.baseVersion, body.data, now, { keys: config.dataEncryptionKey });
      await consumerAudit(c, a.id, 'data.updated', 'account_data', a.id, { version: w.beforeVersion, bytes: w.beforeBytes }, { version: w.version, bytes }, now);
      const stored = body.reminders ? await replaceSchedule(c, a.id, body.reminders, now) : null;
      return { ...w, stored };
    });
    return {
      version: out.version,
      updatedAt: out.updatedAt,
      ...(out.stored === null ? {} : { reminders: { stored: out.stored, emailDelivery: await reminderDeliveryState(app, req) } }),
    };
  });

  // ---- Synced reminders ------------------------------------------------------------------------
  app.put('/api/account/reminders', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const body = parse(z.object({ items: ReminderPlan }).strict(), normaliseKeys(req.body));
    const now = clock();
    const stored = await withTransaction(pool, async (c) => {
      const n = await replaceSchedule(c, a.id, body.items, now);
      await consumerAudit(c, a.id, 'reminders.replaced', 'reminder_schedule', a.id, null, { items: body.items.length, stored: n }, now);
      return n;
    });
    return { stored, emailDelivery: await reminderDeliveryState(app, req) };
  });

  app.get('/api/account/reminders', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const schedule = await many(
      pool,
      `SELECT obligation_ref, title, due_date, remind_at, channel, timezone, quiet_start, quiet_end, attempts, delivered_at
         FROM reminder_schedule WHERE account_id = $1 ORDER BY remind_at LIMIT 1000`,
      [a.id],
    );
    const deliveries = await many(
      pool,
      `SELECT id, obligation_ref, channel, scheduled_for, status, provider_message_id, error, created_at
         FROM reminder_deliveries WHERE account_id = $1 ORDER BY id DESC LIMIT 200`,
      [a.id],
    );
    return { emailDelivery: await reminderDeliveryState(app, req), schedule: camelAll(schedule), deliveries: camelAll(deliveries) };
  });

  // ---- Entitlements ----------------------------------------------------------------------------
  app.get('/api/account/entitlements', { preHandler: requireAccount }, async (req) => entitlementOf(req));

  // ---- Export / delete -------------------------------------------------------------------------
  app.get('/api/account/export', { preHandler: requireRecentSignIn }, async (req, reply) => {
    const a = currentAccount(req);
    const now = clock();
    const doc = await exportAccount(pool, a, now, { dataKey: config.dataEncryptionKey });
    await consumerAudit(pool, a.id, 'account.export', 'account', a.id, null, null, now);
    reply.header('Content-Disposition', `attachment; filename="due-account-export-${now.toISOString().slice(0, 10)}.json"`);
    return doc;
  });

  app.post('/api/account/delete-request', { preHandler: requireRecentSignIn }, async (req) => {
    const a = currentAccount(req);
    const exp = clock().getTime() + DELETE_TOKEN_TTL_MS;
    return {
      confirmationToken: deleteToken(config.sessionSecret, a.id, req.accountSessionHash!, exp),
      expiresAt: new Date(exp).toISOString(),
      warning: 'Deleting your account permanently removes your synced data, devices, reminders and household membership. Data on this device is not affected.',
      retentionExceptions: RETENTION_EXCEPTIONS,
    };
  });

  app.delete('/api/account', { preHandler: requireRecentSignIn }, async (req, reply) => {
    const a = currentAccount(req);
    const body = parse(z.object({ confirmationToken: z.string().min(10).max(200) }).strict(), normaliseKeys(req.body));
    const now = clock();
    const [expRaw] = body.confirmationToken.split('.');
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp < now.getTime() || !safeEqual(body.confirmationToken, deleteToken(config.sessionSecret, a.id, req.accountSessionHash!, exp))) {
      throw new AppError(400, 'invalid_confirmation', 'The confirmation token is invalid or expired. Request a new one.');
    }
    // An active paid subscription is stopped at the gateway first (no further charges), then the deletion runs.
    const subscriptionCancelled = await cancelSubscriptionForDeletion(app, a.id, now);
    // Asynchronous: the account and its sessions are disabled now; the account.delete job removes the data and
    // records progress (GET /api/account/deletion-status?requestId=&token=).
    const r = await withTransaction(pool, (c) => requestDeletion(c, config.sessionSecret, a.id, now, req.id));
    clearAccountCookie(app, reply);
    return reply.code(202).send({
      ok: true,
      status: 'queued',
      subscriptionCancelled,
      requestId: r.requestId,
      statusToken: r.statusToken,
      statusUrl: `/api/account/deletion-status?requestId=${r.requestId}&token=${r.statusToken}`,
    });
  });
}

/** Everything stored about an account, as JSON (session hashes and token hashes are never included). */
export async function exportAccount(q: Queryable, a: ConsumerAccount, now: Date, opts: { dataKey?: DataKeyRing | null } = {}) {
  const account = await one(q, 'SELECT id, email, display_name, created_at, last_login_at, status FROM consumer_accounts WHERE id = $1', [a.id]);
  const sessions = await many(
    q,
    `SELECT public_id AS id, device_label, user_agent, ip, created_at, last_seen_at, expires_at, revoked_at
       FROM consumer_sessions WHERE account_id = $1 ORDER BY created_at`,
    [a.id],
  );
  const data = await readVersionedDoc(q, 'account_data', 'account_id', a.id, opts.dataKey ?? null);
  const entitlement = await one(q, 'SELECT plan, billing_period, status, current_period_end, channel, provider_ref, updated_at FROM entitlements WHERE account_id = $1', [a.id]);
  const subscriptions = await many(q, 'SELECT id, plan, billing_period, status, created_at, updated_at FROM billing_subscriptions WHERE account_id = $1', [a.id]);
  const membership = await one<{ household_id: string; role: string }>(
    q,
    'SELECT household_id, role, invited_email, status, created_at FROM household_members WHERE account_id = $1',
    [a.id],
  );
  let household: unknown = null;
  if (membership) {
    const h = await one(q, 'SELECT id, name, owner_account_id, created_at FROM households WHERE id = $1', [membership.household_id]);
    const members = await many(
      q,
      `SELECT m.account_id, a.email, m.role, m.status, m.created_at FROM household_members m JOIN consumer_accounts a ON a.id = m.account_id
        WHERE m.household_id = $1`,
      [membership.household_id],
    );
    const hdata = await readVersionedDoc(q, 'household_data', 'household_id', membership.household_id, opts.dataKey ?? null);
    household = { ...camel(h!), membership: camel(membership), members: camelAll(members), data: hdata };
  }
  const reminders = await many(q, 'SELECT obligation_ref, title, due_date, remind_at, channel, timezone, quiet_start, quiet_end, attempts, delivered_at FROM reminder_schedule WHERE account_id = $1', [a.id]);
  const deliveries = await many(q, 'SELECT obligation_ref, channel, scheduled_for, status, provider_message_id, error, created_at FROM reminder_deliveries WHERE account_id = $1 ORDER BY id', [a.id]);
  const audit = await many(q, 'SELECT action, entity, entity_id, before, after, at FROM consumer_audit WHERE account_id = $1 ORDER BY id', [a.id]);
  const telemetry = await many(q, 'SELECT anon_id, name, props, at FROM telemetry_events WHERE account_id = $1 ORDER BY id', [a.id]);
  const consents = await many(
    q,
    'SELECT purpose, granted, policy_version, scope, source, granted_at, revoked_at, at FROM consent_records WHERE account_id = $1 ORDER BY at, id',
    [a.id],
  );
  const aliases = await many(q, 'SELECT alias, status, created_at, updated_at FROM intake_aliases WHERE account_id = $1 ORDER BY created_at', [a.id]);
  const events = await many<Record<string, unknown> & { raw_text: string | null }>(
    q,
    `SELECT id, intake_type, source_domain, extracted_fields, confidence, review_status, raw_text, raw_retention_until, parser_version,
            source_meta, identity_id, created_at, updated_at
       FROM user_events WHERE account_id = $1 ORDER BY created_at`,
    [a.id],
  );
  const intakeEvents = events.map(({ raw_text, ...e }) => {
    let rawText: string | null = null;
    if (raw_text && opts.dataKey) {
      try {
        rawText = decryptText(opts.dataKey, raw_text);
      } catch {
        rawText = null;
      }
    }
    return { ...camel(e), rawText };
  });
  const offerMatches = await many(q, 'SELECT user_event_id, offer_id, match_basis, eligibility_status, created_at FROM offer_matches WHERE account_id = $1', [a.id]);
  const identities = await many(
    q,
    `SELECT id, kind, label, email, status, status_reason, consent_version, consented_at, revoked_at, attachments_enabled, sender_filters,
            last_scan_at, last_scan_status, created_at, updated_at FROM email_identities WHERE account_id = $1 ORDER BY created_at`,
    [a.id],
  );
  // Gmail connection metadata only: OAuth tokens are secrets and never exported.
  const gmail = await many(
    q,
    `SELECT g.identity_id, g.scopes, g.expires_at, g.created_at, g.updated_at, g.revoked_at FROM gmail_connections g
       JOIN email_identities i ON i.id = g.identity_id WHERE i.account_id = $1`,
    [a.id],
  );
  const gmailScans = await many(
    q,
    `SELECT r.identity_id, r.trigger, r.status, r.requested_at, r.finished_at, r.messages_listed, r.messages_new, r.events_created, r.error_code
       FROM gmail_scan_runs r JOIN email_identities i ON i.id = r.identity_id WHERE i.account_id = $1 ORDER BY r.requested_at`,
    [a.id],
  );
  const notificationPrefs = await many(
    q,
    'SELECT channel, enabled, timezone, quiet_start, quiet_end, snooze_until, disabled_via, updated_at FROM notification_preferences WHERE account_id = $1',
    [a.id],
  );
  const uploads = await many(q, 'SELECT month, count, updated_at FROM upload_counters WHERE account_id = $1 ORDER BY month', [a.id]);
  // Held messages: metadata only (bodies are wiped after parsing and never kept more than 24 hours).
  const inbound = await many(
    q,
    'SELECT id, provider, sender_domain, status, error_code, user_event_id, received_at, processed_at FROM inbound_messages WHERE account_id = $1 ORDER BY received_at',
    [a.id],
  );
  const deletions = await many(q, 'SELECT id, status, steps, requested_at, completed_at FROM deletion_requests WHERE account_id = $1', [a.id]);
  const breachNotices = await many(q, 'SELECT incident_ref, status, at FROM breach_notifications WHERE account_id = $1 ORDER BY at', [a.id]);
  return {
    exportedAt: now.toISOString(),
    format: 'due-account-export/2',
    account: camel(account!),
    sessions: camelAll(sessions),
    data,
    entitlement: entitlement ? camel(entitlement) : null,
    billingSubscriptions: camelAll(subscriptions),
    household,
    reminderSchedule: camelAll(reminders),
    reminderDeliveries: camelAll(deliveries),
    audit: camelAll(audit),
    telemetry: camelAll(telemetry),
    consents: camelAll(consents),
    intakeAliases: camelAll(aliases),
    intakeEvents,
    offerMatches: camelAll(offerMatches),
    emailIdentities: camelAll(identities),
    gmailConnections: camelAll(gmail),
    gmailScanRuns: camelAll(gmailScans),
    notificationPreferences: camelAll(notificationPrefs),
    uploadCounters: camelAll(uploads),
    inboundMessages: camelAll(inbound),
    deletionRequests: camelAll(deletions),
    breachNotifications: camelAll(breachNotices),
  };
}

/**
 * Where each table holding an account's data appears in the export (M4). A test lists every table with an
 * account column and fails if one is missing here, so a new table cannot silently drop out of the export.
 */
export const EXPORT_COVERAGE: Record<string, string> = {
  consumer_accounts: 'account',
  consumer_sessions: 'sessions',
  account_data: 'data',
  entitlements: 'entitlement',
  billing_subscriptions: 'billingSubscriptions',
  households: 'household',
  household_members: 'household.members',
  household_data: 'household.data',
  household_invites: 'excluded: pending invitations to other people (token hashes); the invitee sees them on sign-in',
  reminder_schedule: 'reminderSchedule',
  reminder_deliveries: 'reminderDeliveries',
  consumer_audit: 'audit',
  telemetry_events: 'telemetry',
  consent_records: 'consents',
  intake_aliases: 'intakeAliases',
  user_events: 'intakeEvents',
  offer_matches: 'offerMatches',
  email_identities: 'emailIdentities',
  gmail_connections: 'gmailConnections (tokens excluded: secrets)',
  gmail_scan_runs: 'gmailScanRuns',
  notification_preferences: 'notificationPreferences',
  upload_counters: 'uploadCounters',
  inbound_messages: 'inboundMessages (metadata; bodies are wiped after parsing)',
  deletion_requests: 'deletionRequests',
  breach_notifications: 'breachNotifications',
  oauth_states: 'excluded: 10-minute OAuth state with an encrypted PKCE verifier (secret, transient)',
  magic_links: 'excluded: sign-in link hashes (secret, 15 minutes)',
  jobs_queue: 'excluded: internal job queue rows hold only ids',
  login_events: 'excluded: admin console sign-ins (staff accounts, not consumer accounts)',
  users: 'excluded: admin staff accounts',
};
