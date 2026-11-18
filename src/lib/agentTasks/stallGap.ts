/**
 * #3775 A (cor:agt:050:32) — the stall evaluator's pass bookkeeping. Server downtime is not anyone's silence: a pass that
 * starts more than {@link STALL_GAP_THRESHOLD_MS} after the previous recorded one marks a GAP, and the start of that first
 * pass (the gap's end) joins the floor of the not-started, no-progress, owner-unreactive and unassignable windows
 * (`stallCandidates`, stall.ts). The finish-by alarm is never floored, and an alarm already raised keeps running.
 *
 * One platform-wide row (`stall_evaluator_state`, id `platform`). Several instances may run the evaluator, so every
 * write is conditional on the `last_pass_at` it read: only one instance records a given gap end, and a re-run records
 * nothing more. The very first pass (no row) records its time and floors nothing.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

/** cor:agt:050:32 (Holger R6): more than five minutes (five missed 60-second ticks) is a gap; five or less is jitter. */
export const STALL_GAP_THRESHOLD_MS = 5 * 60_000;
const ROW_ID = 'platform';

/**
 * Record a pass that starts at `now`. Returns `{ gapEnded: true }` only for the one caller that recorded a gap end.
 * A `now` not later than the recorded pass moves nothing (a slow or concurrent pass never moves the clock back).
 */
export async function recordStallPass(db: PrismaClient, now: Date): Promise<{ gapEnded: boolean }> {
  const row = await db.stallEvaluatorState.findUnique({ where: { id: ROW_ID } });
  if (!row) {
    try {
      await db.stallEvaluatorState.create({ data: { id: ROW_ID, lastPassAt: now } });
      return { gapEnded: false };
    } catch (err) {
      // Another instance made the row first (the primary key); judge this pass against theirs.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      return recordStallPass(db, now);
    }
  }
  if (now.getTime() <= row.lastPassAt.getTime()) return { gapEnded: false };
  const gap = now.getTime() - row.lastPassAt.getTime() > STALL_GAP_THRESHOLD_MS;
  const { count } = await db.stallEvaluatorState.updateMany({
    where: { id: ROW_ID, lastPassAt: row.lastPassAt },
    data: gap ? { lastPassAt: now, lastGapEndedAt: now } : { lastPassAt: now },
  });
  return { gapEnded: gap && count === 1 };
}

/** The end of the latest recorded gap, or null. Read by `loadStallInputs` for every candidate it builds. */
export async function loadLastGapEnd(db: PrismaClient): Promise<Date | null> {
  return (await db.stallEvaluatorState.findUnique({ where: { id: ROW_ID }, select: { lastGapEndedAt: true } }))?.lastGapEndedAt ?? null;
}
