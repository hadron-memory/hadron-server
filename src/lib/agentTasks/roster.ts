/**
 * #1707 — the team roster, derived (plan design:agent-tasks §7.4).
 *
 * One state per worker, computed server-side from T1–T3 so the CLI and the
 * portal render one answer rather than each re-deriving it. PLAN-DERIVED, NOT
 * A SPEC: cor:agt:050 leaves the roster out of scope, and whether it becomes
 * one is Vera's #7485 Q7 for Holger. Each state is built only from the
 * platform's own predicates — free for work (src/lib/agentTasks/matcher.ts),
 * availability (availability.ts), the owner-unreactive episode (stall.ts) —
 * never a second copy of one.
 *
 * A worker can be in several of these at once; `state` is the first that
 * holds, in this order (#1707 interim), most actionable first:
 *
 *   YOUR_MOVE             it is woken on an unacknowledged alarm
 *                         (cor:agt:050:19), or a child of a task it is the
 *                         assignee of finished after it last moved (050:16)
 *   UNAVAILABLE           its own record, or every family it can run as, says
 *                         unavailable now (060:01; stalled included, 060:07)
 *   WAITING               the assignee of a started task with open children
 *                         (050:04); shows on what and since when
 *   WORKING               the assignee of a started task
 *   ASSIGNED_NOT_STARTED  the assignee of a pending task
 *   AVAILABLE             free for work (060:05) — including an unbound worker
 *                         a live host can launch, which the matcher assigns to
 *                         (T6, #1709), and a bound one whose session is quiet,
 *                         which it leaves alone until the session is live again
 *                         (`liveSession` tells them apart)
 *   NO_FAMILY             bound, but its session reported no model family, so
 *                         it can't be matched until one is given (060:04)
 *   NOT_LAUNCHABLE        unbound, and no live host registers it
 */

import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { AvailabilityRecord } from './availability.js';
import { loadWorkerWorkStates, type WorkerWorkState } from './matcher.js';
import { alarmEpisodeKey, endedAlarmEpisodes, loadStallInputs, unreactedChildren } from './stall.js';

export const ROSTER_STATES = [
  'YOUR_MOVE', 'UNAVAILABLE', 'WAITING', 'WORKING', 'ASSIGNED_NOT_STARTED', 'AVAILABLE', 'NO_FAMILY', 'NOT_LAUNCHABLE',
] as const;
export type RosterState = (typeof ROSTER_STATES)[number];

type Db = PrismaClient | Prisma.TransactionClient;
const OPEN_STATUSES = ['pending', 'started'];

export type RosterEntry = {
  workerId: string;
  name: string;
  slug: string;
  role: string | null;
  state: RosterState;
  /** Has an open session, live or quiet (the binding). */
  bound: boolean;
  /** Has a live session (cor:agt:020:11); a BOUND worker is matched only with one. Unbound workers are matched through a host. */
  liveSession: boolean;
  /** The binding's family (its newest open session's); null when unbound or none was reported. */
  family: string | null;
  launchableFamilies: string[];
  /** The families it is free for work as now; empty when not free. */
  freeFamilies: string[];
  free: boolean;
  /** Its own availability record, when it makes the worker unavailable now. */
  unavailable: { reason: string | null; until: Date | null } | null;
  /** Families it could run as that are unavailable in the App now. */
  unavailableFamilies: string[];
  startedTaskIds: string[];
  pendingTaskIds: string[];
  /** WAITING: the open children of its started tasks, and since when the oldest has been open. */
  waitingOnTaskIds: string[];
  waitingSince: Date | null;
  /** YOUR_MOVE: unacknowledged alarms it has been woken on, nearest first. */
  alarmEventIds: string[];
  /** YOUR_MOVE: a finished or cancelled child it owns and hasn't reacted to (#1831). */
  unreactedChildTaskId: string | null;
  lastActiveAt: Date | null;
  lastAssignedAt: Date | null;
  /** #1726 — the worker it reports to (shown beside lastActiveAt, so a stale claim is easy to spot). */
  reportsTo: { workerId: string; name: string; slug: string; retired: boolean } | null;
};

/** The primary state from a worker's facts. Pure; see the file header for the order. */
export function rosterState(f: {
  alarmEventIds: string[];
  unreactedChildTaskId: string | null;
  unavailable: boolean;
  waiting: boolean;
  started: boolean;
  pending: boolean;
  free: boolean;
  bound: boolean;
}): RosterState {
  if (f.alarmEventIds.length || f.unreactedChildTaskId) return 'YOUR_MOVE';
  if (f.unavailable) return 'UNAVAILABLE';
  if (f.waiting) return 'WAITING';
  if (f.started) return 'WORKING';
  if (f.pending) return 'ASSIGNED_NOT_STARTED';
  if (f.free) return 'AVAILABLE';
  return f.bound ? 'NO_FAMILY' : 'NOT_LAUNCHABLE';
}

/** The woken wakes on unacknowledged alarms in an App, per worker owner, nearest first. */
async function loadWokenAlarms(db: Db, appId: string, now: Date): Promise<Map<string, string[]>> {
  const rows = await db.$queryRaw<{ eventId: string; workerId: string | null; taskId: string | null; type: string; episodeStart: Date | null }[]>`
    SELECT e.id AS "eventId", e.chain -> s.chain_index ->> 'workerId' AS "workerId",
           e.task_id AS "taskId", e.type, e.episode_start AS "episodeStart"
    FROM agent_team_events e
    JOIN agent_team_alarm_schedule s ON s.event_id = e.id
    WHERE e.app_id = ${appId} AND e.severity = 'alarm' AND e.acknowledged_at IS NULL
      AND s.woken_at IS NOT NULL
    ORDER BY e.created_at, e.id`;
  // #2200 (R196): an alarm whose own episode has ended is no longer anyone's move, from that instant: classified
  // live here, never from the escalation's `ended_at`, which waits for a pass.
  const ended = await endedAlarmEpisodes(db, rows, now);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.workerId) continue;
    if (r.taskId && r.episodeStart && ended.has(alarmEpisodeKey(r.taskId, r.type, r.episodeStart))) continue;
    const list = out.get(r.workerId) ?? [];
    if (!list.includes(r.eventId)) list.push(r.eventId);
    out.set(r.workerId, list);
  }
  return out;
}

function ownUnavailable(w: WorkerWorkState): { reason: string | null; until: Date | null } | null {
  if (!w.availability.ownInEffect) return null;
  const own = w.availability.own as NonNullable<AvailabilityRecord>;
  return { reason: own.reason, until: own.until };
}

/** The roster of one App's workers that are not retired, by name, at `now`. */
export async function loadTeamRoster(db: Db, appId: string, now: Date): Promise<RosterEntry[]> {
  const states = await loadWorkerWorkStates(db, appId, now);
  if (states.length === 0) return [];
  const [inputs, woken, structure] = await Promise.all([
    // A parent assigned to a PERSON still has worker-owned children whose end is
    // that worker's move (#1831), so person-assigned parents are read too.
    loadStallInputs(db, { appId, OR: [{ assigneeWorkerId: { not: null } }, { assigneeUserId: { not: null } }] }, now),
    loadWokenAlarms(db, appId, now),
    // #1726: every worker of the App, retired too, so a claim on a retired one resolves.
    db.worker.findMany({ where: { appId }, select: { id: true, name: true, slug: true, retiredAt: true, reportsToWorkerId: true } }),
  ]);
  const byId = new Map(structure.map((w) => [w.id, w]));
  const reportsToOf = (workerId: string): RosterEntry['reportsTo'] => {
    const to = byId.get(byId.get(workerId)?.reportsToWorkerId ?? '');
    return to ? { workerId: to.id, name: to.name, slug: to.slug, retired: to.retiredAt !== null } : null;
  };
  const started = inputs.filter((i) => i.task.status === 'started');
  const children = started.length
    ? await db.agentTask.findMany({
        // appId too (#1723 review, Rook P3-4): same-App parents are enforced
        // only at create, so the read stays inside the App on its own.
        where: { appId, parentTaskId: { in: started.map((i) => i.task.id) }, status: { in: OPEN_STATUSES } },
        select: { id: true, parentTaskId: true, createdAt: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      })
    : [];
  // cor:agt:050:16 (#1831): the unreacted child is its OWNER's move, wherever the parent is assigned.
  const unreactedByOwner = new Map<string, { id: string }>();
  for (const i of inputs) {
    for (const c of unreactedChildren(i)) {
      if (c.ownerWorkerId && !unreactedByOwner.has(c.ownerWorkerId)) unreactedByOwner.set(c.ownerWorkerId, c);
    }
  }
  const byWorker = new Map<string, typeof inputs>();
  for (const i of inputs) {
    const id = i.task.assigneeWorkerId;
    if (id) byWorker.set(id, [...(byWorker.get(id) ?? []), i]);
  }

  return states
    .map((w): RosterEntry => {
      const mine = byWorker.get(w.id) ?? [];
      const startedIds = mine.filter((i) => i.task.status === 'started').map((i) => i.task.id);
      const pendingIds = mine.filter((i) => i.task.status === 'pending').map((i) => i.task.id);
      const kids = children.filter((c) => startedIds.includes(c.parentTaskId as string));
      const unreacted = unreactedByOwner.get(w.id) ?? null;
      const unavailable = ownUnavailable(w);
      const unavailableFamilies = w.families.filter((f) => w.availability.familyAvailable.get(f) !== true);
      const alarmEventIds = woken.get(w.id) ?? [];
      const allFamiliesOut = w.families.length > 0 && unavailableFamilies.length === w.families.length;
      return {
        workerId: w.id,
        name: w.name,
        slug: w.slug,
        role: w.role,
        state: rosterState({
          alarmEventIds,
          unreactedChildTaskId: unreacted?.id ?? null,
          unavailable: unavailable !== null || allFamiliesOut,
          waiting: kids.length > 0,
          started: startedIds.length > 0,
          pending: pendingIds.length > 0,
          free: w.free,
          bound: w.bound,
        }),
        bound: w.bound,
        liveSession: w.live,
        family: w.bindingFamily,
        launchableFamilies: w.launchableFamilies,
        freeFamilies: w.freeFamilies,
        free: w.free,
        unavailable,
        unavailableFamilies,
        startedTaskIds: startedIds,
        pendingTaskIds: pendingIds,
        waitingOnTaskIds: kids.map((c) => c.id),
        waitingSince: kids[0]?.createdAt ?? null,
        alarmEventIds,
        unreactedChildTaskId: unreacted?.id ?? null,
        lastActiveAt: w.lastActiveAt,
        lastAssignedAt: w.lastAssignedAt,
        reportsTo: reportsToOf(w.id),
      };
    })
    .sort((a, b) => {
      const na = a.name.toLowerCase();
      const nb = b.name.toLowerCase();
      return na < nb ? -1 : na > nb ? 1 : a.workerId < b.workerId ? -1 : 1;
    });
}
