import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256 } from '../util.js';

/**
 * Time-based one-time passwords (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps) for the admin console,
 * plus single-use recovery codes. Secrets are stored encrypted (AES-256-GCM, key derived from SESSION_SECRET
 * with HKDF); recovery codes are stored only as SHA-256 hashes (80 random bits each).
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next step as well (clock drift on the phone). */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * Checks a 6-digit code. Returns the matched step, or null. A step at or before `lastStep` is refused, so a
 * code that was already used (or an older one) cannot be replayed.
 */
export function verifyTotp(secretB32: string, code: string, now: Date, lastStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const cur = totpStep(now);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = cur + d;
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(totpCode(secretB32, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(issuer: string, account: string, secretB32: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---- Secret encryption -------------------------------------------------------------------------

const KEY_ID = 'k1';

function secretKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', sessionSecret, 'due-admin-totp', 'totp-secret-v1', 32));
}

/** "k1:" + base64(iv | tag | ciphertext). */
export function encryptTotpSecret(sessionSecret: string, secretB32: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', secretKey(sessionSecret), iv);
  const ct = Buffer.concat([c.update(secretB32, 'utf8'), c.final()]);
  return `${KEY_ID}:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64')}`;
}

/** Returns null when the stored secret cannot be decrypted (e.g. SESSION_SECRET was rotated). */
export function decryptTotpSecret(sessionSecret: string, stored: string | null): string | null {
  if (!stored || !stored.startsWith(`${KEY_ID}:`)) return null;
  try {
    const buf = Buffer.from(stored.slice(KEY_ID.length + 1), 'base64');
    const d = createDecipheriv('aes-256-gcm', secretKey(sessionSecret), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

// ---- Recovery codes ----------------------------------------------------------------------------

/** Ten codes like "K7QD-3MXA-PL2W-9TRE" (80 random bits each). Shown once; only hashes are stored. */
export function generateRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: n }, () => base32Encode(randomBytes(10)).match(/.{4}/g)!.join('-'));
}

export function normaliseRecoveryCode(code: string): string | null {
  const c = code.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z2-7]{16}$/.test(c) ? c : null;
}

export function hashRecoveryCode(code: string): string {
  return sha256(`due-admin-recovery:${normaliseRecoveryCode(code) ?? code}`);
}
