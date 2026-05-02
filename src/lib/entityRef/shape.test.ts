import { describe, it, expect } from 'vitest';
import { isId } from './shape.js';

describe('isId', () => {
  it('returns true for a 32-lowercase-hex-char string (UUIDv7 hex form)', () => {
    expect(isId('a1b2c3d4e5f6789012345678901234ab')).toBe(true);
    expect(isId('00000000000000000000000000000000')).toBe(true);
  });

  it('returns true for a cuid (25 chars, starts with c)', () => {
    expect(isId('clxxxxxxxxxxxxxxxxxxxxxxx')).toBe(true);
    expect(isId('c0123456789abcdefghijklmn')).toBe(true);
  });

  it('returns false for cuid-shaped strings of the wrong length', () => {
    expect(isId('cabc')).toBe(false);                          // too short
    expect(isId('cabcdefghijklmnopqrstuvwxyz')).toBe(false);   // too long
  });

  it('returns false for cuid-shaped strings starting with the wrong char', () => {
    expect(isId('xxxxxxxxxxxxxxxxxxxxxxxxx')).toBe(false);     // 25 chars but not c-prefix
  });

  it('returns false for hex strings of the wrong length', () => {
    expect(isId('a1b2c3')).toBe(false);                         // too short
    expect(isId('a1b2c3d4e5f6789012345678901234abcd')).toBe(false); // too long
  });

  it('returns false for strings containing non-hex/non-alphanumeric chars', () => {
    expect(isId('a1b2c3d4e5f6789012345678901234aZ')).toBe(false); // uppercase
    expect(isId('A1B2C3D4E5F6789012345678901234AB')).toBe(false); // uppercase hex (canonical form is lowercase)
  });

  it('returns false for the empty string', () => {
    expect(isId('')).toBe(false);
  });

  it('returns false for bare URNs (any colon disqualifies)', () => {
    expect(isId('org-foo:family-mealplan')).toBe(false);
    expect(isId('org-foo:agent-bar:role-baz')).toBe(false);
  });

  it('returns false for prefixed URNs', () => {
    expect(isId('urn:memory:org-foo:family-mealplan')).toBe(false);
  });

  it('returns false for domain-shaped or slug-shaped org URNs', () => {
    // The reason this heuristic exists: org URNs may be simple slugs
    // without a colon. Both must dispatch to URN lookup, not ID.
    expect(isId('hadronmemory.com')).toBe(false);
    expect(isId('org-a')).toBe(false);
  });
});
