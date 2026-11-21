/**
 * #3819 slice 1 — the saturation episode and its alarm (hrn:node:hadronmemory.com:specs:cor:agt:060:14, :15; Proposed,
 * Vera V37-V51). The stall evaluator's pass calls `evaluateSaturation` every minute (src/jobs/taskStallEvaluator.ts).
 *
 * SATURATED (:15), windowless, per App and (family, tier, role) combination:
 *   (a) the combination's latest decided match outcome is no worker and under 168 hours old, judged by its decision time
 *       on the database clock (`agent_match_outcomes`, #3825); or
 *   (b) the combination has at least one worker that is not retired and none eligible (every one marked unavailable, or
 *       its family paused: V42). Eligibility is `groupWorkerCombinations`, the predicate the utilization read uses.
 * The read's window does not apply: an outcome outside a 24-hour read still holds the episode open (:15, "not saturated as
 * a utilization read shows it").
 *
 * EPISODES. The alarm stream is append-only, so an episode's end lives in `saturation_episodes`, whose partial unique index
 * admits one OPEN row per (App, combination). A pass ends every open episode whose combination is no longer saturated
 * (a match recorded against it, an eligible worker gained while the latest outcome is not no worker, the no-worker outcome
 * reaching 168 hours whether or not the matcher purged its row, its last worker retired), then opens one for each saturated
 * combination that has none. Opening writes the alarm in the same transaction, so two passes or two instances record
 * exactly one (:14 S5): the loser's insert fails on the index and its transaction rolls back.
 *
 * THE ALARM (:14). One App-owned `alarm.saturation` event per episode: no task, no subject worker, an EMPTY chain. There is
 * no wake in slice 1 (the App's wake-roles list and its wake are #4777); with an empty chain nobody is woken (:16 S1) and the
 * alarm stays readable by the roster audience (cor:agt:050:21, :23). Its acknowledgement is the shared `acknowledgeAlarm`:
 * with no chain only whoever manages the App may (cor:agt:050:24), and it records who and when and nothing else (:16). It
 * is deliberately absent from `alarmEpisodeEnds` and `recordEndedEscalations` (stall.ts), so no AlarmEscalationEnd is ever
 * recorded for it: an escalation end is the end of a chain's climb, and this alarm has no chain.
 *
 * The evaluator is the only writer of episodes in slice 1: the match path does not open or close them (a match is seen
 * within one pass). Episode times are the pass's `now`; outcome age is the database clock.
 */

import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { generateId } from '../id.js';
import { toNaiveUtc } from '../sessionActivity.js';
import { loadWorkerWorkStates } from './matcher.js';
import { MATCH_OUTCOME_RETENTION_HOURS } from './matchOutcomes.js';
import { combinationKey, groupWorkerCombinations } from './utilization.js';
import { isSerializationFailure } from './serializationFailure.js';

export const SATURATION_EVENT_TYPE = 'alarm.saturation';
/** Which condition opened the episode: (a) a current no-worker outcome, or (b) workers and none eligible. */
export type SaturationReason = 'no-worker' | 'none-eligible';
/** A combination; `null` is a dimension left open (stored as '' on the episode, like `agent_match_outcomes`). */
export type SaturationCombination = { family: string | null; tier: string | null; role: string | null };

/** The episode hours: an outcome this old or older no longer saturates (the retention of the outcome record). */
const EPISODE_HOURS = MATCH_OUTCOME_RETENTION_HOURS;

/**
 * The combinations of one App whose latest outcome is no worker and under 168 hours old, on the database clock. Strictly
 * under: an outcome exactly 168 hours old has reached the end.
 */
async function currentNoWorkerOutcomes(db: PrismaClient | Prisma.TransactionClient, appId: string, only?: SaturationCombination): Promise<SaturationCombination[]> {
  const rows = await db.$queryRaw<{ family: string; tier: string; role: string }[]>(Prisma.sql`
    SELECT family, tier, role FROM agent_match_outcomes
    WHERE app_id = ${appId} AND outcome = 'NO_WORKER'
      AND decided_at > (clock_timestamp() AT TIME ZONE 'UTC') - make_interval(hours => ${EPISODE_HOURS}::int)
      ${only ? Prisma.sql`AND family = ${only.family ?? ''} AND tier = ${only.tier ?? ''} AND role = ${(only.role ?? '').toLowerCase()}` : Prisma.empty}`);
  return rows.map((r) => ({ family: r.family || null, tier: r.tier || null, role: r.role || null }));
}

/** The saturated combinations of one App now, each with the condition that holds (a no-worker outcome first). */
async function saturatedCombinations(db: PrismaClient, appId: string, now: Date): Promise<Map<string, { combo: SaturationCombination; reason: SaturationReason }>> {
  const [outcomes, workers] = await Promise.all([currentNoWorkerOutcomes(db, appId), loadWorkerWorkStates(db, appId, now)]);
  const out = new Map<string, { combo: SaturationCombination; reason: SaturationReason }>();
  for (const combo of outcomes) out.set(combinationKey(combo), { combo, reason: 'no-worker' });
  for (const [key, group] of groupWorkerCombinations(workers)) {
    if (out.has(key) || group.workers.length === 0 || group.eligible.length > 0) continue;
    out.set(key, { combo: { family: group.family, tier: group.tier, role: group.role?.toLowerCase() ?? null }, reason: 'none-eligible' });
  }
  return out;
}

/**
 * Open one episode for `combo` and raise its alarm, in one transaction. Null when the combination already has an open
 * episode (the index decides a race), when the App is no longer installed, or, for a `no-worker` episode, when the
 * outcome is no longer current by the time the transaction looks again (a match committed since the pass read). Exported
 * for the race pin.
 */
export async function raiseSaturation(db: PrismaClient, appId: string, combo: SaturationCombination, reason: SaturationReason, now: Date): Promise<string | null> {
  const family = combo.family ?? '';
  const tier = combo.tier ?? '';
  const role = (combo.role ?? '').toLowerCase();
  try {
    return await db.$transaction(async (tx): Promise<string | null> => {
      // #3774's fence: uninstallApp / deleteApp hold `apps FOR UPDATE`, so this waits for one in flight and sees its commit.
      const live = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM apps WHERE id = ${appId} AND deleted_at IS NULL AND uninstalled_at IS NULL FOR SHARE`;
      if (live.length === 0) return null;
      if (reason === 'no-worker' && (await currentNoWorkerOutcomes(tx, appId, combo)).length === 0) return null;
      const eventId = generateId();
      const payload: Prisma.InputJsonObject = { reason, family: family || null, tier: tier || null, role: role || null };
      await tx.$executeRaw`
        INSERT INTO agent_team_events (id, app_id, type, task_id, subject_worker_id, severity, chain, payload, created_at, episode_start)
        VALUES (${eventId}, ${appId}, ${SATURATION_EVENT_TYPE}, NULL, NULL, 'alarm', '[]'::jsonb,
                ${JSON.stringify(payload)}::jsonb, ${toNaiveUtc(now)}::timestamp, NULL)`;
      // The one-open-episode-per-combination index decides a race: the loser's insert fails and this transaction rolls back.
      await tx.saturationEpisode.create({ data: { appId, family, tier, role, eventId, openedAt: now } });
      return eventId;
      // READ COMMITTED: the index is the guard, and the re-read above must see a match committed while the App lock waited.
    }, { timeout: 30_000, maxWait: 10_000 });
  } catch (err) {
    if (isSerializationFailure(err)) return null;
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return null; // another pass opened it
    throw err;
  }
}

/**
 * One pass: end the open episodes whose combination is no longer saturated, and open one (with its alarm) for each
 * saturated combination that has none. Returns the ids of the alarms this pass raised.
 */
export async function evaluateSaturation(db: PrismaClient, now = new Date()): Promise<string[]> {
  const raised: string[] = [];
  // An App that is gone from the live set has nothing left to saturate; its open episodes end.
  await db.$executeRaw`
    UPDATE saturation_episodes e SET ended_at = GREATEST(e.opened_at, ${toNaiveUtc(now)}::timestamp)
    WHERE e.ended_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM apps a WHERE a.id = e.app_id AND a.deleted_at IS NULL AND a.uninstalled_at IS NULL)`;
  // Only an App that could be saturated or has an episode to end: a worker, an outcome row, or an open episode.
  const apps = await db.app.findMany({
    where: {
      deletedAt: null, uninstalledAt: null,
      OR: [{ workers: { some: { retiredAt: null } } }, { matchOutcomes: { some: {} } }, { saturationEpisodes: { some: { endedAt: null } } }],
    },
    select: { id: true },
  });
  for (const app of apps) {
    try {
      // Read BEFORE deriving (darkWorker.ts's order): a pass can end only an episode that existed when its derivation
      // began, so one a concurrent pass opened since, on a newer snapshot, is left to that pass's successors.
      const open = await db.saturationEpisode.findMany({ where: { appId: app.id, endedAt: null }, select: { id: true, family: true, tier: true, role: true, openedAt: true } });
      const saturated = await saturatedCombinations(db, app.id, now);
      const openKeys = new Set<string>();
      for (const e of open) {
        const key = combinationKey(e);
        openKeys.add(key);
        if (saturated.has(key)) continue;
        try {
          // Never before the open: another instance's clock may run behind, and the row's CHECK needs ended >= opened.
          await db.saturationEpisode.updateMany({ where: { id: e.id, endedAt: null }, data: { endedAt: e.openedAt > now ? e.openedAt : now } });
        } catch (err) {
          console.error(`[saturation] ending episode ${e.id} failed:`, err);
        }
      }
      for (const [key, s] of saturated) {
        if (openKeys.has(key)) continue;
        try {
          const id = await raiseSaturation(db, app.id, s.combo, s.reason, now);
          if (id) raised.push(id);
        } catch (err) {
          console.error(`[saturation] raising the alarm for App ${app.id} failed:`, err);
        }
      }
    } catch (err) {
      console.error(`[saturation] evaluating App ${app.id} failed:`, err);
    }
  }
  return raised;
}
