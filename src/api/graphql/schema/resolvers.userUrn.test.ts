/**
 * Unit tests for the computed `User.urn` field (#325 / spec cor:urn:010:01).
 * The URN is `hrn:user:<handle>`; a handle-less user has no URN.
 */
import { describe, it, expect } from 'vitest';
import { resolvers } from './resolvers.js';

const userUrn = resolvers.User.urn as (u: { handle?: string | null }) => string | null;

describe('User.urn', () => {
  it('computes the canonical hrn:user:<handle> URN from the handle', () => {
    expect(userUrn({ handle: 'holger' })).toBe('hrn:user:holger');
  });

  it('is null for a handle-less user', () => {
    expect(userUrn({ handle: null })).toBeNull();
    expect(userUrn({})).toBeNull();
  });
});
