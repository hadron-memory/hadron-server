/**
 * #2763 — the coordinator-cadence alarm (cor:agt:050:31, Proposed; Holger's order 2026-10-29, rulings 0094 A, 0115 A).
 *
 * A coordinator is LATE when it has made no counted assignment for 60 minutes while at least one worker in its lane is
 * free for work. Then the platform raises ONE task-less alarm for it per episode and tells its reporting line, nearest
 * first (`darkAlarmChain`). The stall evaluator's pass calls `evaluateCoordinatorCadence`. The email to people outside
 * the team is the follow-up, blocked on ruling 0116; nothing here sends one.
 *
 * WHO. A worker whose role is `coordinator` (cor:agt:110:05; no per-App role-name setting), not retired. The exemptions are the dark-worker alarm's, one source: `EXEMPT_PENDING` over the worker check status
 * (TEAM_PAUSED, PAUSED, STOPPED), read from `loadPendingReasons`. A coordinator with no live session is NOT
 * exempt (cor:agt:050:31 r3: nobody driving it is a case this alarm exists to catch); its clock starts at the first pass that saw it.
 *
 * THE CLOCK. The latest of: the coordinator's last COUNTED assignment (`task.assigned` / `task.reassigned` with
 * `actor_worker_id` = this coordinator; `assignment.matched` is the matcher's and never counts, so a busy matcher cannot
 * hide a coordinator that stopped dispatching), its first session, and `observed_at`, the first pass that saw it
 * (`coordinator_cadence_clocks`), so a coordinator that existed before the deploy is not late at the first pass.
 *
 * THE LANE. The matcher's team pool for the coordinator (`matchingTeamPool`) minus every worker whose role is
 * `coordinator` (the pool includes the lead itself, and another coordinator with no reporting line joins every pool; a
 * coordinator is nobody's free worker). A worker with no reporting line is in every coordinator's lane, as for matching.
 * Free for work is the shared helper's `free` (cor:agt:060:05), the one the matcher and the roster read, minus every
 * lane worker a live stop signal covers at any level (ruling 0123, alarm-only exclusion).
 *
 * EPISODES. The alarm stream is append-only and `agent_team_events_episode_uniq` does not dedupe a NULL task id, so the
 * episode is a row in `coordinator_cadence_episodes` whose partial unique index admits one OPEN row per coordinator,
 * inserted in the same SERIALIZABLE transaction as the event. The loser of a race rolls back and raises nothing. An
 * episode ends ONLY at the coordinator's next counted assignment: neither a shortage of free lane workers nor a pause
 * ends it, so busy/free toggles never raise a second alarm. The next lateness after that opens a new one.
 *
 * LIMIT (stated, not hidden): a coordinator that comes back from a pause keeps its old clock, so one
 * whose last assignment is older than 60 minutes is late on the first pass after it returns, if a lane worker is free.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { loadPendingReasons } from '../tickers/checkPending.js';
import { darkAlarmChain, EXEMPT_PENDING } from './darkWorker.js';
import { loadWorkerWorkStates, matchingTeamPool } from './matcher.js';
import { isSerializationFailure } from './stall.js';
import { coveringSignals } from '../stopSignals/state.js';

export const COORDINATOR_CADENCE_EVENT_TYPE = 'alarm.coordinator-cadence';
/** Ruling 0094 A: 60 minutes, fixed for now (a per-App setting is out of scope). */
export const COORDINATOR_CADENCE_WINDOW_MINUTES = 60;
/** The events that count as a coordinator's own assignment. `assignment.matched` is deliberately absent. */
export const COUNTED_ASSIGNMENT_EVENT_TYPES = ['task.assigned', 'task.reassigned'] as const;

type App = { id: string; organizationId: string | null; ownerUserId: string | null };
const isCoordinator = (role: string | null) => (role ?? '').toLowerCase() === 'coordinator';

/** The newest counted assignment each coordinator made. */
async function lastCountedAssignments(db: PrismaClient, appId: string, workerIds: string[]): Promise<Map<string, Date>> {
  const rows = await db.agentTeamEvent.groupBy({
    by: ['actorWorkerId'],
    where: { appId, actorWorkerId: { in: workerIds }, type: { in: [...COUNTED_ASSIGNMENT_EVENT_TYPES] } },
    _max: { createdAt: true },
  });
  return new Map(rows.filter((r) => r.actorWorkerId && r._max.createdAt).map((r) => [r.actorWorkerId as string, r._max.createdAt as Date]));
}

async function firstSessionStarts(db: PrismaClient, workerIds: string[]): Promise<Map<string, Date>> {
  const rows = await db.session.groupBy({ by: ['workerId'], where: { workerId: { in: workerIds }, deletedAt: null }, _min: { startedAt: true } });
  return new Map(rows.filter((r) => r.workerId && r._min.startedAt).map((r) => [r.workerId as string, r._min.startedAt as Date]));
}

/** Record the first pass that saw each coordinator. Never updated: `ON CONFLICT DO NOTHING`, so concurrent passes agree. */
async function observe(db: PrismaClient, appId: string, workerIds: string[], now: Date): Promise<Map<string, Date>> {
  if (workerIds.length === 0) return new Map();
  await db.$executeRaw`
    INSERT INTO coordinator_cadence_clocks (worker_id, app_id, observed_at)
    SELECT w, ${appId}, ${toNaiveUtc(now)}::timestamp FROM unnest(${workerIds}::text[]) AS w
    ON CONFLICT (worker_id) DO NOTHING`;
  const rows = await db.coordinatorCadenceClock.findMany({ where: { workerId: { in: workerIds } }, select: { workerId: true, observedAt: true } });
  return new Map(rows.map((r) => [r.workerId, r.observedAt]));
}

type Late = { workerId: string; lastAssignedAt: Date | null; freeWorkerCount: number };

/**
 * Is this coordinator late NOW? Null when it is not (retired, not a coordinator, no session, exempt, inside its window, or
 * no free worker in its lane). Every input is read through `db`, so the raise transaction can call it again on its own
 * connection. A coordinator that already has an open episode is the caller's concern (the unique index decides a race).
 */
async function decide(db: PrismaClient, appId: string, workerId: string, now: Date): Promise<Late | null> {
  const c = await db.worker.findFirst({ where: { id: workerId, appId, retiredAt: null }, select: { id: true, role: true } });
  if (!c || !isCoordinator(c.role)) return null;
  const observed = await observe(db, appId, [c.id], now);
  const last = (await lastCountedAssignments(db, appId, [c.id])).get(c.id) ?? null;
  const first = (await firstSessionStarts(db, [c.id])).get(c.id);
  // The pending reason is read directly, not through the check status: NO_SESSION would hide it, and a coordinator with no
  // live session is NOT exempt (cor:agt:050:31 r3), but a paused one without a session still is.
  const reason = (await loadPendingReasons(db, appId, [c.id], now)).get(c.id);
  if (reason && EXEMPT_PENDING.has(reason)) return null;
  const clock = Math.max(last?.getTime() ?? -Infinity, first?.getTime() ?? -Infinity, observed.get(c.id)?.getTime() ?? -Infinity);
  if (now.getTime() - clock < COORDINATOR_CADENCE_WINDOW_MINUTES * 60_000) return null;
  const pool = await matchingTeamPool(db, appId, c.id);
  const states = new Map((await loadWorkerWorkStates(db, appId, now)).map((st) => [st.id, st]));
  // Ruling 0123: every stop level blocks assignment, including pause-dispatch.
  // Read live coverage through this connection so raise() rechecks it in its transaction too.
  const stopped = await coveringSignals(db, appId, [...pool], now);
  const freeWorkerCount = [...pool].filter((id) => {
    const st = states.get(id);
    return !!st && !isCoordinator(st.role) && st.free && !stopped.has(id);
  }).length;
  return freeWorkerCount === 0 ? null : { workerId: c.id, lastAssignedAt: last, freeWorkerCount };
}

/** Open one episode and raise its alarm, in one transaction. Null when the coordinator already has an open episode. */
async function raise(db: PrismaClient, app: App, late: Late, now: Date): Promise<string | null> {
  let chainEmpty = false;
  try {
    const eventId = await db.$transaction(async (tx): Promise<string | null> => {
      // cor:agt:050:18 (Decided): the reporting line, nearest first; App managers only when there is no reporting line
      // (`darkAlarmChain` is that rule since #3364).
      const chain = await darkAlarmChain(tx, app, late.workerId);
      // The decision is re-derived HERE, inside the SERIALIZABLE transaction, so its reads are the ones Postgres checks for a
      // read-write cycle: an assignment, pause or lane change that commits between the pass's reads and this insert makes
      // one side abort (or is seen now), and nothing is published or woken on a stale decision.
      const again = await decide(tx as unknown as PrismaClient, app.id, late.workerId, now);
      if (!again) return null;
      late = again;
      chainEmpty = chain.length === 0;
      const eventId = generateId();
      const payload: Prisma.InputJsonObject = {
        reason: 'coordinator-cadence',
        windowMinutes: COORDINATOR_CADENCE_WINDOW_MINUTES,
        lastAssignedAt: late.lastAssignedAt ? late.lastAssignedAt.toISOString() : null,
        freeWorkerCount: late.freeWorkerCount,
      };
      const chainJson = chain.map((p) => (p.workerId ? { workerId: p.workerId } : { userId: p.userId as string, ...(p.via ? { via: p.via } : {}) }));
      await tx.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
        VALUES (${eventId}, ${app.id}, ${COORDINATOR_CADENCE_EVENT_TYPE}, NULL, ${late.workerId}, 'alarm', ${JSON.stringify(chainJson)}::jsonb,
                ${JSON.stringify(payload)}::jsonb, ${toNaiveUtc(now)}::timestamp, NULL)`;
      // The one-open-episode-per-coordinator index decides a race: the loser's insert fails and this transaction rolls back.
      await tx.coordinatorCadenceEpisode.create({ data: { appId: app.id, workerId: late.workerId, eventId, openedAt: now } });
      const windowMs = COORDINATOR_CADENCE_WINDOW_MINUTES * 60_000;
      // cor:agt:050:19 — the nearest owner is woken now; owner i falls due i windows later, unless acknowledged first.
      await tx.agentTeamAlarmSchedule.createMany({
        data: chain.map((_, i) => ({ eventId, chainIndex: i, dueAt: new Date(now.getTime() + i * windowMs), wokenAt: i === 0 ? now : null })),
      });
      return eventId;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000, maxWait: 10_000 });
    if (chainEmpty) console.warn(JSON.stringify({ event: 'coordinator_cadence.chain_empty', appId: app.id, workerId: late.workerId, eventId }));
    return eventId;
  } catch (err) {
    if (isSerializationFailure(err)) return null;
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

/**
 * One pass: end the open episodes whose coordinator has assigned since, and open one for each late coordinator that has
 * none. Returns the ids of the alarms this pass raised.
 */
export async function evaluateCoordinatorCadence(db: PrismaClient, now = new Date()): Promise<string[]> {
  const raised: string[] = [];
  const apps = await db.app.findMany({ where: { deletedAt: null, uninstalledAt: null }, select: { id: true, organizationId: true, ownerUserId: true } });
  for (const app of apps) {
    try {
      const candidates = await db.worker.findMany({ where: { appId: app.id, retiredAt: null, role: { equals: 'coordinator', mode: 'insensitive' } }, select: { id: true, role: true } });
      // The open episodes are read BEFORE the clocks, so a pass ends only an episode that existed when it began.
      const open = await db.coordinatorCadenceEpisode.findMany({ where: { appId: app.id, endedAt: null }, select: { id: true, workerId: true, openedAt: true } });
      const ids = [...new Set([...candidates.map((c) => c.id), ...open.map((e) => e.workerId)])];
      if (ids.length === 0) continue;
      const lastAssigned = await lastCountedAssignments(db, app.id, ids);
      // An episode ends at the coordinator's next counted assignment, whoever it is and whatever its state now.
      for (const e of open) {
        const last = lastAssigned.get(e.workerId);
        if (!last || last <= e.openedAt) continue;
        try {
          await db.coordinatorCadenceEpisode.updateMany({ where: { id: e.id, endedAt: null }, data: { endedAt: last } });
        } catch (err) {
          console.error(`[coordinator-cadence] ending episode ${e.id} failed:`, err);
        }
      }
      if (candidates.length === 0) continue;
      const openWorkers = new Set(open.filter((e) => !(lastAssigned.get(e.workerId) && (lastAssigned.get(e.workerId) as Date) > e.openedAt)).map((e) => e.workerId));
      for (const c of candidates) {
        try {
          const late = await decide(db, app.id, c.id, now);
          if (!late) continue;
          if (openWorkers.has(c.id)) continue;
          const id = await raise(db, app, late, now);
          if (id) raised.push(id);
        } catch (err) {
          console.error(`[coordinator-cadence] raising the alarm for worker ${c.id} failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[coordinator-cadence] evaluating App ${app.id} failed:`, err);
    }
  }
  return raised;
}
