/**
 * #1706 (Task Management T2) — the four stall rules, the alarm they raise once
 * per episode, and the owner chain the alarm climbs (cor:agt:050:12–:20).
 *
 * | Rule              | Condition                                         | Default | Spec        |
 * |-------------------|---------------------------------------------------|---------|-------------|
 * | not-started       | pending, assigned, past start-by or the window     | 15 min  | 050:14      |
 * | no-progress       | started, no open child, no assignee activity       | 60 min  | 050:15      |
 * | owner-unreactive  | a child finished; no activity since by the         | 20 min  | 050:16 (r2) |
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
 *   - owner-unreactive: the EARLIEST child finish after the parent's
 *     assignee last moved (activity, a still-working note, the parent's start
 *     or its assignment). A second child finishing in the same silence is the
 *     same episode: the condition has held since the first.
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
 * Interim readings carried from the issue until Holger rules: only a FINISHED
 * child starts the owner-unreactive window (050:16 open question); no alarm on
 * an ended parent (it is not open, so it is never evaluated); a root task's
 * chain ends at its owner (050:18 open question); escalation steps by the
 * alarm's own window (050:19, Proposed).
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { appendAlarmEvent, type AlarmChain, type AlarmEventType, type TaskParty } from './events.js';
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

type Db = PrismaClient | Prisma.TransactionClient;

const TASK_SELECT = {
  id: true, appId: true, status: true, parentTaskId: true,
  ownerWorkerId: true, ownerUserId: true, assigneeWorkerId: true, assigneeUserId: true,
  startBy: true, assignedAt: true, startedAt: true, createdAt: true,
} as const;
type TaskState = Prisma.AgentTaskGetPayload<{ select: typeof TASK_SELECT }>;

/** Everything one task's rules read. */
export type StallInputs = {
  task: TaskState;
  openChildCount: number;
  /** When the last child ended (finished or cancelled), if any has. */
  lastChildEndedAt: Date | null;
  /** Finished children, earliest finish first. */
  finishedChildren: { id: string; finishedAt: Date }[];
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
};

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
  const workerIds = [...new Set(tasks.map((t) => t.assigneeWorkerId).filter((w): w is string => !!w))];
  const [children, progress, queued, activity] = await Promise.all([
    db.agentTask.findMany({
      where: { parentTaskId: { in: ids } },
      select: { id: true, parentTaskId: true, status: true, finishedAt: true, cancelledAt: true },
    }),
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
  ]);
  const progressBy = new Map(progress.map((p) => [p.taskId, p._max.createdAt]));
  const queuedBy = new Map(queued.map((q) => [q.taskId, q._max.createdAt]));
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
      finishedChildren: kids
        .filter((c) => c.status === 'finished' && c.finishedAt)
        .map((c) => ({ id: c.id, finishedAt: c.finishedAt as Date }))
        .sort((a, b) => a.finishedAt.getTime() - b.finishedAt.getTime() || a.id.localeCompare(b.id)),
      lastProgressAt: progressBy.get(task.id) ?? null,
      assigneeActivityAt: task.assigneeWorkerId ? activity.get(task.assigneeWorkerId)?.lastActiveAt ?? null : null,
      queuedAt: queuedBy.get(task.id) ?? null,
    };
  });
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

/**
 * The alarms a task's state calls for at `now`, at most one per rule. Pure:
 * every evaluation of the same inputs names the same episodes.
 */
export function stallCandidates(inputs: StallInputs, windows: StallWindows, now: Date): StallCandidate[] {
  const { task } = inputs;
  const assignee = assigneeOf(task);
  const out: StallCandidate[] = [];
  const add = (rule: StallRule, episodeStart: Date, dueAt: Date, extra: Partial<StallCandidate> = {}) => {
    if (dueAt.getTime() > now.getTime()) return;
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
    const queuedAt = inputs.queuedAt ?? task.createdAt;
    add('unassignable', queuedAt, plus(queuedAt, windows.assignmentMinutes));
  }

  // cor:agt:050:14 — assigned and still pending. A still-working note does not
  // stop it (S3): only starting, reassigning or cancelling the task does.
  if (task.status === 'pending' && assignee && task.assignedAt) {
    const deadline = task.startBy && task.startBy.getTime() > task.assignedAt.getTime()
      ? task.startBy
      : plus(task.assignedAt, windows.notStartedMinutes);
    add('not-started', task.assignedAt, deadline);
  }

  // cor:agt:050:15 — started, not waiting on children, no assignee activity.
  if (task.status === 'started' && inputs.openChildCount === 0 && task.startedAt) {
    const since = latest(
      task.startedAt, task.assignedAt, inputs.lastChildEndedAt, inputs.lastProgressAt, inputs.assigneeActivityAt,
    ) as Date;
    add('no-progress', since, plus(since, windows.noProgressMinutes));
  }

  // cor:agt:050:16 r2 — a child finished and the child's owner, this task's
  // assignee, has not moved since. The alarm is about THIS (the parent) task.
  const first = assignee ? unreactedChild(inputs) : null;
  if (first) {
    add('owner-unreactive', first.finishedAt, plus(first.finishedAt, windows.ownerReactionMinutes), {
      childTaskId: first.id,
    });
  }
  return out;
}

/**
 * cor:agt:050:16 r2 — the earliest finished child of this task that finished
 * after its assignee last moved, or null. The owner-unreactive episode starts
 * there; the roster (#1707) reads the same answer as "your move".
 */
export function unreactedChild(inputs: StallInputs): { id: string; finishedAt: Date } | null {
  const { task } = inputs;
  if (!inputs.finishedChildren.length) return null;
  const moved = latest(task.assignedAt, task.startedAt, inputs.lastProgressAt, inputs.assigneeActivityAt);
  return inputs.finishedChildren.find((c) => !moved || c.finishedAt.getTime() > moved.getTime()) ?? null;
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
      WHERE up.depth < 64 AND t.app_id = up.app_id
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
): Promise<string | null> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM agent_tasks WHERE id = ${candidate.taskId} FOR SHARE`;
    const [inputs] = await loadStallInputs(tx, { id: candidate.taskId }, now);
    if (!inputs) return null;
    const windows = (await loadWindows(tx, [inputs.task.appId])).get(inputs.task.appId) as StallWindows;
    const again = stallCandidates(inputs, windows, now).find(
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

    // cor:agt:060:07 — a person assignee is never marked (availability is a worker's).
    if (MARKS_ASSIGNEE.has(again.rule) && subjectWorkerId) {
      await markStalled(tx, { workerId: subjectWorkerId, appId: again.appId, alarmEventId: eventId, now });
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
export async function evaluateStalls(db: PrismaClient, now = new Date()): Promise<string[]> {
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
          const id = await raiseStallAlarm(db, c, now);
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

// ── Escalation ────────────────────────────────────────────────────────────

/**
 * cor:agt:050:19 / :20 — wake every owner whose wake has fallen due on an
 * alarm that is still unacknowledged. Returns how many it woke.
 *
 * The due rows are locked FOR NO KEY UPDATE (SKIP LOCKED, so a concurrent
 * pass takes the others), and their alarm FOR SHARE. `acknowledgeAlarm` holds
 * the alarm FOR UPDATE, so the two serialize: an acknowledgement that commits
 * first makes the alarm's row fail the re-checked `acknowledged_at IS NULL`,
 * and no owner above is woken after it (050:20 S1).
 */
export async function wakeDueOwners(db: PrismaClient, now = new Date()): Promise<number> {
  return db.$transaction(async (tx) => {
    const due = await tx.$queryRaw<{ eventId: string; chainIndex: number }[]>`
      SELECT w.event_id AS "eventId", w.chain_index AS "chainIndex"
      FROM agent_team_alarm_schedule w
      JOIN agent_team_events e ON e.id = w.event_id
      WHERE w.woken_at IS NULL
        AND w.due_at <= ${toNaiveUtc(now)}::timestamp
        AND e.acknowledged_at IS NULL
      ORDER BY w.due_at, w.event_id, w.chain_index
      LIMIT 500
      FOR NO KEY UPDATE OF w SKIP LOCKED
      FOR SHARE OF e`;
    let woken = 0;
    for (const d of due) {
      const n = await tx.agentTeamAlarmSchedule.updateMany({
        where: { eventId: d.eventId, chainIndex: d.chainIndex, wokenAt: null },
        data: { wokenAt: now },
      });
      woken += n.count;
    }
    return woken;
  });
}
