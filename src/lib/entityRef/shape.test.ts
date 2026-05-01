import { describe, it, expect } from 'vitest';
import { isUrn } from './shape.js';

describe('isUrn', () => {
  it('returns false for an empty string', () => {
    expect(isUrn('')).toBe(false);
  });

  it('returns false for a UUIDv7-shaped hex string (no colon)', () => {
    expect(isUrn('a1b2c3d4e5f6789012345678901234ab')).toBe(false);
    expect(isUrn('abc')).toBe(false);
  });

  it('returns true for a bare URN (one colon)', () => {
    expect(isUrn('org-foo:family-mealplan')).toBe(true);
  });

  it('returns true for a URN with multiple colons', () => {
    expect(isUrn('org-foo:agent-bar:role-baz')).toBe(true);
  });

  it('returns true for a prefixed URN form', () => {
    expect(isUrn('urn:memory:org-foo:family-mealplan')).toBe(true);
    expect(isUrn('urn:agent:org-foo:agent-bar')).toBe(true);
  });
});
