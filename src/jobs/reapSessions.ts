/**
 * reapSessions — end sessions nobody is driving any more (#930).
 *
 * `Session.expiresAt` has always been documented as "the janitor reaps
 * sessions past this point" and `Session.autoExpiredAt` as "set if the
 * session was auto-expired due to inactivity" — but neither was real:
 * nothing in `src` ever wrote `autoExpiredAt`, and there was no session
 * janitor at all. A session ended only when a caller ran `endSession`,
 * so a crashed or abandoned client left its session "active" forever
 * (finding `findings:session-expiry-no-reaper`). Anything reading
 * "active session" as presence — the team-worker "taken right now"
 * check (hadron-cli#369, cor:agt:020:03) first among them — inherited
 * that lie.
 *
 * ONE reap rule, idempotent:
 *
 *   1. **Hard expiry** — `endedAt IS NULL AND expiresAt < now`. The
 *      CHATBOT path (`startAgentSession`) stamps `expiresAt` from the
 *      App's `sessionTimeoutSeconds`, so this is that surface's rule.
 *      It is a **promise made at session start**, not an inference from
 *      silence, which is precisely why it survives #1114.
 *
 * **There is no inactivity rule any more (#1114).** It used to end a session
 * whose last heartbeat fell outside its type's idle window, and Holger's
 * ruling retired it outright: *"If I have my personal taxes agent, I use it
 * once a year."* Silence is not evidence of abandonment. The old rule inferred
 * abandonment from quiet and then wrote that inference into `endedAt` as a
 * fact — destructively, because ending a session forecloses the handoff it had
 * not written yet.
 *
 * What replaced it is not another sweep but a **derivation**: liveness is now
 * computed at READ time from the same three heartbeat inputs
 * (`lib/sessionActivity.ts` — `isSessionLive`), by every surface that asks "is
 * anyone driving this". Nothing is mutated to express it, so a session that
 * goes quiet for a year and comes back is simply described as idle in the
 * meantime, and is still there when its driver returns.
 *
 * Reaping sets **both** `endedAt` and `autoExpiredAt` to the same instant,
 * so "active" stays the single predicate `endedAt IS NULL` everywhere and
 * `autoExpiredAt` records *how* it ended (auto vs explicit `endSession`).
 *
 * Deliberately NOT here: `startSession` still leaves `expiresAt` null for
 * DEVELOPER sessions, which since #1114 means nothing ends them but an
 * explicit `endSession` — the intended outcome, not an oversight. Explicit
 * `endSession` is untouched.
 *
 * Run one sweep by hand:
 *   tsx src/jobs/reapSessions.ts
 */

import type { PrismaClient, SessionType } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';

/** Per-sweep cap. The next sweep continues where this one left off (oldest
 * first), so a first run against a long backlog drains over several sweeps
 * instead of one giant transaction. */
const REAP_BATCH_SIZE = 500;

export interface SessionReapOutcome {
  /** Sessions ended by hard expiry (`expiresAt` in the past). */
  expired: number;
  /** Candidates selected. Exceeds `expired` only when an explicit
   * `endSession` landed between selection and the guarded claim — i.e. it
   * counts sessions the race spared. */
  examined: number;
}

/**
 * End the sessions hard expiry selects, stamping `endedAt` +
 * `autoExpiredAt`. Safe to re-run and safe to run concurrently with
 * `endSession` or with a live driver: the claim re-applies the FULL
 * selecting predicate (not just `endedAt: null`), so a heartbeat or an
 * explicit end landing between selection and write leaves the row alone
 * rather than ending a session that just came back to life (PR-933).
 */
export async function runSessionReaper(
  db: PrismaClient = defaultDb,
  now: Date = new Date(),
): Promise<SessionReapOutcome> {
  const outcome: SessionReapOutcome = { expired: 0, examined: 0 };

  // ── Hard expiry: the one rule (#1114) ──────────────────────────────
  // Ids first (not a bare updateMany) so the in-process session-key cache
  // can release the reaped sessions' keys, mirroring endAgentSession.
  const expiredWhere = { endedAt: null, deletedAt: null, expiresAt: { lt: now } };
  const hardExpired = await db.session.findMany({
    where: expiredWhere,
    select: { id: true },
    orderBy: { expiresAt: 'asc' },
    take: REAP_BATCH_SIZE,
  });
  if (hardExpired.length > 0) {
    outcome.examined += hardExpired.length;
    outcome.expired = await claim(db, hardExpired.map((s) => s.id), expiredWhere, now);
  }

  return outcome;
}

/**
 * Mark the given sessions auto-expired and release their cached data keys.
 * `where` is the same predicate that selected them, re-evaluated inside the
 * single UPDATE so the claim is atomic with respect to a concurrent
 * heartbeat or `endSession`. Returns how many rows it actually claimed.
 */
async function claim(
  db: PrismaClient,
  ids: string[],
  where: Record<string, unknown>,
  now: Date,
): Promise<number> {
  const { count } = await db.session.updateMany({
    where: { ...where, id: { in: ids } },
    data: { endedAt: now, autoExpiredAt: now },
  });
  if (count === 0) return 0;
  // Evict only what the claim actually took — a candidate the race spared is
  // live, and dropping ITS key would break decryption for a working session.
  // Best-effort and in-process only (another instance holds its own cache);
  // eviction is ref-counted, so a memory shared with a still-live session
  // keeps its key. Mirrors endAgentSession.
  const claimed = await db.session.findMany({
    where: { id: { in: ids }, autoExpiredAt: now },
    select: { id: true },
  });
  for (const s of claimed) sessionKeyCache.evict(s.id);
  return count;
}

/**
 * Handle for a running reaper loop.
 *
 * `stop()` cancels whichever timer is currently armed (the initial delay OR the
 * interval that replaces it), refuses any further run, and RESOLVES ONLY ONCE
 * an in-flight sweep has finished — so `await loop.stop()` is a guarantee that
 * this loop will not write again (#1091).
 *
 * Awaiting matters because the timer is not the only thing running. Clearing it
 * stops the loop from STARTING work; a sweep already in flight keeps writing
 * from a floating promise nobody holds. In the suite that lands in whatever
 * runs next: `cleanDb` begins deleting while the sweep is still updating
 * sessions, in the same worker DB, and the result is a `40P01` deadlock in a
 * FILE THAT NEVER TOUCHED THE REAPER — the shape #1091 was filed for. Callers
 * that do not await get the old behaviour and no error, which is why the return
 * is a promise rather than a second method.
 */
export interface SessionReaperLoop {
  stop: () => Promise<void>;
}

/**
 * Run the reaper on an interval for the server's lifetime.
 *
 * Scheduling is part of this deliverable, not a follow-up: `runAssetJanitor`
 * shipped with no scheduler at all (#888), so its 24h recovery window never
 * actually expired — a lifecycle rule with no clock is a comment, not a
 * behavior. Same timer shape and in-flight guard as
 * `startAssetScanSweepLoop`, with one deliberate difference: those loops
 * return only the INITIAL timeout, so the interval that replaces it can
 * never be cancelled — which is exactly why none of them has a test that
 * the schedule fires. This one returns a stop handle so
 * `reapSessions.test.ts` can start the loop, watch it fire, and shut it
 * down without leaking a timer into the rest of the run.
 *
 * Since #1114 the loop exists for HARD EXPIRY alone. The cadence therefore
 * only affects how promptly a session whose promised `expiresAt` has passed
 * is closed — nothing here infers an ending from silence any more, so a slow
 * tick delays a promise being honoured rather than leaving a worker held.
 */
export function startSessionReaperLoop(
  db?: PrismaClient,
  intervalMs = 15 * 60 * 1000,
  initialDelayMs = 3 * 60 * 1000,
): SessionReaperLoop {
  let inFlight = false;
  let stopped = false;
  // The promise of the sweep currently running, so stop() can await it. Held
  // deliberately: `void run()` below would otherwise leave a floating promise
  // that outlives the handle and keeps writing (#1091).
  let running: Promise<void> | null = null;
  const run = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      const o = await runSessionReaper(db);
      if (o.expired > 0) {
        // eslint-disable-next-line no-console
        console.log(`[reaper:sessions] auto-expired ${o.expired} past-expiry`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[reaper:sessions] sweep failed:', err);
    } finally {
      inFlight = false;
    }
  };

  // Every tick goes through here so the in-flight promise is always held
  // somewhere stop() can reach it.
  //
  // Both guards below exist because a sweep can outlast `intervalMs`, and the
  // naive version broke the drain in exactly the way the drain exists to
  // prevent (PR #1108 review, @codex P2):
  //
  //   - **Do not replace an active promise.** A skipped tick's `run()` returns
  //     IMMEDIATELY on the `inFlight` guard, so assigning its
  //     already-resolved promise to `running` would hide the sweep that is
  //     still writing, and `stop()` would await nothing.
  //   - **Only clear what you set.** Without the identity check that skipped
  //     tick's `.finally` nulls `running` while the real sweep is mid-flight,
  //     which is the same early resolve by a second route.
  const tick = () => {
    if (running) return;
    const p: Promise<void> = run().finally(() => {
      if (running === p) running = null;
    });
    running = p;
  };
  let timer: NodeJS.Timeout = setTimeout(() => {
    tick();
    timer = setInterval(tick, intervalMs);
  }, initialDelayMs);
  return {
    stop: async () => {
      // Order is load-bearing: refuse first, THEN cancel, then drain. Setting
      // `stopped` before clearing the timer closes the window where an
      // already-queued tick starts a sweep between the two statements.
      stopped = true;
      // One variable holds whichever timer is armed; clearTimeout and
      // clearInterval are interchangeable on a Node timer handle.
      clearTimeout(timer);
      // `run` swallows its own errors, so this cannot reject.
      await running;
    },
  };
}

// Allow `tsx src/jobs/reapSessions.ts` to run one sweep directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  runSessionReaper()
    .then((o) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({ ...o, ranAt: new Date().toISOString() }));
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
