import { describe, expect, it } from 'vitest';
import { generateDataKey } from './crypto.js';
import { decryptNodeFieldsWithKey, encryptNodeFieldsWithKey } from './nodeCrypto.js';

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
});
