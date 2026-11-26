import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db.js';
import { one } from '../db.js';
import { AppError, parse } from '../http/errors.js';

import { openDoc, sealDoc } from './syncCrypto.js';
import { consumerAudit, currentAccount, requireAccount } from './context.js';
import { normaliseKeys } from '../util.js';
import type { DataKeyRing } from '../intake/crypto.js';

/**
 * Nomination (DPDP Act 2023 s.14): one person the user names to exercise the user's rights on death or incapacity.
 * Stored sealed, exported with the account, deleted with the account. Due never contacts the nominee and never
 * releases data on its own: a nominee's request is handled by hand (docs/production/NOMINATION.md).
 */
export const NOMINATION_NOTICE_VERSION = 'nomination-2026-11-v1';

export const NOMINATION_NOTICE =
  'You can name one person (your nominee) who may ask Due to use your data rights for you if you die or can no longer act for yourself. ' +
  'We store your nominee’s name, email and relationship to you, encrypted, only to recognise a request from them. ' +
  'We never email or contact your nominee, and we never share your data because of this entry alone: if someone claims to be your nominee, we check their identity and the proof they give us first. ' +
  'You can change or remove your nominee at any time, and it is deleted when you delete your account.';

const Body = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email().max(254),
    relationship: z.string().trim().max(50).optional(),
    acknowledged: z.literal(true),
  })
  .strict();

export interface Nominee {
  name: string;
  email: string;
  relationship: string | null;
  noticeVersion: string;
  savedAt: string;
}

export const nominationScope = (accountId: string) => `nomination:${accountId}`;

export async function readNomination(q: Queryable, accountId: string, keys: DataKeyRing | null): Promise<Nominee | null> {
  const row = await one<{ data_enc: string }>(q, 'SELECT data_enc FROM account_nominations WHERE account_id = $1', [accountId]);
  if (!row || !keys) return null;
  try {
    return openDoc(keys, nominationScope(accountId), row.data_enc) as Nominee;
  } catch {
    return null;
  }
}

export async function nominationRoutes(app: FastifyInstance): Promise<void> {
  const { pool, config, clock } = app.deps;
  const needKey = (): DataKeyRing => {
    if (!config.dataEncryptionKey) throw new AppError(503, 'unavailable', 'Nomination is not available on this server yet.');
    return config.dataEncryptionKey;
  };

  app.get('/api/account/nomination', { preHandler: requireAccount }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const nominee = await readNomination(pool, currentAccount(req).id, config.dataEncryptionKey);
    return { nominee, noticeVersion: NOMINATION_NOTICE_VERSION, notice: NOMINATION_NOTICE };
  });

  app.put('/api/account/nomination', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const keys = needKey();
    const body = parse(Body, normaliseKeys(req.body));
    if (body.email === a.email.toLowerCase()) throw new AppError(400, 'invalid_nominee', 'Your nominee must be someone other than you.');
    const now = clock();
    const nominee: Nominee = {
      name: body.name,
      email: body.email,
      relationship: body.relationship ? body.relationship : null,
      noticeVersion: NOMINATION_NOTICE_VERSION,
      savedAt: now.toISOString(),
    };
    await pool.query(
      `INSERT INTO account_nominations (account_id, data_enc, created_at, updated_at) VALUES ($1,$2,$3,$3)
       ON CONFLICT (account_id) DO UPDATE SET data_enc = EXCLUDED.data_enc, updated_at = EXCLUDED.updated_at`,
      [a.id, sealDoc(keys, nominationScope(a.id), nominee), now],
    );
    // The audit row records that a nominee was set, never who.
    await consumerAudit(pool, a.id, 'nomination.set', 'account', a.id, null, { noticeVersion: NOMINATION_NOTICE_VERSION }, now);
    return { nominee, noticeVersion: NOMINATION_NOTICE_VERSION };
  });

  app.delete('/api/account/nomination', { preHandler: requireAccount }, async (req) => {
    const a = currentAccount(req);
    const r = await pool.query('DELETE FROM account_nominations WHERE account_id = $1', [a.id]);
    if (r.rowCount) await consumerAudit(pool, a.id, 'nomination.removed', 'account', a.id, null, null, clock());
    return { ok: true, nominee: null };
  });
}
