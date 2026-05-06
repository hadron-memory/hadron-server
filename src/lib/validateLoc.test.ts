import { describe, expect, it } from 'vitest';
import { validateLoc, InvalidLocError } from './validateLoc.js';

describe('validateLoc', () => {
  it('accepts a single-segment lower-kebab loc', () => {
    expect(() => validateLoc('sort-imports')).not.toThrow();
  });

  it('accepts a multi-segment loc with hyphens and underscores', () => {
    expect(() => validateLoc('review:render-urn')).not.toThrow();
    expect(() => validateLoc('review:render_urn')).not.toThrow();
    expect(() => validateLoc('a:b:c:d:e')).not.toThrow();
  });

  it('accepts mixed case and digits', () => {
    expect(() => validateLoc('Review42:Item-3')).not.toThrow();
  });

  it('rejects empty loc', () => {
    expect(() => validateLoc('')).toThrow(InvalidLocError);
  });

  it('rejects whitespace in segments', () => {
    expect(() => validateLoc('review notes')).toThrow(InvalidLocError);
    expect(() => validateLoc('foo:bar baz')).toThrow(InvalidLocError);
  });

  it('rejects forward slashes', () => {
    expect(() => validateLoc('review/render-urn')).toThrow(InvalidLocError);
  });

  it('rejects punctuation', () => {
    expect(() => validateLoc("review:user's-notes")).toThrow(InvalidLocError);
    expect(() => validateLoc('review:render!urn')).toThrow(InvalidLocError);
    expect(() => validateLoc('review:dot.in.segment')).toThrow(InvalidLocError);
  });

  it('rejects empty segments (consecutive colons or trailing colon)', () => {
    expect(() => validateLoc('review::render-urn')).toThrow(InvalidLocError);
    expect(() => validateLoc('review:')).toThrow(InvalidLocError);
    expect(() => validateLoc(':review')).toThrow(InvalidLocError);
  });

  it('error carries the offending loc and segment', () => {
    try {
      validateLoc('review:bad seg');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidLocError);
      expect((e as InvalidLocError).loc).toBe('review:bad seg');
      expect((e as InvalidLocError).segment).toBe('bad seg');
      expect((e as InvalidLocError).name).toBe('InvalidLocError');
    }
  });
});
