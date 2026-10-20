/**
 * #2138 §3.4 — the worker CHECK STATUS: whether a worker that is expected to
 * check its team channel is doing so. Derived at read time, never stored, and a
 * status only (the alarm on it is deferred).
 *
 * - `NO_SESSION`: no live session (cor:agt:020:11, the shared `isSessionLive`).
 * - `PENDING`: not expected to check, with its reason: a team pause, its own
 *   pause, isolated, on standby, or no task.
 * - `OK`: has a task and checked within `failedChecksToOverdue` × period + 5 minutes.
 * - `OVERDUE`: has a task and hasn't checked for longer than that.
 *
 * A worker HAS A TASK when a task assigned to it is open (`pending` or
 * `started`), or when its Agent has `usesTasks: false`. The OVERDUE clock runs
 * from the latest of its last check, its newest open assignment, its live
 * session's start and the end of its own pause. A team pause clears
 * `App.teamPausedAt` without recording when it ended, so ending one does not
 * restart the clock (noted on the PR).
 *
 * Experimental draft spec, not law:
 * hrn:node:hadronmemory.com:hadron-dev-team-vera:work:2138-experiment-spec
 */

import type { Prisma, PrismaClient, SessionType } from '../generated/prisma/index.js';
import { isSessionLive, loadLastEventBySession, recentlyTouchedFilter } from './sessionActivity.js';
import { s7Available } from './tickers/s7Availability.js';
import { workerStandby } from './tickers/standby.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type WorkerCheckState = 'NO_SESSION' | 'PENDING' | 'OK' | 'OVERDUE';
export type WorkerPendingReason = 'TEAM_PAUSED' | 'PAUSED' | 'ISOLATED' | 'STANDBY' | 'NO_TASK';

export type WorkerCheckStatus = {
  status: WorkerCheckState;
  pendingReason: WorkerPendingReason | null;
  /** When it last checked the App's team channel through its own session; null if never. */
  lastCheckedAt: Date | null;
};

export type WorkerCheckInputs = {
  /** Start of its newest live session; null = no live session. */
  liveSessionStartedAt: Date | null;
  /** An open task is assigned to it, or its Agent has `usesTasks: false`. */
  hasTask: boolean;
  /** Its newest open assignment, if any. */
  lastAssignedAt: Date | null;
  lastCheckedAt: Date | null;
  /** Its own pause (`WorkerWakeSettings.pausedUntil`), active while in the future. */
  pausedUntil: Date | null;
  teamPaused: boolean;
  isolated: boolean;
  standby: boolean;
};

export type CheckSettings = { checkPeriodSeconds: number; failedChecksToOverdue: number };

/** The hard-coded slack on top of the missed periods (#2138 §3.2). */
export const OVERDUE_SLACK_MS = 5 * 60_000;

/** How long after the clock starts a worker with a task turns OVERDUE. */
export function overdueAfterMs(s: CheckSettings): number {
  return s.failedChecksToOverdue * s.checkPeriodSeconds * 1000 + OVERDUE_SLACK_MS;
}

/**
 * The status from its inputs. Precedence: NO_SESSION, then PENDING reasons in
 * the order team paused (a worker can't lift it), its own pause, isolated,
 * standby, no task, then OK or OVERDUE. OK holds at
 * exactly the limit; OVERDUE starts one millisecond after it.
 */
export function deriveWorkerCheckStatus(i: WorkerCheckInputs, s: CheckSettings, now: Date): WorkerCheckStatus {
  const out = (status: WorkerCheckState, pendingReason: WorkerPendingReason | null = null): WorkerCheckStatus => ({
    status,
    pendingReason,
    lastCheckedAt: i.lastCheckedAt,
  });
  if (!i.liveSessionStartedAt) return out('NO_SESSION');
  const selfPaused = i.pausedUntil !== null && i.pausedUntil.getTime() > now.getTime();
  if (i.teamPaused) return out('PENDING', 'TEAM_PAUSED');
  if (selfPaused) return out('PENDING', 'PAUSED');
  if (i.isolated) return out('PENDING', 'ISOLATED');
  if (!i.hasTask) return out('PENDING', i.standby ? 'STANDBY' : 'NO_TASK');

  const clockStart = Math.max(
    i.lastCheckedAt?.getTime() ?? -Infinity,
    i.lastAssignedAt?.getTime() ?? -Infinity,
    i.liveSessionStartedAt.getTime(),
    // Its own pause has ended here (an active one returned PAUSED above).
    i.pausedUntil?.getTime() ?? -Infinity,
  );
  return out(now.getTime() - clockStart > overdueAfterMs(s) ? 'OVERDUE' : 'OK');
}

/** A task that makes its assignee "have a task" (cor:agt:050:02); backlog has no assignee. */
const OPEN_TASK_STATUSES = ['pending', 'started'];

/**
 * The check status of workers in one App, batched: one query per input. Only
 * `lastCheckedAt` on `teamChannelId` counts (a check of any other channel
 * doesn't); with no team channel yet, nobody has checked. Pass `workerIds` to
 * limit the read; omit it for every worker of the App.
 */
export async function loadWorkerCheckStatuses(
  db: Db,
  opts: { appId: string; teamChannelId: string | null; workerIds?: string[]; now: Date },
): Promise<Map<string, WorkerCheckStatus>> {
  const { appId, teamChannelId, now } = opts;
  const app = await db.app.findUnique({
    where: { id: appId },
    select: { deliveryCheckPeriodSeconds: true, deliveryFailedChecksToOverdue: true, teamPausedAt: true, deliveryStandbyEnabled: true },
  });
  if (!app) return new Map();
  const workers = await db.worker.findMany({
    where: { appId, ...(opts.workerIds ? { id: { in: opts.workerIds } } : {}) },
    select: { id: true, agent: { select: { usesTasks: true } } },
  });
  if (workers.length === 0) return new Map();
  const ids = workers.map((w) => w.id);

  const [sessions, tasks, readStates, wakeSettings] = await Promise.all([
    db.session.findMany({
      where: { workerId: { in: ids }, endedAt: null, deletedAt: null, ...recentlyTouchedFilter(now) },
      select: { id: true, workerId: true, type: true, startedAt: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true },
    }),
    db.agentTask.groupBy({
      by: ['assigneeWorkerId'],
      where: { appId, assigneeWorkerId: { in: ids }, status: { in: OPEN_TASK_STATUSES } },
      _max: { assignedAt: true },
    }),
    teamChannelId
      ? db.channelReadState.findMany({ where: { workerId: { in: ids }, channelId: teamChannelId }, select: { workerId: true, lastCheckedAt: true } })
      : Promise.resolve([]),
    db.workerWakeSettings.findMany({ where: { workerId: { in: ids } }, select: { workerId: true, pausedUntil: true, isolatedUntil: true } }),
  ]);

  // The same liveness predicate as the roster's liveSession and startSession's gate (cor:agt:020:11).
  const lastEvents = await loadLastEventBySession(db as never, sessions.map((s) => s.id));
  const liveStart = new Map<string, Date>();
  for (const s of sessions) {
    if (!s.workerId || !isSessionLive({ ...s, type: s.type as SessionType }, lastEvents.get(s.id), now)) continue;
    const prev = liveStart.get(s.workerId);
    if (!prev || s.startedAt > prev) liveStart.set(s.workerId, s.startedAt);
  }
  const openTask = new Map(tasks.map((t) => [t.assigneeWorkerId as string, t._max.assignedAt]));
  const checkedAt = new Map(readStates.map((r) => [r.workerId as string, r.lastCheckedAt]));
  const wake = new Map(wakeSettings.map((ws) => [ws.workerId, ws]));
  const settings = { checkPeriodSeconds: app.deliveryCheckPeriodSeconds, failedChecksToOverdue: app.deliveryFailedChecksToOverdue };
  // Standby and isolation are inert until S7b (s7Available() is false in production).
  const standbyLive = s7Available() && app.deliveryStandbyEnabled;

  const out = new Map<string, WorkerCheckStatus>();
  for (const w of workers) {
    const ws = wake.get(w.id);
    const hasOpenTask = openTask.has(w.id);
    const hasTask = hasOpenTask || !w.agent.usesTasks;
    const standby = standbyLive && !hasTask && liveStart.has(w.id) ? (await workerStandby(db, w.id)).onStandby : false;
    out.set(
      w.id,
      deriveWorkerCheckStatus(
        {
          liveSessionStartedAt: liveStart.get(w.id) ?? null,
          hasTask,
          lastAssignedAt: openTask.get(w.id) ?? null,
          lastCheckedAt: checkedAt.get(w.id) ?? null,
          pausedUntil: ws?.pausedUntil ?? null,
          teamPaused: app.teamPausedAt !== null,
          isolated: s7Available() && !!ws?.isolatedUntil && ws.isolatedUntil > now,
          standby,
        },
        settings,
        now,
      ),
    );
  }
  return out;
}

const reasonWords = (r: WorkerPendingReason): string => r.toLowerCase().replace(/_/g, ' ');

/** The short form for a roster line: `check OK`, `check PENDING (no task)`. */
export function renderCheckStatusShort(s: WorkerCheckStatus): string {
  return `check ${s.status}${s.pendingReason ? ` (${reasonWords(s.pendingReason)})` : ''}`;
}

/** The long form for a single-worker read: the status, its reason and the last check. */
export function renderCheckStatusLong(s: WorkerCheckStatus): string {
  const detail = [
    s.pendingReason ? reasonWords(s.pendingReason) : null,
    s.lastCheckedAt ? `last checked ${s.lastCheckedAt.toISOString()}` : 'never checked',
  ].filter(Boolean);
  return `Check status: ${s.status} (${detail.join('; ')})`;
}
