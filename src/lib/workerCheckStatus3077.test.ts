/**
 * #3077 — the NO_SESSION reason in the pure derivation and the renderings.
 * The classification from session rows is pinned end to end in
 * src/api/graphql/schema/resolvers.workerNoSessionReason3077.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveWorkerCheckStatus,
  renderCheckStatusLong,
  renderCheckStatusShort,
  type WorkerCheckInputs,
  type WorkerCheckStatus,
} from './workerCheckStatus.js';

const MIN = 60_000;
const now = new Date('2026-11-01T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const SETTINGS = { checkPeriodSeconds: 600, failedChecksToOverdue: 2 };
const base = (over: Partial<WorkerCheckInputs> = {}): WorkerCheckInputs => ({
  liveSessionStartedAt: ago(60 * MIN),
  pendingReason: null,
  lastAssignedAt: ago(50 * MIN),
  lastCheckedAt: ago(1 * MIN),
  pausedUntil: null,
  ...over,
});

describe('deriveWorkerCheckStatus carries noSessionReason only on NO_SESSION', () => {
  it.each(['IDLE', 'ENDED', 'NEVER_BOUND'] as const)('NO_SESSION %s', (reason) => {
    const s = deriveWorkerCheckStatus(base({ liveSessionStartedAt: null, noSessionReason: reason }), SETTINGS, now);
    expect(s).toMatchObject({ status: 'NO_SESSION', pendingReason: null, noSessionReason: reason });
  });

  it('a live worker never carries one, even if an input says so', () => {
    for (const over of [{}, { pendingReason: 'NO_TASK' as const }, { lastCheckedAt: ago(10 * 60 * MIN), lastAssignedAt: ago(10 * 60 * MIN) }]) {
      const s = deriveWorkerCheckStatus(base({ ...over, noSessionReason: 'IDLE' }), SETTINGS, now);
      expect(s.status).not.toBe('NO_SESSION');
      expect(s.noSessionReason).toBeNull();
    }
  });
});

describe('renderings', () => {
  const st = (over: Partial<WorkerCheckStatus>): WorkerCheckStatus => ({
    status: 'NO_SESSION', pendingReason: null, noSessionReason: null, lastCheckedAt: null, resumedAt: null, ...over,
  });

  it('short form: check NO_SESSION (idle | ended | never bound)', () => {
    expect(renderCheckStatusShort(st({ noSessionReason: 'IDLE' }))).toBe('check NO_SESSION (idle)');
    expect(renderCheckStatusShort(st({ noSessionReason: 'ENDED' }))).toBe('check NO_SESSION (ended)');
    expect(renderCheckStatusShort(st({ noSessionReason: 'NEVER_BOUND' }))).toBe('check NO_SESSION (never bound)');
    expect(renderCheckStatusShort(st({}))).toBe('check NO_SESSION');
  });

  it('long form shows it as it shows a PENDING reason', () => {
    expect(renderCheckStatusLong(st({ noSessionReason: 'IDLE' }))).toBe('Check status: NO_SESSION (idle; never checked)');
    expect(renderCheckStatusLong(st({ noSessionReason: 'ENDED', lastCheckedAt: ago(MIN) }))).toBe(
      `Check status: NO_SESSION (ended; last checked ${ago(MIN).toISOString()})`,
    );
    expect(renderCheckStatusLong(st({ status: 'PENDING', pendingReason: 'NO_TASK' }))).toBe('Check status: PENDING (no task; never checked)');
  });
});
