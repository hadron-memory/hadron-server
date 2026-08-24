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

/** The three-input activity instant for ONE session. */
export function sessionActivityAt(
  session: { startedAt: Date; updatedAt?: Date | null },
  lastEventAt?: Date | null,
): Date {
  return new Date(
    Math.max(
      session.startedAt.getTime(),
      session.updatedAt?.getTime() ?? 0,
      lastEventAt?.getTime() ?? 0,
    ),
  );
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
