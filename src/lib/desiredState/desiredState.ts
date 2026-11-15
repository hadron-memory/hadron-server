/**
 * #4224 (S3 of the Team on Orca epic, #4229) — the desired state of each worker a host runs: should its agent
 * process be running, and why.
 *
 * The platform, not an agent, decides which worker should run. A host's one-minute sweep reads this per host and
 * compares it with what it sees; it never works the answer out itself.
 *
 * THE RULE (epic #4229 definitions; decisions G7 and G10 in
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:coordination:team-on-orca-decisions):
 *
 * - A worker of a LONG_LIVED Agent should run.
 * - A worker of a SHORT_LIVED Agent should run while it is the assignee of a pending or started task that is not
 *   waiting on child tasks (a started task with an open child waits, cor:agt:050:04); otherwise it is stopped.
 * - These always win over the lifecycle, in this order: retired; halted or paused by a stop signal (cor:agt:090; a
 *   `pause-dispatch` signal stops assignment only and changes nothing here); a team pause (cor:agt:100:04,
 *   `App.teamPausedAt`); a context reset in progress (cor:agt:050:27, the `resetting` availability mark).
 * - LEAVE-ALONE wins over all of that for acting: nothing is desired of a marked worker, and the row still says
 *   what its state would be without the marker.
 * - The App's sweep mode OFF wins over everything: nothing is desired of any worker, and each row still says what
 *   its state would be.
 *
 * WHICH WORKERS A HOST RUNS. Until S1a (#4222) stores the assignment on the platform, a host's workers are the ones
 * its registration lists (cor:agt:070:01), live or lapsed, with the family and worktrees it registered. That read
 * is `hostWorkers` below, alone, so S1a replaces one function.
 *
 * Pure reads. Nothing here starts, stops or changes anything.
 */

import { AgentLifecycle as AgentLifecycleEnum, Prisma, SweepMode as SweepModeEnum, type PrismaClient } from '../../generated/prisma/index.js';
import { recordInEffect } from '../agentTasks/availability.js';
import { coveringSignals, strongestLevel, type StopLevel } from '../stopSignals/state.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** The schema's enums (prisma/schema.prisma) are the one definition; these lists are read from the generated client. */
export type AgentLifecycle = AgentLifecycleEnum;
export const AGENT_LIFECYCLES: readonly AgentLifecycle[] = Object.values(AgentLifecycleEnum);
export type SweepMode = SweepModeEnum;
export const SWEEP_MODES: readonly SweepMode[] = Object.values(SweepModeEnum);

export type DesiredRunState = 'RUNNING' | 'STOPPED';

/** The closed set of reasons. The first four come from the lifecycle; the rest override it. */
export const DESIRED_STATE_REASONS = [
  'LONG_LIVED', 'HOLDS_TASK', 'NO_OPEN_TASK', 'WAITING_ON_CHILDREN',
  'RETIRED', 'HALTED', 'PAUSED', 'TEAM_PAUSED', 'RESETTING', 'LEAVE_ALONE', 'SWEEP_OFF',
] as const;
export type DesiredStateReason = (typeof DESIRED_STATE_REASONS)[number];

/** Everything the decision reads about one worker. */
export type DesiredStateFacts = {
  sweepMode: SweepMode;
  leaveAlone: boolean;
  retired: boolean;
  /** The strongest live stop signal covering the worker, or null. */
  stopLevel: StopLevel | null;
  teamPaused: boolean;
  /** A context reset holds the worker (its `resetting` mark is in effect). */
  resetting: boolean;
  lifecycle: AgentLifecycle;
  /** Pending or started tasks the worker is the assignee of. */
  openTasks: number;
  /** Of those, the ones not waiting on a child: pending, or started with no open child. */
  runnableTasks: number;
};

export type DesiredStateVerdict = {
  /** Null exactly when nothing is desired of the worker (LEAVE_ALONE, SWEEP_OFF): a reader acts on nothing. */
  desired: DesiredRunState | null;
  reason: DesiredStateReason;
  /** Set exactly when `desired` is null: the state the worker would have without the marker or with the sweep on. */
  wouldBe: DesiredRunState | null;
  wouldBeReason: DesiredStateReason | null;
};

/** The state without the leave-alone marker and with the sweep on: the overrides in order, then the lifecycle. */
function underlying(f: DesiredStateFacts): { desired: DesiredRunState; reason: DesiredStateReason } {
  if (f.retired) return { desired: 'STOPPED', reason: 'RETIRED' };
  if (f.stopLevel === 'halt') return { desired: 'STOPPED', reason: 'HALTED' };
  if (f.stopLevel === 'pause') return { desired: 'STOPPED', reason: 'PAUSED' };
  if (f.teamPaused) return { desired: 'STOPPED', reason: 'TEAM_PAUSED' };
  if (f.resetting) return { desired: 'STOPPED', reason: 'RESETTING' };
  if (f.lifecycle === 'LONG_LIVED') return { desired: 'RUNNING', reason: 'LONG_LIVED' };
  if (f.runnableTasks > 0) return { desired: 'RUNNING', reason: 'HOLDS_TASK' };
  if (f.openTasks > 0) return { desired: 'STOPPED', reason: 'WAITING_ON_CHILDREN' };
  return { desired: 'STOPPED', reason: 'NO_OPEN_TASK' };
}

/** One worker's desired state from its facts (see the file header for the rule). Pure. */
export function decideDesiredState(f: DesiredStateFacts): DesiredStateVerdict {
  const u = underlying(f);
  if (f.sweepMode === 'OFF') return { desired: null, reason: 'SWEEP_OFF', wouldBe: u.desired, wouldBeReason: u.reason };
  if (f.leaveAlone) return { desired: null, reason: 'LEAVE_ALONE', wouldBe: u.desired, wouldBeReason: u.reason };
  return { desired: u.desired, reason: u.reason, wouldBe: null, wouldBeReason: null };
}

/** One worker a host runs, with the setup the host needs to start it. */
export type HostWorker = { workerId: string; family: string; worktrees: string[] };

/**
 * The workers `hostId` runs in `appId`, or null when the App has no such host. Today: the host's registration
 * (cor:agt:070:01), whether or not it is live, since a host that stopped refreshing still has the same workers.
 * S1a (#4222) replaces this read with the platform's own assignment.
 */
export async function hostWorkers(db: Db, appId: string, hostId: string): Promise<HostWorker[] | null> {
  const reg = await db.hostRegistration.findUnique({
    where: { appId_hostId: { appId, hostId } },
    select: { workers: { select: { workerId: true, family: true, worktrees: true } } },
  });
  return reg ? reg.workers : null;
}

export type WorkerDesiredState = DesiredStateVerdict & {
  workerId: string;
  name: string;
  lifecycle: AgentLifecycle;
  /** The worker's open session (not ended), the latest when it somehow has several; null when it has none. */
  openSessionId: string | null;
  family: string;
  worktrees: string[];
};

export type HostDesiredState = { hostId: string; sweepMode: SweepMode; workers: WorkerDesiredState[] };

/**
 * The desired state of every worker `hostId` runs in `appId` at `now`, by name; null when the App has no such
 * host. A fixed number of queries whatever the number of workers.
 */
export async function loadHostDesiredState(db: Db, appId: string, hostId: string, now: Date): Promise<HostDesiredState | null> {
  const listed = await hostWorkers(db, appId, hostId);
  if (listed === null) return null;
  const app = await db.app.findUnique({ where: { id: appId }, select: { sweepMode: true, teamPausedAt: true } });
  if (!app) return null;
  const ids = listed.map((w) => w.workerId);
  if (ids.length === 0) return { hostId, sweepMode: app.sweepMode, workers: [] };

  const [workers, tasks, covering, marks, sessions] = await Promise.all([
    db.worker.findMany({
      where: { id: { in: ids }, appId },
      select: { id: true, name: true, retiredAt: true, leaveAlone: true, agent: { select: { lifecycle: true } } },
    }),
    // Per assignee: its open tasks, and those of them not waiting on a child (cor:agt:050:04: started with an open child).
    db.$queryRaw<{ workerId: string; open: number; runnable: number }[]>(Prisma.sql`
      SELECT t.assignee_worker_id AS "workerId", count(*)::int AS open,
             (count(*) FILTER (WHERE t.status = 'pending' OR NOT EXISTS (
                SELECT 1 FROM agent_tasks c WHERE c.parent_task_id = t.id AND c.status IN ('pending', 'started'))))::int AS runnable
      FROM agent_tasks t
      WHERE t.app_id = ${appId} AND t.assignee_worker_id IN (${Prisma.join(ids)}) AND t.status IN ('pending', 'started')
      GROUP BY t.assignee_worker_id`),
    coveringSignals(db, appId, ids, now),
    db.workerAvailability.findMany({
      where: { workerId: { in: ids }, state: 'unavailable', reason: 'resetting' },
      select: { workerId: true, state: true, reason: true, until: true, setAt: true, clearsOnActivityAfter: true },
    }),
    db.$queryRaw<{ workerId: string; id: string }[]>(Prisma.sql`
      SELECT DISTINCT ON (s.worker_id) s.worker_id AS "workerId", s.id
      FROM sessions s
      WHERE s.worker_id IN (${Prisma.join(ids)}) AND s.ended_at IS NULL AND s.deleted_at IS NULL
      ORDER BY s.worker_id, s.started_at DESC, s.id DESC`),
  ]);

  const taskOf = new Map(tasks.map((t) => [t.workerId, t]));
  const sessionOf = new Map(sessions.map((s) => [s.workerId, s.id]));
  // The relaunched agent's first activity ends a `resetting` mark before the reset's own report clears it
  // (cor:agt:050:27). Only a mark that is waiting for that activity needs the worker's last activity read.
  const needActivity = marks.filter((m) => m.clearsOnActivityAfter !== null).map((m) => m.workerId);
  const lastActivity = await lastActivityOf(db, needActivity, now);
  const resetting = new Set(
    marks.filter((m) => recordInEffect(m, now, lastActivity.get(m.workerId) ?? null)).map((m) => m.workerId),
  );
  const setupOf = new Map(listed.map((w) => [w.workerId, w]));

  const rows: WorkerDesiredState[] = workers.map((w) => {
    const setup = setupOf.get(w.id)!;
    const t = taskOf.get(w.id);
    return {
      workerId: w.id,
      name: w.name,
      lifecycle: w.agent.lifecycle,
      ...decideDesiredState({
        sweepMode: app.sweepMode,
        leaveAlone: w.leaveAlone,
        retired: w.retiredAt !== null,
        stopLevel: strongestLevel(covering.get(w.id) ?? []),
        teamPaused: app.teamPausedAt !== null,
        resetting: resetting.has(w.id),
        lifecycle: w.agent.lifecycle,
        openTasks: t?.open ?? 0,
        runnableTasks: t?.runnable ?? 0,
      }),
      openSessionId: sessionOf.get(w.id) ?? null,
      family: setup.family,
      worktrees: setup.worktrees,
    };
  });
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.workerId < b.workerId ? -1 : 1));
  return { hostId, sweepMode: app.sweepMode, workers: rows };
}

/** Each worker's last activity (the roster's own aggregate), for the few workers whose reset mark waits on it. */
async function lastActivityOf(db: Db, workerIds: string[], now: Date): Promise<Map<string, Date | null>> {
  if (workerIds.length === 0) return new Map();
  const { loadWorkersActivity } = await import('../../api/graphql/schema/resolvers.worker.js');
  type Ctx = Parameters<typeof loadWorkersActivity>[0];
  const activity = await loadWorkersActivity({ db } as unknown as Ctx, workerIds, now);
  return new Map(workerIds.map((id) => [id, activity.get(id)?.lastActiveAt ?? null]));
}
