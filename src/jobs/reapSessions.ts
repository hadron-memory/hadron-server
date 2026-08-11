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
 * "active session" as presence — the team-persona "taken right now"
 * check (hadron-cli#369, cor:agt:020:03) first among them — inherited
 * that lie.
 *
 * Two reap rules, both idempotent:
 *
 *   1. **Hard expiry** — `endedAt IS NULL AND expiresAt < now`. The
 *      CHATBOT path (`startAgentSession`) stamps `expiresAt` from the
 *      App's `sessionTimeoutSeconds`, so this is that surface's rule.
 *   2. **Inactivity** — `endedAt IS NULL AND expiresAt IS NULL` and last
 *      activity older than the session type's idle window. Last activity
 *      is the greatest of `startedAt`, `updatedAt`, and the session's most
 *      recent `UsageEvent.createdAt`: any write attributed to the session
 *      is a heartbeat, which is exactly the "a session log / chat post
 *      touches liveness" behavior the persona design wants, for free
 *      (`updateSession`'s `updatedAt` bump is the explicit touch, #931).
 *
 * Reaping sets **both** `endedAt` and `autoExpiredAt` to the same instant,
 * so "active" stays the single predicate `endedAt IS NULL` everywhere and
 * `autoExpiredAt` records *how* it ended (auto vs explicit `endSession`).
 *
 * Deliberately NOT here: `startSession` still leaves `expiresAt` null for
 * DEVELOPER sessions (rule 2 covers them; the client contract is
 * unchanged), and explicit `endSession` is untouched.
 *
 * Run one sweep by hand:
 *   tsx src/jobs/reapSessions.ts
 */

import type { PrismaClient, SessionType } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';

/** Every `SessionType` — the per-type idle windows are keyed on this. */
const SESSION_TYPES: SessionType[] = ['DEVELOPER', 'CHATBOT', 'AUTOMATION', 'EDGE'];

/**
 * Fleet-wide default idle window: a session with no heartbeat for a day is
 * over by any reading. Deliberately generous — too SHORT is the worse
 * failure for personas (it frees one mid-lunch and a takeover interleaves
 * her working memory, the caveat on D-2026-08-11-006), while too long only
 * delays a takeover the CLI can already force.
 */
export const DEFAULT_SESSION_IDLE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Per-sweep cap for each rule. The next sweep continues where this one
 * left off (oldest first), so a first run against a long backlog drains
 * over several sweeps instead of one giant transaction. */
const REAP_BATCH_SIZE = 500;

/** Env var carrying the per-type idle-window override for `type`. */
function idleWindowEnvName(type: SessionType): string {
  return `SESSION_IDLE_WINDOW_${type}_MS`;
}

/** Env vars already warned about, so a permanently-malformed value doesn't
 * reprint on every sweep (PR-933 Copilot). Keyed by name AND value, so
 * fixing one typo into another is still reported. */
const warnedWindowValues = new Set<string>();

/**
 * Parse a positive-integer millisecond env value; returns null for anything
 * else (warning once per distinct bad value), so a typo degrades to the
 * default rather than reaping every session immediately or never.
 */
function parseWindowMs(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    const seen = `${name}=${raw}`;
    if (!warnedWindowValues.has(seen)) {
      warnedWindowValues.add(seen);
      // eslint-disable-next-line no-console
      console.warn(`[reaper:sessions] ignoring ${name}="${raw}" — expected a positive integer of milliseconds`);
    }
    return null;
  }
  return n;
}

/**
 * Idle window for a session type: the per-type override wins, then the
 * fleet-wide `SESSION_IDLE_WINDOW_MS`, then the 24h default. Read per call
 * (not memoized) so an operator's change lands on the next sweep and tests
 * can set it without re-importing the module.
 */
export function idleWindowMsFor(type: SessionType): number {
  const perType = parseWindowMs(idleWindowEnvName(type), process.env[idleWindowEnvName(type)]);
  if (perType !== null) return perType;
  const fleet = parseWindowMs('SESSION_IDLE_WINDOW_MS', process.env.SESSION_IDLE_WINDOW_MS);
  if (fleet !== null) return fleet;
  return DEFAULT_SESSION_IDLE_WINDOW_MS;
}

export interface SessionReapOutcome {
  /** Sessions ended by rule 1 (`expiresAt` in the past). */
  expired: number;
  /** Sessions ended by rule 2 (no heartbeat within the idle window). */
  idle: number;
  /** Candidates selected across both rules. Exceeds `expired + idle` only
   * when a heartbeat or an explicit `endSession` landed between selection
   * and the guarded claim — i.e. it counts sessions the race spared. */
  examined: number;
}

/**
 * Predicate for rule 2 on one session type: no hard expiry, and none of the
 * three heartbeat sources inside the window.
 *
 * The `UsageEvent` check lives IN the query rather than in a post-filter
 * (PR-933 Codex P2): with a post-filter, 500 stale-looking-but-actually-busy
 * sessions would re-fill the batch every sweep and genuinely idle rows
 * ordered behind them would never be examined at all. Selecting only rows
 * that are truly idle makes the batch cap a real drain, not a stall.
 *
 * `updatedAt` is null on a session never updated since its insert, which
 * reads as "no touch since startedAt" — `startedAt` then decides.
 */
function idlePredicate(type: SessionType, cutoff: Date) {
  return {
    type,
    endedAt: null,
    deletedAt: null,
    expiresAt: null,
    startedAt: { lt: cutoff },
    OR: [{ updatedAt: null }, { updatedAt: { lt: cutoff } }],
    events: { none: { createdAt: { gte: cutoff } } },
  };
}

/**
 * End the sessions the two rules select, stamping `endedAt` +
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
  const outcome: SessionReapOutcome = { expired: 0, idle: 0, examined: 0 };

  // ── Rule 1: hard expiry ────────────────────────────────────────────
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

  // ── Rule 2: inactivity ─────────────────────────────────────────────
  // Only sessions with NO hard expiry: one with an `expiresAt` is governed
  // by rule 1, and an idle window must not end it early. One pass per type,
  // since each type's window makes its own cutoff.
  for (const type of SESSION_TYPES) {
    const cutoff = new Date(now.getTime() - idleWindowMsFor(type));
    const where = idlePredicate(type, cutoff);
    const candidates = await db.session.findMany({
      where,
      select: { id: true },
      orderBy: { startedAt: 'asc' },
      take: REAP_BATCH_SIZE,
    });
    if (candidates.length === 0) continue;
    outcome.examined += candidates.length;
    outcome.idle += await claim(db, candidates.map((s) => s.id), where, now);
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

/** Handle for a running reaper loop — `stop()` cancels whichever timer is
 * currently armed (the initial delay OR the interval that replaces it). */
export interface SessionReaperLoop {
  stop: () => void;
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
 * 15 minutes is well under any sane idle window; the cadence only affects
 * how promptly a dead session's persona is freed after its window closes.
 */
export function startSessionReaperLoop(
  db?: PrismaClient,
  intervalMs = 15 * 60 * 1000,
  initialDelayMs = 3 * 60 * 1000,
): SessionReaperLoop {
  let inFlight = false;
  const run = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const o = await runSessionReaper(db);
      if (o.expired > 0 || o.idle > 0) {
        // eslint-disable-next-line no-console
        console.log(`[reaper:sessions] auto-expired ${o.expired} past-expiry, ${o.idle} idle`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[reaper:sessions] sweep failed:', err);
    } finally {
      inFlight = false;
    }
  };

  let timer: NodeJS.Timeout = setTimeout(() => {
    void run();
    timer = setInterval(() => void run(), intervalMs);
  }, initialDelayMs);
  return {
    stop: () => {
      // One variable holds whichever timer is armed; clearTimeout and
      // clearInterval are interchangeable on a Node timer handle.
      clearTimeout(timer);
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
