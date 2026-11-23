/**
 * #4847 (cor:int:030:03 clauses 2 and 4): the recurring pass over the chat tool teardown intents. Each pass reconciles the live
 * connections of an owner that is already deleted, caps what a crash left exhausted, and attempts every intent that is due: PENDING,
 * under the ten-attempt cap, its wait (5 minutes doubling to 6 hours) passed. The logic and every guard live in
 * `src/lib/chatToolTeardown.ts`; this file only schedules it. Nothing here is a second path: a pass with nothing to do does nothing.
 *
 * Skipped under NODE_ENV=test (the tests drive `chatToolTeardownSweepTick(db, now)` with a controllable clock) and when
 * DISABLE_CHAT_TOOL_TEARDOWN_SWEEP=true. Hand-run: `pnpm tsx src/jobs/sweepChatToolTeardown.ts`.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { isProcessEntry } from './isProcessEntry.js';
import { chatToolTeardownSweepTick } from '../lib/chatToolTeardown.js';

/** Start the recurring pass (every 5 minutes, first run after 60 s). Overlapping passes are skipped. Returns the initial timer. */
export function startChatToolTeardownSweepLoop(
  db: PrismaClient,
  options: { intervalMs?: number; initialDelayMs?: number } = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? 5 * 60 * 1000;
  const initialDelayMs = options.initialDelayMs ?? 60 * 1000;
  let running = false;
  const run = async () => {
    if (running) return; // a tool call can take its full 30 s timeout: never stack passes
    running = true;
    try {
      const out = await chatToolTeardownSweepTick(db);
      if (out.reconciled + out.capped + out.attempted > 0) {
        console.log(`[chat-tool-teardown-sweep] reconciled ${out.reconciled}, attempted ${out.attempted}, confirmed ${out.confirmed}, capped ${out.capped}`);
      }
    } catch (err) {
      console.error('[chat-tool-teardown-sweep] failed:', err);
    } finally {
      running = false;
    }
  };
  return setTimeout(() => {
    void run();
    setInterval(run, intervalMs).unref();
  }, initialDelayMs);
}

if (isProcessEntry(import.meta.url)) {
  const { db } = await import('../integrations/db/client.js');
  console.log(JSON.stringify(await chatToolTeardownSweepTick(db)));
  await db.$disconnect();
}
