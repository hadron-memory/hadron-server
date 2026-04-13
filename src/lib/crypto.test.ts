import { describe, it, expect } from 'vitest';
import {
  encryptString,
  decryptString,
  encryptJson,
  decryptJson,
  generateDataKey,
  parseDataKey,
  markCiphertext,
  isCiphertext,
  stripCiphertextPrefix,
} from './crypto.js';

describe('crypto', () => {
  describe('encryptString / decryptString', () => {
    it('round-trips an empty string', () => {
      const key = generateDataKey();
      const ct = encryptString('', key);
      expect(decryptString(ct, key)).toBe('');
    });

    it('round-trips a short string', () => {
      const key = generateDataKey();
      const ct = encryptString('hello', key);
      expect(decryptString(ct, key)).toBe('hello');
    });

    it('round-trips unicode content', () => {
      const key = generateDataKey();
      const text = 'héllo 🌍 こんにちは';
      const ct = encryptString(text, key);
      expect(decryptString(ct, key)).toBe(text);
    });

    it('round-trips a large string', () => {
      const key = generateDataKey();
      const text = 'a'.repeat(100_000);
      const ct = encryptString(text, key);
      expect(decryptString(ct, key)).toBe(text);
    });

    it('produces different ciphertexts for the same plaintext (random IV)', () => {
      const key = generateDataKey();
      const ct1 = encryptString('same plaintext', key);
      const ct2 = encryptString('same plaintext', key);
      expect(ct1).not.toBe(ct2);
    });

    it('fails to decrypt with the wrong key', () => {
      const key1 = generateDataKey();
      const key2 = generateDataKey();
      const ct = encryptString('secret', key1);
      expect(() => decryptString(ct, key2)).toThrow();
    });

    it('fails to decrypt tampered ciphertext', () => {
      const key = generateDataKey();
      const ct = encryptString('secret', key);
      // Flip a byte in the middle
      const buf = Buffer.from(ct, 'base64');
      buf[buf.length - 1] ^= 0xff;
      const tampered = buf.toString('base64');
      expect(() => decryptString(tampered, key)).toThrow();
    });

    it('rejects unsupported version bytes', () => {
      const key = generateDataKey();
      const ct = encryptString('secret', key);
      const buf = Buffer.from(ct, 'base64');
      buf[0] = 0x99; // invalid version
      expect(() => decryptString(buf.toString('base64'), key)).toThrow(/version/);
    });
  });

  describe('encryptJson / decryptJson', () => {
    it('round-trips a JSON object', () => {
      const key = generateDataKey();
      const obj = { name: 'Alice', age: 30, tags: ['a', 'b'], nested: { ok: true } };
      const ct = encryptJson(obj, key);
      expect(decryptJson(ct, key)).toEqual(obj);
    });

    it('passes null through unchanged', () => {
      const key = generateDataKey();
      expect(encryptJson(null, key)).toBeNull();
      expect(decryptJson(null, key)).toBeNull();
    });
  });

  describe('parseDataKey', () => {
    it('accepts a 32-byte base64 key', () => {
      const key = generateDataKey();
      const b64 = key.raw.toString('base64');
      const parsed = parseDataKey(b64);
      expect(parsed.raw.length).toBe(32);
      expect(parsed.raw.equals(key.raw)).toBe(true);
    });

    it('rejects the wrong length', () => {
      const short = Buffer.alloc(16).toString('base64');
      expect(() => parseDataKey(short)).toThrow(/Invalid data key/);
    });
  });

  describe('ciphertext prefix', () => {
    it('marks and detects ciphertext', () => {
      const marked = markCiphertext('abc');
      expect(isCiphertext(marked)).toBe(true);
      expect(isCiphertext('plain text')).toBe(false);
      expect(isCiphertext(null)).toBe(false);
      expect(stripCiphertextPrefix(marked)).toBe('abc');
    });

    it('refuses to strip from a non-ciphertext value', () => {
      expect(() => stripCiphertextPrefix('plain')).toThrow();
    });
  });
});
