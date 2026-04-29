/**
 * Column-level encryption for `Asset.storage_key`.
 *
 * Per spec 004-asset-upload FR-014/FR-015: when an asset belongs to
 * an encrypted memory, the `storage_key` column is stored as
 * ciphertext (AES-256-GCM under HADRON_ENCRYPTION_KEY). On download,
 * the server decrypts on the request stack only — decrypted form
 * never enters any cache.
 *
 * Why column-level rather than node-style row-level encryption: the
 * Asset table's other columns (filename, mime_type, size_bytes,
 * scan_status, ...) don't need to be encrypted, and encrypting them
 * would prevent index-based queries. Only `storage_key` is sensitive
 * (it points at the bytes); everything else is metadata.
 */

import { encryptString, decryptString, type EncryptionKey } from '../crypto.js';

/**
 * Storage_key wrapping marker. Same prefix the platform uses
 * elsewhere to distinguish ciphertext from plaintext at runtime.
 */
const CIPHERTEXT_PREFIX = 'enc:v1:';

export function isEncryptedStorageKey(value: string): boolean {
  return value.startsWith(CIPHERTEXT_PREFIX);
}

/**
 * Encrypt `storageKey` if the memory is encrypted; pass through
 * otherwise. Idempotent — passing already-encrypted ciphertext
 * returns it unchanged.
 */
export function encryptStorageKeyForMemory(
  storageKey: string,
  memory: { isEncrypted: boolean },
  key: EncryptionKey,
): string {
  if (!memory.isEncrypted) return storageKey;
  if (isEncryptedStorageKey(storageKey)) return storageKey;
  return CIPHERTEXT_PREFIX + encryptString(storageKey, key);
}

/**
 * Decrypt `storageKey` if it is encrypted; pass through otherwise.
 * Throws if the value is encrypted-shaped but the key is missing
 * (caller must surface MEMORY_ENCRYPTED_NO_KEY to the request).
 */
export function decryptStorageKey(
  stored: string,
  key: EncryptionKey | null,
): string {
  if (!isEncryptedStorageKey(stored)) return stored;
  if (!key) {
    throw new Error('MEMORY_ENCRYPTED_NO_KEY: cannot decrypt storage_key without session key');
  }
  return decryptString(stored.slice(CIPHERTEXT_PREFIX.length), key);
}
