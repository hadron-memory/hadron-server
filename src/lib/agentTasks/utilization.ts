/**
 * #3819 slice 1 (hrn:node:hadronmemory.com:specs:cor:agt:060:13, cor:agt:060:01/:02/:04, cor:agt:050:21), Vera V1-V5/V8,
 * V37-V43 and Xabat6762777653: current eligible workers grouped by binding family/tier/role, whether each held work during
 * the window, and the combination's latest match outcome inside the window (#3825's record, read only here, behind the
 * roster gate: V37). Advisory only; never a matching or authorization input. The saturation EPISODE and its alarm are
 * `saturation.ts`'s (cor:agt:060:14, :15); this read never writes.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { loadWorkerWorkStates } from './matcher.js';
import { tierOf, type ModelTier } from './family.js';
import { latestMatchOutcomes, type LatestMatchOutcome } from './matchOutcomes.js';

type Db = PrismaClient | Prisma.TransactionClient;
/** The latest no-worker outcome of a combination inside the window: when it was decided and its coarse reason. */
export interface MatchFailure { at: Date; reason: string | null }
export interface UtilizationCombination {
  /** Null: the failed task left the family open (gate ruling 7067106396; a worker row always has one). */
  family: string | null;
  tier: ModelTier | null;
  role: string | null;
  eligibleWorkers: number;
  busyWorkers: number;
  utilization: number;
  saturated: boolean;
  /** Null unless the combination's LATEST outcome inside the window is no worker (the record is latest-only). */
  lastMatchFailure: MatchFailure | null;
}
export interface UtilizationFilters { family?: string | null; tier?: ModelTier | null; role?: string | null }
const HOUR = 3_600_000;
const ASSIGNMENTS = ['task.assigned', 'task.reassigned', 'assignment.matched'];

/** Only typed worker IDs from assignment history, never arbitrary event actors/chat activity. */
function workerParty(value: Prisma.JsonValue | undefined): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return typeof value.workerId === 'string' ? value.workerId : null;
}

/**
 * V2: held pending/started work at any instant in the window, or finished in it. Current rows cover old assignments
 * still held and end-state holders; the append-only windowed events retain reassigned-away and handed-back holders.
 * A hand-back's last assignment identifies its former holder; event actors are attribution, not task ownership.
 */
async function busyWorkersInWindow(db: Db, appId: string, since: Date, now: Date): Promise<Set<string>> {
  const [tasks, events, handedBack] = await Promise.all([
    db.agentTask.findMany({
      where: { appId, createdAt: { lte: now }, assignedAt: { lte: now }, assigneeWorkerId: { not: null }, OR: [
        { status: { in: ['pending', 'started'] } },
        { status: 'finished', finishedAt: { gte: since, lte: now } },
        { status: 'cancelled', cancelledAt: { gte: since, lte: now } },
      ] },
      select: { assigneeWorkerId: true },
    }),
    db.agentTeamEvent.findMany({
      where: { appId, createdAt: { gte: since, lte: now }, type: { in: ASSIGNMENTS } },
      select: { type: true, subjectWorkerId: true, payload: true },
    }),
    db.$queryRaw<Array<{ workerId: string | null }>>`
      SELECT previous.subject_worker_id AS "workerId"
      FROM agent_team_events h
      JOIN LATERAL (
        SELECT a.subject_worker_id FROM agent_team_events a
        WHERE a.app_id = ${appId} AND a.task_id = h.task_id
          AND a.type IN (${Prisma.join(ASSIGNMENTS)})
          AND (a.created_at, a.id) < (h.created_at, h.id)
        ORDER BY a.created_at DESC, a.id DESC LIMIT 1
      ) previous ON true
      WHERE h.app_id = ${appId} AND h.type = 'task.handed-back'
        AND h.created_at >= ${since} AND h.created_at <= ${now}`,
  ]);
  const busy = new Set(tasks.flatMap(t => t.assigneeWorkerId ? [t.assigneeWorkerId] : []));
  for (const event of events) {
    if (ASSIGNMENTS.includes(event.type)) {
      if (event.subjectWorkerId) busy.add(event.subjectWorkerId);
      if (event.type === 'task.reassigned' && event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
        const former = workerParty(event.payload.from);
        if (former) busy.add(former);
      }
    }
  }
  for (const former of handedBack) if (former.workerId) busy.add(former.workerId);
  return busy;
}

const nameCompare = (a: string | null, b: string | null): number => (a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0;
/**
 * V5: utilization highest first; then the most recent failed match first (a row with none after every row with one);
 * then fewest eligible workers; then family, tier and role by name.
 */
export function compareUtilization(a: UtilizationCombination, b: UtilizationCombination): number {
  const failed = (r: UtilizationCombination) => r.lastMatchFailure?.at.getTime() ?? -Infinity;
  return b.utilization - a.utilization || (failed(a) === failed(b) ? 0 : failed(b) > failed(a) ? 1 : -1)
    || a.eligibleWorkers - b.eligibleWorkers
    || nameCompare(a.family, b.family) || nameCompare(a.tier, b.tier) || nameCompare(a.role, b.role);
}

/**
 * The key a combination has in both worlds: a worker row's (family, tier, role) and a match outcome's, where an open
 * dimension is none (V41) and the role compares case-insensitively (`combinationsOf`).
 */
export const combinationKey = (c: { family: string | null; tier: string | null; role: string | null }): string =>
  JSON.stringify([c.family ?? '', c.tier ?? '', (c.role ?? '').toLowerCase()]);

type WorkerState = Awaited<ReturnType<typeof loadWorkerWorkStates>>[number];
export interface WorkerCombination { family: string; tier: ModelTier | null; role: string | null; workers: string[]; eligible: string[] }

/**
 * The current, non-retired workers of one App grouped by family/tier/role, with which of them are eligible: not marked
 * unavailable themselves and their family not paused (`ModelFamilyAvailability`, V42). The ONE eligibility predicate the
 * read and the saturation evaluator share. An unbound multi-host worker contributes to each family it can run.
 */
export function groupWorkerCombinations(workers: WorkerState[], filters: UtilizationFilters = {}): Map<string, WorkerCombination> {
  const groups = new Map<string, WorkerCombination>();
  for (const worker of workers) {
    const tier = tierOf(worker.bindingModel);
    for (const family of worker.families) {
      if ((filters.family != null && filters.family !== family) || (filters.tier != null && filters.tier !== tier)
          || (filters.role != null && filters.role !== worker.role)) continue;
      const key = combinationKey({ family, tier, role: worker.role });
      let group = groups.get(key);
      if (!group) {
        group = { family, tier, role: worker.role, workers: [], eligible: [] };
        groups.set(key, group);
      }
      group.workers.push(worker.id);
      if (worker.availability.ownInEffect || worker.availability.familyAvailable.get(family) !== true) continue;
      group.eligible.push(worker.id);
    }
  }
  return groups;
}

/**
 * One admitted App/read snapshot. Current binding or live host families and the shared effective-availability
 * predicate define the eligible denominator, independently of task load or session quietness. Retired workers
 * are absent from the same shared loader the roster uses. An unbound multi-host worker can contribute to each family.
 *
 * #3819 slice 1 (cor:agt:060:13, V41/V43): a combination is SATURATED when its latest outcome inside the window is no
 * worker, or when it has workers and none eligible; utilization is then 1. A combination with no workers appears only
 * through a no-worker outcome inside the window (an open dimension is a null on the row). Window: the read's own.
 */
export async function loadTeamUtilization(db: Db, appId: string, now: Date, windowHours: number, filters: UtilizationFilters) {
  const [workers, busy, outcomes] = await Promise.all([
    loadWorkerWorkStates(db, appId, now),
    busyWorkersInWindow(db, appId, new Date(now.getTime() - windowHours * HOUR), now),
    // `undefined` does not narrow; a filter is never the open dimension here (the arguments have no way to ask for it).
    latestMatchOutcomes(db, appId, { windowHours, family: filters.family ?? undefined, tier: filters.tier ?? undefined, role: filters.role ?? undefined }),
  ]);
  const latest = new Map<string, LatestMatchOutcome>(outcomes.map((o) => [combinationKey(o), o]));
  const rows = new Map<string, UtilizationCombination>();
  for (const [key, group] of groupWorkerCombinations(workers, filters)) {
    rows.set(key, {
      family: group.family, tier: group.tier, role: group.role, eligibleWorkers: group.eligible.length,
      busyWorkers: group.eligible.filter((id) => busy.has(id)).length, utilization: 0, saturated: false, lastMatchFailure: null,
    });
  }
  for (const [key, o] of latest) {
    if (o.outcome !== 'NO_WORKER' || rows.has(key)) continue;
    rows.set(key, { family: o.family, tier: o.tier as ModelTier | null, role: o.role, eligibleWorkers: 0, busyWorkers: 0, utilization: 0, saturated: false, lastMatchFailure: null });
  }
  for (const [key, row] of rows) {
    const o = latest.get(key);
    row.lastMatchFailure = o?.outcome === 'NO_WORKER' ? { at: o.decidedAt, reason: o.reason } : null;
    row.saturated = row.lastMatchFailure !== null || row.eligibleWorkers === 0;
    row.utilization = row.saturated ? 1 : row.busyWorkers / row.eligibleWorkers;
  }
  return { appId, computedAt: now, windowHours, combinations: [...rows.values()].sort(compareUtilization) };
}
