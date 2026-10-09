/**
 * #1707 (Task Management T3) — the matcher's sweep (plan design:agent-tasks
 * §5). Every minute:
 *
 *   1. write down every host registration that lapsed (`host.lost`,
 *      cor:agt:070:01);
 *   2. match every App's queued tasks to workers free for work
 *      (cor:agt:060:06).
 *
 * The sweep backs up the event-driven runs (`matchAfterChange`: a task created
 * with no assignee, a task finished or cancelled, an availability change) and
 * catches what they don't see: a worker binding a session, a stall mark
 * clearing, an `until` lapsing. Overlapping runs, here or on another instance,
 * are safe: see the concurrency note in src/lib/agentTasks/matcher.ts.
 *
 * Off under NODE_ENV=test (tests drive `taskMatcherTick` with a controllable
 * clock) and when DISABLE_TASK_MATCHER=true, which also turns off the
 * event-driven runs.
 */

import type { PrismaClient } from '../generated/prisma/index.js';
import { matchQueuedTasks } from '../lib/agentTasks/matcher.js';
import { sweepLostHosts } from '../lib/agentTasks/hosts.js';

export type TaskMatcherTickResult = { lost: number; matched: number };

/** One pass at `now`. Each step runs even when the other failed. */
export async function taskMatcherTick(db: PrismaClient, now = new Date()): Promise<TaskMatcherTickResult> {
  const result: TaskMatcherTickResult = { lost: 0, matched: 0 };
  try {
    result.lost = await sweepLostHosts(db, now);
  } catch (err) {
    console.error('[task-matcher] host lapse sweep failed:', err);
  }
  try {
    result.matched = (await matchQueuedTasks(db, now)).length;
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
