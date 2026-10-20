/**
 * #2138 §3.4 — the worker check status, as a pure derivation: every boundary
 * the plan's acceptance list names (no session, each PENDING reason, a fresh
 * assignment after an old check, exactly `failedChecksToOverdue` × period + 5
 * minutes at the default and at a changed value, `usesTasks: false`), plus the
 * precedence between reasons and what starts the OVERDUE clock.
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
  hasTask: true,
  lastAssignedAt: ago(50 * MIN),
  lastCheckedAt: ago(1 * MIN),
  pausedUntil: null,
  teamPaused: false,
  isolated: false,
  standby: false,
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
    });
  });

  it('wins over every PENDING reason (NO_SESSION is never PENDING or OVERDUE)', () => {
    expect(derive({ liveSessionStartedAt: null, hasTask: false, teamPaused: true, isolated: true }).status).toBe('NO_SESSION');
  });
});

describe('PENDING, with its reason', () => {
  it('NO_TASK: no open task and the Agent uses tasks', () => {
    expect(derive({ hasTask: false, lastAssignedAt: null, lastCheckedAt: null })).toEqual({
      status: 'PENDING',
      pendingReason: 'NO_TASK',
      lastCheckedAt: null,
    });
  });

  it('STANDBY: no task, and on standby', () => {
    expect(derive({ hasTask: false, lastAssignedAt: null, standby: true })).toMatchObject({ status: 'PENDING', pendingReason: 'STANDBY' });
  });

  it('PAUSED by its own pause, even with a task and a stale check', () => {
    expect(derive({ pausedUntil: new Date(now.getTime() + MIN), lastCheckedAt: ago(5 * 60 * MIN) })).toMatchObject({
      status: 'PENDING',
      pendingReason: 'PAUSED',
    });
  });

  it('TEAM_PAUSED by a team pause, separate from the worker\'s own pause', () => {
    expect(derive({ teamPaused: true, lastCheckedAt: ago(5 * 60 * MIN) })).toMatchObject({ status: 'PENDING', pendingReason: 'TEAM_PAUSED' });
  });

  it('ISOLATED, even with a task', () => {
    expect(derive({ isolated: true, lastCheckedAt: ago(5 * 60 * MIN) })).toMatchObject({ status: 'PENDING', pendingReason: 'ISOLATED' });
  });

  it('precedence: TEAM_PAUSED over PAUSED over ISOLATED over STANDBY over NO_TASK', () => {
    const idle = { hasTask: false, lastAssignedAt: null };
    const selfPause = { pausedUntil: new Date(now.getTime() + MIN) };
    expect(derive({ ...idle, ...selfPause, teamPaused: true, isolated: true, standby: true }).pendingReason).toBe('TEAM_PAUSED');
    expect(derive({ ...idle, ...selfPause, isolated: true, standby: true }).pendingReason).toBe('PAUSED');
    expect(derive({ ...idle, isolated: true, standby: true }).pendingReason).toBe('ISOLATED');
    expect(derive({ ...idle, standby: true }).pendingReason).toBe('STANDBY');
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

  it('usesTasks: false counts as having a task (the loader sets hasTask), with no assignment at all', () => {
    expect(derive({ hasTask: true, lastAssignedAt: null, lastCheckedAt: ago(30 * MIN) }).status).toBe('OVERDUE');
    expect(derive({ hasTask: true, lastAssignedAt: null, lastCheckedAt: ago(2 * MIN) }).status).toBe('OK');
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

  it('a check in the future (clock skew) is not OVERDUE', () => {
    expect(derive({ lastCheckedAt: new Date(now.getTime() + MIN) }).status).toBe('OK');
  });
});
