/**
 * #1706 (Task Management T2) — the stall evaluator loop (plan
 * design:agent-tasks §4). Every minute:
 *
 *   1. evaluate every open task against the four stall rules and raise each
 *      due alarm once per episode (cor:agt:050:13–:17);
 *   2. wake the next owner up the chain of every alarm still unacknowledged
 *      one window on (cor:agt:050:19, :20);
 *   3. write down that a stalled worker acted again (cor:agt:060:07);
 *   4. (#1708) record, once, each task wake whose subject is dormant and so
 *      cannot be delivered (cor:agt:080:11). It launches nothing (T6).
 *   5. (#1709) resolve each session-end request whose grace has passed
 *      (cor:agt:050:10): the session ended, or the platform issues
 *      `worker.end` for it to a live host, or there is no live host.
 *
 * No claim race, unlike the scheduler: every write is idempotent on its own
 * key (the episode's unique index, a conditional wake stamp, a conditional
 * availability update), so several instances may run it at once and a re-run
 * is a no-op. Delivering a wake is the router's, through the due-wake read
(src/lib/agentTasks/taskWakes.ts); this loop never delivers.
 *
 * Off under NODE_ENV=test (tests drive `taskStallTick` with a controllable
 * clock) and when DISABLE_TASK_STALL_EVALUATOR=true.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { evaluateStalls, wakeDueOwners } from '../lib/agentTasks/stall.js';
import { clearStalledMarks } from '../lib/agentTasks/availability.js';
import { recordUndeliverableTaskWakes } from '../lib/agentTasks/taskWakes.js';
import { sweepSessionEndRequests } from '../lib/hostOperations/sessionEnd.js';
import { sweepUnreportedHostOperations } from '../lib/hostOperations/settle.js';
import { anchorNow } from '../lib/stopSignals/state.js';

export type TaskStallTickResult = { raised: number; woken: number; cleared: number; undeliverable: number; sessionEnds: number; hostOperationsSettled: number };

/** One pass at `now`. Each step runs even when an earlier one failed. */
export async function taskStallTick(db: PrismaClient, now = new Date()): Promise<TaskStallTickResult> {
  const result: TaskStallTickResult = { raised: 0, woken: 0, cleared: 0, undeliverable: 0, sessionEnds: 0, hostOperationsSettled: 0 };
  // #2022: the monotonic half of `now`'s sample, so a raise decides at its own moment (stall.ts raiseStallAlarm).
  const anchor = anchorNow();
  try {
    result.raised = (await evaluateStalls(db, now, anchor)).length;
  } catch (err) {
    console.error('[task-stall] evaluation failed:', err);
  }
  try {
    result.woken = await wakeDueOwners(db, now);
  } catch (err) {
    console.error('[task-stall] escalation failed:', err);
  }
  try {
    result.cleared = await clearStalledMarks(db, now);
  } catch (err) {
    console.error('[task-stall] clearing stall marks failed:', err);
  }
  try {
    result.undeliverable = await recordUndeliverableTaskWakes(db, now);
  } catch (err) {
    console.error('[task-stall] recording undeliverable task wakes failed:', err);
  }
  try {
    result.sessionEnds = await sweepSessionEndRequests(db, now);
  } catch (err) {
    console.error('[task-stall] resolving session-end requests failed:', err);
  }
  try {
    // #1881 (cor:agt:070:02): nothing stays in flight forever.
    result.hostOperationsSettled = await sweepUnreportedHostOperations(db, now);
  } catch (err) {
    console.error('[task-stall] settling unreported host operations failed:', err);
  }
  return result;
}

/** Start the periodic loop (default 60s). Returns the interval handle. */
export function startTaskStallEvaluatorLoop(db: PrismaClient, opts: { intervalMs?: number } = {}): NodeJS.Timeout {
  const intervalMs = opts.intervalMs ?? 60_000;
  let running = false;
  return setInterval(() => {
    // A pass slower than the interval is skipped rather than stacked.
    if (running) return;
    running = true;
    taskStallTick(db)
      .catch((err) => console.error('[task-stall] tick error:', err))
      .finally(() => {
        running = false;
      });
  }, intervalMs);
}
