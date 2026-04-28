import { describe, it, expect } from 'vitest';
import {
  encryptStorageKeyForMemory,
  decryptStorageKey,
  isEncryptedStorageKey,
} from './encryption.js';
import { generateDataKey, parseDataKey } from '../crypto.js';

const KEY_B64 = generateDataKey().raw.toString('base64');
const KEY = parseDataKey(KEY_B64);
const PLAINKEY = 'baragaun.com/secureid/abc123.pdf';

describe('asset / encryption', () => {
  it('passes plaintext through for unencrypted memories', () => {
    const out = encryptStorageKeyForMemory(PLAINKEY, { isEncrypted: false }, KEY);
    expect(out).toBe(PLAINKEY);
    expect(isEncryptedStorageKey(out)).toBe(false);
  });

  it('encrypts for encrypted memories with the enc:v1: prefix', () => {
    const out = encryptStorageKeyForMemory(PLAINKEY, { isEncrypted: true }, KEY);
    expect(out).not.toBe(PLAINKEY);
    expect(isEncryptedStorageKey(out)).toBe(true);
    expect(out.startsWith('enc:v1:')).toBe(true);
  });

  it('round-trips through encrypt → decrypt', () => {
    const enc = encryptStorageKeyForMemory(PLAINKEY, { isEncrypted: true }, KEY);
    const dec = decryptStorageKey(enc, KEY);
    expect(dec).toBe(PLAINKEY);
  });

  it('decryptStorageKey passes plaintext through unchanged', () => {
    expect(decryptStorageKey(PLAINKEY, KEY)).toBe(PLAINKEY);
    expect(decryptStorageKey(PLAINKEY, null)).toBe(PLAINKEY);
  });

  it('decryptStorageKey throws MEMORY_ENCRYPTED_NO_KEY when key is missing', () => {
    const enc = encryptStorageKeyForMemory(PLAINKEY, { isEncrypted: true }, KEY);
    expect(() => decryptStorageKey(enc, null)).toThrow(/MEMORY_ENCRYPTED_NO_KEY/);
  });

  it('is idempotent — encrypting already-encrypted is a no-op', () => {
    const enc1 = encryptStorageKeyForMemory(PLAINKEY, { isEncrypted: true }, KEY);
    const enc2 = encryptStorageKeyForMemory(enc1, { isEncrypted: true }, KEY);
    expect(enc2).toBe(enc1);
  });
});
