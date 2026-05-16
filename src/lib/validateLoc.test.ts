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

  // Spec 021 FR-016: charset loosened from [a-zA-Z0-9_-]+ to allow dots.
  // Existing data and authoring patterns are unaffected; the change is
  // additive (more inputs accepted, none rejected that were previously
  // accepted).
  it('accepts dots inside atoms (spec 021 FR-016)', () => {
    expect(() => validateLoc('a.b.c.com')).not.toThrow();
    expect(() => validateLoc('review:dot.in.segment')).not.toThrow();
    expect(() => validateLoc('foo.bar:baz_qux')).not.toThrow();
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

  it('rejects punctuation other than dot/underscore/hyphen', () => {
    expect(() => validateLoc("review:user's-notes")).toThrow(InvalidLocError);
    expect(() => validateLoc('review:render!urn')).toThrow(InvalidLocError);
  });

  it('rejects atoms with leading or trailing punctuation', () => {
    expect(() => validateLoc('.foo')).toThrow(InvalidLocError);
    expect(() => validateLoc('foo.')).toThrow(InvalidLocError);
    expect(() => validateLoc('-foo')).toThrow(InvalidLocError);
    expect(() => validateLoc('foo:_bar')).toThrow(InvalidLocError);
  });

  it('rejects empty segments (consecutive colons or trailing colon)', () => {
    expect(() => validateLoc('review::render-urn')).toThrow(InvalidLocError);
    expect(() => validateLoc('review:')).toThrow(InvalidLocError);
    expect(() => validateLoc(':review')).toThrow(InvalidLocError);
  });

  // Spec 021 FR-017: each atom is bounded at 64 chars.
  it('accepts a 64-character atom', () => {
    const sixtyFour = 'a' + 'b'.repeat(62) + 'c'; // 64 chars
    expect(sixtyFour.length).toBe(64);
    expect(() => validateLoc(sixtyFour)).not.toThrow();
    expect(() => validateLoc(`foo:${sixtyFour}`)).not.toThrow();
  });

  it('rejects a 65-character atom', () => {
    const sixtyFive = 'a' + 'b'.repeat(63) + 'c';
    expect(sixtyFive.length).toBe(65);
    expect(() => validateLoc(sixtyFive)).toThrow(InvalidLocError);
    expect(() => validateLoc(`prefix:${sixtyFive}`)).toThrow(InvalidLocError);
  });

  it('error carries the offending loc, segment, and reason', () => {
    try {
      validateLoc('review:bad seg');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidLocError);
      const err = e as InvalidLocError;
      expect(err.loc).toBe('review:bad seg');
      expect(err.segment).toBe('bad seg');
      expect(err.reason).toBe('invalid-charset');
      expect(err.name).toBe('InvalidLocError');
    }
  });

  it('error carries the too-long reason when an atom exceeds 64 chars', () => {
    const sixtyFive = 'x'.repeat(65);
    try {
      validateLoc(`review:${sixtyFive}`);
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidLocError);
      const err = e as InvalidLocError;
      expect(err.reason).toBe('too-long');
      expect(err.segment).toBe(sixtyFive);
    }
  });

  it('error carries the empty reason for an empty loc', () => {
    try {
      validateLoc('');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidLocError);
      expect((e as InvalidLocError).reason).toBe('empty');
    }
  });

  // Spec 021 note: validateLoc does NOT enforce FR-019 reserved-word
  // rejection. Node locs legitimately use type-name words as nesting
  // namespaces (e.g., `review:` for review-typed nodes). The check
  // happens at entity-create boundaries via `validateUserSlug` in urn.ts.
  it('accepts node locs that use reserved-type words as nesting namespaces', () => {
    expect(() => validateLoc('review:my-review')).not.toThrow();
    expect(() => validateLoc('prompt:greeting')).not.toThrow();
    expect(() => validateLoc('record:audit:2026-05-15')).not.toThrow();
  });
});
