/**
 * #2763, renamed and re-pointed by #4375 (rulings 0270 and 0271) — the lead-cadence alarm (cor:agt:050:31).
 *
 * A lead is LATE when it has made no counted assignment for 60 minutes while at least one worker under it is free for
 * work. Then the platform raises ONE task-less alarm for it per episode and tells its reporting line, nearest first
 * (`darkAlarmChain`). The stall evaluator's pass calls `evaluateLeadCadence`. The email to people outside the team is
 * the follow-up, blocked on ruling 0116; nothing here sends one.
 *
 * WHO. Every LEAD: a worker that at least one worker reports to, not retired (cor:agt:020:12), as defined once in
 * `./leads.ts`. No role name takes part: a worker in any role is watched when it leads, and a worker that nobody
 * reports to is not watched, whatever its role. The exemptions are the dark-worker alarm's, one source:
 * `EXEMPT_PENDING` over the worker check status (TEAM_PAUSED, PAUSED, STOPPED), read from `loadPendingReasons`. A lead
 * with no live session is NOT exempt (cor:agt:050:31 r3: nobody driving it is a case this alarm exists to catch); its
 * clock starts at the first pass that saw it as a lead.
 *
 * THE CLOCK. The latest of: the lead's last COUNTED assignment (`task.assigned` / `task.reassigned` with
 * `actor_worker_id` = this lead; `assignment.matched` is the matcher's and never counts, so a busy matcher cannot hide a
 * lead that stopped dispatching), its first session, and `observed_at`, the first pass that saw it as a lead
 * (`lead_cadence_clocks`), so a worker that was already a lead before the deploy, or that becomes one later, is not late
 * at the first pass that sees it. The row belongs to the lead's current stint: a pass deletes the rows of workers that are
 * not leads, so one that stops leading and leads again, or that kept a row from the old role-based watch, starts afresh.
 *
 * THE WORKERS UNDER THE LEAD. The matcher's team pool for the lead (`matchingTeamPool`) minus every lead (the pool
 * includes the lead itself, and a worker with no reporting line joins every pool; a lead, a sub-lead included, is not
 * a free worker for another lead's alarm). A worker with no reporting line is in every lead's pool, as for matching.
 * Free for work is the shared helper's `free` (cor:agt:060:05), the one the matcher and the roster read, minus every
 * pool worker a live stop signal covers at any level (ruling 0123, alarm-only exclusion).
 *
 * EPISODES. The alarm stream is append-only and `agent_team_events_episode_uniq` does not dedupe a NULL task id, so the
 * episode is a row in `lead_cadence_episodes` whose partial unique index admits one OPEN row per lead, inserted in
 * the same SERIALIZABLE transaction as the event. The loser of a race rolls back and raises nothing. An episode ends
 * ONLY at the lead's next counted assignment: neither a shortage of free workers nor a pause ends it, so busy/free
 * toggles never raise a second alarm. The next lateness after that opens a new one. An episode also ends when its worker
 * STOPS BEING A LEAD (nobody reports to it any more): the alarm says a lead stopped assigning, which is no longer true of
 * a worker that leads nobody, and an ended episode is what stops the alarm's escalation up the reporting line. Its
 * `ended_at` is the pass's time.
 *
 * WIRE. Emitted under `alarm.lead-cadence` only. Events raised before #4375 carry `alarm.coordinator-cadence`; they are
 * history and are not rewritten, and every reader matches both (`LEAD_CADENCE_EVENT_TYPES`).
 *
 * LIMIT (stated, not hidden): a lead that comes back from a pause keeps its old clock, so one whose last assignment is
 * older than 60 minutes is late on the first pass after it returns, if a worker under it is free.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { loadPendingReasons } from '../tickers/checkPending.js';
import { darkAlarmChain, EXEMPT_PENDING } from './darkWorker.js';
import { LEAD_CADENCE_EVENT_TYPE } from './events.js';
import { leadWorkerIds } from './leads.js';
import { loadWorkerWorkStates, matchingTeamPool } from './matcher.js';
import { isSerializationFailure } from './stall.js';
import { coveringSignals } from '../stopSignals/state.js';

export { LEAD_CADENCE_EVENT_TYPE, LEAD_CADENCE_EVENT_TYPES } from './events.js';
/** Ruling 0094 A: 60 minutes, fixed for now (a per-App setting is out of scope). */
export const LEAD_CADENCE_WINDOW_MINUTES = 60;
/** The events that count as a lead's own assignment. `assignment.matched` is deliberately absent. */
export const COUNTED_ASSIGNMENT_EVENT_TYPES = ['task.assigned', 'task.reassigned'] as const;

type App = { id: string; organizationId: string | null; ownerUserId: string | null };

/** The newest counted assignment each lead made. */
async function lastCountedAssignments(db: PrismaClient, appId: string, workerIds: string[]): Promise<Map<string, Date>> {
  const rows = await db.agentTeamEvent.groupBy({
    by: ['actorWorkerId'],
    where: { appId, actorWorkerId: { in: workerIds }, type: { in: [...COUNTED_ASSIGNMENT_EVENT_TYPES] } },
    _max: { createdAt: true },
  });
  return new Map(rows.filter((r) => r.actorWorkerId && r._max.createdAt).map((r) => [r.actorWorkerId as string, r._max.createdAt as Date]));
}

async function firstSessionStarts(db: PrismaClient, workerIds: string[]): Promise<Map<string, Date>> {
  // #4273: each worker's earliest start from one end of sessions_worker_started_idx, not a read of all its sessions.
  const rows = await db.$queryRaw<{ workerId: string; first: Date | null }[]>`
    SELECT w AS "workerId", (SELECT min(s.started_at) FROM sessions s WHERE s.worker_id = w AND s.deleted_at IS NULL) AS "first"
    FROM unnest(${workerIds}::text[]) AS w`;
  return new Map(rows.filter((r) => r.first).map((r) => [r.workerId, r.first as Date]));
}

/** Record the first pass that saw each worker as a lead. Never updated: `ON CONFLICT DO NOTHING`, so concurrent passes agree. */
async function observe(db: PrismaClient, appId: string, workerIds: string[], now: Date): Promise<Map<string, Date>> {
  if (workerIds.length === 0) return new Map();
  await db.$executeRaw`
    INSERT INTO lead_cadence_clocks (worker_id, app_id, observed_at)
    SELECT w, ${appId}, ${toNaiveUtc(now)}::timestamp FROM unnest(${workerIds}::text[]) AS w
    ON CONFLICT (worker_id) DO NOTHING`;
  const rows = await db.leadCadenceClock.findMany({ where: { workerId: { in: workerIds } }, select: { workerId: true, observedAt: true } });
  return new Map(rows.map((r) => [r.workerId, r.observedAt]));
}

type Late = { workerId: string; lastAssignedAt: Date | null; freeWorkerCount: number };

/**
 * Is this lead late NOW? Null when it is not (retired, not a lead, exempt, inside its window, or no free worker under
 * it). Every input is read through `db`, so the raise transaction can call it again on its own connection. A lead that
 * already has an open episode is the caller's concern (the unique index decides a race).
 */
async function decide(db: PrismaClient, appId: string, workerId: string, now: Date): Promise<Late | null> {
  // The lead set is read once per judgement (cor:agt:020:12, `./leads.ts`): it decides whether this worker is watched at
  // all and which pool workers do not count as free. In the raise transaction it is read again on that connection.
  const leads = await leadWorkerIds(db, appId);
  if (!leads.has(workerId)) return null;
  const observed = await observe(db, appId, [workerId], now);
  const last = (await lastCountedAssignments(db, appId, [workerId])).get(workerId) ?? null;
  const first = (await firstSessionStarts(db, [workerId])).get(workerId);
  // The pending reason is read directly, not through the check status: NO_SESSION would hide it, and a lead with no live
  // session is NOT exempt (cor:agt:050:31 r3), but a paused one without a session still is.
  const reason = (await loadPendingReasons(db, appId, [workerId], now)).get(workerId);
  if (reason && EXEMPT_PENDING.has(reason)) return null;
  const clock = Math.max(last?.getTime() ?? -Infinity, first?.getTime() ?? -Infinity, observed.get(workerId)?.getTime() ?? -Infinity);
  if (now.getTime() - clock < LEAD_CADENCE_WINDOW_MINUTES * 60_000) return null;
  const pool = await matchingTeamPool(db, appId, workerId);
  const states = new Map((await loadWorkerWorkStates(db, appId, now)).map((st) => [st.id, st]));
  // Ruling 0123: every stop level blocks assignment, including pause-dispatch.
  // Read live coverage through this connection so raise() rechecks it in its transaction too.
  const stopped = await coveringSignals(db, appId, [...pool], now);
  const freeWorkerCount = [...pool].filter((id) => {
    const st = states.get(id);
    // No lead counts as a free worker (a sub-lead under this lead included): leads are judged, not dispatched to.
    return !!st && !leads.has(id) && st.free && !stopped.has(id);
  }).length;
  return freeWorkerCount === 0 ? null : { workerId, lastAssignedAt: last, freeWorkerCount };
}

/** Open one episode and raise its alarm, in one transaction. Null when the lead already has an open episode. */
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
        reason: 'lead-cadence',
        windowMinutes: LEAD_CADENCE_WINDOW_MINUTES,
        lastAssignedAt: late.lastAssignedAt ? late.lastAssignedAt.toISOString() : null,
        freeWorkerCount: late.freeWorkerCount,
      };
      const chainJson = chain.map((p) => (p.workerId ? { workerId: p.workerId } : { userId: p.userId as string, ...(p.via ? { via: p.via } : {}) }));
      await tx.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
        VALUES (${eventId}, ${app.id}, ${LEAD_CADENCE_EVENT_TYPE}, NULL, ${late.workerId}, 'alarm', ${JSON.stringify(chainJson)}::jsonb,
                ${JSON.stringify(payload)}::jsonb, ${toNaiveUtc(now)}::timestamp, NULL)`;
      // The one-open-episode-per-lead index decides a race: the loser's insert fails and this transaction rolls back.
      await tx.leadCadenceEpisode.create({ data: { appId: app.id, workerId: late.workerId, eventId, openedAt: now } });
      const windowMs = LEAD_CADENCE_WINDOW_MINUTES * 60_000;
      // cor:agt:050:19 — the nearest owner is woken now; owner i falls due i windows later, unless acknowledged first.
      await tx.agentTeamAlarmSchedule.createMany({
        data: chain.map((_, i) => ({ eventId, chainIndex: i, dueAt: new Date(now.getTime() + i * windowMs), wokenAt: i === 0 ? now : null })),
      });
      return eventId;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 30_000, maxWait: 10_000 });
    if (chainEmpty) console.warn(JSON.stringify({ event: 'lead_cadence.chain_empty', appId: app.id, workerId: late.workerId, eventId }));
    return eventId;
  } catch (err) {
    if (isSerializationFailure(err)) return null;
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null;
    throw err;
  }
}

/**
 * One pass: end the open episodes whose lead has assigned since, and open one for each late lead that has none. Returns the ids of the alarms this pass raised.
 */
export async function evaluateLeadCadence(db: PrismaClient, now = new Date()): Promise<string[]> {
  const raised: string[] = [];
  const apps = await db.app.findMany({ where: { deletedAt: null, uninstalledAt: null }, select: { id: true, organizationId: true, ownerUserId: true } });
  for (const app of apps) {
    try {
      // Every lead of the App (cor:agt:020:12), whatever its role; one definition, `./leads.ts`.
      const leads = await leadWorkerIds(db, app.id);
      const candidates = [...leads].map((id) => ({ id }));
      // A clock row belongs to a lead's CURRENT stint: a worker that is not a lead has none. So a worker that becomes a lead
      // (or comes back to leading after a gap, or kept a row from the old role-based watch) starts a fresh 60 minutes at the
      // first pass that sees it as a lead, instead of being late at once on a stale first sighting.
      await db.leadCadenceClock.deleteMany({ where: { appId: app.id, workerId: { notIn: [...leads] } } });
      // The open episodes are read BEFORE the clocks, so a pass ends only an episode that existed when it began.
      const open = await db.leadCadenceEpisode.findMany({ where: { appId: app.id, endedAt: null }, select: { id: true, workerId: true, openedAt: true } });
      const ids = [...new Set([...candidates.map((c) => c.id), ...open.map((e) => e.workerId)])];
      if (ids.length === 0) continue;
      const lastAssigned = await lastCountedAssignments(db, app.id, ids);
      // An episode ends at the lead's next counted assignment, whoever it is and whatever its state now, or when its worker
      // is no longer a lead (nobody reports to it: the alarm's subject is gone, and ending it stops the escalation).
      for (const e of open) {
        const last = lastAssigned.get(e.workerId);
        const assigned = !!last && last > e.openedAt;
        if (!assigned && leads.has(e.workerId)) continue;
        try {
          // Assigned: the assignment's time. No longer a lead: this pass's time (never before the episode opened).
          const endedAt = assigned ? (last as Date) : new Date(Math.max(now.getTime(), e.openedAt.getTime()));
          await db.leadCadenceEpisode.updateMany({ where: { id: e.id, endedAt: null }, data: { endedAt } });
        } catch (err) {
          console.error(`[lead-cadence] ending episode ${e.id} failed:`, err);
        }
      }
      if (candidates.length === 0) continue;
      const openWorkers = new Set(open.filter((e) => !(lastAssigned.get(e.workerId) && (lastAssigned.get(e.workerId) as Date) > e.openedAt) && leads.has(e.workerId)).map((e) => e.workerId));
      for (const c of candidates) {
        try {
          const late = await decide(db, app.id, c.id, now);
          if (!late) continue;
          if (openWorkers.has(c.id)) continue;
          const id = await raise(db, app, late, now);
          if (id) raised.push(id);
        } catch (err) {
          console.error(`[lead-cadence] raising the alarm for worker ${c.id} failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[lead-cadence] evaluating App ${app.id} failed:`, err);
    }
  }
  return raised;
}
