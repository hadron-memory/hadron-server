/**
 * #2458 slice 2 (cor:dmo:050:11): an open session finishes under the agent and role it was bound with. `changeWorkerAgent`
 * moves the worker row for the NEXT bind, so every read that serves a worker's OPEN session resolves its placement here
 * instead of from the live worker row. A reader that is not that session (a manager, the portal) reads the live row.
 *
 * A session with no stamped role (a worker-less session; after the S1 backfill nothing else) has no placement: the caller
 * falls back to the worker row, never errors.
 */
import { Prisma } from '../generated/prisma/index.js';

export interface SessionPlacement {
  agentId: string;
  role: string;
}

type SessionReader = { session: { findFirst: (args: never) => Promise<unknown> } };

/**
 * The placement of `workerId`'s open session: the one named by `sessionId` when given (the acting principal), else the
 * newest open one (the binding the matcher and the context reset serve). Null when there is none, or it carries none.
 */
export async function openSessionPlacement(
  db: unknown,
  workerId: string,
  sessionId?: string | null,
): Promise<SessionPlacement | null> {
  const s = (await (db as SessionReader).session.findFirst({
    where: { workerId, endedAt: null, deletedAt: null, ...(sessionId ? { id: sessionId } : {}) },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { agentId: true, role: true },
  } as never)) as { agentId: string | null; role: string | null } | null;
  return s?.agentId && s.role ? { agentId: s.agentId, role: s.role } : null;
}

/**
 * SQL: the newest open session's placement of the worker aliased `w`, as `os.agent_id` / `os.role`, both null when it
 * has none. Read as `COALESCE(os.agent_id, w.agent_id)` / `COALESCE(os.role, w.role)`. The newest-open ordering is the
 * binding family's (loadWorkersActivity), so a worker's family and its agent never come from different sessions.
 */
export const OPEN_SESSION_PLACEMENT_JOIN = Prisma.sql`
  LEFT JOIN LATERAL (
    SELECT CASE WHEN s.role IS NOT NULL THEN s.agent_id END AS agent_id, s.role AS role
    FROM sessions s
    WHERE s.worker_id = w.id AND s.ended_at IS NULL AND s.deleted_at IS NULL
    ORDER BY s.started_at DESC, s.id DESC LIMIT 1
  ) os ON true`;
