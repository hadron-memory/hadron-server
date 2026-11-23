/**
 * #435 — the boolean tsquery compiler is bounded (ruling Holger 2026-11-22: 512 raw characters, 64 leaves, depth 8).
 *
 * Structure overflow is a BooleanQueryError (the findNodes literal fallback answers it, never a bare RangeError 500);
 * the raw length bound is a BAD_USER_INPUT refusal, never a truncation. The limits are exact: the value itself is
 * accepted, one more is refused.
 */
import { describe, it, expect } from 'vitest';
import {
  BooleanQueryError, MAX_DEPTH, MAX_LEAVES, MAX_QUERY_CHARS, QueryTooLongError, UnindexableQueryError, assertQueryLength, compileBooleanQuery,
} from './tsquery.js';

const terms = (n: number) => Array.from({ length: n }, (_, i) => `w${i}x`).join(' ');
const nested = (d: number) => '('.repeat(d) + 'a' + ')'.repeat(d);

describe('#435 limits are the ruled numbers', () => {
  it('exports 512 / 64 / 8', () => {
    expect([MAX_QUERY_CHARS, MAX_LEAVES, MAX_DEPTH]).toEqual([512, 64, 8]);
  });
});

describe('#435 structure overflow is a BooleanQueryError, never a stack overflow', () => {
  it('5000 nested parens', () => {
    expect(() => compileBooleanQuery(nested(5000), 1)).toThrow(BooleanQueryError);
  });
  it('100k plain terms', () => {
    expect(() => compileBooleanQuery(terms(100_000), 1)).toThrow(BooleanQueryError);
  });
  it('64 leaves compile, 65 do not', () => {
    expect(compileBooleanQuery(terms(64), 1).params).toHaveLength(64);
    expect(() => compileBooleanQuery(terms(65), 1)).toThrow(BooleanQueryError);
  });
  it('depth 8 compiles, depth 9 does not (parens)', () => {
    expect(compileBooleanQuery(nested(8), 1).params).toEqual(['a']);
    expect(() => compileBooleanQuery(nested(9), 1)).toThrow(BooleanQueryError);
  });
  it('NOT nesting counts toward depth', () => {
    expect(compileBooleanQuery(`${'NOT '.repeat(8)}a`, 1).params).toEqual(['a']);
    expect(() => compileBooleanQuery(`${'NOT '.repeat(9)}a`, 1)).toThrow(BooleanQueryError);
  });
  it('a refused structure is refused before anything is compiled for a megabyte of input', () => {
    expect(() => compileBooleanQuery('a '.repeat(500_000), 1)).toThrow(BooleanQueryError);
  });
  it('defence in depth: input over cap + 2 is refused by the compiler itself (a literal fallback of 512 chars still fits)', () => {
    expect(() => compileBooleanQuery('x'.repeat(MAX_QUERY_CHARS + 3), 1)).toThrow(BooleanQueryError);
    expect(compileBooleanQuery(`"${'x'.repeat(MAX_QUERY_CHARS)}"`, 1).params).toHaveLength(1);
  });
});

describe('#435 the raw length bound is a refusal, not a truncation', () => {
  it('512 characters pass, 513 refuse with BAD_USER_INPUT', () => {
    expect(() => assertQueryLength('x'.repeat(512))).not.toThrow();
    let err: unknown;
    try { assertQueryLength('x'.repeat(513)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(QueryTooLongError);
    expect((err as QueryTooLongError).extensions.code).toBe('BAD_USER_INPUT');
    expect(err).not.toBeInstanceOf(BooleanQueryError);
  });
  it('the unindexable refusal is typed BAD_USER_INPUT and is not a BooleanQueryError (the literal fallback must not swallow it)', () => {
    const e = new UnindexableQueryError();
    expect(e.extensions.code).toBe('BAD_USER_INPUT');
    expect(e).not.toBeInstanceOf(BooleanQueryError);
  });
});

describe('#435 existing grammar is unchanged within the limits', () => {
  it.each(['memory NOT chat', 'memory -chat', 'a OR (b -c)', '"a phrase" AND (b OR c)'])('%s still compiles', (q) => {
    expect(() => compileBooleanQuery(q, 1)).not.toThrow();
  });
});
