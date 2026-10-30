/**
 * #2014 — the post-limit alarm: the first refusal of a worker's team-chat post by the rate limit in an hour raises ONE
 * `alarm.post-limit`, task-less, on the seam #2755's dark-worker alarm built (event, chain, wake schedule).
 *
 * The episode (`post_limit_episodes`) only de-duplicates: the alarm itself stays open and keeps escalating until
 * acknowledged. It is read and written on the DATABASE clock, under the worker's admission lock (the one that counted the
 * posts), in its own transaction that COMMITS although the post is refused: a refusal must never roll its own alarm back.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { lockWorkerPostAdmission } from '../teamChatAdmission.js';
import { darkAlarmChain } from './darkWorker.js';
import type { AlarmChain } from './events.js';
import { isSerializationFailure } from './stall.js';

export const POST_LIMIT_EVENT_TYPE = 'alarm.post-limit';
const MAX_ATTEMPTS = 5;

const partyJson = (p: AlarmChain[number]): Prisma.InputJsonObject =>
  p.workerId ? { workerId: p.workerId } : { userId: p.userId as string, ...(p.via ? { via: p.via } : {}) };

/**
 * Raise the alarm for a refusal of `workerId`'s post, unless this hour already has one. Returns the new alarm's id, or
 * null (an episode is open, the worker or App is exempt, or a concurrent refusal raised it first).
 */
export async function raisePostLimitAlarm(db: PrismaClient, workerId: string, limit: string): Promise<string | null> {
  // A serialization failure or unique race means a competing transaction touched the same rows, which proves nothing about
  // whether it committed THIS hour's alarm: run again. The rerun sees the committed episode (and raises nothing) or finds
  // none and raises. When the retries run out, the failure propagates unless a committed open episode proves the alarm exists.
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptRaise(db, workerId, limit);
    } catch (err) {
      const raced = isSerializationFailure(err) || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002');
      if (!raced) throw err;
      if (attempt >= MAX_ATTEMPTS) {
        // Out of retries: only a COMMITTED, fresh open episode proves an alarm exists for this hour. Without one, the failure is
        // propagated (the post stays refused and unstored, and the caller sees an error, never a refusal with no alarm).
        // Fresh means opened within the hour on the DATABASE clock: a stale open episode is no proof this refusal has an alarm.
        const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM post_limit_episodes
          WHERE worker_id = ${workerId} AND ended_at IS NULL AND opened_at + interval '1 hour' > (clock_timestamp() AT TIME ZONE 'UTC')`;
        if (n > 0n) return null;
        console.error(JSON.stringify({ event: 'post_limit.alarm_not_raised', workerId, attempts: attempt }));
        throw err;
      }
    }
  }
}

async function attemptRaise(db: PrismaClient, workerId: string, limit: string): Promise<string | null> {
  return await db.$transaction(async (tx) => {
      await lockWorkerPostAdmission(tx, workerId);
      const w = await tx.worker.findUnique({
        where: { id: workerId },
        select: { id: true, name: true, appId: true, retiredAt: true, app: { select: { id: true, organizationId: true, ownerUserId: true, deletedAt: true, uninstalledAt: true, deliveryDarkAlarmWindowSeconds: true } } },
      });
      // The dark-worker alarm's exemptions: a retired worker, a dead or soft-deleted App (and its deleted Organization).
      if (!w || w.retiredAt || w.app.deletedAt || w.app.uninstalledAt) return null;
      if (w.app.organizationId) {
        const org = await tx.organization.findUnique({ where: { id: w.app.organizationId }, select: { deletedAt: true } });
        if (org?.deletedAt) return null;
      }
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT (clock_timestamp() AT TIME ZONE 'UTC') AS now`;
      const at = toNaiveUtc(now);
      // An open episode older than an hour is over: closed an hour after it opened, never later.
      await tx.$executeRaw`
        UPDATE post_limit_episodes SET ended_at = opened_at + interval '1 hour'
        WHERE worker_id = ${workerId} AND ended_at IS NULL AND opened_at + interval '1 hour' <= ${at}::timestamp`;
      const chain = await darkAlarmChain(tx, w.app, workerId);
      const eventId = generateId();
      const payload: Prisma.InputJsonObject = { limit };
      await tx.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
        VALUES (${eventId}, ${w.appId}, ${POST_LIMIT_EVENT_TYPE}, NULL, ${workerId}, 'alarm', ${JSON.stringify(chain.map(partyJson))}::jsonb,
                ${JSON.stringify(payload)}::jsonb, ${at}::timestamp, NULL)`;
      // The partial unique index decides: a row exists only when no open episode did.
      const opened = await tx.$executeRaw`
        INSERT INTO post_limit_episodes (id, app_id, worker_id, event_id, opened_at)
        VALUES (${generateId()}, ${w.appId}, ${workerId}, ${eventId}, ${at}::timestamp)
        ON CONFLICT DO NOTHING`;
      if (opened === 0) {
        await tx.$executeRaw`DELETE FROM agent_team_events WHERE id = ${eventId}`;
        return null;
      }
      // cor:agt:050:19 — the nearest owner is woken now; owner i falls due i windows later, unless acknowledged first.
      const windowMs = w.app.deliveryDarkAlarmWindowSeconds * 1000;
      await tx.agentTeamAlarmSchedule.createMany({
        data: chain.map((_, i) => ({ eventId, chainIndex: i, dueAt: new Date(now.getTime() + i * windowMs), wokenAt: i === 0 ? now : null })),
      });
      return eventId;
      // SERIALIZABLE like the dark-worker alarm: the chain names manager users, sealed, and `mergeUsers` refuses to merge an
      // account named in an open alarm.
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
