/**
 * #1707 (Task Management T3) — the matcher's sweep (plan design:agent-tasks
 * §5). Every minute:
 *
 *   1. write down every host registration that lapsed (`host.lost`,
 *      cor:agt:070:01);
 *   2. write down every worker availability whose `until` passed (#1766,
 *      cor:agt:060:02), before matching, so the worker is matched in this
 *      same pass;
 *   3. write down every stop signal whose until passed (#2022, cor:agt:090:05),
 *      with its notices, so a worker it no longer covers is matched in this pass;
 *   4. match every App's queued tasks to workers free for work
 *      (cor:agt:060:06), and record the stop holds of what stays queued.
 *
 * The sweep backs up the event-driven runs (`matchAfterChange`: a task created
 * with no assignee, a task finished or cancelled, an availability change) and
 * catches what they don't see: a worker binding a session, a stall mark
 * clearing, an `until` lapsing (recorded in step 2). Overlapping runs, here or
 * on another instance, are safe: see the concurrency note in
 * src/lib/agentTasks/matcher.ts, and step 2's guarded update.
 *
 * Off under NODE_ENV=test (tests drive `taskMatcherTick` with a controllable
 * clock) and when DISABLE_TASK_MATCHER=true, which also turns off the
 * event-driven runs and the lapse recording.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { matchQueuedTasks } from '../lib/agentTasks/matcher.js';
import { sweepLostHosts } from '../lib/agentTasks/hosts.js';
import { recordLapsedAvailability } from '../lib/agentTasks/availability.js';
import { sweepExpiredStopSignals } from '../lib/stopSignals/sweep.js';
import { anchorNow } from '../lib/stopSignals/state.js';

export type TaskMatcherTickResult = { lost: number; lapsed: number; expired: number; matched: number };

/** One pass at `now`. Each step runs even when an earlier one failed. */
export async function taskMatcherTick(db: PrismaClient, now = new Date()): Promise<TaskMatcherTickResult> {
  // #2022: the monotonic half of `now`'s sample, so every stop decision of the pass is made at its own moment.
  const anchor = anchorNow();
  const result: TaskMatcherTickResult = { lost: 0, lapsed: 0, expired: 0, matched: 0 };
  try {
    result.lost = await sweepLostHosts(db, now);
  } catch (err) {
    console.error('[task-matcher] host lapse sweep failed:', err);
  }
  try {
    result.lapsed = await recordLapsedAvailability(db, now);
  } catch (err) {
    console.error('[task-matcher] availability lapse sweep failed:', err);
  }
  try {
    result.expired = (await sweepExpiredStopSignals(db, now, anchor)).length;
  } catch (err) {
    console.error('[task-matcher] stop signal expiry sweep failed:', err);
  }
  try {
    result.matched = (await matchQueuedTasks(db, now, { anchor })).length;
  } catch (err) {
    console.error('[task-matcher] matching failed:', err);
  }
  return result;
}

/** Start the periodic loop (default 60s). Returns the interval handle. */
export function startTaskMatcherLoop(db: PrismaClient, opts: { intervalMs?: number } = {}): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? 60_000;
  let running = false;
  return setInterval(() => {
    // A pass slower than the interval is skipped rather than stacked.
    if (running) return;
    running = true;
    taskMatcherTick(db)
      .catch((err) => console.error('[task-matcher] tick error:', err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}
