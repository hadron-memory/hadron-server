/**
 * #2755 — the dark-worker alarm (cor:agt:100:06, Proposed; the deferred "alarm on OVERDUE" of cor:agt:100:03).
 *
 * A worker goes dark when its check status is OVERDUE, or when a wake due to it has gone unacknowledged for longer
 * than the App's `darkAlarmWindowSeconds`. Then the platform raises ONE task-less alarm for it per episode, across
 * both reasons, and tells its reporting line, nearest first. The stall evaluator's pass calls `evaluateDarkWorkers`.
 *
 * EPISODES. The alarm stream is append-only (a trigger), so the end of an episode cannot be written on the alarm:
 * it lives in `dark_worker_episodes`, whose partial unique index admits one OPEN row per worker. An episode opens on
 * the first pass that sees either condition and ends on the first pass that sees both cleared, so a worker that
 * checks again but still has an unacknowledged wake stays in its episode (no second alarm). Two passes, or two
 * instances, race for the one open row: the loser's transaction rolls back and raises nothing.
 *
 * EXCEPTIONS (cor:agt:050:26's, kept): a worker with no live session (NO_SESSION), a retired worker, a worker of a
 * dead App, and one that is PENDING because its team is paused, it is paused, isolated, on standby, or stopped
 * (a `pause` / `halt` stop signal). `NO_TASK` exempts the OVERDUE trigger by itself (such a worker is never OVERDUE)
 * and does NOT exempt the unacknowledged-wake trigger.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { appManagerUserIds } from '../auth/appManagement.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { loadWorkerCheckStatuses, type WorkerCheckStatus } from '../workerCheckStatus.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { computeDueWakes } from '../tickers/dueWakes.js';
import type { AlarmChain } from './events.js';
import { isSerializationFailure } from './stall.js';

export const DARK_WORKER_EVENT_TYPE = 'alarm.dark-worker';
export type DarkReason = 'overdue' | 'wake-unacked';

/** The PENDING reasons that exempt a worker from every trigger (`NO_TASK` is not one of them). */
const EXEMPT_PENDING = new Set(['TEAM_PAUSED', 'PAUSED', 'ISOLATED', 'STANDBY', 'STOPPED']);

type DarkWorker = { workerId: string; reason: DarkReason; status: WorkerCheckStatus; oldestWakeAgeSeconds: number | null };

/**
 * The workers of one App that are dark now, with the reason that would open an episode (OVERDUE first), and the
 * evidence: the last check and the age of the oldest wake left unacknowledged past the window.
 */
async function darkWorkersOf(
  db: PrismaClient,
  app: { id: string; organizationId: string | null; ownerUserId: string | null; deliveryDarkAlarmWindowSeconds: number },
  now: Date,
): Promise<Map<string, DarkWorker>> {
  const workers = await db.worker.findMany({ where: { appId: app.id, retiredAt: null }, select: { id: true } });
  const out = new Map<string, DarkWorker>();
  if (workers.length === 0) return out;
  // Dynamic: resolvers.teamChat imports modules that import this one.
  const { locateTeamChatChannel } = await import('../../api/graphql/schema/resolvers.teamChat.js');
  const channel = await locateTeamChatChannel({ db } as Context, app.id);
  const statuses = await loadWorkerCheckStatuses(db, { appId: app.id, teamChannelId: channel?.channelId ?? null, workerIds: workers.map((w) => w.id), now });
  const eligible = new Map<string, WorkerCheckStatus>();
  for (const [workerId, status] of statuses) {
    if (status.status === 'NO_SESSION') continue;
    if (status.status === 'PENDING' && status.pendingReason && EXEMPT_PENDING.has(status.pendingReason)) continue;
    eligible.set(workerId, status);
  }
  if (eligible.size === 0) return out;
  const wakeAges = await unackedWakeAges(db, app, new Map([...eligible].map(([id, s]) => [id, s.resumedAt])), app.deliveryDarkAlarmWindowSeconds, now);
  for (const [workerId, status] of eligible) {
    const oldestWakeAgeSeconds = wakeAges.get(workerId) ?? null;
    if (status.status === 'OVERDUE') out.set(workerId, { workerId, reason: 'overdue', status, oldestWakeAgeSeconds });
    else if (oldestWakeAgeSeconds !== null) out.set(workerId, { workerId, reason: 'wake-unacked', status, oldestWakeAgeSeconds });
  }
  return out;
}

/**
 * The age, in seconds, of each worker's oldest due wake, for the workers whose wake is older than `windowSeconds`. Time
 * before a worker's `resumedAt` (a pause, team pause or stop that ended, or a new session) is exempt and never counts:
 * the age runs from the later of the wake's anchor and that moment, so a worker that comes back is not alarmed at once. A READ-ONLY
 * preview of `computeDueWakes` as a manager of the App (the wake derivation is not duplicated here), so nothing is
 * reserved or charged. A wake is "due and unacknowledged" for as long as it is still derived: an acknowledgement moves
 * the marks that make it due. Only the wake's own anchor counts, never the delivery floor or the batching window.
 */
async function unackedWakeAges(db: PrismaClient, app: { id: string; organizationId: string | null; ownerUserId: string | null }, resumedAtOf: Map<string, Date | null>, windowSeconds: number, now: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let after: string | null = null;
  for (;;) {
    const page = await computeDueWakes({
      ctx: { db, roles: [] } as unknown as Context,
      app,
      reader: { manager: true, userId: null },
      requester: { userId: 'platform' },
      first: 200,
      after,
      now,
      preview: true,
    });
    for (const wake of page.wakes) {
      if (!resumedAtOf.has(wake.workerId)) continue;
      const startedAt = Math.max(wake.timing.anchorAt.getTime(), resumedAtOf.get(wake.workerId)?.getTime() ?? -Infinity);
      const ageSeconds = Math.floor((now.getTime() - startedAt) / 1000);
      if (ageSeconds > windowSeconds) out.set(wake.workerId, Math.max(ageSeconds, out.get(wake.workerId) ?? 0));
    }
    if (!page.nextAfter) return out;
    after = page.nextAfter;
  }
}

/** The worker's reporting line, nearest first (cycle-safe, same App, retired workers skipped), then whoever manages the App. */
export async function darkAlarmChain(db: Prisma.TransactionClient | PrismaClient, app: { id: string; organizationId: string | null; ownerUserId: string | null }, workerId: string): Promise<AlarmChain> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE up AS (
      SELECT w.reports_to_worker_id AS id, 1 AS depth FROM workers w WHERE w.id = ${workerId} AND w.reports_to_worker_id IS NOT NULL
      UNION ALL
      SELECT w.reports_to_worker_id, up.depth + 1 FROM workers w JOIN up ON w.id = up.id
      WHERE w.reports_to_worker_id IS NOT NULL AND up.depth < 64
    )
    SELECT up.id FROM up JOIN workers h ON h.id = up.id AND h.app_id = ${app.id} AND h.retired_at IS NULL ORDER BY up.depth`;
  const chain: AlarmChain = [];
  const seen = new Set<string>([workerId]);
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    chain.push({ workerId: r.id });
  }
  for (const userId of await appManagerUserIds(db, app)) chain.push({ userId, via: 'manager' });
  return chain;
}

const partyJson = (p: AlarmChain[number]): Prisma.InputJsonObject =>
  p.workerId ? { workerId: p.workerId } : { userId: p.userId as string, ...(p.via ? { via: p.via } : {}) };

/** Open one episode and raise its alarm, in one transaction. Null when the worker already has an open episode. */
async function raise(db: PrismaClient, app: { id: string; organizationId: string | null; ownerUserId: string | null }, dark: DarkWorker, windowMs: number, now: Date): Promise<string | null> {
  try {
    return await db.$transaction(async (tx) => {
      const chain = await darkAlarmChain(tx, app, dark.workerId);
      const eventId = generateId();
      const payload: Prisma.InputJsonObject = {
        reason: dark.reason,
        windowMinutes: windowMs / 60_000,
        lastCheckedAt: dark.status.lastCheckedAt ? dark.status.lastCheckedAt.toISOString() : null,
        oldestWakeAgeSeconds: dark.oldestWakeAgeSeconds,
      };
      await tx.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
        VALUES (${eventId}, ${app.id}, ${DARK_WORKER_EVENT_TYPE}, NULL, ${dark.workerId}, 'alarm', ${JSON.stringify(chain.map(partyJson))}::jsonb,
                ${JSON.stringify(payload)}::jsonb, ${toNaiveUtc(now)}::timestamp, NULL)`;
      // The one-open-episode-per-worker index decides a race: the loser's insert fails and this transaction rolls back.
      await tx.darkWorkerEpisode.create({ data: { appId: app.id, workerId: dark.workerId, eventId, reason: dark.reason, openedAt: now } });
      // cor:agt:050:19 — the nearest owner is woken now; owner i falls due i windows later, unless acknowledged first.
      await tx.agentTeamAlarmSchedule.createMany({
        data: chain.map((_, i) => ({ eventId, chainIndex: i, dueAt: new Date(now.getTime() + i * windowMs), wokenAt: i === 0 ? now : null })),
      });
      return eventId;
      // SERIALIZABLE like `raiseStallAlarm`: the chain names manager users, sealed, and `mergeUsers` refuses to merge an
      // account named in an open alarm. A raise racing a merge is a read-write cycle Postgres aborts on one side.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (err) {
    if (isSerializationFailure(err)) return null; // lost a race (another pass, or a merge): the next pass decides again
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null; // another pass opened it
    throw err;
  }
}

const REASON_WORDS: Record<string, string> = { overdue: 'overdue', 'wake-unacked': 'wake unacknowledged' };

/**
 * The platform's ONE team-channel post per episode (H2, held on Holger): it names the worker and the reason and nothing
 * else, and it carries no mention. The evidence stays on the alarm. The post is claimed in the append's own transaction
 * (`notice_posted_at`, set once), so two passes post once; an open episode whose post failed or found no live chat is
 * retried on the next pass. An episode that has ended never posts late.
 */
async function postEpisodeNotices(db: PrismaClient, appId: string, now: Date): Promise<void> {
  const open = await db.darkWorkerEpisode.findMany({
    where: { appId, endedAt: null, noticePostedAt: null },
    select: { id: true, reason: true, worker: { select: { name: true } } },
  });
  if (open.length === 0) return;
  // Lazy: resolvers.teamChat imports a long chain of resolvers.
  const { postSystemNotice } = await import('../../api/graphql/schema/resolvers.teamChat.js');
  for (const e of open) {
    try {
      await postSystemNotice(db, appId, `${e.worker.name} has gone dark (${REASON_WORDS[e.reason] ?? e.reason}).`, async (tx) =>
        (await tx.darkWorkerEpisode.updateMany({ where: { id: e.id, endedAt: null, noticePostedAt: null }, data: { noticePostedAt: now } })).count > 0);
    } catch (err) {
      console.error(`[dark-worker] posting the notice for episode ${e.id} failed:`, err);
    }
  }
}

/**
 * One pass: end the open episodes whose conditions have cleared, and open one for each dark worker that has none.
 * Returns the ids of the alarms this pass raised.
 */
export async function evaluateDarkWorkers(db: PrismaClient, now = new Date()): Promise<string[]> {
  const raised: string[] = [];
  const apps = await db.app.findMany({
    where: { deletedAt: null, uninstalledAt: null },
    select: { id: true, organizationId: true, ownerUserId: true, deliveryDarkAlarmWindowSeconds: true },
  });
  for (const app of apps) {
    try {
      // The open episodes are read BEFORE the conditions are derived. Read after, a pass that derived "clear" could meet an
      // episode a concurrent pass opened since, and end it on its older snapshot; read before, it can end only an episode
      // that existed when its own derivation began, so a newer one is left to the pass that opened it.
      const open = await db.darkWorkerEpisode.findMany({ where: { appId: app.id, endedAt: null }, select: { id: true, workerId: true, openedAt: true } });
      const dark = await darkWorkersOf(db, app, now);
      const openWorkers = new Set(open.map((e) => e.workerId));
      // One worker's failure (a fence or CHECK refusal, say) must not stop the App's other workers or its notices.
      for (const e of open) {
        if (dark.has(e.workerId)) continue;
        try {
          // Never before the open: another instance's clock may run behind, and the row's CHECK needs ended >= opened.
          const endedAt = e.openedAt > now ? e.openedAt : now;
          await db.darkWorkerEpisode.updateMany({ where: { id: e.id, endedAt: null }, data: { endedAt } });
        } catch (err) {
          console.error(`[dark-worker] ending episode ${e.id} failed:`, err);
        }
      }
      for (const d of dark.values()) {
        if (openWorkers.has(d.workerId)) continue;
        try {
          const id = await raise(db, app, d, app.deliveryDarkAlarmWindowSeconds * 1000, now);
          if (id) raised.push(id);
        } catch (err) {
          console.error(`[dark-worker] raising the alarm for worker ${d.workerId} failed:`, err);
        }
      }
      await postEpisodeNotices(db, app.id, now);
    } catch (err) {
      console.error(`[dark-worker] evaluating App ${app.id} failed:`, err);
    }
  }
  return raised;
}

/** The evidence a dark-worker alarm carries beyond its reason: shown only to a reader of the worker's internals. */
const EVIDENCE_KEYS = ['lastCheckedAt', 'oldestWakeAgeSeconds'] as const;

/**
 * An event's payload as one reader may see it. Every event but a dark-worker alarm is returned as written; a
 * dark-worker alarm keeps its `reason` and window for everyone who may read the alarm, and its evidence (the last
 * check, the oldest unacknowledged wake's age) only for a reader of the worker's internals (cor:agt:100:06, Proposed).
 */
export async function eventPayloadFor(
  e: { type: string; appId: string; payload: unknown },
  ctx: Context,
): Promise<unknown> {
  if (e.type !== DARK_WORKER_EVENT_TYPE || !e.payload || typeof e.payload !== 'object') return e.payload;
  // Lazy: resolvers.worker imports a long chain of resolvers.
  const { maySeeWorkerInternals } = await import('../../api/graphql/schema/resolvers.worker.js');
  if (await maySeeWorkerInternals(ctx, e.appId)) return e.payload;
  const rest: Record<string, unknown> = { ...(e.payload as Record<string, unknown>) };
  for (const k of EVIDENCE_KEYS) delete rest[k];
  return rest;
}
