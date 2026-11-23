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
 * ALREADY RUNNING (#4933, cor:agt:070:08 rev 21 and cor:agt:070:01). No platform start with no task is issued for a worker
 * whose Agent a host already runs: that host would refuse it ("an agent this host launched is still running") and
 * every minute would add a failed start, until the trip below stopped it. What the hosts have reported decides it: the
 * worker's stored terminal report (#2771) is fresh (`TERMINAL_FRESH_MS`) and shows an agent (status `busy`, `idle` or
 * `locked`, and a reason that is not agent-absent). The host it names does not matter: it is where the agent is, and a
 * start on another of the worker's hosts would be a second agent. The state is logged once when first seen and again
 * when a start follows (`already running`, then `starting`; after the transaction commits), never as a failure, and it
 * counts toward no trip and raises no alarm. A stale or missing report decides nothing, so the start goes ahead as before.
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
  fenceHostDecision, insertWorkerStart, LaunchRefusal, liveRegistrationsFor, lockStartableWorker, startSettingsFor, type StartHold,
} from '../hostOperations/launch.js';
import { loadHostDesiredState } from './desiredState.js';
import { AGENT_ABSENT_REASONS, AGENT_PRESENT_STATUSES, type WorkerTerminal } from '../workerTerminal.js';

export const START_FAILING_EVENT_TYPE = 'alarm.start-failing';
/** The reason a desired-state start records (`HostOperation.issuedReason`). */
export const DESIRED_RUNNING = 'DESIRED_RUNNING';
/** This many failed platform starts inside the window stop further desired-state starts of the worker. */
export const START_FAILURE_LIMIT = 3;
export const START_FAILURE_WINDOW_MS = 60 * 60_000;
/**
 * #4933: how long a stored terminal report keeps saying the agent runs, measured from `reportedAt`, the SERVER's clock at
 * the moment it stored the report (#4941; `checkedAt` is the host's own clock, so a host clock more than this slow made
 * every report read stale and switched the guard off). A constant, not derived from the host's check-in interval
 * (cor:agt:070:01 judges a registration by that interval, which the App tunes 2 to 10 times): the cadence of the host's
 * terminal sweep is hadron-cli's and is not visible to the server, so five minutes is a tolerance for a few missed
 * reports, not a statement of that cadence. Open on #4941 whether to derive it from the registration's lapse rule.
 */
export const TERMINAL_FRESH_MS = 5 * 60_000;
/**
 * How far ahead of the pass's `now` a report's `reportedAt` may be and still count. `reportedAt` is the server's own
 * clock, so this is only the gap between a pass taking `now` and a report committed while the pass waited on its locks.
 */
export const TERMINAL_FUTURE_TOLERANCE_MS = 2 * 60_000;

/** The stored `Worker.terminal` JSON; read defensively (a row may predate a key), so every key is optional here and a value is an unvalidated string. */
type StoredTerminal = Partial<Record<Extract<keyof WorkerTerminal, 'status' | 'reportedAt'>, string>> & {
  reason?: string | null;
  host?: Partial<WorkerTerminal['host']>;
};

/** The stored `Worker.terminal` JSON as a typed value, or null when it is not an object (the DB CHECK makes it one). */
function asTerminal(value: unknown): StoredTerminal | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as StoredTerminal) : null;
}

/**
 * Does the worker's last report say its agent is up on SOME host right now? (#4933, renamed from `hostRunsAgent` in
 * #4941, which read as the host the pass is starting on.) The reading, which cor:agt:070:08 does not state ("the
 * registered host"; it is silent on a worker registered on several hosts): ANY registering host's report counts, because
 * the stored report names the one host the agent is on, and a start on another of the worker's hosts would make a second
 * agent (the loop tries the hosts in id order, so the reporting one may not be first). Agent present is
 * `AGENT_PRESENT_STATUSES` (cor:agt:070:01: busy, idle, locked; `dark` and any status this code does not know say no),
 * unless the reason says the agent is absent.
 */
export function agentRunsOnAnyHost(terminal: StoredTerminal | null, now: Date): boolean {
  if (!terminal) return false;
  if (!terminal.status || !AGENT_PRESENT_STATUSES.has(terminal.status)) return false;
  if (terminal.reason != null && AGENT_ABSENT_REASONS.has(terminal.reason)) return false;
  const at = terminal.reportedAt ? Date.parse(terminal.reportedAt) : NaN;
  return Number.isFinite(at) && now.getTime() - at <= TERMINAL_FRESH_MS && at <= now.getTime() + TERMINAL_FUTURE_TOLERANCE_MS;
}

/**
 * Workers whose last logged state is `already running`, with when it was first seen (a pass's `now`) and whether the
 * long-hold line was written. An entry goes when the worker is started, when a pass no longer lists it as startable
 * (`pruneRunningLog`, so a deleted or retired worker's id is not held for the life of the process), or the process ends.
 */
const loggedRunning = new Map<string, { since: number; longHoldLogged: boolean }>();
/** For tests: forget what was logged. */
export function resetDesiredStartStateLog(): void {
  loggedRunning.clear();
}
/**
 * #4941: a worker the guard has held for this long, with no change, gets ONE `held a long time` line. A log line only:
 * no alarm event (that needs its own cor:agt:050 rule and a decision) and never a start (a hold judged too long and then
 * started over would break the cor:agt:070:08 guard). A host that reports `idle` forever is the case it is for.
 */
export const LONG_HOLD_LOG_MS = 6 * 60 * 60_000;
/** For tests and the pass: the workers the log remembers. */
export function runningLogSize(): number {
  return loggedRunning.size;
}
/** Forget every logged worker that is not in `keep`: a worker no longer startable (deleted, retired, held by a session). */
export function pruneRunningLog(keep: ReadonlySet<string>): void {
  for (const id of [...loggedRunning.keys()]) if (!keep.has(id)) loggedRunning.delete(id);
}
/**
 * Log a state change once, AFTER the transaction that decided it committed (a rolled-back decision must not be
 * remembered): `already running` when first seen, `held a long time` once past LONG_HOLD_LOG_MS, and `starting` when a
 * start is issued for a worker last seen running.
 */
function noteOutcome(
  a: { appId: string; workerId: string; hostId: string },
  outcome: Awaited<ReturnType<typeof startDesiredWorker>>,
  now: Date,
): void {
  if (outcome === 'running') {
    const seen = loggedRunning.get(a.workerId);
    if (!seen) {
      loggedRunning.set(a.workerId, { since: now.getTime(), longHoldLogged: false });
      console.info('[desired-start] no start issued: a host already runs this worker\'s agent (already running)', a);
    } else if (!seen.longHoldLogged && now.getTime() - seen.since >= LONG_HOLD_LOG_MS) {
      seen.longHoldLogged = true;
      console.info('[desired-start] a host has run this worker\'s agent for a long time and no start was issued (held a long time)', { ...a, sinceMs: now.getTime() - seen.since });
    }
    return;
  }
  // `no-host` is this host having no usable registration: the pass goes on to the worker's next host, so the state is
  // kept and a start issued there is still logged as `starting` (#4941; it used to be forgotten here, unlogged).
  if (outcome === 'no-host') return;
  // Any other outcome ends the remembered state, so a later return to running is logged again.
  if (loggedRunning.delete(a.workerId) && outcome === 'issued') {
    console.info('[desired-start] starting a worker whose agent no host runs any more (starting)', a);
  }
}

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
  const startableNow = new Set<string>();
  let complete = true;
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
          complete = false;
        }
      }
    } catch (err) {
      // One App's host list failing skips that App only.
      console.error('[desired-start] listing an App\'s hosts failed:', { appId: app.id }, err);
      complete = false;
      continue;
    }
    for (const [workerId, hostIds] of candidates) {
      startableNow.add(workerId);
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
  // #4941: only after a pass that read every App and host, so a failed read never forgets a worker still held.
  if (complete) pruneRunningLog(startableNow);
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
 * inserted, `running` when the host already runs its agent (#4933), `tripped` when the failure limit stopped it,
 * `no-host` when this host has no live registration listing a
 * worktree for it (the caller tries the worker's next host), `skipped` otherwise.
 */
export async function startDesiredWorker(
  db: PrismaClient,
  a: { appId: string; workerId: string; hostId: string },
  now: Date,
  anchor: number = anchorNow(),
): Promise<'issued' | 'tripped' | 'skipped' | 'no-host' | 'running'> {
  try {
    const owner = await db.app.findUnique({ where: { id: a.appId }, select: { organizationId: true, ownerUserId: true } });
    const outcome = await db.$transaction(async (tx) => {
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
      // #4933: before the failure count, so a worker the host already runs is neither started nor tripped nor alarmed.
      const reported = asTerminal((await tx.worker.findUnique({ where: { id: a.workerId }, select: { terminal: true } }))?.terminal);
      if (agentRunsOnAnyHost(reported, now)) return 'running';
      if ((await recentFailures(tx, a.workerId, now)) >= START_FAILURE_LIMIT) return 'tripped';
      await fenceHostDecision(tx, a.appId);
      const reg = (await liveRegistrationsFor(tx, a.appId, a.workerId, now, a.hostId)).find((r) => r.worktrees.length > 0);
      if (!reg) return 'no-host';
      await insertWorkerStart(tx, {
        appId: a.appId, hostId: reg.hostId, workerId: a.workerId, worktree: reg.worktrees[0]!, family: reg.family,
        // #4267: the assignment's launcher profile (null under `host`), as the other start paths pass it; with it the
        // start also carries the Agent's lifecycle.
        profile: reg.profile,
        // #4291 (decision 7): a long-lived worker comes back with its last-used settings; the profile seeds an empty record.
        settings: await startSettingsFor(tx, a.workerId, null, reg),
        taskId: null, issuer: { issuedBy: 'platform' }, hold, issuedReason: DESIRED_RUNNING,
      });
      return 'issued';
    });
    noteOutcome(a, outcome, now);
    return outcome;
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
