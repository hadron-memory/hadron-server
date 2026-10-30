/**
 * #1706 (Task Management T2) — the four stall rules, the alarm they raise once
 * per episode, and the owner chain the alarm climbs (cor:agt:050:12–:20).
 *
 * | Rule              | Condition                                         | Default | Spec        |
 * |-------------------|---------------------------------------------------|---------|-------------|
 * | not-started       | pending, assigned, past start-by or the window     | 15 min  | 050:14      |
 * | no-progress       | started, no open child, no assignee activity       | 60 min  | 050:15      |
 * | owner-unreactive  | a child finished or cancelled; no activity by the | 20 min  | 050:16 (r2) |
 * |                   | parent's assignee (the child's owner)              |         |             |
 * | unassignable      | queued: pending with no assignee                   | 30 min  | 050:17      |
 *
 * EPISODES (cor:agt:050:13, Proposed). An episode's key is (task, rule,
 * episode start), and the episode start is the instant of the MOVE that began
 * the condition — the assignment, the start, the child's finish, the last
 * activity — never the evaluator's clock. Two passes, on one instance or two,
 * therefore compute the same key, and the unique index on that key
 * (agent_team_events_episode_uniq) admits one alarm. A move by the task gives
 * the condition a new start, which is a new episode. Per rule:
 *   - not-started: the assignment (`assignedAt`). The deadline is an explicit
 *     `startBy` when it is later than the assignment, else the window counted
 *     from it — so a reassignment past `startBy` gets a fresh window (050:14
 *     edge case, #1706 interim).
 *   - no-progress: the latest of the start, the latest assignment (a
 *     reassignment while started, 050:15 edge case), the moment the last open
 *     child ended (050:15 edge case), the assignee's last activity, and its
 *     latest still-working note (`task.progress`; cor:agt:050:12).
 *   - owner-unreactive: the EARLIEST child end (finish or cancel, #1760) after
 *     the CHILD'S OWNER last acted (#1831: its own session activity only; a
 *     move on the parent, such as a reassignment, start or progress, is no
 *     reaction). A second child ending in the same silence is the same episode:
 *     the condition has held since the first.
 *   - unassignable: when the task entered its current queue stint — its latest
 *     `assignment.queued` event (#1754: make-ready re-queues a parked task),
 *     falling back to creation for rows seeded past the resolvers.
 *
 * ACTIVITY is cor:agt:050:12: the worker's sessions, through the one SQL
 * derivation the roster uses (`loadWorkersActivity`, lib/sessionActivity.ts's
 * database twin), plus its latest `task.progress` on the task. A person has no
 * session, so only their still-working notes and moves count (#1706 interim,
 * 050:12 open question). Someone else reading the task is not activity (050:15 S3).
 *
 * RAISING re-evaluates under a FOR SHARE lock on the task: a T1 move holds the
 * task FOR UPDATE, so it either committed before the lock (and the
 * re-evaluation sees it) or waits for the alarm. Session activity is not
 * locked; a call landing in the same instant as the alarm can lose that race,
 * and the alarm stands.
 *
 * Interim readings carried from the issue until Holger rules: no alarm on
 * an ended parent (it is not open, so it is never evaluated); a root task's
 * chain ends at its owner (050:18 open question); escalation steps by the
 * alarm's own window (050:19, Proposed).
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { PASSIVE_EVENT_TYPES, appendAlarmEvent, type AlarmChain, type AlarmEventType, type TaskParty } from './events.js';
import { markStalled } from './availability.js';
import { appManagerUserIds } from '../auth/appManagement.js';

export const STALL_RULES = ['not-started', 'no-progress', 'owner-unreactive', 'unassignable'] as const;
export type StallRule = (typeof STALL_RULES)[number];

/** Each rule's alarm type (cor:agt:050:11). */
export const STALL_EVENT_TYPE: Record<StallRule, AlarmEventType> = {
  'not-started': 'stall.not-started',
  'no-progress': 'stall.no-progress',
  'owner-unreactive': 'stall.owner-unreactive',
  unassignable: 'assignment.unassignable',
};

/** The App's stall windows, in minutes. */
export type StallWindows = {
  notStartedMinutes: number;
  noProgressMinutes: number;
  ownerReactionMinutes: number;
  assignmentMinutes: number;
};

/** The platform defaults (Holger, 2026-10-08, D-2026-10-07-002) — tunables per App, not contract. */
export const STALL_WINDOW_DEFAULTS: StallWindows = {
  notStartedMinutes: 15,
  noProgressMinutes: 60,
  ownerReactionMinutes: 20,
  assignmentMinutes: 30,
};

const RULE_WINDOW: Record<StallRule, keyof StallWindows> = {
  'not-started': 'notStartedMinutes',
  'no-progress': 'noProgressMinutes',
  'owner-unreactive': 'ownerReactionMinutes',
  unassignable: 'assignmentMinutes',
};

const MINUTE = 60_000;
const OPEN_STATUSES = ['pending', 'started'];

/** An App's effective windows: its stored overrides over the defaults. */
export function effectiveWindows(row: Partial<Record<keyof StallWindows, number | null>> | null | undefined): StallWindows {
  return {
    notStartedMinutes: row?.notStartedMinutes ?? STALL_WINDOW_DEFAULTS.notStartedMinutes,
    noProgressMinutes: row?.noProgressMinutes ?? STALL_WINDOW_DEFAULTS.noProgressMinutes,
    ownerReactionMinutes: row?.ownerReactionMinutes ?? STALL_WINDOW_DEFAULTS.ownerReactionMinutes,
    assignmentMinutes: row?.assignmentMinutes ?? STALL_WINDOW_DEFAULTS.assignmentMinutes,
  };
}

async function loadWindows(db: Db, appIds: string[]): Promise<Map<string, StallWindows>> {
  const rows = appIds.length
    ? await db.agentTaskStallSchedule.findMany({ where: { appId: { in: appIds } } })
    : [];
  const byApp = new Map(rows.map((r) => [r.appId, r]));
  return new Map(appIds.map((id) => [id, effectiveWindows(byApp.get(id))]));
}

// ── Inputs ────────────────────────────────────────────────────────────────

import { afterWaits, anchorNow, lockStopFence } from '../stopSignals/state.js';

type Db = PrismaClient | Prisma.TransactionClient;

const TASK_SELECT = {
  id: true, appId: true, status: true, parentTaskId: true, blocked: true, releasedAt: true,
  ownerWorkerId: true, ownerUserId: true, assigneeWorkerId: true, assigneeUserId: true,
  startBy: true, assignedAt: true, startedAt: true, createdAt: true,
} as const;
type SelectedTaskState = Prisma.AgentTaskGetPayload<{ select: typeof TASK_SELECT }>;
type TaskState = Omit<SelectedTaskState, 'blocked' | 'releasedAt'> & Partial<Pick<SelectedTaskState, 'blocked' | 'releasedAt'>>;

/** Everything one task's rules read. */
export type StallInputs = {
  task: TaskState;
  openChildCount: number;
  /** When the last child ended (finished or cancelled), if any has. */
  lastChildEndedAt: Date | null;
  /**
   * Children that ended by finishing or being cancelled (cor:agt:050:16, #1760),
   * earliest end first, each with its OWNER's last session activity (#1831):
   * the owner-unreactive window tests the child owner's silence, never the
   * parent's assignee's. A worker owner's activity is its session activity; a
   * person owner has no session, so theirs is the latest task call they made
   * (cor:agt:050:12, #1848): the task events they caused, in this App.
   */
  endedChildren: { id: string; endedAt: Date; ownerWorkerId: string | null; ownerActivityAt: Date | null }[];
  /** The latest still-working note on the task (cor:agt:050:12). */
  lastProgressAt: Date | null;
  /** The worker assignee's last session activity; null for a person or a queued task. */
  assigneeActivityAt: Date | null;
  /**
   * When the task entered its CURRENT queue stint: the latest
   * `assignment.queued` event (#1754 — make-ready re-queues a parked task, so
   * creation is no longer the queue entry). Null when no such event exists, a
   * row seeded past the resolvers; `unassignable` then falls back to creation,
   * the pre-#1754 episode start.
   */
  queuedAt: Date | null;
  /** #2645: changing startBy creates a new not-started episode, without changing assignment/progress clocks. */
  startByEditedAt?: Date | null;
  /**
   * #2022 (R68; the Proposed stop-signal exceptions to cor:agt:050:13-:17): when a `pause` or `halt` covered each
   * worker these rules read (the assignee, and each ended child's owner), from the coverage ledger. Time inside them
   * doesn't count. Absent ⇒ none.
   */
  stopIntervals?: Map<string, StopInterval[]>;
  /** #2022 (R68, Vera's receipt §5) — when stop signals were what kept this queued task unassigned. Absent ⇒ none. */
  stopHolds?: StopInterval[];
};

/** A closed or still-open span of stopped time; `end` null means it hasn't ended. */
export type StopInterval = { start: Date; end: Date | null };

/**
 * #2022 — when a rule that started at `start` has counted `windowMs` of time, not counting any of `intervals`
 * (overlapping ones once: they are merged first). Infinity-dated (a far-future Date) while an open interval holds.
 * Pure. With no intervals it is `start + windowMs`, the pre-#2022 due time.
 */
export function countedDueAt(start: Date, windowMs: number, intervals: readonly StopInterval[] = []): Date {
  const spans = intervals
    .map((i) => ({ a: i.start.getTime(), b: i.end ? i.end.getTime() : Infinity }))
    .filter((i) => i.b > start.getTime() && i.b > i.a)
    .sort((x, y) => x.a - y.a);
  let t = start.getTime();
  let remaining = windowMs;
  for (const { a, b } of spans) {
    if (b <= t) continue;
    if (a > t) {
      const gap = a - t;
      if (gap >= remaining) return new Date(t + remaining);
      remaining -= gap;
    }
    if (b === Infinity) return new Date(8.64e15);
    t = b;
  }
  return new Date(t + remaining);
}

/**
 * Load the rules' inputs for the open tasks of live, installed Apps matching
 * `where`. One query per kind of input, not per task.
 */
export async function loadStallInputs(db: Db, where: Prisma.AgentTaskWhereInput, now: Date): Promise<StallInputs[]> {
  const tasks = await db.agentTask.findMany({
    where: { AND: [where, { status: { in: OPEN_STATUSES }, app: { deletedAt: null, uninstalledAt: null } }] },
    select: TASK_SELECT,
    orderBy: { id: 'asc' },
  });
  if (tasks.length === 0) return [];
  const ids = tasks.map((t) => t.id);
  const children = await db.agentTask.findMany({
    where: { parentTaskId: { in: ids } },
    select: { id: true, parentTaskId: true, status: true, finishedAt: true, cancelledAt: true, ownerWorkerId: true, ownerUserId: true },
  });
  const workerIds = [...new Set([
    ...tasks.map((t) => t.assigneeWorkerId),
    ...children.map((c) => c.ownerWorkerId),
  ].filter((w): w is string => !!w))];
  const ownerUserIds = [...new Set(children.map((c) => c.ownerUserId).filter((u): u is string => !!u))];
  const [progress, queued, activity, userCalls, startByEdits] = await Promise.all([
    db.agentTeamEvent.groupBy({
      by: ['taskId'],
      where: { taskId: { in: ids }, type: 'task.progress' },
      _max: { createdAt: true },
    }),
    db.agentTeamEvent.groupBy({
      by: ['taskId'],
      where: { taskId: { in: ids }, type: 'assignment.queued' },
      _max: { createdAt: true },
    }),
    loadWorkersActivity({ db } as unknown as Context, workerIds, now),
    // cor:agt:050:12 — "a person's activity is any task call they make". The
    // record of a call is the task event it caused (create, assign, start,
    // progress, finish, cancel, park, ready); a read leaves none (#1848), and
    // an event with no task (availability, host) is not a task call.
    ownerUserIds.length
      ? db.agentTeamEvent.groupBy({
        by: ['appId', 'actorUserId'],
        // actorWorkerId null: a worker-bound call made under the person's credential
        // carries their user id too, but it is the WORKER's activity, not theirs.
        where: { actorUserId: { in: ownerUserIds }, actorWorkerId: null, taskId: { not: null }, type: { startsWith: 'task.', notIn: [...PASSIVE_EVENT_TYPES] } },
        _max: { createdAt: true },
      })
      : Promise.resolve([]),
    db.agentTeamEvent.groupBy({
      by: ['taskId'],
      where: { taskId: { in: ids }, type: 'task.edited', payload: { path: ['fields'], array_contains: ['startBy'] } },
      _max: { createdAt: true },
    }),
  ]);
  const userCallAt = new Map(userCalls.map((r) => [`${r.appId}:${r.actorUserId}`, r._max.createdAt]));
  const { intervals: stopIntervals, holds: stopHoldsBy } = await loadStopIntervals(db, workerIds, ids);
  const progressBy = new Map(progress.map((p) => [p.taskId, p._max.createdAt]));
  const queuedBy = new Map(queued.map((q) => [q.taskId, q._max.createdAt]));
  const editedBy = new Map(startByEdits.map(e => [e.taskId, e._max.createdAt]));
  const childrenBy = new Map<string, typeof children>();
  for (const c of children) {
    const list = childrenBy.get(c.parentTaskId as string) ?? [];
    list.push(c);
    childrenBy.set(c.parentTaskId as string, list);
  }
  return tasks.map((task) => {
    const kids = childrenBy.get(task.id) ?? [];
    const ends = kids.map((c) => c.finishedAt ?? c.cancelledAt).filter((d): d is Date => !!d);
    return {
      task,
      openChildCount: kids.filter((c) => OPEN_STATUSES.includes(c.status)).length,
      lastChildEndedAt: latest(...ends),
      endedChildren: kids
        .flatMap((c) => {
          const endedAt = c.status === 'finished' ? c.finishedAt : c.status === 'cancelled' ? c.cancelledAt : null;
          return endedAt
            ? [{
              id: c.id, endedAt, ownerWorkerId: c.ownerWorkerId,
              ownerActivityAt: c.ownerWorkerId
                ? activity.get(c.ownerWorkerId)?.lastActiveAt ?? null
                : c.ownerUserId ? userCallAt.get(`${task.appId}:${c.ownerUserId}`) ?? null : null,
            }]
            : [];
        })
        .sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime() || a.id.localeCompare(b.id)),
      lastProgressAt: progressBy.get(task.id) ?? null,
      assigneeActivityAt: task.assigneeWorkerId ? activity.get(task.assigneeWorkerId)?.lastActiveAt ?? null : null,
      queuedAt: queuedBy.get(task.id) ?? null,
      startByEditedAt: editedBy.get(task.id) ?? null,
      stopIntervals,
      stopHolds: stopHoldsBy.get(task.id) ?? [],
    };
  });
}

/**
 * #2022 — the stopped spans the rules subtract: each worker's `pause` / `halt` coverage (an interval ends at the
 * earliest of leaving the coverage, its signal's end and its signal's until, so a late expiry sweep never lengthens it;
 * `pause-dispatch` stops no stall time but the couldn't-be-assigned one, R68), and each task's stop holds.
 */
async function loadStopIntervals(db: Db, workerIds: string[], taskIds: string[]): Promise<{ intervals: Map<string, StopInterval[]>; holds: Map<string, StopInterval[]> }> {
  const intervals = new Map<string, StopInterval[]>();
  const holds = new Map<string, StopInterval[]>();
  const [cov, held] = await Promise.all([
    workerIds.length
      ? db.$queryRaw<{ workerId: string; start: Date; end: Date | null }[]>(Prisma.sql`
          SELECT c.worker_id AS "workerId", c.entered_at AS start, LEAST(c.left_at, s.ended_at, s.until) AS "end"
          FROM team_stop_coverage c JOIN team_stop_signals s ON s.id = c.signal_id
          WHERE c.worker_id IN (${Prisma.join(workerIds)}) AND s.level IN ('pause', 'halt')`)
      : Promise.resolve([]),
    taskIds.length
      ? db.agentTaskStopHold.findMany({ where: { taskId: { in: taskIds } }, select: { taskId: true, startedAt: true, endedAt: true } })
      : Promise.resolve([]),
  ]);
  for (const r of cov) intervals.set(r.workerId, [...(intervals.get(r.workerId) ?? []), { start: r.start, end: r.end }]);
  for (const h of held) holds.set(h.taskId, [...(holds.get(h.taskId) ?? []), { start: h.startedAt, end: h.endedAt }]);
  return { intervals, holds };
}

function latest(...dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const d of dates) if (d && (!best || d.getTime() > best.getTime())) best = d;
  return best;
}

// ── The rules (pure) ──────────────────────────────────────────────────────

/** One alarm a task is due, keyed by its episode. */
export type StallCandidate = {
  rule: StallRule;
  taskId: string;
  appId: string;
  episodeStart: Date;
  /** When the condition has held for the window. The alarm is due at or after it. */
  dueAt: Date;
  windowMinutes: number;
  assignee: TaskParty | null;
  childTaskId?: string;
};

function assigneeOf(t: TaskState): TaskParty | null {
  if (t.assigneeWorkerId) return { workerId: t.assigneeWorkerId };
  if (t.assigneeUserId) return { userId: t.assigneeUserId };
  return null;
}

const plus = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * MINUTE);

/** #2022 — does a stopped span hold at `at` (started at or before it, not yet ended)? */
function heldAt(spans: readonly StopInterval[], at: Date): boolean {
  const t = at.getTime();
  return spans.some((i) => i.start.getTime() <= t && (i.end === null || i.end.getTime() > t));
}

/** #2022 — a worker's stopped spans, or none. */
const stopOf = (inputs: StallInputs, workerId: string | null | undefined): StopInterval[] =>
  (workerId ? inputs.stopIntervals?.get(workerId) : undefined) ?? [];

/**
 * The alarms a task's state calls for at `now`, at most one per rule. Pure:
 * every evaluation of the same inputs names the same episodes.
 *
 * `episodesRunning` (#2200, R196) asks a different question of the same rules:
 * not "is an alarm DUE now" but "does this episode's CONDITION still hold". It
 * skips the two gates in `add` (the window having passed, and a #2022 stop
 * holding the clock), because an alarm already raised stays running through
 * both. It names a superset of the default's candidates with the same
 * `episodeStart` for each; the rule bodies are not forked.
 */
export function stallCandidates(
  inputs: StallInputs,
  windows: StallWindows,
  now: Date,
  options: { episodesRunning?: boolean } = {},
): StallCandidate[] {
  const { task } = inputs;
  if (task.blocked) return [];
  const floor = (d: Date) => latest(d, task.releasedAt) as Date;
  const assignee = assigneeOf(task);
  const out: StallCandidate[] = [];
  const running = options.episodesRunning === true;
  const add = (rule: StallRule, episodeStart: Date, dueAt: Date, extra: Partial<StallCandidate> = {}, stopped: readonly StopInterval[] = []) => {
    if (!running && dueAt.getTime() > now.getTime()) return;
    // #2022: while the stop exception holds, nothing is raised and nobody up the chain is woken (the Proposed
    // amendment to cor:agt:050:13); the episode carries on afterwards from the time it had counted.
    if (!running && heldAt(stopped, now)) return;
    out.push({
      rule, taskId: task.id, appId: task.appId, episodeStart, dueAt,
      windowMinutes: windows[RULE_WINDOW[rule]], assignee, ...extra,
    });
  };

  // cor:agt:050:17 — queued: pending with no assignee. The episode starts when
  // the task entered the queue — its latest `assignment.queued` event: #1754
  // made queue entry a move (make-ready re-queues a parked task), so `createdAt`
  // would arm an aged backlog's alarm the moment it is made ready, and a second
  // stint would share the first alarm's episode key and be silenced. Rows with
  // no queue event (seeded past the resolvers) fall back to creation, the
  // pre-#1754 start.
  if (task.status === 'pending' && !assignee) {
    const queuedAt = floor(inputs.queuedAt ?? task.createdAt);
    add('unassignable', queuedAt, countedDueAt(queuedAt, windows.assignmentMinutes * MINUTE, inputs.stopHolds), {}, inputs.stopHolds);
  }

  // cor:agt:050:14 — assigned and still pending. A still-working note does not
  // stop it (S3): only starting, reassigning or cancelling the task does.
  if (task.status === 'pending' && assignee && task.assignedAt) {
    const assignedAt = floor(task.assignedAt);
    const deadline = task.startBy && task.startBy.getTime() > assignedAt.getTime()
      ? task.startBy
      : plus(assignedAt, windows.notStartedMinutes);
    // #2022: a `pause` or `halt` on the assignee holds the clock, startBy's included (Vera's receipt §5).
    const stopped = stopOf(inputs, task.assigneeWorkerId);
    // A startBy edit (task.edited) opens a new episode; the deadline stays anchored at the floored assignment.
    add('not-started', latest(assignedAt, inputs.startByEditedAt) as Date, countedDueAt(assignedAt, deadline.getTime() - assignedAt.getTime(), stopped), {}, stopped);
  }

  // cor:agt:050:15 — started, not waiting on children, no assignee activity.
  if (task.status === 'started' && inputs.openChildCount === 0 && task.startedAt) {
    const since = latest(
      task.startedAt, task.assignedAt, inputs.lastChildEndedAt, inputs.lastProgressAt, inputs.assigneeActivityAt, task.releasedAt,
    ) as Date;
    const stopped = stopOf(inputs, task.assigneeWorkerId);
    add('no-progress', since, countedDueAt(since, windows.noProgressMinutes * MINUTE, stopped), {}, stopped);
  }

  // cor:agt:050:16 r2 — a child finished and the child's owner, this task's
  // assignee, has not moved since. The alarm is about THIS (the parent) task.
  const first = assignee ? unreactedChild(inputs) : null;
  if (first) {
    const stopped = stopOf(inputs, first.ownerWorkerId);
    add('owner-unreactive', floor(first.endedAt), countedDueAt(floor(first.endedAt), windows.ownerReactionMinutes * MINUTE, stopped), {
      childTaskId: first.id,
    }, stopped);
  }
  return out;
}

/**
 * cor:agt:050:16 r2 — the earliest finished child of this task that finished
 * after its assignee last moved, or null. The owner-unreactive episode starts
 * there; the roster (#1707) reads the same answer as "your move".
 */
export function unreactedChild(inputs: StallInputs): StallInputs['endedChildren'][number] | null {
  return unreactedChildren(inputs)[0] ?? null;
}

/**
 * Every ended child whose owner has not been active since it ended, earliest
 * end first. Only the CHILD OWNER's own activity counts (cor:agt:050:16,
 * #1831): the parent's reassignment, start or progress by its assignee is not
 * a reaction, so the answer does not depend on who the parent is assigned to.
 */
export function unreactedChildren(inputs: StallInputs): StallInputs['endedChildren'] {
  return inputs.endedChildren.filter((c) => !c.ownerActivityAt || c.endedAt.getTime() > c.ownerActivityAt.getTime());
}

// ── The owner chain ───────────────────────────────────────────────────────

/**
 * cor:agt:050:18 — the task's owner, then its parent's owner, up to the root
 * owner, nearest first; then, cor:agt:050:25 (#1761), whoever manages the App
 * (`appManagerUserIds`), because a root task has no parent owner to escalate to.
 * A party who appears more than once is kept at their nearest position only, so
 * escalation never wakes the same party twice.
 */
export async function ownerChain(db: Db, taskId: string): Promise<AlarmChain> {
  const rows = await db.$queryRaw<{ ownerWorkerId: string | null; ownerUserId: string | null }[]>`
    WITH RECURSIVE up AS (
      SELECT id, app_id, parent_task_id, owner_worker_id, owner_user_id, 0 AS depth
      FROM agent_tasks WHERE id = ${taskId}
      UNION ALL
      SELECT t.id, t.app_id, t.parent_task_id, t.owner_worker_id, t.owner_user_id, up.depth + 1
      FROM agent_tasks t JOIN up ON t.id = up.parent_task_id
      -- Same App only (#1720 review, Rook P3-4): T1 refuses a cross-App
      -- parent at create; this keeps another tenant's owners out of a chain
      -- even if a later move ever relinked one.
      -- #2553: the walk stops below AT0, the reserved "No project" row: its owner is a bookkeeping fallback, not a
      -- parent who owns the task.
      WHERE up.depth < 64 AND t.app_id = up.app_id AND t.handle <> 'AT0'
    )
    SELECT owner_worker_id AS "ownerWorkerId", owner_user_id AS "ownerUserId" FROM up ORDER BY depth`;
  const chain: AlarmChain = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const party: TaskParty | null = r.ownerWorkerId
      ? { workerId: r.ownerWorkerId }
      : r.ownerUserId ? { userId: r.ownerUserId } : null;
    if (!party) continue;
    const key = party.workerId ? `w:${party.workerId}` : `u:${party.userId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push(party);
  }
  const app = await db.agentTask.findUnique({
    where: { id: taskId },
    select: { app: { select: { id: true, organizationId: true, ownerUserId: true } } },
  });
  if (app) {
    for (const userId of await appManagerUserIds(db, app.app)) {
      const key = `u:${userId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push({ userId, via: 'manager' });
    }
  }
  return chain;
}

// ── Raising ───────────────────────────────────────────────────────────────

/** The rules whose alarm marks a worker assignee unavailable (cor:agt:060:07, Proposed; #1758 added owner-unreactive). */
const MARKS_ASSIGNEE: ReadonlySet<StallRule> = new Set(['not-started', 'no-progress', 'owner-unreactive']);

/**
 * Raise one candidate's alarm, once per episode. Re-evaluates the task under
 * a FOR SHARE lock and raises only if the same episode is still due, then
 * inserts the alarm (`ON CONFLICT DO NOTHING` on the episode key), its wake
 * rows, and — for not-started / no-progress on a worker — the stall mark.
 * Returns the alarm's id, or null when there was nothing (more) to raise.
 *
 * SERIALIZABLE (#1720 review, Diego P2). The chain names person owners by user
 * id, sealed, and `mergeUsers` refuses to merge an account named in an open
 * alarm (`refuseUsersInOpenAlarmChains`). A raise reads the chain's owner rows
 * that a merge rewrites, and the merge's guard reads the events this raise
 * inserts. Both transactions are SERIALIZABLE, so a raise racing a merge is a
 * read-write cycle that Postgres aborts on one side, and never a committed
 * alarm naming a just-merged account. A raise that loses throws a
 * serialization failure. `evaluateStalls` skips it, and the next pass raises
 * against the merged owner. So does a raise that collides with a concurrent
 * pass's insert of the same episode.
 *
 * `hooks.afterChain` is a TEST seam: it runs between reading the chain and
 * inserting the alarm, so a test can interleave a merge there.
 */
export async function raiseStallAlarm(
  db: PrismaClient,
  candidate: StallCandidate,
  now: Date,
  hooks: { afterChain?: () => Promise<void> } = {},
  /** `now`'s monotonic half (`anchorNow`), from the evaluation pass; by default taken here, beside `now`. */
  anchor: number = anchorNow(),
): Promise<string | null> {
  return db.$transaction(async (tx) => {
    // #2022: the App's stop fence, shared, so a raise and a stop signal change are ordered; the re-evaluation below
    // then reads the coverage ledger as the last signal change left it.
    await lockStopFence(tx, candidate.appId, 'shared');
    await tx.$queryRaw`SELECT id FROM agent_tasks WHERE id = ${candidate.taskId} FOR SHARE`;
    // #2022 (Xan #2166 LOCAL-1): re-decided at the moment after the waits, so a stop that began or ended while this
    // raise waited is counted as it is now.
    const decidedAt = afterWaits(now, anchor);
    const [inputs] = await loadStallInputs(tx, { id: candidate.taskId }, decidedAt);
    if (!inputs) return null;
    const windows = (await loadWindows(tx, [inputs.task.appId])).get(inputs.task.appId) as StallWindows;
    const again = stallCandidates(inputs, windows, decidedAt).find(
      (c) => c.rule === candidate.rule && c.episodeStart.getTime() === candidate.episodeStart.getTime(),
    );
    if (!again) return null;

    const chain = await ownerChain(tx, again.taskId);
    await hooks.afterChain?.();
    const subjectWorkerId = again.assignee?.workerId ?? null;
    const eventId = await appendAlarmEvent(tx, {
      appId: again.appId,
      taskId: again.taskId,
      type: STALL_EVENT_TYPE[again.rule],
      episodeStart: again.episodeStart,
      chain,
      subjectWorkerId,
      payload: {
        windowMinutes: again.windowMinutes,
        ...(again.rule === 'unassignable' ? {} : { assignee: again.assignee }),
        ...(again.childTaskId ? { childTaskId: again.childTaskId } : {}),
      },
      createdAt: now,
    });
    if (!eventId) return null;

    // cor:agt:050:19 — the nearest owner is woken now; owner i falls due i
    // windows later (Proposed), unless the alarm is acknowledged first.
    await tx.agentTeamAlarmSchedule.createMany({
      data: chain.map((_, i) => ({
        eventId,
        chainIndex: i,
        dueAt: plus(now, i * again.windowMinutes),
        wokenAt: i === 0 ? now : null,
      })),
    });

    // cor:agt:060:07 — not-started / no-progress mark the task's assignee;
    // owner-unreactive marks the FINISHED CHILD's owner (#1758), who is the
    // parent's assignee only until the parent is reassigned. A person is never
    // marked (availability is a worker's).
    let markWorkerId = subjectWorkerId;
    if (again.rule === 'owner-unreactive') {
      const child = again.childTaskId
        ? await tx.agentTask.findUnique({ where: { id: again.childTaskId }, select: { ownerWorkerId: true } })
        : null;
      markWorkerId = child?.ownerWorkerId ?? null;
    }
    if (MARKS_ASSIGNEE.has(again.rule) && markWorkerId) {
      await markStalled(tx, { workerId: markWorkerId, appId: again.appId, alarmEventId: eventId, now });
    }
    return eventId;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/**
 * A serialization failure: Prisma reports P2034 for the transaction, or
 * P2010 with SQLSTATE 40001 when a raw statement hits it.
 */
export function isSerializationFailure(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === 'P2034') return true;
  const meta = e.meta as { code?: unknown } | undefined;
  return e.code === 'P2010' && meta?.code === '40001';
}

/** Tasks per evaluation page: the inputs are loaded per page, not per task. */
const EVALUATION_PAGE = 500;

/**
 * One evaluation pass over every open task of every live, installed App:
 * compute the due candidates page by page, then raise each. Returns the ids of
 * the alarms this pass raised (a re-run, or a pass racing another instance,
 * raises none it already raised).
 */
export async function evaluateStalls(db: PrismaClient, now = new Date(), anchor: number = anchorNow()): Promise<string[]> {
  const raised: string[] = [];
  let after: string | null = null;
  for (;;) {
    const page: { id: string; appId: string }[] = await db.agentTask.findMany({
      where: {
        status: { in: OPEN_STATUSES },
        app: { deletedAt: null, uninstalledAt: null },
        ...(after ? { id: { gt: after } } : {}),
      },
      select: { id: true, appId: true },
      orderBy: { id: 'asc' },
      take: EVALUATION_PAGE,
    });
    if (page.length === 0) break;
    after = page[page.length - 1].id;
    const inputs = await loadStallInputs(db, { id: { in: page.map((t) => t.id) } }, now);
    const windows = await loadWindows(db, [...new Set(page.map((t) => t.appId))]);
    for (const i of inputs) {
      for (const c of stallCandidates(i, windows.get(i.task.appId) as StallWindows, now)) {
        try {
          const id = await raiseStallAlarm(db, c, now, {}, anchor);
          if (id) raised.push(id);
        } catch (err) {
          // Lost a serialization race (a concurrent pass raised the same
          // episode, a merge rewrote an owner, a T1 move): the next pass re-evaluates.
          if (isSerializationFailure(err)) continue;
          // One task's failure never stops the pass; the next pass retries it.
          console.error(`[task-stall] raising ${c.rule} on task ${c.taskId} failed:`, err);
        }
      }
    }
    if (page.length < EVALUATION_PAGE) break;
  }
  return raised;
}

/** An alarm's episode key: its task, its type (the rule) and its episode start. */
export const alarmEpisodeKey = (taskId: string, type: string, episodeStart: Date): string =>
  `${taskId}|${type}|${episodeStart.getTime()}`;

/**
 * #1708 (Rook §10 P3-1 on #1720) — which of these alarms' episodes still hold
 * NOW: the same rule still fires for the task with the same episode start, by
 * the evaluator's own `stallCandidates`. `loadStallInputs` reads only open tasks
 * of live, installed Apps, so an ended task or an uninstalled App is not
 * current either. Returns the current alarms' `alarmEpisodeKey`s.
 */
export async function currentAlarmEpisodes(
  db: Db,
  alarms: { taskId: string; type: string; episodeStart: Date | null }[],
  now: Date,
): Promise<Set<string>> {
  const out = new Set<string>();
  const taskIds = [...new Set(alarms.filter((a) => a.episodeStart).map((a) => a.taskId))];
  if (taskIds.length === 0) return out;
  const inputs = await loadStallInputs(db, { id: { in: taskIds } }, now);
  const windows = await loadWindows(db, [...new Set(inputs.map((i) => i.task.appId))]);
  for (const i of inputs) {
    for (const c of stallCandidates(i, windows.get(i.task.appId) as StallWindows, now)) {
      out.add(alarmEpisodeKey(c.taskId, STALL_EVENT_TYPE[c.rule], c.episodeStart));
    }
  }
  return out;
}

/** The alarm types the stall rules raise, each back to nothing else: only these can be classified as ended. */
const STALL_ALARM_TYPES: ReadonlySet<string> = new Set(Object.values(STALL_EVENT_TYPE));
/** A task row that can never move again, or raises no alarms (cor:agt:050:02): its alarms' episodes are over. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['finished', 'cancelled', 'backlog']);

/**
 * #2200 (R196) — which of these alarms' OWN episodes have ended: the condition that
 * raised each no longer holds, so nothing up its chain should be woken for it.
 * Positive proof only. An alarm is ended when its task, in a live and installed App,
 *   - is in a terminal status (finished, cancelled, or parked to backlog), or
 *   - is open, was actually loaded by the evaluator's own `loadStallInputs`, and the
 *     alarm's episode key is not among `stallCandidates` in `episodesRunning` mode.
 * Anything else is NOT ended: a task that is missing or sits in an uninstalled or
 * deleted App, an open task `loadStallInputs` returned nothing for, an alarm with no
 * episode start, or a type the stall rules do not raise. A #2022 stop never ends an
 * alarm (the flagged mode ignores it). One loader serves every caller (the escalation
 * and the roster), so the two cannot disagree. Returns the ended alarms' `alarmEpisodeKey`s.
 */
export async function endedAlarmEpisodes(
  db: Db,
  alarms: { taskId: string | null; type: string; episodeStart: Date | null }[],
  now: Date,
): Promise<Set<string>> {
  const out = new Set<string>();
  const subject = alarms.filter((a): a is { taskId: string; type: string; episodeStart: Date } =>
    !!a.taskId && !!a.episodeStart && STALL_ALARM_TYPES.has(a.type));
  const taskIds = [...new Set(subject.map((a) => a.taskId))];
  if (taskIds.length === 0) return out;
  const tasks = await db.agentTask.findMany({
    where: { id: { in: taskIds }, app: { deletedAt: null, uninstalledAt: null } },
    select: { id: true, status: true },
  });
  const statusOf = new Map(tasks.map((t) => [t.id, t.status]));
  const openIds = tasks.filter((t) => OPEN_STATUSES.includes(t.status)).map((t) => t.id);
  const inputs = openIds.length ? await loadStallInputs(db, { id: { in: openIds } }, now) : [];
  const windows = await loadWindows(db, [...new Set(inputs.map((i) => i.task.appId))]);
  const loaded = new Set(inputs.map((i) => i.task.id));
  const running = new Set<string>();
  for (const i of inputs) {
    for (const c of stallCandidates(i, windows.get(i.task.appId) as StallWindows, now, { episodesRunning: true })) {
      running.add(alarmEpisodeKey(c.taskId, STALL_EVENT_TYPE[c.rule], c.episodeStart));
    }
  }
  for (const a of subject) {
    const status = statusOf.get(a.taskId);
    if (status === undefined) continue; // unknown: not found among live, installed Apps' tasks
    const key = alarmEpisodeKey(a.taskId, a.type, a.episodeStart);
    if (TERMINAL_STATUSES.has(status)) out.add(key);
    else if (loaded.has(a.taskId) && !running.has(key)) out.add(key);
  }
  return out;
}

// ── Escalation ────────────────────────────────────────────────────────────

/**
 * cor:agt:050:19 / :20 — wake every owner whose wake has fallen due on an
 * alarm that is still unacknowledged. Returns how many it woke.
 *
 * #2200 (R196): an alarm whose own episode has ended is closed instead
 * (`ended_at` on all its unwoken rows) and wakes nobody; see `endedAlarmEpisodes`.
 *
 * The due rows are locked FOR NO KEY UPDATE (SKIP LOCKED, so a concurrent
 * pass takes the others), and their alarm FOR SHARE. `acknowledgeAlarm` holds
 * the alarm FOR UPDATE, so the two serialize: an acknowledgement that commits
 * first makes the alarm's row fail the re-checked `acknowledged_at IS NULL`,
 * and no owner above is woken after it (050:20 S1).
 */
export async function wakeDueOwners(db: PrismaClient, now = new Date()): Promise<number> {
  return db.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ eventId: string; chainIndex: number; taskId: string | null; type: string; episodeStart: Date | null }[]>`
      SELECT w.event_id AS "eventId", w.chain_index AS "chainIndex",
             e.task_id AS "taskId", e.type, e.episode_start AS "episodeStart"
      FROM agent_team_alarm_schedule w
      JOIN agent_team_events e ON e.id = w.event_id
      WHERE w.woken_at IS NULL
        AND w.ended_at IS NULL
        AND w.due_at <= ${toNaiveUtc(now)}::timestamp
        AND e.acknowledged_at IS NULL
      ORDER BY w.due_at, w.event_id, w.chain_index
      LIMIT 500
      FOR NO KEY UPDATE OF w SKIP LOCKED
      FOR SHARE OF e`;
    if (due.length === 0) return 0;
    // #2200: the batch's tasks, shared and in id order (the lock `raiseStallAlarm` takes, so no deadlock), BEFORE the
    // episodes are read: a cancel, start or reassignment holds its task exclusively, so it committed before this read
    // or waits until the batch is stamped. No stray stamp lands after a committed move.
    const taskIds = [...new Set(due.map((d) => d.taskId).filter((t): t is string => !!t))].sort();
    if (taskIds.length) await tx.$queryRaw`SELECT id FROM agent_tasks WHERE id IN (${Prisma.join(taskIds)}) ORDER BY id FOR SHARE`;
    const ended = await endedAlarmEpisodes(tx, due, now);
    const endedEvents = new Set(
      due.filter((d) => d.taskId && d.episodeStart && ended.has(alarmEpisodeKey(d.taskId, d.type, d.episodeStart))).map((d) => d.eventId),
    );
    // #2755: a dark-worker alarm is task-less; its episode ended when `dark_worker_episodes` says so.
    const darkIds = due.filter((d) => d.type === 'alarm.dark-worker').map((d) => d.eventId);
    if (darkIds.length) {
      const over = await tx.darkWorkerEpisode.findMany({ where: { eventId: { in: darkIds }, endedAt: { not: null } }, select: { eventId: true } });
      for (const e of over) endedEvents.add(e.eventId);
    }
    if (endedEvents.size) {
      // The alarm's own episode is over: close EVERY row of it still unwoken (not only the due ones), so no later
      // owner up the chain is woken for a condition that is gone. Nothing else is written: the alarm, its chain and
      // the rows already woken stay as they were. The rows are taken SKIP LOCKED, never waited for: a row another
      // pass holds is that pass's to stamp, and waiting on it while it waits on ours is a lock cycle (two passes
      // owning different rows of one ended alarm).
      const rows = await tx.$queryRaw<{ eventId: string; chainIndex: number }[]>`
        SELECT event_id AS "eventId", chain_index AS "chainIndex"
        FROM agent_team_alarm_schedule
        WHERE event_id IN (${Prisma.join([...endedEvents])})
          AND woken_at IS NULL AND ended_at IS NULL
        ORDER BY event_id, chain_index
        FOR NO KEY UPDATE SKIP LOCKED`;
      for (const r of rows) {
        await tx.agentTeamAlarmSchedule.updateMany({
          where: { eventId: r.eventId, chainIndex: r.chainIndex, wokenAt: null, endedAt: null },
          data: { endedAt: now },
        });
      }
    }
    let woken = 0;
    for (const d of due) {
      if (endedEvents.has(d.eventId)) continue;
      const n = await tx.agentTeamAlarmSchedule.updateMany({
        where: { eventId: d.eventId, chainIndex: d.chainIndex, wokenAt: null, endedAt: null },
        data: { wokenAt: now },
      });
      woken += n.count;
    }
    return woken;
  });
}
