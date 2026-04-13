import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * AES-256-GCM encryption for memory content and structured data.
 *
 * Used by Tier 2.5 of the multi-user-agent feature: per-memory data keys
 * live only in the session key cache (in-memory, never persisted), and this
 * module provides the raw encrypt/decrypt primitives.
 *
 * Format:
 *   version (1 byte) | iv (12 bytes) | tag (16 bytes) | ciphertext (n bytes)
 *   encoded as base64
 *
 * The version prefix leaves room for algorithm upgrades without breaking
 * backwards compatibility with existing encrypted data.
 */

const VERSION_V1 = 0x01;
const IV_LENGTH = 12; // 96 bits, standard for GCM
const TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

export interface EncryptionKey {
  raw: Buffer;
}

/**
 * Parse a base64-encoded data key provided by a caller (e.g. from
 * startAgentSession). Throws if the key is the wrong length.
 */
export function parseDataKey(base64: string): EncryptionKey {
  const raw = Buffer.from(base64, 'base64');
  if (raw.length !== KEY_LENGTH) {
    throw new Error(`Invalid data key: expected ${KEY_LENGTH} bytes (got ${raw.length})`);
  }
  return { raw };
}

/** Generate a fresh random data key (for tests and ad-hoc tooling). */
export function generateDataKey(): EncryptionKey {
  return { raw: randomBytes(KEY_LENGTH) };
}

/** Encrypt a UTF-8 string. Returns a base64 string. */
export function encryptString(plaintext: string, key: EncryptionKey): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key.raw, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([
    Buffer.from([VERSION_V1]),
    iv,
    tag,
    ciphertext,
  ]);
  return out.toString('base64');
}

/** Decrypt a base64 string produced by encryptString. */
export function decryptString(encrypted: string, key: EncryptionKey): string {
  const buf = Buffer.from(encrypted, 'base64');
  if (buf.length < 1 + IV_LENGTH + TAG_LENGTH) {
    throw new Error('Invalid ciphertext: too short');
  }
  const version = buf[0];
  if (version !== VERSION_V1) {
    throw new Error(`Unsupported ciphertext version: 0x${version.toString(16)}`);
  }
  const iv = buf.subarray(1, 1 + IV_LENGTH);
  const tag = buf.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(1 + IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv('aes-256-gcm', key.raw, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Encrypt arbitrary JSON as a base64 string. `null` passes through unchanged. */
export function encryptJson<T>(value: T | null | undefined, key: EncryptionKey): string | null {
  if (value === null || value === undefined) return null;
  return encryptString(JSON.stringify(value), key);
}

/** Decrypt a base64 string into JSON. `null` passes through unchanged. */
export function decryptJson<T = unknown>(encrypted: string | null | undefined, key: EncryptionKey): T | null {
  if (encrypted === null || encrypted === undefined) return null;
  const text = decryptString(encrypted, key);
  return JSON.parse(text) as T;
}

/**
 * Sentinel marker prepended to encrypted node fields so callers can tell at a
 * glance whether a stored value is plaintext or ciphertext without consulting
 * the Memory row. Stored ciphertext looks like:
 *
 *   "enc:v1:<base64>"
 *
 * Plaintext values (from Tier 2 memories) are stored as-is.
 */
const CIPHERTEXT_PREFIX = 'enc:v1:';

export function markCiphertext(base64: string): string {
  return CIPHERTEXT_PREFIX + base64;
}

export function isCiphertext(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(CIPHERTEXT_PREFIX);
}

export function stripCiphertextPrefix(value: string): string {
  if (!value.startsWith(CIPHERTEXT_PREFIX)) {
    throw new Error('Value is not ciphertext');
  }
  return value.slice(CIPHERTEXT_PREFIX.length);
}
