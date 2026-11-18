import { describe, expect, it } from 'vitest';
import { generateDataKey } from './crypto.js';
import { decryptNodeFields, decryptNodeFieldsWithKey, encryptNodeFields, encryptNodeFieldsWithKey, SessionExpiredError } from './nodeCrypto.js';

describe('authenticated node envelopes', () => {
  it('encrypts marker-shaped plaintext instead of trusting its marker', () => {
    const key = generateDataKey();
    const plain = {
      content: 'enc:v1:not ciphertext',
      abstract: 'enc:v1:still an abstract',
      data: { __enc: 'ordinary value', detail: 'not an envelope' },
    };
    const stored = encryptNodeFieldsWithKey(plain, key);
    expect(stored.content).not.toBe(plain.content);
    expect(stored.abstract).not.toBe(plain.abstract);
    expect(stored.data).not.toEqual(plain.data);
    expect(decryptNodeFieldsWithKey({ ...stored }, key)).toEqual(plain);
    expect(encryptNodeFieldsWithKey(stored, key)).toEqual(stored);
  });

  it('rejects a wrong key for every stored envelope field', () => {
    const key = generateDataKey();
    const wrongKey = generateDataKey();
    const stored = encryptNodeFieldsWithKey({
      content: 'secret content', abstract: 'secret abstract', data: { secret: true },
    }, key);
    expect(() => decryptNodeFieldsWithKey({ content: stored.content }, wrongKey)).toThrow();
    expect(() => decryptNodeFieldsWithKey({ abstract: stored.abstract }, wrongKey)).toThrow();
    expect(() => decryptNodeFieldsWithKey({ data: stored.data }, wrongKey)).toThrow();
  });
});

describe('#3136 — a keyless encrypted memory refuses at the source with the typed class', () => {
  // The local seat's mutant M5: reverting encryptNodeFields' throw to a bare
  // Error('SESSION_EXPIRED: …') left the whole suite green — the class mapping
  // and the decrypt path had pins (formatError.test.ts, the recovery HTTP leg),
  // but nothing drove a keyless WRITE. These pins hold both throw sites at the
  // source, so the bare-Error mutant dies here. The memory ids are unique to
  // this file, so sessionKeyCache never holds a key for them.
  it('encryptNodeFields throws SessionExpiredError with the memoryId', () => {
    let caught: unknown;
    try {
      encryptNodeFields({ content: 'x' }, { id: 'mem_keyless_write_3136', isEncrypted: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionExpiredError);
    expect((caught as SessionExpiredError).memoryId).toBe('mem_keyless_write_3136');
    expect((caught as Error).message.startsWith('SESSION_EXPIRED')).toBe(true);
  });

  it('decryptNodeFields throws SessionExpiredError with the memoryId', () => {
    let caught: unknown;
    try {
      decryptNodeFields({ content: 'enc:v1:x' }, { id: 'mem_keyless_read_3136', isEncrypted: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionExpiredError);
    expect((caught as SessionExpiredError).memoryId).toBe('mem_keyless_read_3136');
    expect((caught as Error).message.startsWith('SESSION_EXPIRED')).toBe(true);
  });
});
