import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { DataKeyRing } from '../intake/crypto.js';

/**
 * Server-side encryption of synced documents (H3, minimum fix): every account's backup and every household's
 * shared document is sealed with AES-256-GCM under its own key, derived with HKDF-SHA256 from the current
 * DATA_ENCRYPTION_KEY and the row's scope ("account:<id>" / "household:<id>"). The scope is also bound as
 * additional authenticated data, so a ciphertext copied to another row does not open.
 * Format: "d1:<kid>:" + base64(iv[12] | tag[16] | ciphertext). The key id selects the ring entry, so a rotated
 * key keeps opening older rows, which are re-sealed under the current key on their next read or write.
 *
 * This protects against database/backup leaks and casual operator access; it is not end-to-end encryption
 * (the server holds the key). The end-to-end plan is in docs/production/E2E_SYNC_PLAN.md.
 */
const PREFIX = 'd1:';

function docKey(master: Buffer, scope: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, 'due-sync-doc-v1', scope, 32));
}

export function sealDoc(ring: DataKeyRing, scope: string, doc: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', docKey(ring.current.key, scope), iv);
  c.setAAD(Buffer.from(scope));
  const ct = Buffer.concat([c.update(JSON.stringify(doc), 'utf8'), c.final()]);
  return `${PREFIX}${ring.current.kid}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

export function sealedKid(stored: string): string | null {
  return stored.startsWith(PREFIX) ? (stored.slice(PREFIX.length).split(':')[0] ?? null) : null;
}

export function openDoc(ring: DataKeyRing, scope: string, stored: string): unknown {
  if (!stored.startsWith(PREFIX)) throw new Error('Unknown sync ciphertext format');
  const rest = stored.slice(PREFIX.length);
  const idx = rest.indexOf(':');
  const kid = rest.slice(0, idx);
  const k = ring.keys.find((x) => x.kid === kid);
  if (!k) throw new Error(`Sync document sealed with unknown key id "${kid}"`);
  const buf = Buffer.from(rest.slice(idx + 1), 'base64');
  const d = createDecipheriv('aes-256-gcm', docKey(k.key, scope), buf.subarray(0, 12));
  d.setAAD(Buffer.from(scope));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}
