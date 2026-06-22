import { describe, it, expect } from 'vitest';
import {
  buildReplacer,
  replaceInTags,
  SearchReplaceInvalidPatternError,
  MAX_REGEX_SOURCE,
} from './searchReplace.js';

describe('buildReplacer — literal mode', () => {
  it('replaces every occurrence and counts them', () => {
    const r = buildReplacer('cat', 'dog');
    const { value, count } = r.apply('cat cat scatter');
    // 'scatter' contains 'cat' too → 3 matches.
    expect(count).toBe(3);
    expect(value).toBe('dog dog sdogter');
  });

  it('returns count 0 and the original string when nothing matches', () => {
    const r = buildReplacer('zzz', 'q');
    expect(r.apply('hello')).toEqual({ value: 'hello', count: 0 });
  });

  it('treats $ in newText literally (no replacement-pattern interpretation)', () => {
    const r = buildReplacer('x', '$1$&');
    expect(r.apply('axb').value).toBe('a$1$&b');
  });

  it('treats regex metacharacters in oldText literally', () => {
    const r = buildReplacer('a.c', 'Z');
    // Should NOT match 'abc' — the dot is literal.
    expect(r.apply('abc a.c').value).toBe('abc Z');
  });

  it('honors caseInsensitive', () => {
    const r = buildReplacer('cat', 'dog', { caseInsensitive: true });
    expect(r.apply('Cat CAT cat').value).toBe('dog dog dog');
  });

  it('empty newText deletes the matched text', () => {
    const r = buildReplacer('-', '');
    expect(r.apply('a-b-c').value).toBe('abc');
  });

  it('rejects an empty oldText', () => {
    expect(() => buildReplacer('', 'x')).toThrow(SearchReplaceInvalidPatternError);
  });
});

describe('buildReplacer — regex mode', () => {
  it('supports capture-group backreferences in newText', () => {
    const r = buildReplacer('(\\w+)@(\\w+)', '$2.$1', { regex: true });
    expect(r.apply('bob@acme').value).toBe('acme.bob');
  });

  it('honors caseInsensitive', () => {
    const r = buildReplacer('foo', 'bar', { regex: true, caseInsensitive: true });
    expect(r.apply('FOO foo').value).toBe('bar bar');
  });

  it('rejects a pattern that matches the empty string', () => {
    expect(() => buildReplacer('a*', 'x', { regex: true })).toThrow(
      SearchReplaceInvalidPatternError,
    );
  });

  it('rejects an uncompilable pattern', () => {
    expect(() => buildReplacer('(', 'x', { regex: true })).toThrow(
      SearchReplaceInvalidPatternError,
    );
  });

  it('rejects a pattern source over the length cap', () => {
    const long = 'a'.repeat(MAX_REGEX_SOURCE + 1);
    expect(() => buildReplacer(long, 'x', { regex: true })).toThrow(
      SearchReplaceInvalidPatternError,
    );
  });
});

describe('replaceInTags', () => {
  it('replaces within each tag element and sums the count', () => {
    const r = replaceInTags(['cat-lover', 'dog', 'cat'], buildReplacer('cat', 'feline'));
    expect(r.count).toBe(2);
    expect(r.value).toEqual(['feline-lover', 'dog', 'feline']);
  });

  it('drops a tag emptied by the replacement, leaves others verbatim', () => {
    const r = replaceInTags(['draft', 'keep'], buildReplacer('draft', ''));
    expect(r.value).toEqual(['keep']);
    expect(r.count).toBe(1);
  });

  it('returns the original array unchanged when nothing matched', () => {
    const tags = ['a', 'b'];
    const r = replaceInTags(tags, buildReplacer('zzz', 'q'));
    expect(r.value).toBe(tags); // same reference
    expect(r.count).toBe(0);
  });
});
