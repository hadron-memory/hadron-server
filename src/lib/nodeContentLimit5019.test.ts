/** #5019 (Billing A11): the setting's parse table and the byte measure. Red on main: the module does not exist. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isExpectedClientError, isTrustedRefusal } from '../api/graphql/formatError.js';
import { generateDataKey, encryptString, encryptJson, markCiphertext } from './crypto.js';
import {
  assertNodeContentSize, NODE_CONTENT_MAX_BYTES_ERROR, NodeContentTooLargeError, nodeContentBytes, parseNodeContentMaxBytes,
  resultingNodeContent, withEncryptedSizes,
} from './nodeContentLimit.js';

afterEach(() => vi.unstubAllEnvs());
const refused = (fields: Parameters<typeof assertNodeContentSize>[0]) => {
  try { assertNodeContentSize(fields); return null; } catch (e) { return e as NodeContentTooLargeError; }
};

describe('#5019 NODE_CONTENT_MAX_BYTES', () => {
  it.each([[undefined, null], ['', null], ['1000', 1000], ['1', 1], [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER]])(
    '%s parses', (raw, want) => expect(parseNodeContentMaxBytes(raw)).toBe(want));
  it.each(['abc', 'x7Qmarker', '0', '-1', '+1', '1.5', '1e3', '0x10', ' 10', '10 ', '010', '9007199254740992', '9'.repeat(400)])(
    '%s is refused with the fixed sentence', (raw) => expect(() => parseNodeContentMaxBytes(raw)).toThrow(new Error(NODE_CONTENT_MAX_BYTES_ERROR)));
});

describe('#5019 the measure', () => {
  it('counts UTF-8 bytes, not characters, and refuses only above the ceiling', () => {
    vi.stubEnv('NODE_CONTENT_MAX_BYTES', '1000');
    expect(refused({ content: '€'.repeat(334) })!.extensions).toEqual({ code: 'NODE_CONTENT_TOO_LARGE', maxBytes: 1000 });
    expect(refused({ content: 'a'.repeat(1000) })).toBeNull();
    expect(refused({ content: 'a'.repeat(1001) })!.message).toBe('A node can hold at most 1000 bytes.');
  });
  it('adds the four fields; null and omitted count 0', () => {
    expect(nodeContentBytes({})).toBe(0);
    expect(nodeContentBytes({ content: null, description: null, data: null, properties: null })).toBe(0);
    expect(nodeContentBytes({ content: 'ab', description: 'c', data: { a: 1 }, properties: { b: '€' } })).toBe(2 + 1 + 7 + 11);
  });
  it('a supplied field wins, null clears, an omitted one keeps the stored value', () => {
    const stored = { content: 'abc', description: 'd', data: { a: 1 }, properties: { p: 1 } };
    expect(resultingNodeContent({ content: 'z', data: null }, stored)).toEqual({ content: 'z', description: 'd', data: null, properties: { p: 1 } });
  });
  it('an encrypted field is measured at its plaintext size without a key', () => {
    const key = generateDataKey();
    for (const n of [1, 2, 3, 100]) {
      const row = { content: markCiphertext(encryptString('€'.repeat(n), key)), data: { __enc: encryptJson({ a: n }, key) }, description: 'd' };
      expect(nodeContentBytes(withEncryptedSizes(row))).toBe(3 * n + JSON.stringify({ a: n }).length + 1);
    }
    expect(nodeContentBytes(withEncryptedSizes({ content: 'plain', data: { a: 1 } }))).toBe(12);
  });
  it('is a trusted refusal, and not a Sentry fault', () => {
    const e = new NodeContentTooLargeError(5);
    expect(isTrustedRefusal(e)).toBe(true);
    expect(isExpectedClientError(e)).toBe(true);
  });
});

describe('#5160 a lazy measure', () => {
  afterEach(() => { vi.unstubAllEnvs(); });
  it('is not computed when no ceiling is set, and is judged when one is', () => {
    const fields = vi.fn(() => ({ content: 'a'.repeat(11) }));
    vi.stubEnv('NODE_CONTENT_MAX_BYTES', '');
    assertNodeContentSize(fields);
    expect(fields).not.toHaveBeenCalled();
    vi.stubEnv('NODE_CONTENT_MAX_BYTES', '10');
    expect(() => assertNodeContentSize(fields)).toThrow(NodeContentTooLargeError);
    vi.stubEnv('NODE_CONTENT_MAX_BYTES', '11');
    assertNodeContentSize(fields);
  });
});
