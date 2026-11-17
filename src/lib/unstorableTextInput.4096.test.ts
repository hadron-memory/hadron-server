/** #4096 — the shared predicate behind every typed refusal for text a write cannot store. No database. */
import { describe, expect, it } from 'vitest';
import { assertStorableText, edgeTextFields, findUnstorableText, unstorableTextMessage } from './unstorableTextInput.js';

const NUL_WHAT = 'a NUL (U+0000) character';
const SURR_WHAT = 'an unpaired UTF-16 surrogate';

describe('findUnstorableText', () => {
  it('finds a NUL in a string, an array element and the first of several fields', () => {
    expect(findUnstorableText({ content: 'a\0b' })).toEqual({ field: 'content', what: NUL_WHAT });
    expect(findUnstorableText({ tags: ['ok', 'x\0'] })).toEqual({ field: 'tags', what: NUL_WHAT });
    expect(findUnstorableText({ name: 'fine', content: '\0', description: '\0' })?.field).toBe('content');
  });
  it('finds each lone-surrogate shape: high alone, low alone, high then non-low, reversed pair', () => {
    for (const bad of ['a\ud800', '\udc00b', '\ud800x', '\udc00\ud800', 'x\ud83d']) {
      expect(findUnstorableText({ content: bad })).toEqual({ field: 'content', what: SURR_WHAT });
    }
  });
  it('admits valid pairs, ordinary controls and non-text values', () => {
    expect(findUnstorableText({ a: 'a😀b', b: '\u0001\u001f', c: ['é', '😀'], d: undefined, e: null, f: 3, g: true })).toBeNull();
    expect(findUnstorableText({ tags: [], properties: {}, data: [] })).toBeNull();
  });
  it('ignores a non-string element mixed into an array and still finds the string that fails', () => {
    expect(findUnstorableText({ tags: [1, null, 'x\0'] })?.field).toBe('tags');
    expect(findUnstorableText({ tags: [1, null, 'x'] })).toBeNull();
  });
  it('scans JSON objects recursively, keys included', () => {
    expect(findUnstorableText({ data: { a: { b: ['ok', 'v\0'] } } })).toEqual({ field: 'data', what: NUL_WHAT });
    expect(findUnstorableText({ data: { 'k\0': 1 } })).toEqual({ field: 'data', what: NUL_WHAT });
    expect(findUnstorableText({ data: { a: { b: 'fine' } } })).toBeNull();
  });
  it('never recurses without bound', () => {
    let deep: any = 'x\0';
    for (let i = 0; i < 200; i++) deep = { n: deep };
    expect(() => findUnstorableText({ data: deep })).not.toThrow();
    expect(findUnstorableText({ data: deep })).toEqual({ field: 'data', what: 'a NUL (U+0000) character' });
    let deepKey: any = { 'k\0': 1 };
    for (let i = 0; i < 200; i++) deepKey = { n: deepKey };
    expect(findUnstorableText({ data: deepKey })?.field).toBe('data');
  });
});

describe('edgeTextFields and the refusal', () => {
  it('names the exact edge field', () => {
    const fields = edgeTextFields([{ targetId: 't', name: 'ok' }, { targetId: 't', description: 'x\0' }]);
    expect(findUnstorableText(fields)).toEqual({ field: 'edges[1].description', what: NUL_WHAT });
    expect(edgeTextFields(undefined)).toEqual({});
  });
  it('the message names the field and kind, never the value', () => {
    const msg = unstorableTextMessage({ field: 'content', what: NUL_WHAT });
    expect(msg).toContain('`content`');
    expect(msg).not.toContain('SECRET');
    expect(() => assertStorableText({ content: 'SECRET\0' })).toThrowError(/content/);
    try { assertStorableText({ content: 'SECRET\0' }); } catch (e: any) {
      expect(e.extensions).toEqual({ code: 'BAD_USER_INPUT', field: 'content' });
      expect(e.message).not.toContain('SECRET');
    }
  });
});
