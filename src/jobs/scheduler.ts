/**
 * Schedule trigger loop (spec 040 plan §7).
 *
 * Every tick: claim due AgentSchedule rows (enabled, live, nextRunAt <= now)
 * by ATOMICALLY advancing nextRunAt to the next cron occurrence — the claim
 * IS the advance, so overlapping instances can't double-mint and a skipped
 * overlap can't re-fire every tick (PR-492 review). Then apply the overlap
 * policy (skip when a PENDING/RUNNING run exists for this schedule) and mint.
 *
 * Misfire policy v1: an overdue schedule runs ONCE; missed ticks are never
 * backfilled (nextRunAt advances from NOW, not from the missed slot).
 *
 * One-shot schedules (#510): runAt XOR cron. The claim disables the row
 * (enabled=false, nextRunAt=null) instead of advancing — same atomicity,
 * and the row remains as the audit record. An overdue one-shot fires once,
 * per the misfire policy.
 */

import { CronExpressionParser } from 'cron-parser';
import type { PrismaClient, AgentSchedule } from '../generated/prisma/index.js';
import { mintAppRun, RunLaunchDeniedError } from './appRuns.js';

/** Next occurrence strictly after `from` in the schedule's timezone. */
export function nextCronOccurrence(cron: string, timezone: string, from = new Date()): Date {
  const it = CronExpressionParser.parse(cron, { currentDate: from, tz: timezone });
  return it.next().toDate();
}

/**
 * One scheduler pass: claim due schedules by atomically advancing nextRunAt
 * (the claim IS the advance — multi-instance safe), apply the overlap-skip
 * policy, and mint a run per claimed schedule. Returns the mint count.
 */
export async function schedulerTick(db: PrismaClient, now = new Date()): Promise<number> {
  const due = await db.agentSchedule.findMany({
    where: { enabled: true, deletedAt: null, nextRunAt: { lte: now } },
    orderBy: { nextRunAt: 'asc' },
    take: 25,
  });
  let minted = 0;
  for (const s of due) {
    // Atomic claim-by-advance: only the instance that moves nextRunAt off
    // the due value proceeds. One-shot schedules (runAt, no cron — #510)
    // claim by DISABLING instead of advancing: the flip IS the claim, and
    // the row survives as the audit record of what was scheduled. Invalid
    // cron → disable loudly (config bug).
    let claimData: { nextRunAt: Date } | { enabled: false; nextRunAt: null };
    if (s.cron == null) {
      claimData = { enabled: false, nextRunAt: null };
    } else {
      try {
        claimData = { nextRunAt: nextCronOccurrence(s.cron, s.timezone, now) };
      } catch (err) {
        console.error(`[scheduler] invalid cron on schedule ${s.id} — disabling:`, err);
        await db.agentSchedule.updateMany({ where: { id: s.id }, data: { enabled: false } });
        continue;
      }
    }
    const claimed = await db.agentSchedule.updateMany({
      where: { id: s.id, nextRunAt: s.nextRunAt }, // optimistic: unchanged since read
      data: claimData,
    });
    if (claimed.count === 0) continue; // another instance took it

    // Overlap policy: skip (nextRunAt ALREADY advanced) when a run for this
    // schedule is still in flight.
    const inFlight = await db.appRun.findFirst({
      where: { triggerId: s.id, status: { in: ['PENDING', 'RUNNING'] } },
      select: { id: true },
    });
    if (inFlight) {
      console.log(`[scheduler] schedule ${s.id} skipped — run ${inFlight.id} still in flight`);
      continue;
    }

    try {
      await mintAppRun(db, {
        organizationId: s.organizationId,
        appId: s.appId,
        agentId: s.agentId,
        userId: s.userId,
        triggerKind: 'SCHEDULE',
        triggerId: s.id,
        entryNodeUrn: s.entryNodeUrn,
        entryNodeId: s.entryNodeId,
        eventData: {
          ...(s.eventData && typeof s.eventData === 'object' && !Array.isArray(s.eventData)
            ? (s.eventData as Record<string, unknown>)
            : {}),
          scheduleName: s.name,
          scheduledFor: (s.nextRunAt ?? now).toISOString(),
          ...(s.aiConfigName ? { __aiConfigName: s.aiConfigName } : {}),
        },
        policy: s.policy,
        scopeId: s.scopeId,
        createdBy: s.createdBy,
      });
      minted += 1;
      await db.agentSchedule.updateMany({ where: { id: s.id }, data: { lastRunAt: now } });
    } catch (err) {
      if (err instanceof RunLaunchDeniedError) {
        // Denied launches are normal operation (quota, revoked relationship)
        // — log; the schedule stays enabled and tries again next occurrence.
        console.warn(`[scheduler] launch denied for schedule ${s.id}: ${err.code} ${err.message}`);
      } else {
        console.error(`[scheduler] mint failed for schedule ${s.id}:`, err);
      }
    }
  }
  return minted;
}

/** Start the periodic scheduler loop (default 60s). Returns the interval handle. */
export function startSchedulerLoop(
  db: PrismaClient,
  opts: { intervalMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? 60_000;
  return setInterval(() => {
    schedulerTick(db).catch((err) => console.error('[scheduler] tick error:', err));
  }, intervalMs);
}
