/**
 * AES-256-GCM token encryption for small secrets stored at rest
 * (AI-config API keys, exchange refresh tokens). Key: the
 * HADRON_ENCRYPTION_KEY env var (hex). Wire format:
 * base64( iv[12] | gcm-tag[16] | ciphertext ).
 *
 * Extracted from the private helpers in resolvers.ts for spec 036 so
 * src/lib/aiConfig.ts and the resolver layer share one implementation.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

function getEncryptionKey(): Buffer {
  const key = process.env.HADRON_ENCRYPTION_KEY;
  if (!key) throw new Error('HADRON_ENCRYPTION_KEY env var is required');
  // Fail deterministically on misconfiguration: Buffer.from(.., 'hex')
  // silently truncates at the first non-hex char, and a wrong-length key
  // only surfaces later as a cryptic createCipheriv error.
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('HADRON_ENCRYPTION_KEY must be 64 hex characters (a 32-byte AES-256 key)');
  }
  return Buffer.from(key, 'hex');
}

export function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

export function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * #2973 C1 — AES-256-GCM with ASSOCIATED DATA, for secrets whose ciphertext must
 * be bound to their purpose and row (the stamp-key registry). Same wire format as
 * {@link encryptToken}; the AAD is authenticated but not stored, so a ciphertext
 * minted for one AAD (or with none, via {@link encryptToken}) fails `final()`'s tag
 * check when opened under another — a planted ciphertext cannot pose as a key
 * (Rico #92969 §1). `key` overrides the env root (the rotation/re-wrap path holds
 * both roots explicitly); bytes in, bytes out.
 */
export function encryptBytesAad(plaintext: Buffer, aad: string, key: Buffer = getEncryptionKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

/** {@link encryptBytesAad}'s inverse: throws on a wrong AAD, a wrong key, or tampering. */
export function decryptBytesAad(ciphertext: string, aad: string, key: Buffer = getEncryptionKey()): Buffer {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/** {@link getEncryptionKey} for an explicit hex root (the re-wrap path holds both). */
export function encryptionKeyFromHex(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('HADRON_ENCRYPTION_KEY must be 64 hex characters (a 32-byte AES-256 key)');
  }
  return Buffer.from(hex, 'hex');
}
