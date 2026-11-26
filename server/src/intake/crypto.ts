import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Data-at-rest encryption for raw intake text, held inbound mail and Gmail excerpts (AES-256-GCM).
 *
 * DATA_ENCRYPTION_KEY is either one base64 key (32 bytes; key id "k0") or a key ring
 * "kid:base64,oldkid:base64" whose first entry is current. New ciphertexts are "v2:<kid>:" + base64(iv|tag|ct);
 * older "v1:" ciphertexts (no key id) are still read by trying each key (GCM authentication picks the right one).
 * Rotation: prepend a new key, wait out the retention window (7 days for raw text), then drop the old key.
 */
export interface DataKey {
  kid: string;
  key: Buffer;
}
export interface DataKeyRing {
  current: DataKey;
  keys: DataKey[];
}

const V1 = 'v1:';
const V2 = 'v2:';
/** v3 = v2 plus additional authenticated data naming the row (e.g. "user_events:<id>"): a ciphertext copied to another row does not open. */
const V3 = 'v3:';
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;

function decodeKey(b64: string, label: string): Buffer {
  const key = Buffer.from(b64.trim(), 'base64');
  if (key.length !== 32) throw new Error(`Invalid environment: DATA_ENCRYPTION_KEY ${label} must be 32 bytes, base64-encoded`);
  return key;
}

export function parseDataKeys(v: string | undefined): DataKeyRing | null {
  if (!v?.trim()) return null;
  const raw = v.trim();
  if (!raw.includes(':')) {
    const k = { kid: 'k0', key: decodeKey(raw, 'value') };
    return { current: k, keys: [k] };
  }
  const keys: DataKey[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    const kid = entry.slice(0, idx);
    if (idx <= 0 || !KID_RE.test(kid)) throw new Error('Invalid environment: DATA_ENCRYPTION_KEY entries must be "kid:base64key"');
    if (keys.some((k) => k.kid === kid)) throw new Error(`Invalid environment: DATA_ENCRYPTION_KEY kid "${kid}" is repeated`);
    keys.push({ kid, key: decodeKey(entry.slice(idx + 1), `key "${kid}"`) });
  }
  if (!keys.length) return null;
  return { current: keys[0]!, keys };
}

function asRing(k: DataKeyRing | Buffer): DataKeyRing {
  if (Buffer.isBuffer(k)) {
    const key = { kid: 'k0', key: k };
    return { current: key, keys: [key] };
  }
  return k;
}

function open(key: Buffer, b64: string, aad?: string): string {
  const buf = Buffer.from(b64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * AES-256-GCM under the current key: "v2:<kid>:" + base64(iv[12] | tag[16] | ciphertext), or "v3:<kid>:" when
 * `aad` (the row it belongs to) is given. Every row-level caller passes `aad`.
 */
export function encryptText(keys: DataKeyRing | Buffer, plaintext: string, aad?: string): string {
  const { current } = asRing(keys);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', current.key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${aad !== undefined ? V3 : V2}${current.kid}:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
}

/** Decrypts encryptText output; throws if no key matches, the row (aad) differs or the ciphertext was tampered with. */
export function decryptText(keys: DataKeyRing | Buffer, stored: string, aad?: string): string {
  const ring = asRing(keys);
  if (stored.startsWith(V3)) {
    if (aad === undefined) throw new Error('This ciphertext is bound to a row: pass its context');
    const rest = stored.slice(V3.length);
    const idx = rest.indexOf(':');
    const kid = rest.slice(0, idx);
    const k = ring.keys.find((x) => x.kid === kid) ?? (Buffer.isBuffer(keys) ? ring.current : undefined);
    if (!k) throw new Error(`Unknown encryption key id "${kid}"`);
    return open(k.key, rest.slice(idx + 1), aad);
  }
  if (stored.startsWith(V2)) {
    const rest = stored.slice(V2.length);
    const idx = rest.indexOf(':');
    const kid = rest.slice(0, idx);
    const k = ring.keys.find((x) => x.kid === kid) ?? (Buffer.isBuffer(keys) ? ring.current : undefined);
    if (!k) throw new Error(`Unknown encryption key id "${kid}"`);
    return open(k.key, rest.slice(idx + 1));
  }
  if (stored.startsWith(V1)) {
    let last: unknown;
    for (const k of ring.keys) {
      try {
        return open(k.key, stored.slice(V1.length));
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error('Cannot decrypt');
  }
  throw new Error('Unknown ciphertext format');
}

/** Key id a ciphertext was written with ("legacy" for v1). */
export function ciphertextKid(stored: string): string | null {
  if (stored.startsWith(V3)) return stored.slice(V3.length).split(':')[0] ?? null;
  if (stored.startsWith(V2)) return stored.slice(V2.length).split(':')[0] ?? null;
  if (stored.startsWith(V1)) return 'legacy';
  return null;
}
