/**
 * #3819 slice 1, Vera V1–V5/V8 and Xabat6762777653: current eligible workers grouped by binding family/tier/role,
 * and whether each held work during the window. Advisory only; never a matching or authorization input.
 * Failure-driven saturation, match-outcome history and alarm episodes await their separate provider/integration.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { loadWorkerWorkStates } from './matcher.js';
import { tierOf, type ModelTier } from './family.js';

type Db = PrismaClient | Prisma.TransactionClient;
export interface UtilizationCombination {
  family: string;
  tier: ModelTier | null;
  role: string | null;
  eligibleWorkers: number;
  busyWorkers: number;
  utilization: number;
  saturated: boolean;
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
/** V5 without the deferred failed-match dimension: least eligible, then names break equal-utilization ties. */
export function compareUtilization(a: UtilizationCombination, b: UtilizationCombination): number {
  return b.utilization - a.utilization || a.eligibleWorkers - b.eligibleWorkers
    || nameCompare(a.family, b.family) || nameCompare(a.tier, b.tier) || nameCompare(a.role, b.role);
}

/**
 * One admitted App/read snapshot. Current binding or live host families and the shared effective-availability
 * predicate define the eligible denominator, independently of task load or session quietness. Retired workers
 * are absent from the same shared loader the roster uses. An unbound multi-host worker can contribute to each family.
 */
export async function loadTeamUtilization(db: Db, appId: string, now: Date, windowHours: number, filters: UtilizationFilters) {
  const [workers, busy] = await Promise.all([
    loadWorkerWorkStates(db, appId, now),
    busyWorkersInWindow(db, appId, new Date(now.getTime() - windowHours * HOUR), now),
  ]);
  const groups = new Map<string, UtilizationCombination>();
  for (const worker of workers) {
    const tier = tierOf(worker.bindingModel);
    for (const family of worker.families) {
      if ((filters.family != null && filters.family !== family) || (filters.tier != null && filters.tier !== tier)
          || (filters.role != null && filters.role !== worker.role)) continue;
      const key = JSON.stringify([family, tier, worker.role]);
      let row = groups.get(key);
      if (!row) {
        row = { family, tier, role: worker.role, eligibleWorkers: 0, busyWorkers: 0, utilization: 0, saturated: false };
        groups.set(key, row);
      }
      if (worker.availability.ownInEffect || worker.availability.familyAvailable.get(family) !== true) continue;
      row.eligibleWorkers++;
      if (busy.has(worker.id)) row.busyWorkers++;
    }
  }
  for (const row of groups.values()) {
    row.saturated = row.eligibleWorkers === 0;
    row.utilization = row.saturated ? 1 : row.busyWorkers / row.eligibleWorkers;
  }
  return { appId, computedAt: now, windowHours, combinations: [...groups.values()].sort(compareUtilization) };
}
