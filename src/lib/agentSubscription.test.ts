/**
 * Tests for the isActiveAgentSubscription predicate. Verifies the
 * spec's active-status contract (FR-004 + data-model.md §"Active-status definition").
 */

import { describe, it, expect } from 'vitest';
import { isActiveAgentSubscription } from './agentSubscription.js';

const NOW = new Date('2026-04-30T12:00:00Z');
const PAST = new Date('2026-04-29T12:00:00Z');
const FUTURE = new Date('2026-05-01T12:00:00Z');

describe('isActiveAgentSubscription', () => {
  it('returns true for an activated, non-revoked, non-expired subscription', () => {
    expect(isActiveAgentSubscription(
      { activatedAt: PAST, revokedAt: null, expiresAt: null },
      NOW,
    )).toBe(true);
  });

  it('returns true for a future-expiring subscription', () => {
    expect(isActiveAgentSubscription(
      { activatedAt: PAST, revokedAt: null, expiresAt: FUTURE },
      NOW,
    )).toBe(true);
  });

  it('returns false when activatedAt is null (deferred-activation, e.g. pre-billing)', () => {
    expect(isActiveAgentSubscription(
      { activatedAt: null, revokedAt: null, expiresAt: null },
      NOW,
    )).toBe(false);
  });

  it('returns false when revokedAt is set', () => {
    expect(isActiveAgentSubscription(
      { activatedAt: PAST, revokedAt: PAST, expiresAt: null },
      NOW,
    )).toBe(false);
  });

  it('returns false when expiresAt has passed', () => {
    expect(isActiveAgentSubscription(
      { activatedAt: PAST, revokedAt: null, expiresAt: PAST },
      NOW,
    )).toBe(false);
  });

  it('returns false when expiresAt equals now (boundary: exclusive)', () => {
    expect(isActiveAgentSubscription(
      { activatedAt: PAST, revokedAt: null, expiresAt: NOW },
      NOW,
    )).toBe(false);
  });
});
