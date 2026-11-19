/**
 * #3130 (carried from #3134, §10 P3): `refHasUnstorableChars` rejects only
 * NUL and LONE surrogates. Well-formed non-ASCII (a valid surrogate pair, an
 * accented letter) is storable and must not be refused, so a guard broadened
 * to "any non-ASCII" cannot survive these pins.
 */
import { describe, expect, it } from 'vitest';
import { refHasUnstorableChars } from './refNamesNothing.js';

describe('refHasUnstorableChars', () => {
  it.each([
    ['NUL', 'hrn:org:a\0b'],
    ['lone high surrogate', 'hrn:org:a\uD800b'],
    ['lone low surrogate', 'hrn:org:a\uDC00b'],
    ['trailing lone high surrogate', 'hrn:org:ab\uD800'],
    ['leading lone low surrogate', '\uDC00hrn:org:ab'],
  ])('%s is unstorable', (_label, ref) => {
    expect(refHasUnstorableChars(ref)).toBe(true);
  });

  it.each([
    ['plain ASCII', 'hrn:org:abc'],
    ['a valid surrogate pair', 'hrn:org:a😀b'],
    ['an accented letter (é)', 'hrn:org:café'],
    ['CJK', 'hrn:org:中文'],
  ])('%s is storable', (_label, ref) => {
    expect(refHasUnstorableChars(ref)).toBe(false);
  });
});
