/**
 * When a session was last DRIVEN — the platform's one derivation of it
 * (`cor:agt:020:03`).
 *
 * Three inputs, and the set is the contract rather than an implementation
 * detail: `startedAt`, `updatedAt` (the explicit heartbeat a mid-session write
 * bumps), and the latest `UsageEvent` attributed to the session. The spec's
 * invalidation list names narrowing this set as a defect in its own right —
 * "activity means every surface a driver reaches the session through, not only
 * the ones that happen to write provenance" — and #1081 is what that costs when
 * a whole transport falls outside it: coordinators, who write the least
 * provenance, were reaped soonest.
 *
 * Extracted (#487) because a THIRD caller was about to spell it out a fourth
 * way. It already lived twice — the reaper's candidate query
 * (`src/jobs/reapSessions.ts`, in SQL because the liveness test must be IN the
 * query, #930) and the takeover prompt's `lastSeenAt`
 * (`resolvers.mutation.session.ts`) — and two copies of a definition disagree
 * eventually. The SQL one cannot share this code; the TypeScript ones now do,
 * so a change here reaches every surface a human reads an "idle since" off.
 */

import type { SessionType } from '../generated/prisma/index.js';

/**
 * The three-input activity instant for ONE session.
 *
 * `updatedAt` is DROPPED on an auto-expired session. The reaper ends an idle
 * session with an `updateMany`, and Prisma's `@updatedAt` advances the column to
 * the reaping instant — so on a reaped row it records the background cleanup,
 * not a driver, and folding it in reports an ABANDONED session as active until
 * the moment it was swept up (PR #1086 review, Codex P2). `autoExpiredAt` marks
 * exactly those rows (#930).
 *
 * The last genuine heartbeat is gone — the reap overwrote it — so this
 * under-reports on a reaped session, falling back to `startedAt` and the usage
 * events. That is the safe direction: an abandoned session reads as MORE idle,
 * never less, and every consumer of this number is asking "is anyone there?".
 *
 * The same reasoning caps the result at `endedAt`: `updateSession` permits
 * writes after a session ends (a merge lands days later), and usage events can
 * be attributed late, so both can advance a timestamp on a session nobody is
 * driving. Nothing that happens after a stint ends is that stint being driven.
 *
 * Today's other caller passes only ACTIVE sessions, where `autoExpiredAt` and
 * `endedAt` are null by construction, so its behaviour is unchanged — these
 * rules live here rather than at the call site because they are properties of
 * the derivation.
 */
export function sessionActivityAt(
  session: {
    startedAt: Date;
    updatedAt?: Date | null;
    autoExpiredAt?: Date | null;
    endedAt?: Date | null;
  },
  lastEventAt?: Date | null,
): Date {
  const heartbeat = session.autoExpiredAt ? null : session.updatedAt;
  const at = Math.max(
    session.startedAt.getTime(),
    heartbeat?.getTime() ?? 0,
    lastEventAt?.getTime() ?? 0,
  );
  // Activity cannot POSTDATE the end. `updateSession` deliberately permits
  // writes after `endedAt` — a merge lands days after the stint that produced
  // it — and usage events can be attributed late for the same reason
  // (`hadron_record_work` takes an ended session on purpose). Both advance
  // timestamps on a session nobody is driving.
  const end = session.endedAt?.getTime();
  return new Date(end !== undefined && end < at ? end : at);
}

/**
 * The latest attributed `UsageEvent` per session, in one grouped query.
 *
 * Returns an empty map for an empty input rather than issuing a query whose
 * `IN ()` matches everything or nothing depending on the engine.
 */
export async function loadLastEventBySession(
  db: {
    usageEvent: {
      groupBy: (args: unknown) => Promise<{ sessionId: string | null; _max: { createdAt: Date | null } }[]>;
    };
  },
  sessionIds: string[],
): Promise<Map<string, Date | null>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await db.usageEvent.groupBy({
    by: ['sessionId'],
    where: { sessionId: { in: sessionIds } },
    _max: { createdAt: true },
  });
  return new Map(
    rows
      .filter((r): r is { sessionId: string; _max: { createdAt: Date | null } } => !!r.sessionId)
      .map((r) => [r.sessionId, r._max.createdAt]),
  );
}

/**
 * The most recently active session out of several, with its activity instant.
 *
 * ALL active sessions are considered rather than the newest-created (PR #983
 * review): `force` lets several coexist, and the most recent ACTIVITY can be on
 * an older row — so the takeover prompt must name whoever actually drove the
 * worker last, not whoever bound most recently.
 */
export function mostRecentlyActive<T extends { id: string; startedAt: Date; updatedAt?: Date | null }>(
  sessions: T[],
  lastEventBySession: Map<string, Date | null>,
): { session: T; at: Date } | null {
  let best: { session: T; at: Date } | null = null;
  for (const session of sessions) {
    const at = sessionActivityAt(session, lastEventBySession.get(session.id));
    if (!best || at > best.at) best = { session, at };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Liveness — DERIVED, never stored (#1114)
// ---------------------------------------------------------------------------

/**
 * Every `SessionType`, for the per-type window overrides below.
 */
const SESSION_TYPES: SessionType[] = ['DEVELOPER', 'CHATBOT', 'AUTOMATION', 'EDGE'];

/**
 * Fleet-wide default window for "is anyone driving this": a session with no
 * heartbeat for a day is not being driven, by any reading.
 *
 * #1114 changed what this number COSTS, and the change is the reason the
 * default can stay generous. It used to decide when a session was ENDED — an
 * inference from silence, written into the record as a fact, destroying the
 * handoff that session had not written yet. It now decides only how a session
 * is DESCRIBED. Getting it wrong is a rendering mistake a reader can see past,
 * not a destroyed stint, so it is cheap to tune and cheap to be wrong about.
 */
export const DEFAULT_SESSION_IDLE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Env var carrying the per-type window override for `type`. */
function idleWindowEnvName(type: SessionType): string {
  return `SESSION_IDLE_WINDOW_${type}_MS`;
}

/**
 * Env vars already warned about, so a permanently-malformed value does not
 * reprint on every read. Keyed by name AND value, so fixing one typo into
 * another is still reported.
 */
const warnedWindowValues = new Set<string>();

/**
 * Parse a positive-integer millisecond env value; null for anything else
 * (warning once per distinct bad value), so a typo degrades to the default.
 */
function parseWindowMs(name: string, raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    const seen = `${name}=${raw}`;
    if (!warnedWindowValues.has(seen)) {
      warnedWindowValues.add(seen);
      // eslint-disable-next-line no-console
      console.warn(`[session-activity] ignoring ${name}="${raw}" — expected a positive integer of milliseconds`);
    }
    return null;
  }
  return n;
}

/**
 * The window for one session type: per-type override, then the fleet-wide
 * `SESSION_IDLE_WINDOW_MS`, then the 24h default. Read per call (not memoized)
 * so an operator's change lands immediately and tests can set it without
 * re-importing the module.
 *
 * The env names are unchanged from when this window governed reaping (#930).
 * They still describe the same quantity — how long without a heartbeat before
 * a session counts as idle — so a deployment that tuned one keeps its intent;
 * only the CONSEQUENCE moved, from ending the session to describing it.
 */
export function idleWindowMsFor(type: SessionType): number {
  const perType = parseWindowMs(idleWindowEnvName(type), process.env[idleWindowEnvName(type)]);
  if (perType !== null) return perType;
  const fleet = parseWindowMs('SESSION_IDLE_WINDOW_MS', process.env.SESSION_IDLE_WINDOW_MS);
  if (fleet !== null) return fleet;
  return DEFAULT_SESSION_IDLE_WINDOW_MS;
}

/**
 * A Prisma `DateTime` column is `timestamp WITHOUT time zone`, and Prisma binds
 * a JS Date as `timestamptz` — so a raw-SQL comparison between the two coerces
 * the COLUMN using the session zone, which is silently correct on a UTC server
 * and wrong everywhere else (findings:prisma-naive-timestamp-raw-sql). Bind
 * this instead, cast `::timestamp`, and leave the column bare so the predicate
 * stays sargable.
 */
export const toNaiveUtc = (d: Date): string => d.toISOString().replace('Z', '');

/** The per-type cutoffs for one instant — every window resolved once. */
export function idleCutoffs(now: Date): Record<SessionType, Date> {
  const out = {} as Record<SessionType, Date>;
  for (const type of SESSION_TYPES) {
    out[type] = new Date(now.getTime() - idleWindowMsFor(type));
  }
  return out;
}

/**
 * **Is anyone driving this session right now?** The platform's ONE liveness
 * predicate (`cor:agt:020:11` — a reader must see the same predicate the
 * binder enforces), and the answer #1114 made derived rather than stored.
 *
 * Two conjuncts, and both are load-bearing:
 *
 *  - **The session has not ended.** Ending is an ACT — an explicit
 *    `endSession`, or a hard `expiresAt` promised at session start. It is
 *    never inferred.
 *  - **It was driven inside its type's window.** This is the half that used to
 *    be expressed by ENDING the session, and that was the defect: inferring
 *    abandonment from silence is a guess, and writing a guess into `endedAt`
 *    made it indistinguishable from a fact — permanently, since the stint's
 *    unwritten handoff went with it. Computing it at read time says exactly
 *    as much as the evidence supports and costs nothing if it is wrong.
 *
 * "Silence is not evidence of abandonment" (Holger, 2026-08-31): a taxes agent
 * used once a year is not abandoned in month two. The window decides what a
 * reader is TOLD, never what is true of the record.
 */
export function isSessionLive(
  session: {
    type: SessionType;
    startedAt: Date;
    updatedAt?: Date | null;
    autoExpiredAt?: Date | null;
    endedAt?: Date | null;
  },
  lastEventAt: Date | null | undefined,
  now: Date,
): boolean {
  if (session.endedAt) return false;
  const cutoff = now.getTime() - idleWindowMsFor(session.type);
  return sessionActivityAt(session, lastEventAt).getTime() >= cutoff;
}

/**
 * Record that a caller just drove a LIVE session through a team-chat call
 * (#1540): bump `Session.updatedAt`, the same heartbeat column the MCP track
 * writes (`heartbeatSession`, #1081), so `isSessionLive` — and with it the
 * roster, the bind gate's WORKER_TAKEN and the post gate — sees the activity.
 * Before this, a CLI/GraphQL-bound worker that posted and read every few
 * minutes still went SESSION_NOT_LIVE one idle window after `startedAt`,
 * because nothing on that track touched any of the predicate's inputs.
 *
 * The CALLER must already have established that the session is live and that
 * it owns and may still drive it; this does no authorization of its own. It
 * keeps a live session alive and never revives a lapsed one: callers run it
 * only after their liveness check passes, and the `endedAt: null` guard means
 * a touch racing `endSession` updates nothing.
 *
 * Bookkeeping, never a failure: an error is logged and swallowed, so a
 * caller's post or read cannot fail because liveness bookkeeping did.
 */
export async function touchLiveSession(
  db: { session: { updateMany: (args: { where: Record<string, unknown>; data: { updatedAt: Date } }) => Promise<unknown> } },
  sessionId: string,
): Promise<void> {
  try {
    await db.session.updateMany({
      where: { id: sessionId, endedAt: null, deletedAt: null },
      data: { updatedAt: new Date() },
    });
  } catch (err) {
    console.warn('[touchLiveSession] heartbeat failed:', err);
  }
}

/**
 * Backstop cap on how many OPEN sessions any liveness read will scan.
 *
 * #1114 removed the only thing that closed abandoned sessions, so the count of
 * open rows on one worker now grows with every stint whose driver never ran
 * `endSession` — which, on the desktop track, is the ordinary ending. An
 * unbounded `findMany` plus an `IN (...)` of every id was fine while a reaper
 * kept that set small and is a slow leak now (#1120 review, Codex P2).
 *
 * A cap alone would be the WRONG fix on its own — it would silently drop the
 * live session if it sorted late — which is why it sits behind
 * `recentlyTouchedFilter` below rather than in front of it: the filter removes
 * rows that cannot be live, and this only bounds the pathological remainder.
 */
export const OPEN_SESSION_SCAN_CAP = 200;

/**
 * A Prisma filter admitting exactly the sessions that could still be live,
 * evaluated PER TYPE.
 *
 * The first version used the single widest window across all types. That was
 * safe on its own — it can never exclude a live row — but not safe in front of
 * a cap (#1120 review, Codex P2): with a 1h DEVELOPER window and a 30d EDGE
 * window, 200 day-old DEVELOPER rows are admitted, fill a `startedAt DESC`
 * cap, and push out an older EDGE session with a current usage event. The
 * binder then permits a takeover while the uncapped roster SQL still reports
 * taken — the three-surfaces-two-answers failure again, arriving through the
 * bound rather than the predicate.
 *
 * Type-aware, the filter and `isSessionLive` agree on every row, so everything
 * admitted is genuinely a candidate and the cap can only ever drop one live
 * row in favour of another. "Is anyone driving this" is unchanged by which of
 * several live sessions answers it.
 *
 * All three heartbeat inputs are represented, including the usage-event one —
 * dropping it would miss a session driven entirely through surfaces that write
 * provenance rather than touching the row, which is #1081's exact lesson.
 */
export function recentlyTouchedFilter(now: Date) {
  const cutoffs = idleCutoffs(now);
  return {
    OR: SESSION_TYPES.map((type) => ({
      type,
      OR: [
        { startedAt: { gte: cutoffs[type] } },
        { updatedAt: { gte: cutoffs[type] } },
        { events: { some: { createdAt: { gte: cutoffs[type] } } } },
      ],
    })),
  };
}
