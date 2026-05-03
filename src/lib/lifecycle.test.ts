/**
 * Unit tests for the shared lifecycle predicate. Covers the four states
 * documented in 008-agent-installation R-2 + 005-agent-subscription FR-004.
 */

import { describe, it, expect } from 'vitest';
import { isLifecycleActive } from './lifecycle.js';

describe('isLifecycleActive', () => {
  const now = new Date('2026-05-02T12:00:00.000Z');
  const past = new Date('2026-04-01T00:00:00.000Z');
  const future = new Date('2027-01-01T00:00:00.000Z');

  it('returns true when activated, not revoked, no expiry', () => {
    expect(
      isLifecycleActive({ activatedAt: past, revokedAt: null, expiresAt: null }, now),
    ).toBe(true);
  });

  it('returns true when activated, not revoked, expiry in the future', () => {
    expect(
      isLifecycleActive({ activatedAt: past, revokedAt: null, expiresAt: future }, now),
    ).toBe(true);
  });

  it('returns false when activatedAt is null (not yet activated)', () => {
    expect(
      isLifecycleActive({ activatedAt: null, revokedAt: null, expiresAt: null }, now),
    ).toBe(false);
  });

  it('returns false when revokedAt is set', () => {
    expect(
      isLifecycleActive({ activatedAt: past, revokedAt: past, expiresAt: null }, now),
    ).toBe(false);
  });

  it('returns false when expiresAt is in the past (or now)', () => {
    expect(
      isLifecycleActive({ activatedAt: past, revokedAt: null, expiresAt: past }, now),
    ).toBe(false);
    // Boundary: expiresAt equal to now is NOT active (strict > comparison).
    expect(
      isLifecycleActive({ activatedAt: past, revokedAt: null, expiresAt: now }, now),
    ).toBe(false);
  });

  it('uses the current Date by default when no `now` argument is supplied', () => {
    // A row with activatedAt = a long time ago, no revoke, no expiry → true
    expect(
      isLifecycleActive({
        activatedAt: new Date('2020-01-01'),
        revokedAt: null,
        expiresAt: null,
      }),
    ).toBe(true);
  });
});
