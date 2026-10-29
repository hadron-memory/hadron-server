import { lockTaskGraph } from './blockers.js';
/**
 * #1707 — the matcher (cor:agt:060:05, :06; plan design:agent-tasks §5).
 *
 * The platform assigns a queued task (pending, no assignee — cor:agt:050:03)
 * to a worker FREE FOR WORK that has the task's role, runs as an allowed model
 * family, and isn't excluded by name; among those, the one assigned least
 * recently. No language model is involved anywhere.
 *
 * FREE FOR WORK (060:05): in the App and not retired; the assignee of no
 * pending or started task; available for work (060:01: neither its own record
 * nor its family's says unavailable, so a stalled worker is out); and has a
 * model family — its binding's (newest open session's, quiet or not) when
 * bound, else one a live host registration can launch it as (060:04). A worker kept bound after a finished
 * task (`closeSessionWhenDone: false`) is free and keeps its family.
 *
 * WHO IS MATCHED (`matchable`, shipped with T6, #1709): a BOUND worker only
 * while its session is LIVE (cor:agt:020:11) and has reported a family, since
 * a quiet session has nobody driving it and matching it would only park the
 * task; an UNBOUND worker when a live host registration can launch it, as one
 * of the families that host lists (`MATCH_UNBOUND_LAUNCHABLE`; the assignment
 * then issues a `worker.start`). That restriction is the matcher's; the family
 * still follows the binding (#1723 review, Diego P2-2), and the roster still
 * reports a quiet bound worker as free (`liveSession` tells them apart).
 * #1709 (T6): a worker waiting on a session end (cor:agt:050:10: an open
 * request whose session is still open, or an outstanding `worker.end`) is not
 * matched either (`endingSession`), so new work never lands in a session the
 * platform is about to end. Also the matcher's restriction, Proposed: free for
 * work (060:05) is unchanged, and the roster still shows such a worker free.
 *
 * INTERIM until Holger rules (060:06 open questions, #1707): a never-assigned
 * worker ranks as least recent; ties break by name, then id; the oldest
 * queued task is served first (Proposed). A family is a MATCHING input, never
 * an authorization input — nothing here grants anything on the strength of it.
 *
 * CONCURRENCY. Several runs may overlap (event triggers, the sweep, other
 * instances). Each assignment is its own READ COMMITTED transaction:
 *   1. the App's authority anchor, SHARED — an uninstall or delete either
 *      committed first (the task is left alone) or waits;
 *   2. a transaction-scoped advisory lock on the WORKER, taken with
 *      `$executeRaw` (`$queryRaw` can't deserialize the void return), which
 *      serializes the free-for-work re-check with the assignment: a second run
 *      waiting on the same worker re-checks after the first commits, sees the
 *      task it was just given, and moves on. READ COMMITTED on purpose: a
 *      SERIALIZABLE snapshot would predate the wait
 *      (findings:serializable-advisory-wait-keeps-old-snapshot);
 *   3. the worker row FOR SHARE, so a retire either committed first or waits;
 *   4. a guarded `updateMany` on (`status = pending`, no assignee): two runs
 *      can never both assign one task — the loser's update matches no row.
 */

import { lockWorkersForAssignment } from './workerLock.js';
import { afterWaits, anchorNow, coveringSignals, liveSql, lockStopFence, timeStoppedWorkers, type StopSignal } from '../stopSignals/state.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { OPEN_SESSION_PLACEMENT_JOIN } from '../sessionPlacement.js';
import { s7Available } from '../tickers/s7Availability.js';
import { type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadAppWorkerActivity, loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { loadAvailabilityByFamily, type WorkerAvailabilityView } from './availability.js';
import { appendTaskEvent, ASSIGNED_EVENT_TYPES, PLATFORM_ACTOR } from './events.js';
import { loadLaunchableFamilies } from './hosts.js';
import { launchForAssignment } from '../hostOperations/launch.js';
import { PENDING_SESSION_END_SQL } from '../hostOperations/sessionEnd.js';
import { normalizeFamily } from './family.js';

/** On since T6 (#1709): a host can start an unbound worker, so the matcher assigns to one (see the file header). */
export const MATCH_UNBOUND_LAUNCHABLE = true;
/** Queued tasks considered per App per run, oldest first. */
const QUEUE_PAGE = 500;
const OPEN_STATUSES = ['pending', 'started'];

type Db = PrismaClient | Prisma.TransactionClient;

// ── Requirements ──────────────────────────────────────────────────────────

/** A task's matching requirements, as T1 stores them (plan §3.1). */
export type Requirements = {
  /** Malformed legacy metadata is never interpreted as unconstrained work. */
  invalid?: boolean;
  role?: string;
  familyIn?: string[];
  familyNotIn?: string[];
  excludeWorkerIds?: string[];
};

export function parseRequirements(json: Prisma.JsonValue | null): Requirements {
  if (json == null) return {};
  if (typeof json !== 'object' || Array.isArray(json)) return { invalid: true };
  const r = json as Record<string, unknown>;
  let invalid = false;
  const list = (v: unknown, family = false): string[] | undefined => {
    if (v == null) return undefined;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim() || (family && !normalizeFamily(x)))) {
      invalid = true;
      return undefined;
    }
    return v.map((x: string) => family ? normalizeFamily(x)! : x);
  };
  const familyIn = list(r.familyIn, true);
  const familyNotIn = list(r.familyNotIn, true);
  const excludeWorkerIds = list(r.excludeWorkerIds);
  if (r.role != null && (typeof r.role !== 'string' || !r.role.trim())) invalid = true;
  if (familyIn && familyNotIn) invalid = true;
  if (invalid) return { invalid: true };
  return {
    role: typeof r.role === 'string' ? r.role.trim() : undefined,
    familyIn, familyNotIn, excludeWorkerIds,
  };
}

function familyAllowed(req: Requirements, family: string): boolean {
  if (req.familyIn) return req.familyIn.includes(family);
  if (req.familyNotIn) return !req.familyNotIn.includes(family);
  return true;
}

/**
 * The family a free worker would take this task as, or null when it isn't
 * eligible (cor:agt:060:06): excluded by name, another role, or no family it
 * can run as is allowed. Roles compare case-insensitively.
 */
export function eligibleFamily(req: Requirements, w: { id: string; role: string | null; freeFamilies: string[] }): string | null {
  if (req.invalid || (req.familyIn && req.familyNotIn)) return null;
  if (req.excludeWorkerIds?.includes(w.id)) return null;
  if (req.role && (w.role ?? '').toLowerCase() !== req.role.toLowerCase()) return null;
  return w.freeFamilies.map(normalizeFamily).find((f): f is string => f !== null && familyAllowed(req, f)) ?? null;
}

/**
 * Least recently assigned first (cor:agt:060:06). Never assigned ranks as
 * least recent; ties break by name (case-insensitive, then exact), then id
 * (#1707 interim).
 */
export function compareRank(
  a: { id: string; name: string; lastAssignedAt: Date | null },
  b: { id: string; name: string; lastAssignedAt: Date | null },
): number {
  const ta = a.lastAssignedAt?.getTime() ?? -Infinity;
  const tb = b.lastAssignedAt?.getTime() ?? -Infinity;
  if (ta !== tb) return ta < tb ? -1 : 1;
  const na = a.name.toLowerCase();
  const nb = b.name.toLowerCase();
  if (na !== nb) return na < nb ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ── Free for work ─────────────────────────────────────────────────────────

/** Everything free for work reads, per worker of one App — shared by the matcher and the roster. */
export type WorkerWorkState = {
  usesTasks: boolean;
  id: string;
  appId: string;
  name: string;
  slug: string;
  role: string | null;
  /** Bound: has an OPEN session — live or quiet (cor:agt:060:04 follows the binding). */
  bound: boolean;
  /** Has a LIVE session (cor:agt:020:11): what matching requires of a BOUND worker. */
  live: boolean;
  /** The binding's family (its newest open session's); null when unbound or it reported none. */
  bindingFamily: string | null;
  /** Advisory model metadata from that same binding; never a matching input. */
  bindingModel: string | null;
  modelReportedAt: Date | null;
  lastActiveAt: Date | null;
  /** Families a live host registration can launch it as. */
  launchableFamilies: string[];
  /** #1709: waiting on a session end (an open request, or an outstanding `worker.end`); not matched meanwhile. */
  endingSession: boolean;
  /** The families it can run as now (060:04): its binding's when bound, else its launchable ones. */
  families: string[];
  availability: WorkerAvailabilityView;
  /** Pending or started tasks it is the assignee of. */
  openTaskCount: number;
  /** Families it is free for work as now: `families` whose availability allows it. */
  freeFamilies: string[];
  /** cor:agt:060:05. */
  free: boolean;
  lastAssignedAt: Date | null;
};

/**
 * cor:agt:060:04 — what a worker can run as now: its binding's family while
 * bound — a quiet binding included, so a host family never replaces it — and
 * otherwise any family a live host can launch it as.
 */
export function familiesOf(w: { bound: boolean; bindingFamily: string | null; launchableFamilies: string[] }): string[] {
  const values = w.bound ? [w.bindingFamily] : w.launchableFamilies;
  return [...new Set(values.map(normalizeFamily).filter((f): f is string => f !== null))];
}

/**
 * May the matcher assign to this worker at all? A bound worker only while its
 * session is LIVE (#1707: a quiet one has nobody driving it, so a match would
 * only park the task); an unbound worker always here, since free for work then
 * requires a family a live host can launch it as (#1709, T6). Never one waiting
 * on a session end. This is the matcher's restriction, kept apart from free for
 * work.
 */
export function matchable(w: { bound: boolean; live: boolean; endingSession?: boolean; usesTasks?: boolean }): boolean {
  if (w.usesTasks === false || w.endingSession) return false;
  return w.live || (MATCH_UNBOUND_LAUNCHABLE && !w.bound);
}

/** #1709: the workers of `ids` waiting on a session end (see the file header). */
async function loadEndingSession(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT w.id FROM workers w WHERE w.id IN (${Prisma.join(ids)}) AND ${PENDING_SESSION_END_SQL(Prisma.sql`w.id`)}`;
  return new Set(rows.map((r) => r.id));
}

/** cor:agt:060:05 over one worker's inputs. Pure. */
export function freeFamiliesOf(w: {
  retired: boolean;
  openTaskCount: number;
  families: string[];
  availability: WorkerAvailabilityView;
  /** S7 (R87): a live isolation. An assignment an isolated worker cannot receive would only stall. */
  isolated?: boolean;
}): string[] {
  if (w.retired || w.isolated || w.openTaskCount > 0 || w.availability.ownInEffect) return [];
  return w.families.filter((f) => w.availability.familyAvailable.get(f) === true);
}

/** The latest assignment event naming each worker (cor:agt:060:06's "assigned least recently"). */
async function loadLastAssignedAt(db: Db, appId: string, workerIds: string[]): Promise<Map<string, Date>> {
  if (workerIds.length === 0) return new Map();
  const rows = await db.agentTeamEvent.groupBy({
    by: ['subjectWorkerId'],
    where: { appId, subjectWorkerId: { in: workerIds }, type: { in: [...ASSIGNED_EVENT_TYPES] } },
    _max: { createdAt: true },
  });
  return new Map(rows.filter((r) => r.subjectWorkerId && r._max.createdAt).map((r) => [r.subjectWorkerId as string, r._max.createdAt as Date]));
}

/** The role and `usesTasks` of the agent each worker's newest open session was bound under (#2458). */
async function loadOpenSessionPlacements(db: Db, workerIds: string[]): Promise<Map<string, { role: string; usesTasks: boolean }>> {
  const rows = await db.$queryRaw<{ id: string; role: string; usesTasks: boolean }[]>`
    SELECT w.id, os.role AS role, a.uses_tasks AS "usesTasks" FROM workers w
    ${OPEN_SESSION_PLACEMENT_JOIN}
    JOIN agents a ON a.id = os.agent_id
    WHERE w.id = ANY(${workerIds}::text[]) AND os.agent_id IS NOT NULL`;
  return new Map(rows.map((r) => [r.id, { role: r.role, usesTasks: r.usesTasks }]));
}

/**
 * The work state of every worker of one App that is not retired, at `now`.
 * One query per kind of input, never one per worker.
 */
export async function loadWorkerWorkStates(db: Db, appId: string, now: Date, opts?: { bySession?: boolean }): Promise<WorkerWorkState[]> {
  const workers = await db.worker.findMany({
    where: { appId, retiredAt: null },
    select: { id: true, appId: true, name: true, slug: true, role: true, agent: { select: { usesTasks: true } } },
    orderBy: { id: 'asc' },
  });
  if (workers.length === 0) return [];
  const ids = workers.map((w) => w.id);
  // #2458: a worker with an open session is matched on that session's agent and role, not the live worker row.
  // Only the matcher asks (`bySession`): a manager-facing read, the roster, shows the live row (cor:dmo:050:11).
  const placed = opts?.bySession ? await loadOpenSessionPlacements(db, ids) : new Map<string, { role: string; usesTasks: boolean }>();
  const [activity, launchable, open, lastAssigned, ending] = await Promise.all([
    loadAppWorkerActivity({ db } as unknown as Context, appId, { now }),
    loadLaunchableFamilies(db, { appId }, now),
    db.agentTask.groupBy({
      by: ['assigneeWorkerId'],
      where: { appId, assigneeWorkerId: { in: ids }, status: { in: OPEN_STATUSES } },
      _count: { _all: true },
    }),
    loadLastAssignedAt(db, appId, ids),
    loadEndingSession(db, ids),
  ]);
  const openBy = new Map(open.map((o) => [o.assigneeWorkerId as string, o._count._all]));
  const partial = workers.map((w) => {
    const a = activity.get(w.id);
    const bound = a?.bound ?? false;
    const live = a?.hasLiveSession ?? false;
    const bindingFamily = bound ? a?.bindingFamily ?? null : null;
    const launchableFamilies = launchable.get(w.id) ?? [];
    return {
      ...w, role: placed.get(w.id)?.role ?? w.role, usesTasks: placed.get(w.id)?.usesTasks ?? w.agent.usesTasks, bound, live, bindingFamily,
      bindingModel: bound ? a?.bindingModel ?? null : null,
      modelReportedAt: bound ? a?.modelReportedAt ?? null : null,
      launchableFamilies, lastActiveAt: a?.lastActiveAt ?? null, endingSession: ending.has(w.id),
      families: familiesOf({ bound, bindingFamily, launchableFamilies }),
    };
  });
  const isolatedRows = s7Available() ? await db.workerWakeSettings.findMany({ where: { workerId: { in: ids }, isolatedUntil: { gt: now } }, select: { workerId: true } }) : [];
  const isolatedIds = new Set(isolatedRows.map((r) => r.workerId));
  const avail = await loadAvailabilityByFamily(db, partial.map((w) => ({ id: w.id, appId, families: w.families })), now);
  return partial.map((w) => {
    const availability = avail.get(w.id) as WorkerAvailabilityView;
    const openTaskCount = openBy.get(w.id) ?? 0;
    const freeFamilies = freeFamiliesOf({ retired: false, isolated: isolatedIds.has(w.id), openTaskCount, families: w.families, availability });
    return {
      ...w, availability, openTaskCount, freeFamilies, free: freeFamilies.length > 0,
      lastAssignedAt: lastAssigned.get(w.id) ?? null,
    };
  });
}

/**
 * Inside the assignment's transaction, after the worker lock: is the worker
 * still free for work as `family`? Re-reads every input on the transaction
 * client, so a run that waited on the lock sees what the first run committed.
 */
async function stillFreeAs(tx: Prisma.TransactionClient, appId: string, workerId: string, family: string, now: Date, req: Requirements, anchor: number): Promise<boolean> {
  // The owning Agent row fences usesTasks against updateAgent, before the
  // Worker row. No session/worker lock upgrades and no inherited setting.
  // #2458: a worker with an open session is matched on that session's agent and role (it finishes under them); the
  // placement is stable here because a bind and changeWorkerAgent both take this assignment lock.
  const [owner] = await tx.$queryRaw<{ id: string; usesTasks: boolean; role: string | null; liveAgentId: string }[]>`
    SELECT a.id, a.uses_tasks AS "usesTasks", COALESCE(os.role, w.role) AS role, w.agent_id AS "liveAgentId" FROM workers w
    ${OPEN_SESSION_PLACEMENT_JOIN}
    JOIN agents a ON a.id = COALESCE(os.agent_id, w.agent_id)
    WHERE w.id = ${workerId} FOR SHARE OF a`;
  if (!owner?.usesTasks) return false;
  const [w] = await tx.$queryRaw<{ appId: string; retiredAt: Date | null; agentId: string }[]>`
    SELECT app_id AS "appId", retired_at AS "retiredAt", agent_id AS "agentId" FROM workers WHERE id = ${workerId} FOR SHARE`;
  if (!w || w.appId !== appId || w.retiredAt) return false;
  if (w.agentId !== owner.liveAgentId || eligibleFamily(req, { id: workerId, role: owner.role, freeFamilies: [family] }) === null) return false;
  // Bind/backfill take Worker before Session; end/refresh only need Session. Holding
  // existing session rows prevents a family refresh after the deciding read;
  // a new bind needs the held Worker row first.
  await tx.$queryRaw`SELECT id FROM sessions WHERE worker_id = ${workerId} AND ended_at IS NULL AND deleted_at IS NULL ORDER BY id FOR SHARE`;
  const openTaskCount = await tx.agentTask.count({
    where: { assigneeWorkerId: workerId, status: { in: OPEN_STATUSES } },
  });
  if (openTaskCount > 0) return false;
  const decidedAt = afterWaits(now, anchor);
  const activity = (await loadWorkersActivity({ db: tx } as unknown as Context, [workerId], decidedAt)).get(workerId);
  const bound = activity?.bound ?? false;
  const endingSession = (await loadEndingSession(tx, [workerId])).has(workerId);
  if (!matchable({ bound, live: activity?.hasLiveSession ?? false, endingSession })) return false;
  const launchable = bound ? [] : (await loadLaunchableFamilies(tx, { workerIds: [workerId] }, decidedAt)).get(workerId) ?? [];
  const families = familiesOf({ bound, bindingFamily: activity?.bindingFamily ?? null, launchableFamilies: launchable });
  if (!families.includes(family)) return false;
  const availability = (await loadAvailabilityByFamily(tx, [{ id: workerId, appId, families: [family] }], decidedAt)).get(workerId) as WorkerAvailabilityView;
  const isolated = s7Available() && (await tx.workerWakeSettings.count({ where: { workerId, isolatedUntil: { gt: decidedAt } } })) > 0;
  return freeFamiliesOf({ retired: false, isolated, openTaskCount, families: [family], availability }).length > 0;
}

// ── Assigning ─────────────────────────────────────────────────────────────

type QueuedTask = { id: string; appId: string; requirements: Prisma.JsonValue | null; closeSessionWhenDone: boolean; createdByWorkerId?: string | null };

/** Why one attempt did not assign. */
type AttemptOutcome = 'assigned' | 'task-gone' | 'worker-not-free';

/** Test seam: runs after the worker lock and re-check, before the guarded update. */
export type MatcherHooks = { afterWorkerCheck?: (args: { taskId: string; workerId: string }) => Promise<void> };

async function tryAssign(
  db: PrismaClient,
  task: QueuedTask,
  workerId: string,
  family: string,
  now: Date,
  hooks: MatcherHooks,
  /** The monotonic half of `now`'s sample (`anchorNow`), from the pass; by default taken here, beside a fresh `now`. */
  anchor: number = anchorNow(),
): Promise<AttemptOutcome> {
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'app', id: task.appId }], 'shared');
    const app = await tx.app.findUnique({ where: { id: task.appId }, select: { deletedAt: true, uninstalledAt: true } });
    if (!app || app.deletedAt || app.uninstalledAt) return 'task-gone';
    // #2022: the App's stop fence, shared, then the authoritative stop check: a signal set after the candidates were
    // loaded is seen here, or waits for this assignment (src/lib/stopSignals/state.ts, the lock order).
    await lockStopFence(tx, task.appId, 'shared');
    await lockTaskGraph(tx, task.appId, 'shared');
    // The per-worker lock (src/lib/agentTasks/workerLock.ts).
    await lockWorkersForAssignment(tx, [workerId]);
    const currentTask = await tx.agentTask.findUnique({ where: { id: task.id }, select: { requirements: true } });
    if (!currentTask) return 'task-gone';
    if (!(await stillFreeAs(tx, task.appId, workerId, family, now, parseRequirements(currentTask.requirements), anchor))) return 'worker-not-free';
    const creator = task.createdByWorkerId ?? null;
    // Decided at the moment after the waits (Xan #2166 LOCAL-1), not the pass's start.
    const covering = await coveringSignals(tx, task.appId, creator && creator !== workerId ? [workerId, creator] : [workerId], afterWaits(now, anchor));
    if (covering.has(workerId)) return 'worker-not-free';
    // R71: a task its creator made under a pause or halt waits while that still covers the creator.
    if (creator && timeStoppedWorkers(covering).has(creator)) return 'task-gone';
    await hooks.afterWorkerCheck?.({ taskId: task.id, workerId });
    const n = await tx.agentTask.updateMany({
      where: { id: task.id, appId: task.appId, status: 'pending', blocked: false, assigneeWorkerId: null, assigneeUserId: null,
        requirements: { equals: currentTask.requirements ?? Prisma.AnyNull } },
      data: {
        assigneeWorkerId: workerId,
        assignedAt: now, assignedBy: null, assignedByWorkerId: null, assignedByAgentId: null,
        updatedBy: null, updatedByWorkerId: null, updatedByAgentId: null,
      },
    });
    if (n.count === 0) return 'task-gone';
    await appendTaskEvent(tx, {
      appId: task.appId, taskId: task.id, actor: PLATFORM_ACTOR, createdAt: now,
      event: { type: 'assignment.matched', assignee: { workerId }, family, closeSessionWhenDone: task.closeSessionWhenDone },
    });
    return 'assigned';
  });
}

export type MatchResult = { taskId: string; workerId: string; family: string };

/**
 * Match one App's queued tasks, oldest first, each to the least recently
 * assigned eligible worker free for work. Returns what it assigned.
 *
 * The WHOLE queue, a page at a time in stable (createdAt, id) order (#1723
 * review, Diego P2-1): a first page of tasks nobody free can take must not
 * hide a later task someone can. It stops early only when every candidate is
 * spent, and the spent set carries across pages.
 */
async function matchApp(db: PrismaClient, appId: string, now: Date, hooks: MatcherHooks, anchor: number): Promise<MatchResult[]> {
  const out: MatchResult[] = [];
  let candidates: WorkerWorkState[] | null = null;
  let covering: Map<string, StopSignal[]> | null = null;
  const spent = new Set<string>();
  let after: { priority: number; createdAt: Date; id: string } | null = null;
  for (;;) {
    const page: (QueuedTask & { priority: number; createdAt: Date })[] = await db.agentTask.findMany({
      where: {
        appId, status: 'pending', blocked: false, assigneeWorkerId: null, assigneeUserId: null,
        ...(after
          ? { OR: [{ priority: { gt: after.priority } }, { priority: after.priority, createdAt: { gt: after.createdAt } }, { priority: after.priority, createdAt: after.createdAt, id: { gt: after.id } }] }
          : {}),
      },
      select: { id: true, appId: true, requirements: true, closeSessionWhenDone: true, priority: true, createdAt: true, createdByWorkerId: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: QUEUE_PAGE,
    });
    if (page.length === 0) break;
    const last = page[page.length - 1];
    after = { priority: last.priority, createdAt: last.createdAt, id: last.id };
    if (candidates === null) {
      // #2022 (cor:agt:090:03): a worker a live stop signal covers is skipped, at every level; tryAssign re-checks.
      covering = await coveringSignals(db, appId, null, now);
      candidates = (await loadWorkerWorkStates(db, appId, now, { bySession: true })).filter((w) => w.free && matchable(w) && !covering!.has(w.id)).sort(compareRank);
    }
    for (const task of page) {
      if (spent.size === candidates.length) return out;
      // R71: not matched while its creator is under a pause or halt.
      if (task.createdByWorkerId && timeStoppedWorkers(covering!).has(task.createdByWorkerId)) continue;
      const req = parseRequirements(task.requirements);
      for (const w of candidates) {
        if (spent.has(w.id)) continue;
        const family = eligibleFamily(req, w);
        if (!family) continue;
        const outcome = await tryAssign(db, task, w.id, family, now, hooks, anchor);
        // Assigned, or no longer free: either way this worker is spent for this run.
        if (outcome !== 'task-gone') spent.add(w.id);
        if (outcome === 'assigned') {
          out.push({ taskId: task.id, workerId: w.id, family });
          // #1709 (cor:agt:070:08): a matched worker with no live session is started through its host.
          if (!w.live) await launchForAssignment(db, { appId, taskId: task.id, workerId: w.id, family }, now, anchor);
        }
        if (outcome !== 'worker-not-free') break;
      }
    }
    if (page.length < QUEUE_PAGE) break;
  }
  return out;
}

/**
 * Run the matcher (cor:agt:060:06): over one App, or every live, installed App
 * with a queued task. A failure in one App is logged and the others still run.
 */
export async function matchQueuedTasks(
  db: PrismaClient,
  now: Date,
  opts: { appId?: string; hooks?: MatcherHooks; /** `now`'s monotonic half (`anchorNow`); default: here. */ anchor?: number } = {},
): Promise<MatchResult[]> {
  const anchor = opts.anchor ?? anchorNow();
  const appIds = opts.appId
    ? [opts.appId]
    : (await db.agentTask.findMany({
        where: {
          status: 'pending', blocked: false, assigneeWorkerId: null, assigneeUserId: null,
          app: { deletedAt: null, uninstalledAt: null },
        },
        select: { appId: true },
        distinct: ['appId'],
      })).map((r) => r.appId);
  // #2022: an App with an open stop hold is visited too, so a hold whose task left the queue is closed.
  const held = opts.appId ? [] : (await db.agentTaskStopHold.findMany({ where: { endedAt: null }, select: { appId: true }, distinct: ['appId'] })).map((r) => r.appId);
  const out: MatchResult[] = [];
  for (const appId of [...new Set([...appIds, ...held])]) {
    try {
      out.push(...(await matchApp(db, appId, now, opts.hooks ?? {}, anchor)));
      await recordStopHolds(db, appId, now);
    } catch (err) {
      console.error(`[task-matcher] matching App ${appId} failed:`, err);
    }
  }
  return out;
}

/**
 * #2022 (R68; Vera's receipt §5, the "decisive blocker") — after a matching pass, record for each queued task whether
 * stop signals are what keep it unassigned: its creator is under a `pause` or `halt` (R71), or at least one worker free
 * for work could take it and every such worker is covered by a live signal. An open hold is opened for each such task
 * and closed for every other (or one that left the queue). The couldn't-be-assigned clock (cor:agt:050:17) doesn't count
 * a hold's time; a task nobody could take for another reason keeps counting. Resolution: one matching pass.
 */
export async function recordStopHolds(db: PrismaClient, appId: string, now: Date): Promise<void> {
  const [{ n }] = await db.$queryRaw<{ n: bigint }[]>(Prisma.sql`
    SELECT (SELECT count(*) FROM team_stop_signals s WHERE s.app_id = ${appId} AND ${liveSql(now)})
         + (SELECT count(*) FROM agent_task_stop_holds h WHERE h.app_id = ${appId} AND h.ended_at IS NULL) AS n`);
  if (Number(n) === 0) return;
  const covering = await coveringSignals(db, appId, null, now);
  const timeStopped = timeStoppedWorkers(covering);
  const free = (await loadWorkerWorkStates(db, appId, now, { bySession: true })).filter((w) => w.free && matchable(w));
  const decisive = new Set<string>();
  let after: { priority: number; createdAt: Date; id: string } | null = null;
  for (;;) {
    const page: { id: string; priority: number; createdAt: Date; requirements: Prisma.JsonValue | null; createdByWorkerId: string | null }[] = await db.agentTask.findMany({
      where: {
        appId, status: 'pending', blocked: false, assigneeWorkerId: null, assigneeUserId: null,
        ...(after ? { OR: [{ priority: { gt: after.priority } }, { priority: after.priority, createdAt: { gt: after.createdAt } }, { priority: after.priority, createdAt: after.createdAt, id: { gt: after.id } }] } : {}),
      },
      select: { id: true, priority: true, createdAt: true, requirements: true, createdByWorkerId: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: QUEUE_PAGE,
    });
    for (const t of page) {
      if (t.createdByWorkerId && timeStopped.has(t.createdByWorkerId)) { decisive.add(t.id); continue; }
      const req = parseRequirements(t.requirements);
      const eligible = free.filter((w) => eligibleFamily(req, w) !== null);
      if (eligible.length > 0 && eligible.every((w) => covering.has(w.id))) decisive.add(t.id);
    }
    if (page.length < QUEUE_PAGE) break;
    const last = page[page.length - 1];
    after = { priority: last.priority, createdAt: last.createdAt, id: last.id };
  }
  const nowNaive = toNaiveUtc(now);
  const open = await db.agentTaskStopHold.findMany({ where: { appId, endedAt: null }, select: { id: true, taskId: true } });
  const toClose = open.filter((h) => !decisive.has(h.taskId)).map((h) => h.id);
  if (toClose.length) {
    await db.$executeRaw`UPDATE agent_task_stop_holds SET ended_at = ${nowNaive}::timestamp WHERE id IN (${Prisma.join(toClose)}) AND ended_at IS NULL`;
  }
  const have = new Set(open.map((h) => h.taskId));
  for (const taskId of decisive) {
    if (have.has(taskId)) continue;
    await db.$executeRaw`
      INSERT INTO agent_task_stop_holds (id, app_id, task_id, started_at) VALUES (${generateId()}, ${appId}, ${taskId}, ${nowNaive}::timestamp)
      ON CONFLICT (task_id) WHERE ended_at IS NULL DO NOTHING`;
  }
}

/**
 * The event-driven trigger (cor:agt:060:06 interim triggers, #1707): after a
 * task is created with no assignee, a task finishes or is cancelled, or an
 * availability record changes, match that App now rather than at the next
 * sweep. Runs after the triggering write has committed, and never fails it:
 * an error is logged, and the sweep retries within a minute.
 * `DISABLE_TASK_MATCHER=true` turns it off with the loop.
 */
export async function matchAfterChange(db: PrismaClient, appId: string): Promise<void> {
  if (process.env.DISABLE_TASK_MATCHER === 'true') return;
  try {
    await matchQueuedTasks(db, new Date(), { appId, anchor: anchorNow() });
  } catch (err) {
    console.error('[task-matcher] triggered run failed:', err);
  }
}

/** Test seam only: one assignment attempt, so a test can hold two against each other. */
export const __matcherTesting = { tryAssign };
