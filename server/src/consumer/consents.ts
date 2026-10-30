import type { Queryable } from '../db.js';
import { one } from '../db.js';

export type ConsentPurpose = 'email_intake' | 'document_parsing' | 'reminders_email' | 'telemetry' | 'sync_backup';

/**
 * True when the account's most recent consent record for `purpose` is a withdrawal.
 * No record at all is not a withdrawal (the feature's own opt-in governs it).
 */
export async function consentWithdrawn(q: Queryable, accountId: string, purpose: ConsentPurpose): Promise<boolean> {
  const r = await one<{ granted: boolean }>(
    q,
    'SELECT granted FROM consent_records WHERE account_id = $1 AND purpose = $2 ORDER BY at DESC, id DESC LIMIT 1',
    [accountId, purpose],
  );
  return r !== null && !r.granted;
}
