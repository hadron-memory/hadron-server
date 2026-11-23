import type { PrismaClient } from '../generated/prisma/index.js';
import { ownsSession } from './sessionOwnership.js';
import { DEFAULT_SESSION_DORMANCY_DAYS, isSessionDormant, loadLastEventBySession } from './sessionActivity.js';

/** The principal fields the binding check reads (a subset of `AuthContext`). */
export interface SessionBindingPrincipal {
  appId?: string;
  userId?: string;
  impersonation?: unknown;
}

export type SessionBinding = { sessionId: string; actor: { workerId: string | null; agentId: string | null } };

/**
 * The body of the ONE session-binding check (#934), with no GraphQL reach: `validateSessionBinding` in
 * `src/middleware/auth.ts` is this plus its typed #3818 supersession refusal for an ended session, and the shared
 * App-key session predicate (`sessionScopedMemoryIds`, #3401 D1) calls this directly, because that predicate sits
 * under bounded import leaves (`instructedActImportGraph3332.test.ts`) that must not reach resolver modules.
 *
 * An active session (not ended, not past a hard expiry, not DORMANT) of the caller's own: an App key's own App's
 * session, or a user's own session, never under impersonation. `binding` is null for anything else; `ended` says the
 * session row exists and has ended, which is the only case the middleware classifies further.
 */
export async function loadSessionBinding(
  db: PrismaClient,
  principal: SessionBindingPrincipal,
  sessionId: string,
): Promise<{ binding: SessionBinding | null; ended: boolean }> {
  const isPureAppKey = !!principal.appId && !principal.userId;
  const isUserPrincipal = !!principal.userId && !principal.impersonation;
  if (!isPureAppKey && !isUserPrincipal) return { binding: null, ended: false };
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: {
      id: true, appId: true, userId: true, expiresAt: true, endedAt: true, workerId: true, agentId: true,
      startedAt: true, updatedAt: true, autoExpiredAt: true, launchOperationId: true,
      app: { select: { sessionDormancyDays: true } },
    },
  });
  if (!session) return { binding: null, ended: false };
  if (session.endedAt) return { binding: null, ended: true };
  const now = new Date();
  if (session.expiresAt && session.expiresAt <= now) return { binding: null, ended: false };
  if (!ownsSession(principal, session)) return { binding: null, ended: false };
  // Ruling DY-5, completed for sessions with NO hard expiry (#1661 review,
  // Rook P2-1): a session nobody has driven for longer than its App's
  // dormancy threshold no longer binds. Without this, an App with
  // `agentSessionsExpire: false` left a chatbot session, and its session-
  // scoped reach into an end user's personal memory, bindable by any key of
  // that App forever: Holger's "5 year old session, forgotten by everyone,
  // starts acting unexpectedly". A session WITH a hard expiry is already
  // bounded by it. Only an explicit new session brings a dormant one back.
  // Here, in the ONE check, so it guards BOTH doors: the X-Hadron-Session
  // header and the MCP connection binding (#1665): a dormant session neither
  // binds nor attributes writes.
  if (!session.expiresAt) {
    const lastEvent = (await loadLastEventBySession(db as never, [session.id])).get(session.id);
    const days = session.app?.sessionDormancyDays ?? DEFAULT_SESSION_DORMANCY_DAYS;
    if (isSessionDormant(session, lastEvent, days, now)) return { binding: null, ended: false };
  }
  return { binding: { sessionId: session.id, actor: { workerId: session.workerId, agentId: session.agentId } }, ended: false };
}
