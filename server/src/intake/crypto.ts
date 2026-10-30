import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'v1:';

/** AES-256-GCM: returns "v1:" + base64(iv[12] | tag[16] | ciphertext). */
export function encryptText(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Decrypts encryptText output; throws if the key is wrong or the ciphertext was tampered with. */
export function decryptText(key: Buffer, stored: string): string {
  if (!stored.startsWith(PREFIX)) throw new Error('Unknown ciphertext format');
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}
