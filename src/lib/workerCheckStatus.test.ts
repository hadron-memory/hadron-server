/**
 * #2138 §3.4 — the worker check status, as a pure derivation: every boundary
 * the plan's acceptance list names (no session, each PENDING reason, a fresh
 * assignment after an old check, exactly `failedChecksToOverdue` × period + 5
 * minutes at the default and at a changed value), plus what starts the OVERDUE
 * clock. Which reason applies, and in what order, is `loadPendingReasons`
 * (the ticker's), exercised end to end in resolvers.workerCheckStatus2138.test.ts.
 *
 * The draft spec is hrn:node:hadronmemory.com:hadron-dev-team-vera:work:2138-experiment-spec.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveWorkerCheckStatus,
  overdueAfterMs,
  OVERDUE_SLACK_MS,
  type WorkerCheckInputs,
} from './workerCheckStatus.js';

const MIN = 60_000;
const now = new Date('2026-10-20T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);
const DEFAULTS = { checkPeriodSeconds: 600, failedChecksToOverdue: 2 };

/** A live worker with a task that checked a minute ago. Each test changes one thing. */
const base = (over: Partial<WorkerCheckInputs> = {}): WorkerCheckInputs => ({
  liveSessionStartedAt: ago(60 * MIN),
  pendingReason: null,
  lastAssignedAt: ago(50 * MIN),
  lastCheckedAt: ago(1 * MIN),
  pausedUntil: null,
  ...over,
});

const derive = (over: Partial<WorkerCheckInputs> = {}, settings = DEFAULTS) =>
  deriveWorkerCheckStatus(base(over), settings, now);

describe('overdueAfterMs: failedChecksToOverdue × period + 5 minutes', () => {
  it('is 25 minutes at the defaults (2 × 600 s + 5 min)', () => {
    expect(OVERDUE_SLACK_MS).toBe(5 * MIN);
    expect(overdueAfterMs(DEFAULTS)).toBe(25 * MIN);
  });

  it('follows changed settings (3 × 120 s + 5 min = 11 min)', () => {
    expect(overdueAfterMs({ checkPeriodSeconds: 120, failedChecksToOverdue: 3 })).toBe(11 * MIN);
  });
});

describe('NO_SESSION', () => {
  it('a worker with no live session, even with a task and a stale check', () => {
    expect(derive({ liveSessionStartedAt: null, lastCheckedAt: ago(10 * 60 * MIN) })).toEqual({
      status: 'NO_SESSION',
      pendingReason: null,
      lastCheckedAt: ago(10 * 60 * MIN),
      resumedAt: null,
    });
  });

  it('wins over every PENDING reason (NO_SESSION is never PENDING or OVERDUE)', () => {
    expect(derive({ liveSessionStartedAt: null, pendingReason: 'TEAM_PAUSED' }).status).toBe('NO_SESSION');
  });
});

describe('PENDING, with its reason', () => {
  it.each(['TEAM_PAUSED', 'PAUSED', 'ISOLATED', 'STANDBY', 'NO_TASK'] as const)('%s, even with a stale check', (reason) => {
    expect(derive({ pendingReason: reason, lastCheckedAt: ago(5 * 60 * MIN) })).toMatchObject({
      status: 'PENDING',
      pendingReason: reason,
      lastCheckedAt: ago(5 * 60 * MIN),
    });
  });

  it('a self-pause that has already ended does not pause', () => {
    expect(derive({ pausedUntil: ago(MIN) }).status).toBe('OK');
  });
});

describe('OK and OVERDUE at the boundary', () => {
  it('OK at exactly the limit, OVERDUE one millisecond past it (defaults)', () => {
    expect(derive({ lastCheckedAt: ago(25 * MIN), lastAssignedAt: ago(90 * MIN) }).status).toBe('OK');
    expect(derive({ lastCheckedAt: ago(25 * MIN + 1), lastAssignedAt: ago(90 * MIN) }).status).toBe('OVERDUE');
  });

  it('OK at exactly the limit, OVERDUE one millisecond past it (changed settings)', () => {
    const settings = { checkPeriodSeconds: 120, failedChecksToOverdue: 3 };
    expect(derive({ lastCheckedAt: ago(11 * MIN), lastAssignedAt: ago(90 * MIN) }, settings).status).toBe('OK');
    expect(derive({ lastCheckedAt: ago(11 * MIN + 1), lastAssignedAt: ago(90 * MIN) }, settings).status).toBe('OVERDUE');
  });

  it('with no assignment at all (usesTasks: false), the last check alone runs the clock', () => {
    expect(derive({ lastAssignedAt: null, lastCheckedAt: ago(30 * MIN) }).status).toBe('OVERDUE');
    expect(derive({ lastAssignedAt: null, lastCheckedAt: ago(2 * MIN) }).status).toBe('OK');
  });
});

describe('the OVERDUE clock: the latest of the last check, the assignment, the session start and a self-pause ending', () => {
  it('a fresh assignment to a worker that last checked long ago is OK until the clock runs out', () => {
    const longAgo = ago(6 * 60 * MIN);
    expect(derive({ lastCheckedAt: longAgo, lastAssignedAt: ago(2 * MIN) }).status).toBe('OK');
    expect(derive({ lastCheckedAt: longAgo, lastAssignedAt: ago(25 * MIN + 1) }).status).toBe('OVERDUE');
  });

  it('a worker that never checked counts from its assignment', () => {
    expect(derive({ lastCheckedAt: null, lastAssignedAt: ago(10 * MIN) }).status).toBe('OK');
    expect(derive({ lastCheckedAt: null, lastAssignedAt: ago(26 * MIN) }).status).toBe('OVERDUE');
  });

  it('a new session restarts the clock', () => {
    expect(derive({ lastCheckedAt: ago(3 * 60 * MIN), lastAssignedAt: ago(3 * 60 * MIN), liveSessionStartedAt: ago(5 * MIN) }).status).toBe('OK');
  });

  it('a self-pause ending restarts the clock', () => {
    const stale = { lastCheckedAt: ago(3 * 60 * MIN), lastAssignedAt: ago(3 * 60 * MIN), liveSessionStartedAt: ago(4 * 60 * MIN) };
    expect(derive({ ...stale, pausedUntil: ago(5 * MIN) }).status).toBe('OK');
    expect(derive({ ...stale, pausedUntil: ago(26 * MIN) }).status).toBe('OVERDUE');
  });

  it('a TEAM pause ending restarts the clock: a stale worker is not OVERDUE the moment it lifts', () => {
    const stale = { lastCheckedAt: ago(3 * 60 * MIN), lastAssignedAt: ago(3 * 60 * MIN), liveSessionStartedAt: ago(4 * 60 * MIN) };
    expect(derive({ ...stale }).status).toBe('OVERDUE'); // without a recorded resume
    expect(derive({ ...stale, teamResumedAt: ago(5 * MIN) }).status).toBe('OK');
    expect(derive({ ...stale, teamResumedAt: ago(26 * MIN) }).status).toBe('OVERDUE');
    expect(derive({ ...stale, pendingReason: 'TEAM_PAUSED', teamResumedAt: ago(5 * MIN) }).status).toBe('PENDING'); // still paused wins
  });

  it('a check in the future (clock skew) is not OVERDUE', () => {
    expect(derive({ lastCheckedAt: new Date(now.getTime() + MIN) }).status).toBe('OK');
  });
});

describe('resumedAt (#2755): the end of exempt time', () => {
  it('is the latest of the live session start and the ended pause, team pause and stop', () => {
    const r = derive({ liveSessionStartedAt: ago(100 * MIN), pausedUntil: ago(40 * MIN), teamResumedAt: ago(30 * MIN), stopEndedAt: ago(50 * MIN) }).resumedAt;
    expect(r).toEqual(ago(30 * MIN));
  });
  it('ignores a pause that has not ended yet', () => {
    expect(derive({ liveSessionStartedAt: ago(100 * MIN), pausedUntil: new Date(now.getTime() + 10 * MIN) }).resumedAt).toEqual(ago(100 * MIN));
  });
});
