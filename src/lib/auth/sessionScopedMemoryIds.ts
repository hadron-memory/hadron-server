/**
 * The App-key-with-active-session memory scope — the hard isolation boundary
 * for multi-user agents, as ONE predicate with two callers.
 *
 * When an App key operates inside a session, it is confined to that session's
 * memory plus the bound agent's system memory: even if an LLM asks for another
 * memory by id, the filter denies it. Two surfaces implement that confinement —
 * the GraphQL gate (`getAccessibleMemoryIds` in `resolvers.helpers.ts`) and the
 * MCP node-search scope (`src/mcp/server.ts`) — and until #945 each carried its
 * own copy of the rule, the second one annotated "mirrors the resolver's
 * app+session branch". A rule that is written down twice is a rule that will be
 * fixed once (`findings:public-read-predicate-has-two-copies`), so it lives here
 * now and both call sites delegate.
 *
 * ## Why the admissibility checks exist (#945)
 *
 * This branch was written when `startAgentSession` was the ONLY writer of
 * `Session.memoryId` / `Session.agentId`. Their provenance was therefore
 * implicit: the App provisioned both, in the same call, for itself. The branch
 * could trust the row because the App had authored it.
 *
 * That is no longer true. `SessionInput.agentRef` (#928) and `SessionInput.appRef`
 * (#943) made both pivots caller-suppliable, and the session id is caller-chosen
 * too — so a session row is now partly caller-authored INPUT. Unguarded, the
 * branch inverts: instead of NARROWING an App key to its session, it GRANTS the
 * App key whatever memory a session happens to name.
 *
 * The live case that closes: `agentRef` gates only on the agent being READABLE,
 * so a foreign PUBLIC agent may legitimately be bound to a session. Binding one
 * must not hand this App's key that agent's system memory (its system prompt and
 * role definitions). This is the read-side mirror of the write-side
 * `SESSION_AGENT_NOT_IN_APP` check in `resolvers.teamChat.ts` — same asymmetry,
 * other half.
 *
 * Both checks are no-ops for every session `startAgentSession` creates, which is
 * the point: they re-state in code an invariant that used to hold only by
 * construction.
 *
 * What this deliberately does NOT do is intersect with `getAppMemoryAccess`.
 * That map is the App's *management* reach (its primary agent's system memory +
 * that agent's linked memories) and it excludes per-user memories entirely — so
 * intersecting with it would deny the multi-user-agent case this branch exists
 * to serve. The admissible set is a UNION of legitimate provenances, not an
 * intersection with a set that was never meant to cover them.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import { isAgentInstalled } from '../appAgent.js';

/**
 * Memory ids an App key may reach while operating inside `sessionId`.
 *
 * @param db      Prisma client.
 * @param appId   The AUTHENTICATED App (a credential, never a selection — the
 *                caller must have established that `sessionId` belongs to this
 *                App, which `src/middleware/auth.ts` does at bind time).
 * @param sessionId The active session.
 * @returns The admissible ids — possibly empty, never null.
 */
export async function sessionScopedMemoryIds(
  db: PrismaClient,
  appId: string,
  sessionId: string,
): Promise<string[]> {
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: {
      agentId: true,
      memory: { select: { id: true, appId: true, userMemoryOfAgentId: true } },
      agent: { select: { systemMemoryId: true } },
    },
  });
  if (!session) return [];

  const ids: string[] = [];

  // The session memory is admissible when it is tied to THIS App or to THIS
  // session's agent. Three legitimate provenances, matching the three ways a
  // session memory legitimately comes to be:
  //
  //   1. provisioned BY this App (`startAgentSession` stamps `appId`);
  //   2. the per-user / anonymous memory OF this session's agent — which also
  //      covers the REUSE case, where a memory keyed on (agent, user) was first
  //      provisioned by a DIFFERENT App that installed the same agent;
  //   3. a memory this session's agent is LINKED to (`AgentMemoryItem`) — the
  //      schema's "active write-memory for this session" case, which is how a
  //      session names an org knowledge memory rather than a per-user one.
  //
  // Note (3) is checked against THIS session's agent rather than through
  // `getAppMemoryAccess`, which folds in only the App's FIRST installed agent —
  // wrong for a multi-agent App (a team App installs one agent per persona).
  const mem = session.memory;
  if (mem) {
    const tiedToApp = mem.appId === appId;
    const isAgentsOwnMemory =
      session.agentId !== null && mem.userMemoryOfAgentId === session.agentId;
    const isAgentLinked =
      !tiedToApp &&
      !isAgentsOwnMemory &&
      session.agentId !== null &&
      (await db.agentMemoryItem.findFirst({
        where: { agentId: session.agentId, memoryId: mem.id, deletedAt: null },
        select: { id: true },
      })) !== null;
    if (tiedToApp || isAgentsOwnMemory || isAgentLinked) ids.push(mem.id);
  }

  // The agent's system memory rides on the INSTALL, not on the session binding.
  if (
    session.agentId &&
    session.agent?.systemMemoryId &&
    (await isAgentInstalled(db, appId, session.agentId))
  ) {
    ids.push(session.agent.systemMemoryId);
  }

  return ids;
}
