/**
 * #4231 (S8 of the Team on Orca epic, #4229) — the platform starts a long-lived worker that should run and has no
 * session (cor:agt:070:05 S7 and :08, Proposed; G2 OK'd by Holger in the decision queue,
 * hrn:node:hadronmemory.com:hadron-dev-team-shared:coordination:team-on-orca-decisions).
 *
 * WHAT IS STARTED. In each App whose `sweepMode` is APPLY, every worker a host's desired state (#4224, #4248) lists as
 * RUNNING because its Agent is LONG_LIVED, with no open session. A short-lived worker is never started here: it is
 * RUNNING only while it holds a task, and that task's own start covers it (cor:agt:070:08). Leave-alone, sweep OFF and
 * OBSERVE desire nothing; retired, halted, paused, team-paused and resetting are STOPPED, so none of them is started.
 *
 * THE FENCES, per worker in one transaction, in `launchForAssignment`'s order: the authority anchors SHARED (an
 * uninstall or delete committed first is seen, or waits), the App live and still APPLY; the stop fence SHARED (a stop
 * signal set concurrently is ordered with this decision); the worker row FOR UPDATE through `lockStartableWorker`
 * (held, not retired, NO OPEN session, V16, and no start in flight); then the desired state is re-read inside those
 * locks, so the start is decided on fresh facts; then the host decision is fenced and made from the live
 * registrations, assignment-aware under `hostSetupSource: server` (`liveRegistrationsFor`).
 *
 * WHAT IS RECORDED. `issuedBy: platform`, no task, and `issuedReason: DESIRED_RUNNING`. The operation's `args` are the
 * same as any start's, so the host contract does not change.
 *
 * THE TRIP. Three failed platform starts of a worker in the last hour stop this loop starting it (counted under the
 * worker row lock, so two passes agree), and raise ONE task-less `alarm.start-failing` to its reporting line, nearest
 * first (App managers only when that line is empty, as the dark-worker alarm). The episode table only de-duplicates:
 * an episode closes an hour after it opened, so a worker still failing then is alarmed again. The start resumes on its
 * own once fewer than three failures remain in the hour (Proposed default, recorded on #4231).
 *
 * Runs as a step of the one-minute matcher tick (src/jobs/taskMatcher.ts), after matching, so a task's own start goes
 * first. Never throws for one worker: a failure is logged and the next worker is tried.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { lockAuthorityAnchors } from '../auth/authorityAnchors.js';
import { afterWaits, anchorNow, lockStopFence } from '../stopSignals/state.js';
import { darkAlarmChain } from '../agentTasks/darkWorker.js';
import type { AlarmChain } from '../agentTasks/events.js';
import { isSerializationFailure } from '../agentTasks/stall.js';
import {
  fenceHostDecision, insertWorkerStart, LaunchRefusal, liveRegistrationsFor, lockStartableWorker, type StartHold,
} from '../hostOperations/launch.js';
import { loadHostDesiredState } from './desiredState.js';

export const START_FAILING_EVENT_TYPE = 'alarm.start-failing';
/** The reason a desired-state start records (`HostOperation.issuedReason`). */
export const DESIRED_RUNNING = 'DESIRED_RUNNING';
/** This many failed platform starts inside the window stop further desired-state starts of the worker. */
export const START_FAILURE_LIMIT = 3;
export const START_FAILURE_WINDOW_MS = 60 * 60_000;

type Db = PrismaClient | Prisma.TransactionClient;

/** Is this row of a host's desired state one this loop starts? */
const startable = (r: { desired: string | null; reason: string; openSessionId: string | null }) =>
  r.desired === 'RUNNING' && r.reason === 'LONG_LIVED' && r.openSessionId === null;

/** Every host id of an App: the registered ones and, for an App that states its setup, the assigned ones. */
async function hostIdsOf(db: Db, appId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ hostId: string }[]>`
    SELECT host_id AS "hostId" FROM host_registrations WHERE app_id = ${appId}
    UNION
    SELECT host_id FROM host_worker_assignments WHERE app_id = ${appId}
    ORDER BY 1`;
  return rows.map((r) => r.hostId);
}

/**
 * One pass at `now`: start every worker the file header describes, in every App that applies its sweep. Returns the
 * number of starts issued.
 */
export async function startDesiredWorkers(db: PrismaClient, now = new Date(), anchor: number = anchorNow()): Promise<number> {
  const apps = await db.app.findMany({ where: { sweepMode: 'APPLY', deletedAt: null, uninstalledAt: null }, select: { id: true }, orderBy: { id: 'asc' } });
  let issued = 0;
  for (const app of apps) {
    // Every host that lists the worker as startable, by host id. The first is tried; a host that turns out unusable
    // under the locks (its registration lapsed, or it no longer lists a worktree) falls through to the next.
    const candidates = new Map<string, string[]>();
    try {
      for (const hostId of await hostIdsOf(db, app.id)) {
        try {
          const state = await loadHostDesiredState(db, app.id, hostId, now);
          for (const r of state?.workers ?? []) if (startable(r)) candidates.set(r.workerId, [...(candidates.get(r.workerId) ?? []), hostId]);
        } catch (err) {
          // One host's read failing skips that host only.
          console.error('[desired-start] reading a host\'s desired state failed:', { appId: app.id, hostId }, err);
        }
      }
    } catch (err) {
      // One App's host list failing skips that App only.
      console.error('[desired-start] listing an App\'s hosts failed:', { appId: app.id }, err);
      continue;
    }
    for (const [workerId, hostIds] of candidates) {
      for (const hostId of hostIds) {
        const outcome = await startDesiredWorker(db, { appId: app.id, workerId, hostId }, now, anchor);
        if (outcome === 'issued') issued++;
        else if (outcome === 'tripped') {
          try {
            await raiseStartFailingAlarm(db, app.id, workerId, now);
          } catch (err) {
            console.error('[desired-start] raising the start-failing alarm failed:', { appId: app.id, workerId }, err);
          }
        }
        if (outcome !== 'no-host') break;
      }
    }
  }
  return issued;
}

/** Failed platform starts of the worker finished inside the window ending at `now`. */
async function recentFailures(db: Db, workerId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - START_FAILURE_WINDOW_MS);
  return db.hostOperation.count({
    where: { workerId, type: 'worker.start', issuedBy: 'platform', status: 'failed', finishedAt: { gt: since, lte: now } },
  });
}

/**
 * Start one worker if it is still startable once every fence is held (file header). `issued` when a start was
 * inserted, `tripped` when the failure limit stopped it, `no-host` when this host has no live registration listing a
 * worktree for it (the caller tries the worker's next host), `skipped` otherwise.
 */
export async function startDesiredWorker(
  db: PrismaClient,
  a: { appId: string; workerId: string; hostId: string },
  now: Date,
  anchor: number = anchorNow(),
): Promise<'issued' | 'tripped' | 'skipped' | 'no-host'> {
  try {
    const owner = await db.app.findUnique({ where: { id: a.appId }, select: { organizationId: true, ownerUserId: true } });
    return await db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [
        { kind: 'app', id: a.appId },
        ...(owner?.organizationId ? [{ kind: 'org' as const, id: owner.organizationId }] : []),
        ...(owner?.ownerUserId ? [{ kind: 'user' as const, id: owner.ownerUserId }] : []),
      ], 'shared');
      const app = await tx.app.findUnique({ where: { id: a.appId }, select: { deletedAt: true, uninstalledAt: true, sweepMode: true } });
      if (!app || app.deletedAt || app.uninstalledAt || app.sweepMode !== 'APPLY') return 'skipped';
      await lockStopFence(tx, a.appId, 'shared');
      let hold: StartHold;
      try {
        hold = await lockStartableWorker(tx, a.appId, a.workerId, now, 'open');
      } catch (e) {
        if (e instanceof LaunchRefusal) return 'skipped';
        throw e;
      }
      // Re-decided under the locks, at the moment after their waits: a stop signal, a team pause, leave-alone or a
      // session since the pass's read wins.
      const row = (await loadHostDesiredState(tx, a.appId, a.hostId, afterWaits(now, anchor)))?.workers.find((w) => w.workerId === a.workerId);
      if (!row || !startable(row)) return 'skipped';
      if ((await recentFailures(tx, a.workerId, now)) >= START_FAILURE_LIMIT) return 'tripped';
      await fenceHostDecision(tx, a.appId);
      const reg = (await liveRegistrationsFor(tx, a.appId, a.workerId, now, a.hostId)).find((r) => r.worktrees.length > 0);
      if (!reg) return 'no-host';
      await insertWorkerStart(tx, {
        appId: a.appId, hostId: reg.hostId, workerId: a.workerId, worktree: reg.worktrees[0]!, family: reg.family,
        // #4267: the assignment's launcher profile (null under `host`), as the other start paths pass it; with it the
        // start also carries the Agent's lifecycle.
        profile: reg.profile,
        taskId: null, issuer: { issuedBy: 'platform' }, hold, issuedReason: DESIRED_RUNNING,
      });
      return 'issued';
    });
  } catch (err) {
    console.error('[desired-start] starting a worker that should run failed:', a, err);
    return 'skipped';
  }
}

const partyJson = (p: AlarmChain[number]): Prisma.InputJsonObject =>
  p.workerId ? { workerId: p.workerId } : { userId: p.userId as string, ...(p.via ? { via: p.via } : {}) };

/**
 * Raise ONE `alarm.start-failing` for the worker unless an episode is open (the post-limit alarm's seam: event, chain,
 * wake schedule, episode). Returns the alarm's id, or null (an episode is open, the App or worker is exempt, or a
 * concurrent pass raised it first).
 */
export async function raiseStartFailingAlarm(db: PrismaClient, appId: string, workerId: string, now: Date): Promise<string | null> {
  try {
    return await db.$transaction(async (tx) => {
      const live = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM apps WHERE id = ${appId} AND deleted_at IS NULL AND uninstalled_at IS NULL FOR SHARE`;
      if (live.length === 0) return null;
      const w = await tx.worker.findUnique({
        where: { id: workerId },
        select: { appId: true, retiredAt: true, app: { select: { id: true, organizationId: true, ownerUserId: true, deliveryDarkAlarmWindowSeconds: true } } },
      });
      if (!w || w.appId !== appId || w.retiredAt) return null;
      const at = toNaiveUtc(now);
      // An episode older than an hour is over: closed an hour after it opened, never later.
      await tx.$executeRaw`
        UPDATE start_failing_episodes SET ended_at = opened_at + interval '1 hour'
        WHERE worker_id = ${workerId} AND ended_at IS NULL AND opened_at + interval '1 hour' <= ${at}::timestamp`;
      // Checked BEFORE the event is written: the event stream is append-only, so an abandoned row could not be removed.
      const open = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM start_failing_episodes WHERE worker_id = ${workerId} AND ended_at IS NULL LIMIT 1`;
      if (open.length > 0) return null;
      const chain = await darkAlarmChain(tx, w.app, workerId);
      const eventId = generateId();
      const payload: Prisma.InputJsonObject = { failures: await recentFailures(tx, workerId, now), windowMinutes: START_FAILURE_WINDOW_MS / 60_000 };
      await tx.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
        VALUES (${eventId}, ${appId}, ${START_FAILING_EVENT_TYPE}, NULL, ${workerId}, 'alarm', ${JSON.stringify(chain.map(partyJson))}::jsonb,
                ${JSON.stringify(payload)}::jsonb, ${at}::timestamp, NULL)`;
      // The partial unique index is the backstop for a race the check above cannot see: the insert fails and this
      // transaction, event included, rolls back.
      await tx.startFailingEpisode.create({ data: { appId, workerId, eventId, openedAt: now } });
      // cor:agt:050:19 — the nearest owner is woken now; owner i falls due i windows later, unless acknowledged first.
      const windowMs = w.app.deliveryDarkAlarmWindowSeconds * 1000;
      await tx.agentTeamAlarmSchedule.createMany({
        data: chain.map((_, i) => ({ eventId, chainIndex: i, dueAt: new Date(now.getTime() + i * windowMs), wokenAt: i === 0 ? now : null })),
      });
      return eventId;
      // SERIALIZABLE like the other alarms: the chain names manager users, sealed, and `mergeUsers` refuses to merge an
      // account named in an open alarm.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (err) {
    if (isSerializationFailure(err)) return null; // a concurrent pass: the next pass decides again
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null; // another pass opened it
    throw err;
  }
}
