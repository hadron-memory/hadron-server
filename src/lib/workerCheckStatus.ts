/**
 * #2138 §3.4 — the worker CHECK STATUS: whether a worker that is expected to
 * check its team channel is doing so. Derived at read time, never stored, and a
 * status only (the alarm on it is deferred).
 *
 * - `NO_SESSION`: no live session (cor:agt:020:11, the shared `isSessionLive`),
 *   with its reason (#3077): IDLE, ENDED or NEVER_BOUND (`loadNoSessionReasons`).
 * - `PENDING`: not expected to check, with its reason: a team pause, its own
 *   pause, isolated, on standby, or no task. The reasons come from the ticker's
 *   own `loadPendingReasons`, so the roster and the `live-check` rule can't
 *   disagree about who is expected to check.
 * - `OK`: has a task and checked within `failedChecksToOverdue` × period + 5 minutes.
 * - `OVERDUE`: has a task and hasn't checked for longer than that.
 *
 * A worker HAS A TASK when a task assigned to it is open (`pending` or
 * `started`), or when its Agent has `usesTasks: false`. The OVERDUE clock runs
 * from the latest of its last check, its newest open assignment, its live
 * session's start, the end of its own pause and the end of a team pause
 * (`App.teamResumedAt`), so no worker turns OVERDUE the moment a pause lifts.
 *
 * Experimental draft spec, not law:
 * hrn:node:hadronmemory.com:hadron-dev-team-vera:work:2138-experiment-spec
 */

import { Prisma, type PrismaClient, type SessionType } from '../generated/prisma/index.js';
import { isSessionLive, loadLastEventBySession, recentlyTouchedFilter } from './sessionActivity.js';
import { loadPendingReasons, type PendingReason } from './tickers/checkPending.js';

type Db = PrismaClient | Prisma.TransactionClient;

export type WorkerCheckState = 'NO_SESSION' | 'PENDING' | 'OK' | 'OVERDUE';
export type WorkerPendingReason = PendingReason;
/**
 * #3077 — why a worker reads NO_SESSION (cor:agt:100:03; idle vs ended per cor:agt:020:03):
 * - `IDLE`: it has an open session that would bind it again, but nobody drove it inside its idle window;
 * - `ENDED`: every session it has had is over: ended, auto-expired, or past its promised `expiresAt`;
 * - `NEVER_BOUND`: it has never had a session (soft-deleted sessions count for nothing).
 */
export type WorkerNoSessionReason = 'IDLE' | 'ENDED' | 'NEVER_BOUND';

export type WorkerCheckStatus = {
  status: WorkerCheckState;
  pendingReason: WorkerPendingReason | null;
  /** #3077: set only when status is NO_SESSION. */
  noSessionReason: WorkerNoSessionReason | null;
  /** When it last checked the App's team channel through its own session; null if never. */
  lastCheckedAt: Date | null;
  /**
   * #2755: the latest moment the worker became expected to check again: its live session's start, the end of its own
   * pause, of a team pause and of a stop signal. Time before it is exempt time, so a wake's age never counts it.
   */
  resumedAt: Date | null;
};

export type WorkerCheckInputs = {
  /** Start of its newest live session; null = no live session. */
  liveSessionStartedAt: Date | null;
  /** Why it isn't expected to check (`loadPendingReasons`); null = it has a task and is expected to. */
  pendingReason: WorkerPendingReason | null;
  /** #3077: why it has no live session (`loadNoSessionReasons`); read only when `liveSessionStartedAt` is null. */
  noSessionReason?: WorkerNoSessionReason | null;
  /** Its newest open assignment, if any. */
  lastAssignedAt: Date | null;
  lastCheckedAt: Date | null;
  /** Its own pause (`WorkerWakeSettings.pausedUntil`); a past one restarts the clock. */
  pausedUntil: Date | null;
  /** When the App's last TEAM pause ended (`App.teamResumedAt`); restarts the clock like a worker's own pause. */
  teamResumedAt?: Date | null;
  /** #2022: when the latest `pause` / `halt` stop signal coverage of the worker ended; restarts the clock likewise. */
  stopEndedAt?: Date | null;
  /** #2755: when its isolation expired (an active one is PENDING ISOLATED); restarts the clock like a pause. */
  isolatedUntil?: Date | null;
  /** #2755: when an active pause or isolation was cleared on purpose (`WorkerWakeSettings.exemptEndedAt`). */
  exemptEndedAt?: Date | null;
};

export type CheckSettings = { checkPeriodSeconds: number; failedChecksToOverdue: number };

/** The hard-coded slack on top of the missed periods (#2138 §3.2). */
export const OVERDUE_SLACK_MS = 5 * 60_000;

/** How long after the clock starts a worker with a task turns OVERDUE. */
export function overdueAfterMs(s: CheckSettings): number {
  return s.failedChecksToOverdue * s.checkPeriodSeconds * 1000 + OVERDUE_SLACK_MS;
}

/** The ends of the worker's own isolation and of a pause or isolation cleared on purpose, as far as they are past. */
function ownExemptionEnds(i: WorkerCheckInputs, now: Date): number[] {
  return [i.isolatedUntil, i.exemptEndedAt].map((d) => (d && d.getTime() <= now.getTime() ? d.getTime() : -Infinity));
}

/** The latest end of an exemption (or the live session's start); null when it has no live session. */
function resumedAt(i: WorkerCheckInputs, now: Date): Date | null {
  if (!i.liveSessionStartedAt) return null;
  const t = Math.max(
    i.liveSessionStartedAt.getTime(),
    i.pausedUntil && i.pausedUntil.getTime() <= now.getTime() ? i.pausedUntil.getTime() : -Infinity,
    i.teamResumedAt?.getTime() ?? -Infinity,
    i.stopEndedAt && i.stopEndedAt.getTime() <= now.getTime() ? i.stopEndedAt.getTime() : -Infinity,
    ...ownExemptionEnds(i, now),
  );
  return new Date(t);
}

/**
 * The status from its inputs: NO_SESSION, then PENDING with its reason, then
 * OK or OVERDUE. OK holds at exactly the limit; OVERDUE starts one millisecond
 * after it.
 */
export function deriveWorkerCheckStatus(i: WorkerCheckInputs, s: CheckSettings, now: Date): WorkerCheckStatus {
  const out = (status: WorkerCheckState, pendingReason: WorkerPendingReason | null = null): WorkerCheckStatus => ({
    status,
    pendingReason,
    noSessionReason: status === 'NO_SESSION' ? (i.noSessionReason ?? null) : null,
    lastCheckedAt: i.lastCheckedAt,
    resumedAt: resumedAt(i, now),
  });
  if (!i.liveSessionStartedAt) return out('NO_SESSION');
  if (i.pendingReason) return out('PENDING', i.pendingReason);

  const clockStart = Math.max(
    i.lastCheckedAt?.getTime() ?? -Infinity,
    i.lastAssignedAt?.getTime() ?? -Infinity,
    i.liveSessionStartedAt.getTime(),
    // A pause that has ended (an active one is PAUSED above).
    i.pausedUntil && i.pausedUntil.getTime() <= now.getTime() ? i.pausedUntil.getTime() : -Infinity,
    // #2138 §3.6: a team pause that has ended restarts every worker's clock (an active one is TEAM_PAUSED above).
    i.teamResumedAt?.getTime() ?? -Infinity,
    // #2022: a stop signal's coverage that has ended (an active one is STOPPED above).
    i.stopEndedAt && i.stopEndedAt.getTime() <= now.getTime() ? i.stopEndedAt.getTime() : -Infinity,
    // #2755: an isolation that has ended, and a pause or isolation cleared on purpose.
    ...ownExemptionEnds(i, now),
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
    select: { deliveryCheckPeriodSeconds: true, deliveryFailedChecksToOverdue: true, teamResumedAt: true },
  });
  if (!app) return new Map();
  const workers = await db.worker.findMany({
    where: { appId, ...(opts.workerIds ? { id: { in: opts.workerIds } } : {}) },
    select: { id: true },
  });
  if (workers.length === 0) return new Map();
  const ids = workers.map((w) => w.id);

  const [sessions, tasks, readStates, wakeSettings, pending] = await Promise.all([
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
    db.workerWakeSettings.findMany({ where: { workerId: { in: ids } }, select: { workerId: true, pausedUntil: true, isolatedUntil: true, exemptEndedAt: true } }),
    loadPendingReasons(db, appId, ids, now),
  ]);
  // #2022: the latest end of each worker's pause/halt coverage (the earliest of leaving it, its signal's end, its until).
  const stopEnds = await db.$queryRaw<{ workerId: string; endedAt: Date }[]>(Prisma.sql`
    SELECT c.worker_id AS "workerId", max(LEAST(c.left_at, s.ended_at, s.until)) AS "endedAt"
    FROM team_stop_coverage c JOIN team_stop_signals s ON s.id = c.signal_id
    WHERE c.app_id = ${appId} AND c.worker_id IN (${Prisma.join(ids)}) AND s.level IN ('pause', 'halt')
      AND LEAST(c.left_at, s.ended_at, s.until) IS NOT NULL
    GROUP BY c.worker_id`);
  const stopEndOf = new Map(stopEnds.map((r) => [r.workerId, r.endedAt]));

  // The same liveness predicate as the roster's liveSession and startSession's gate (cor:agt:020:11).
  const lastEvents = await loadLastEventBySession(db as never, sessions.map((s) => s.id));
  const liveStart = new Map<string, Date>();
  for (const s of sessions) {
    if (!s.workerId || !isSessionLive({ ...s, type: s.type as SessionType }, lastEvents.get(s.id), now)) continue;
    const prev = liveStart.get(s.workerId);
    if (!prev || s.startedAt > prev) liveStart.set(s.workerId, s.startedAt);
  }
  // #3077: why the workers without a live session have none, in a separate read so the live-session read stays as it is.
  const noSessionReasons = await loadNoSessionReasons(db, ids.filter((id) => !liveStart.has(id)), now);
  const openTask = new Map(tasks.map((t) => [t.assigneeWorkerId as string, t._max.assignedAt]));
  const checkedAt = new Map(readStates.map((r) => [r.workerId as string, r.lastCheckedAt]));
  const wake = new Map(wakeSettings.map((ws) => [ws.workerId, ws]));
  const settings = { checkPeriodSeconds: app.deliveryCheckPeriodSeconds, failedChecksToOverdue: app.deliveryFailedChecksToOverdue };
  const out = new Map<string, WorkerCheckStatus>();
  for (const w of workers) {
    out.set(
      w.id,
      deriveWorkerCheckStatus(
        {
          liveSessionStartedAt: liveStart.get(w.id) ?? null,
          pendingReason: pending.get(w.id) ?? null,
          noSessionReason: noSessionReasons.get(w.id) ?? null,
          lastAssignedAt: openTask.get(w.id) ?? null,
          lastCheckedAt: checkedAt.get(w.id) ?? null,
          pausedUntil: wake.get(w.id)?.pausedUntil ?? null,
          isolatedUntil: wake.get(w.id)?.isolatedUntil ?? null,
          exemptEndedAt: wake.get(w.id)?.exemptEndedAt ?? null,
          teamResumedAt: app.teamResumedAt,
          stopEndedAt: stopEndOf.get(w.id) ?? null,
        },
        settings,
        now,
      ),
    );
  }
  return out;
}

/**
 * #3077 — the NO_SESSION reason of each worker in `workerIds`, all of which the caller has already found to have no
 * live session (`isSessionLive` over their open, undeleted sessions). Gate settlement (issue comment 6554106259):
 * - IDLE when an open (`endedAt` null), undeleted, not auto-expired session's promised `expiresAt` has not passed:
 *   it is not live, so it was driven outside its window. An expiry at or before `now` has ended it (R5,
 *   cor:agt:020:03), even before the reaper stamps `endedAt` (Pin A).
 * - ENDED when any undeleted Session row exists, auto-expired rows included.
 * - NEVER_BOUND when none does (Pin B): the same reader as `Worker.lastActiveAt` being null.
 * Soft-deleted sessions count for nothing, as in the bind gate and `Worker.lastActiveAt` (gate amendment, after
 * team chat #60698).
 * Classification only: it never decides liveness, so it can't become a second liveness rule (cor:agt:020:11). It
 * reveals nothing beyond the closed reason; callers expose it only inside the masked `checkStatus`.
 */
export async function loadNoSessionReasons(db: Db, workerIds: string[], now: Date): Promise<Map<string, WorkerNoSessionReason>> {
  if (workerIds.length === 0) return new Map();
  const [open, any] = await Promise.all([
    db.session.groupBy({
      by: ['workerId'],
      where: { workerId: { in: workerIds }, endedAt: null, deletedAt: null, autoExpiredAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    }),
    db.session.groupBy({ by: ['workerId'], where: { workerId: { in: workerIds }, deletedAt: null } }),
  ]);
  const idle = new Set(open.map((r) => r.workerId));
  const seen = new Set(any.map((r) => r.workerId));
  return new Map(workerIds.map((id) => [id, idle.has(id) ? 'IDLE' : seen.has(id) ? 'ENDED' : 'NEVER_BOUND']));
}

const reasonWords = (r: WorkerPendingReason | WorkerNoSessionReason): string => r.toLowerCase().replace(/_/g, ' ');

/** The short form for a roster line: `check OK`, `check PENDING (no task)`, `check NO_SESSION (idle)`. */
export function renderCheckStatusShort(s: WorkerCheckStatus): string {
  const reason = s.pendingReason ?? s.noSessionReason;
  return `check ${s.status}${reason ? ` (${reasonWords(reason)})` : ''}`;
}

/** The long form for a single-worker read: the status, its reason and the last check. */
export function renderCheckStatusLong(s: WorkerCheckStatus): string {
  const detail = [
    s.pendingReason ? reasonWords(s.pendingReason) : null,
    s.noSessionReason ? reasonWords(s.noSessionReason) : null,
    s.lastCheckedAt ? `last checked ${s.lastCheckedAt.toISOString()}` : 'never checked',
  ].filter(Boolean);
  return `Check status: ${s.status} (${detail.join('; ')})`;
}
