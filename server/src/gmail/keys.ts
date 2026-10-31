import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** One AES-256 key from GMAIL_TOKEN_KEYS. */
export interface TokenKey {
  kid: string;
  key: Buffer;
}

/** Ordered key ring: `keys[0]` is current (used to encrypt); every key can decrypt values stored under its kid. */
export interface TokenKeyRing {
  keys: TokenKey[];
}

const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Parses GMAIL_TOKEN_KEYS = "kid:base64key,kid2:base64key2". The first entry is the current key.
 * Returns null when unset; throws on malformed entries (bad kid, duplicate kid, key not 32 bytes).
 */
export function parseTokenKeys(raw: string | undefined): TokenKeyRing | null {
  if (!raw?.trim()) return null;
  const keys: TokenKey[] = [];
  for (const entry of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const idx = entry.indexOf(':');
    const kid = idx > 0 ? entry.slice(0, idx) : '';
    if (!KID_RE.test(kid)) throw new Error('Invalid environment: GMAIL_TOKEN_KEYS entries must be "kid:base64key" (kid: letters, digits, _ or -)');
    const key = Buffer.from(entry.slice(idx + 1), 'base64');
    if (key.length !== 32) throw new Error(`Invalid environment: GMAIL_TOKEN_KEYS key "${kid}" must be 32 bytes, base64-encoded`);
    if (keys.some((k) => k.kid === kid)) throw new Error(`Invalid environment: GMAIL_TOKEN_KEYS kid "${kid}" is repeated`);
    keys.push({ kid, key });
  }
  return keys.length ? { keys } : null;
}

const PREFIX = 'g1:';

export interface Sealed {
  kid: string;
  value: string;
}

/**
 * AES-256-GCM under the current key. `context` (e.g. "refresh:<identity id>") is bound as additional
 * authenticated data, so a ciphertext copied to another row or field fails to decrypt.
 */
export function seal(ring: TokenKeyRing, plaintext: string, context: string): Sealed {
  const { kid, key } = ring.keys[0]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${kid}|${context}`, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { kid, value: PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64') };
}

export class TokenKeyMissingError extends Error {
  constructor(readonly kid: string) {
    super(`No GMAIL_TOKEN_KEYS entry for kid "${kid}"`);
    this.name = 'TokenKeyMissingError';
  }
}

/** Decrypts with the key named by `kid`; throws TokenKeyMissingError if that kid was removed from the ring. */
export function unseal(ring: TokenKeyRing, kid: string, value: string, context: string): string {
  const k = ring.keys.find((x) => x.kid === kid);
  if (!k) throw new TokenKeyMissingError(kid);
  if (!value.startsWith(PREFIX)) throw new Error('Unknown token ciphertext format');
  const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', k.key, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(`${kid}|${context}`, 'utf8'));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function currentKid(ring: TokenKeyRing): string {
  return ring.keys[0]!.kid;
}
