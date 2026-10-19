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

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { type Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { loadAppWorkerActivity, loadWorkersActivity } from '../../api/graphql/schema/resolvers.worker.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { loadAvailabilityByFamily, type WorkerAvailabilityView } from './availability.js';
import { appendTaskEvent, ASSIGNED_EVENT_TYPES, PLATFORM_ACTOR } from './events.js';
import { loadLaunchableFamilies } from './hosts.js';
import { launchForAssignment } from '../hostOperations/launch.js';
import { PENDING_SESSION_END_SQL } from '../hostOperations/sessionEnd.js';

/** On since T6 (#1709): a host can start an unbound worker, so the matcher assigns to one (see the file header). */
export const MATCH_UNBOUND_LAUNCHABLE = true;
/** Queued tasks considered per App per run, oldest first. */
const QUEUE_PAGE = 500;
const OPEN_STATUSES = ['pending', 'started'];

type Db = PrismaClient | Prisma.TransactionClient;

// ── Requirements ──────────────────────────────────────────────────────────

/** A task's matching requirements, as T1 stores them (plan §3.1). */
export type Requirements = {
  role?: string;
  familyIn?: string[];
  familyNotIn?: string[];
  excludeWorkerIds?: string[];
};

export function parseRequirements(json: Prisma.JsonValue | null): Requirements {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
  const r = json as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  return {
    role: typeof r.role === 'string' ? r.role : undefined,
    familyIn: list(r.familyIn)?.map((f) => f.toLowerCase()),
    familyNotIn: list(r.familyNotIn)?.map((f) => f.toLowerCase()),
    excludeWorkerIds: list(r.excludeWorkerIds),
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
  if (req.excludeWorkerIds?.includes(w.id)) return null;
  if (req.role && (w.role ?? '').toLowerCase() !== req.role.toLowerCase()) return null;
  return w.freeFamilies.find((f) => familyAllowed(req, f)) ?? null;
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
  if (w.bound) return w.bindingFamily ? [w.bindingFamily] : [];
  return w.launchableFamilies;
}

/**
 * May the matcher assign to this worker at all? A bound worker only while its
 * session is LIVE (#1707: a quiet one has nobody driving it, so a match would
 * only park the task); an unbound worker always here, since free for work then
 * requires a family a live host can launch it as (#1709, T6). Never one waiting
 * on a session end. This is the matcher's restriction, kept apart from free for
 * work.
 */
export function matchable(w: { bound: boolean; live: boolean; endingSession?: boolean }): boolean {
  if (w.endingSession) return false;
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

/**
 * The work state of every worker of one App that is not retired, at `now`.
 * One query per kind of input, never one per worker.
 */
export async function loadWorkerWorkStates(db: Db, appId: string, now: Date): Promise<WorkerWorkState[]> {
  const workers = await db.worker.findMany({
    where: { appId, retiredAt: null },
    select: { id: true, appId: true, name: true, slug: true, role: true },
    orderBy: { id: 'asc' },
  });
  if (workers.length === 0) return [];
  const ids = workers.map((w) => w.id);
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
      ...w, bound, live, bindingFamily, launchableFamilies, lastActiveAt: a?.lastActiveAt ?? null, endingSession: ending.has(w.id),
      families: familiesOf({ bound, bindingFamily, launchableFamilies }),
    };
  });
  const isolatedRows = await db.workerWakeSettings.findMany({ where: { workerId: { in: ids }, isolatedUntil: { gt: now } }, select: { workerId: true } });
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
async function stillFreeAs(tx: Prisma.TransactionClient, appId: string, workerId: string, family: string, now: Date): Promise<boolean> {
  const [w] = await tx.$queryRaw<{ appId: string; retiredAt: Date | null }[]>`
    SELECT app_id AS "appId", retired_at AS "retiredAt" FROM workers WHERE id = ${workerId} FOR SHARE`;
  if (!w || w.appId !== appId || w.retiredAt) return false;
  const openTaskCount = await tx.agentTask.count({
    where: { assigneeWorkerId: workerId, status: { in: OPEN_STATUSES } },
  });
  if (openTaskCount > 0) return false;
  const activity = (await loadWorkersActivity({ db: tx } as unknown as Context, [workerId], now)).get(workerId);
  const bound = activity?.bound ?? false;
  const endingSession = (await loadEndingSession(tx, [workerId])).has(workerId);
  if (!matchable({ bound, live: activity?.hasLiveSession ?? false, endingSession })) return false;
  const launchable = bound ? [] : (await loadLaunchableFamilies(tx, { workerIds: [workerId] }, now)).get(workerId) ?? [];
  const families = familiesOf({ bound, bindingFamily: activity?.bindingFamily ?? null, launchableFamilies: launchable });
  if (!families.includes(family)) return false;
  const availability = (await loadAvailabilityByFamily(tx, [{ id: workerId, appId, families: [family] }], now)).get(workerId) as WorkerAvailabilityView;
  const isolated = (await tx.workerWakeSettings.count({ where: { workerId, isolatedUntil: { gt: now } } })) > 0;
  return freeFamiliesOf({ retired: false, isolated, openTaskCount, families: [family], availability }).length > 0;
}

// ── Assigning ─────────────────────────────────────────────────────────────

type QueuedTask = { id: string; appId: string; requirements: Prisma.JsonValue | null; closeSessionWhenDone: boolean };

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
): Promise<AttemptOutcome> {
  return db.$transaction(async (tx) => {
    await lockAuthorityAnchors(tx, [{ kind: 'app', id: task.appId }], 'shared');
    const app = await tx.app.findUnique({ where: { id: task.appId }, select: { deletedAt: true, uninstalledAt: true } });
    if (!app || app.deletedAt || app.uninstalledAt) return 'task-gone';
    // The per-worker lock. $executeRaw: pg_advisory_xact_lock returns void,
    // which $queryRaw cannot deserialize.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('agent-task-matcher:worker'), hashtext(${workerId}))`;
    if (!(await stillFreeAs(tx, task.appId, workerId, family, now))) return 'worker-not-free';
    await hooks.afterWorkerCheck?.({ taskId: task.id, workerId });
    const n = await tx.agentTask.updateMany({
      where: { id: task.id, appId: task.appId, status: 'pending', assigneeWorkerId: null, assigneeUserId: null },
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
async function matchApp(db: PrismaClient, appId: string, now: Date, hooks: MatcherHooks): Promise<MatchResult[]> {
  const out: MatchResult[] = [];
  let candidates: WorkerWorkState[] | null = null;
  const spent = new Set<string>();
  let after: { createdAt: Date; id: string } | null = null;
  for (;;) {
    const page: (QueuedTask & { createdAt: Date })[] = await db.agentTask.findMany({
      where: {
        appId, status: 'pending', assigneeWorkerId: null, assigneeUserId: null,
        ...(after
          ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }
          : {}),
      },
      select: { id: true, appId: true, requirements: true, closeSessionWhenDone: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: QUEUE_PAGE,
    });
    if (page.length === 0) break;
    const last = page[page.length - 1];
    after = { createdAt: last.createdAt, id: last.id };
    candidates ??= (await loadWorkerWorkStates(db, appId, now)).filter((w) => w.free && matchable(w)).sort(compareRank);
    for (const task of page) {
      if (spent.size === candidates.length) return out;
      const req = parseRequirements(task.requirements);
      for (const w of candidates) {
        if (spent.has(w.id)) continue;
        const family = eligibleFamily(req, w);
        if (!family) continue;
        const outcome = await tryAssign(db, task, w.id, family, now, hooks);
        // Assigned, or no longer free: either way this worker is spent for this run.
        if (outcome !== 'task-gone') spent.add(w.id);
        if (outcome === 'assigned') {
          out.push({ taskId: task.id, workerId: w.id, family });
          // #1709 (cor:agt:070:08): a matched worker with no live session is started through its host.
          if (!w.live) await launchForAssignment(db, { appId, taskId: task.id, workerId: w.id }, now);
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
  opts: { appId?: string; hooks?: MatcherHooks } = {},
): Promise<MatchResult[]> {
  const appIds = opts.appId
    ? [opts.appId]
    : (await db.agentTask.findMany({
        where: {
          status: 'pending', assigneeWorkerId: null, assigneeUserId: null,
          app: { deletedAt: null, uninstalledAt: null },
        },
        select: { appId: true },
        distinct: ['appId'],
      })).map((r) => r.appId);
  const out: MatchResult[] = [];
  for (const appId of appIds) {
    try {
      out.push(...(await matchApp(db, appId, now, opts.hooks ?? {})));
    } catch (err) {
      console.error(`[task-matcher] matching App ${appId} failed:`, err);
    }
  }
  return out;
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
    await matchQueuedTasks(db, new Date(), { appId });
  } catch (err) {
    console.error('[task-matcher] triggered run failed:', err);
  }
}

/** Test seam only: one assignment attempt, so a test can hold two against each other. */
export const __matcherTesting = { tryAssign };
