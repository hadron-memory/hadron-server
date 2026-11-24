/**
 * #4531 — the dark-team episode, its alarm and its read (hrn:node:hadronmemory.com:specs:cor:agt:050:34, Proposed; the
 * incident of 2026-11-19, when a whole team sat idle for hours and nothing noticed). The stall evaluator's pass calls
 * `evaluateTeamDark` every minute (src/jobs/taskStallEvaluator.ts); `Query.teamHealth` reads {@link teamHealthView}.
 *
 * THE CONDITION, worked out from the platform's own state (due wakes, acknowledgements, session activity), never from the
 * deliverer's logs: the team is dark when, for longer than the window,
 *   (a) a COORDINATOR (by role, never by position: an App with no coordinator, or whose workers report to no one, is a valid
 *       team) has a wake due and unacknowledged, or has a live session that has shown no turn since it started or was
 *       relaunched; or
 *   (b) work is waiting (a queued task, or a wake due to any worker) while no worker of the App has been driven inside the
 *       window.
 *
 * OPEN QUESTIONS, NOT DECIDED HERE (the Rule's "Open Questions, Need Ruling"; the gate of 2026-11-20 says build the
 * recommended reading behind one named decision point): whether one silent NON-coordinator alone makes the team dark, and
 * whether a worker with no live session counts. The recommended reading is built: under (a) only a coordinator counts, a
 * coordinator with no live session still counts (it stays due), and a quiet non-coordinator reaches the team only through
 * (b). The one decision point is {@link countsUnderWakeCondition}; a ruling changes that function and nothing else.
 *
 * EXCEPTIONS (cor:agt:050:34): a retired worker; one that is never due a wake (paused, dormant, a stopped short-lived
 * worker: `computeDueWakes` already derives no wake for them); one a `pause` / `halt` stop signal or a team pause covers
 * (`EXEMPT_PENDING`); one mid-shed (a live, unconsumed, unrevoked, unexpired resume claim: a shed is not silence, and the
 * claim lasts 60 seconds, so a longer one counts again); and server downtime (every age and every start is floored at the
 * end of the last evaluator gap, cor:agt:050:32, as the other stall rules are).
 *
 * THE WINDOW is {@link TEAM_DARK_WINDOW_SECONDS}, 30 minutes, for every App. Whether each App may set its own, within what
 * bounds, and who sets it are open questions the gate holds for Holger, so this slice adds NO setter and NO column;
 * {@link teamDarkWindowSeconds} is the one seam a per-App value will go through. It is deliberately not the per-worker
 * `darkAlarmWindowSeconds`, which belongs to the separate dark-worker alarm (#2755).
 *
 * EPISODES. The alarm stream is append-only, so an episode's end lives in `team_dark_episodes`, whose partial unique index
 * admits one OPEN row per App. Opening writes the `team.dark` alarm in the same transaction, so two passes or two instances
 * record exactly one (S6): the loser's insert fails on the index and its transaction rolls back. Ending writes one
 * `team.recovered` event in the transaction that closes the episode, under a guard on the still-open row, so a second pass
 * records nothing more. The alarm holds counts and ages only (never message text), has an empty chain, wakes nobody and
 * cannot be acknowledged; nothing is sent to a human and no recovery is chosen.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { loadLastEventBySession, OPEN_SESSION_SCAN_CAP, sessionActivityAt, toNaiveUtc } from '../sessionActivity.js';
import { loadWorkerCheckStatuses } from '../workerCheckStatus.js';
import { activeInsideWindow, EXEMPT_PENDING, unackedWakeAges } from './darkWorker.js';
import { loadLastGapEnd } from './stallGap.js';
import { isSerializationFailure } from './serializationFailure.js';

export const TEAM_DARK_EVENT_TYPE = 'team.dark';
export const TEAM_RECOVERED_EVENT_TYPE = 'team.recovered';

/** cor:agt:050:34: the dark window, 30 minutes. One value for every App until the per-App setting is ruled. */
export const TEAM_DARK_WINDOW_SECONDS = 30 * 60;
/** The role that makes a worker a coordinator, matched in any case (Holger, 2026-10-31, decision 16). */
export const COORDINATOR_ROLE = 'coordinator';
/**
 * A session whose latest activity is no more than this after its start has shown no turn since: the start itself writes
 * `updatedAt` a few milliseconds after `startedAt`, and neither is a turn.
 */
const NO_TURN_TOLERANCE_MS = 5_000;

export type TeamDarkReason = 'wake-unacked' | 'no-turn' | 'work-waiting';

/** The one seam for a per-App window: today every App gets the default. */
export function teamDarkWindowSeconds(_app: { id: string }): number {
  return TEAM_DARK_WINDOW_SECONDS;
}

export const isCoordinatorRole = (role: string | null | undefined): boolean => (role ?? '').toLowerCase() === COORDINATOR_ROLE;

/**
 * THE DECISION POINT of the two open questions (see the file header): does a worker's due, unacknowledged wake make the
 * team dark under (a)? Recommended reading: only a coordinator's, whether or not it has a live session. A ruling that
 * non-coordinators count, or that a worker with no live session does not, changes this function and nothing else.
 */
export function countsUnderWakeCondition(worker: { role: string | null }, _hasLiveSession: boolean): boolean {
  return isCoordinatorRole(worker.role);
}

export type TeamHealthWorker = { workerId: string; role: string | null; oldestWakeAgeSeconds: number | null };
export type TeamDarkState = {
  /** The condition holds now. */
  dark: boolean;
  reason: TeamDarkReason | null;
  windowSeconds: number;
  workers: TeamHealthWorker[];
  /** The workers whose own state makes the team dark under (a). */
  darkWorkerIds: string[];
  /** Under (b): how long the oldest waiting work has waited, in seconds; null when nothing waits. */
  waitingSeconds: number | null;
};
/** What a `team.dark` alarm carries: counts and ages, never text or a worker's words. */
export type TeamDarkEvidence = {
  reason: TeamDarkReason;
  workerCount: number;
  darkWorkerCount: number;
  oldestWakeAgeSeconds: number | null;
  waitingSeconds: number | null;
  windowSeconds: number;
};

type AppRow = { id: string; organizationId: string | null; ownerUserId: string | null };

/** The workers among `workerIds` holding a live, unconsumed, unrevoked, unexpired resume claim at `now`: mid-shed. */
async function midShedWorkers(db: PrismaClient, workerIds: string[], now: Date): Promise<Set<string>> {
  if (workerIds.length === 0) return new Set();
  const claims = await db.resumeClaim.findMany({
    where: { workerId: { in: workerIds }, consumedAt: null, revokedAt: null, expiresAt: { gt: now } },
    select: { workerId: true },
  });
  return new Set(claims.map((c) => c.workerId));
}

/**
 * The newest open session of each worker. NOT narrowed by the idle window: a coordinator whose session has shown no turn
 * for longer than that window is exactly the case (a) names, and dropping it would end its episode as a recovery.
 * Bounded to the newest {@link OPEN_SESSION_SCAN_CAP} rows per worker.
 * Each carries its start and its latest activity (the platform's one derivation). */
async function liveSessionActivity(db: PrismaClient, workerIds: string[], now: Date): Promise<Map<string, { startedAt: Date; activityAt: Date }>> {
  const out = new Map<string, { startedAt: Date; activityAt: Date }>();
  if (workerIds.length === 0) return out;
  const sessions = await db.session.findMany({
    where: { workerId: { in: workerIds }, endedAt: null, deletedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true, workerId: true, type: true, startedAt: true, updatedAt: true, autoExpiredAt: true, endedAt: true, expiresAt: true },
    orderBy: { startedAt: 'desc' },
    take: OPEN_SESSION_SCAN_CAP * workerIds.length,
  });
  const lastEvents = await loadLastEventBySession(db as never, sessions.map((s) => s.id));
  for (const s of sessions) {
    if (!s.workerId) continue;
    const have = out.get(s.workerId);
    if (have && have.startedAt.getTime() >= s.startedAt.getTime()) continue;
    out.set(s.workerId, { startedAt: s.startedAt, activityAt: sessionActivityAt(s, lastEvents.get(s.id)) });
  }
  return out;
}

/** The age in seconds of the oldest queued task (pending, not blocked, no assignee: the matcher's own queue), counted from its queueing and floored. */
async function oldestQueuedSeconds(db: PrismaClient, appId: string, floorAt: Date | null, now: Date): Promise<number | null> {
  const [row] = await db.$queryRaw<{ since: Date | null }[]>`
    SELECT min(GREATEST(COALESCE(released_at, created_at), created_at)) AS since
    FROM agent_tasks
    WHERE app_id = ${appId} AND status = 'pending' AND blocked = false AND assignee_worker_id IS NULL AND assignee_user_id IS NULL`;
  if (!row?.since) return null;
  const since = Math.max(new Date(row.since).getTime(), floorAt?.getTime() ?? -Infinity);
  return Math.max(0, Math.floor((now.getTime() - since) / 1000));
}

/**
 * Whether one App's team is dark at `now`, with the evidence. Read-only: it writes nothing, so the read door and the
 * evaluator share one derivation.
 */
export async function teamDarkOf(db: PrismaClient, app: AppRow, now: Date): Promise<TeamDarkState> {
  const windowSeconds = teamDarkWindowSeconds(app);
  const workers = await db.worker.findMany({ where: { appId: app.id, retiredAt: null }, select: { id: true, role: true }, orderBy: { id: 'asc' } });
  const base: TeamDarkState = { dark: false, reason: null, windowSeconds, workers: workers.map((w) => ({ workerId: w.id, role: w.role, oldestWakeAgeSeconds: null })), darkWorkerIds: [], waitingSeconds: null };
  if (workers.length === 0) return base;
  const ids = workers.map((w) => w.id);
  const gapEnd = await loadLastGapEnd(db);
  // Dynamic: resolvers.teamChat imports modules that import this one.
  const { locateTeamChatChannelOfApp } = await import('../../api/graphql/schema/resolvers.teamChat.js');
  const channel = await locateTeamChatChannelOfApp(db, app.id);
  const statuses = await loadWorkerCheckStatuses(db, { appId: app.id, teamChannelId: channel?.channelId ?? null, workerIds: ids, now });
  const shed = await midShedWorkers(db, ids, now);
  const counted = workers.filter((w) => {
    const st = statuses.get(w.id);
    if (!st || shed.has(w.id)) return false;
    return !(st.status === 'PENDING' && st.pendingReason && EXEMPT_PENDING.has(st.pendingReason));
  });
  const countedIds = new Set(counted.map((w) => w.id));
  // Every age, however small: the window is applied below, and teamHealth shows each worker's own age.
  const ages = await unackedWakeAges(db, app, new Map(counted.map((w) => [w.id, statuses.get(w.id)?.resumedAt ?? null])), -1, now, gapEnd);
  const activity = await liveSessionActivity(db, ids, now);

  const darkWorkerIds: string[] = [];
  let reason: TeamDarkReason | null = null;
  for (const w of counted) {
    const hasLive = activity.has(w.id);
    const age = ages.get(w.id) ?? null;
    if (countsUnderWakeCondition(w, hasLive) && age !== null && age > windowSeconds) {
      darkWorkerIds.push(w.id);
      reason ??= 'wake-unacked';
      continue;
    }
    // A coordinator whose live session has shown no turn since it started or was relaunched is dark on its own account.
    const live = activity.get(w.id);
    if (isCoordinatorRole(w.role) && live && live.activityAt.getTime() - live.startedAt.getTime() <= NO_TURN_TOLERANCE_MS) {
      const from = Math.max(live.startedAt.getTime(), statuses.get(w.id)?.resumedAt?.getTime() ?? -Infinity, gapEnd?.getTime() ?? -Infinity);
      if ((now.getTime() - from) / 1000 > windowSeconds) {
        darkWorkerIds.push(w.id);
        reason ??= 'no-turn';
      }
    }
  }

  // (b): work waiting while no worker of the App has been driven inside the window.
  const queued = await oldestQueuedSeconds(db, app.id, gapEnd, now);
  const wakeWaiting = [...ages].filter(([id]) => countedIds.has(id)).map(([, a]) => a);
  const waits = [...wakeWaiting, ...(queued === null ? [] : [queued])];
  const waitingSeconds = waits.length ? Math.max(...waits) : null;
  if (reason === null && waitingSeconds !== null && waitingSeconds > windowSeconds) {
    if ((await activeInsideWindow(db, ids, windowSeconds, now)).size === 0) reason = 'work-waiting';
  }

  return {
    dark: reason !== null,
    reason,
    windowSeconds,
    workers: workers.map((w) => ({ workerId: w.id, role: w.role, oldestWakeAgeSeconds: ages.get(w.id) ?? null })),
    darkWorkerIds,
    waitingSeconds,
  };
}

/** The evidence a state's alarm carries: counts and ages only. */
export function evidenceOf(state: TeamDarkState): TeamDarkEvidence {
  if (state.reason === null) throw new Error('evidenceOf: the team is not dark');
  const ages = state.workers.map((w) => w.oldestWakeAgeSeconds).filter((a): a is number => a !== null);
  return {
    reason: state.reason,
    workerCount: state.workers.length,
    darkWorkerCount: state.darkWorkerIds.length,
    oldestWakeAgeSeconds: ages.length ? Math.max(...ages) : null,
    waitingSeconds: state.waitingSeconds,
    windowSeconds: state.windowSeconds,
  };
}

/**
 * Open the App's episode and raise its `team.dark` alarm, in one transaction. Null when the App already has an open
 * episode (the unique index decides a race) or is no longer installed. Exported for the race pin.
 */
export async function raiseTeamDark(db: PrismaClient, appId: string, evidence: TeamDarkEvidence, now: Date): Promise<string | null> {
  try {
    return await db.$transaction(async (tx): Promise<string | null> => {
      // #3774's fence: uninstallApp / deleteApp hold `apps FOR UPDATE`, so this waits for one in flight and sees its commit.
      const live = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM apps WHERE id = ${appId} AND deleted_at IS NULL AND uninstalled_at IS NULL FOR SHARE`;
      if (live.length === 0) return null;
      const eventId = generateId();
      const payload: Prisma.InputJsonObject = {
        reason: evidence.reason,
        windowMinutes: evidence.windowSeconds / 60,
        workerCount: evidence.workerCount,
        darkWorkerCount: evidence.darkWorkerCount,
        oldestWakeAgeSeconds: evidence.oldestWakeAgeSeconds,
        waitingSeconds: evidence.waitingSeconds,
      };
      // No task, no subject worker, an empty chain: it wakes nobody and is routed to no owner (cor:agt:050:34).
      await tx.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
        VALUES (${eventId}, ${appId}, ${TEAM_DARK_EVENT_TYPE}, NULL, NULL, 'alarm', '[]'::jsonb,
                ${JSON.stringify(payload)}::jsonb, ${toNaiveUtc(now)}::timestamp, NULL)`;
      // The one-open-episode-per-App index decides a race: the loser's insert fails and this transaction rolls back.
      await tx.teamDarkEpisode.create({ data: { appId, eventId, openedAt: now } });
      return eventId;
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (err) {
    if (isSerializationFailure(err)) return null;
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null; // another pass opened it
    throw err;
  }
}

class EpisodeAlreadyEnded extends Error {}

/**
 * End the open episode `episodeId` and record its one `team.recovered`, in one transaction. The close is a guarded update
 * on the still-open row, and the event is written first inside the same transaction, so a pass that lost the race rolls
 * its event back: exactly one `team.recovered` per episode. Null when another pass already ended it.
 */
export async function recoverTeamDark(db: PrismaClient, appId: string, episodeId: string, openedAt: Date, evidence: Pick<TeamDarkEvidence, 'workerCount'>, now: Date): Promise<string | null> {
  try {
    return await db.$transaction(async (tx): Promise<string | null> => {
      const eventId = generateId();
      // Never before the open: another instance's clock may run behind, and the row's CHECK needs ended >= opened.
      const endedAt = openedAt > now ? openedAt : now;
      await tx.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
        VALUES (${eventId}, ${appId}, ${TEAM_RECOVERED_EVENT_TYPE}, NULL, NULL, NULL, NULL,
                ${JSON.stringify({ workerCount: evidence.workerCount, darkSeconds: Math.max(0, Math.floor((endedAt.getTime() - openedAt.getTime()) / 1000)) })}::jsonb,
                ${toNaiveUtc(endedAt)}::timestamp, NULL)`;
      const { count } = await tx.teamDarkEpisode.updateMany({ where: { id: episodeId, endedAt: null }, data: { endedAt, recoveredEventId: eventId } });
      if (count === 0) throw new EpisodeAlreadyEnded();
      return eventId;
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (err) {
    if (err instanceof EpisodeAlreadyEnded) return null;
    if (isSerializationFailure(err)) return null;
    throw err;
  }
}

/**
 * One pass: end the open episode of each App whose team is no longer dark (one `team.recovered`), and open one (with its
 * alarm) for each App whose team is dark and has none. Returns the ids of the alarms this pass raised.
 */
export async function evaluateTeamDark(db: PrismaClient, now = new Date()): Promise<string[]> {
  const raised: string[] = [];
  // An App gone from the live set has no team left to be dark: its open episodes end (no recovery is recorded for a team
  // that was deleted rather than cured).
  await db.$executeRaw`
    UPDATE team_dark_episodes e SET ended_at = GREATEST(e.opened_at, ${toNaiveUtc(now)}::timestamp)
    WHERE e.ended_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM apps a WHERE a.id = e.app_id AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL)`;
  const apps = await db.app.findMany({
    where: { deletedAt: null, uninstalledAt: null, OR: [{ workers: { some: { retiredAt: null } } }, { teamDarkEpisodes: { some: { endedAt: null } } }] },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  for (const app of apps) {
    try {
      // Read BEFORE deriving (darkWorker.ts's order): a pass can end only an episode that existed when its derivation
      // began, so one a concurrent pass opened since, on a newer snapshot, is left to that pass's successors.
      const open = await db.teamDarkEpisode.findFirst({ where: { appId: app.id, endedAt: null }, select: { id: true, openedAt: true } });
      const state = await teamDarkOf(db, app, now);
      if (open && !state.dark) {
        await recoverTeamDark(db, app.id, open.id, open.openedAt, { workerCount: state.workers.length }, now);
      } else if (!open && state.dark) {
        const id = await raiseTeamDark(db, app.id, evidenceOf(state), now);
        if (id) raised.push(id);
      }
    } catch (err) {
      console.error(`[team-dark] evaluating App ${app.id} failed:`, err);
    }
  }
  return raised;
}

/**
 * `Query.teamHealth` (cor:agt:050:34): whether the team is dark (an open episode), the episode's start, and for each
 * worker the age of its oldest unacknowledged wake. The caller's right to read is the resolver's gate, not this function's.
 */
export async function teamHealthView(db: PrismaClient, app: AppRow, now = new Date()) {
  const [open, state] = await Promise.all([
    db.teamDarkEpisode.findFirst({ where: { appId: app.id, endedAt: null }, select: { openedAt: true } }),
    teamDarkOf(db, app, now),
  ]);
  return { appId: app.id, dark: open !== null, episodeStart: open?.openedAt ?? null, windowSeconds: state.windowSeconds, workers: state.workers };
}
