import { personalOrgAgentTextAllowed } from './personalOrgAgentInstall.js';
/**
 * The App-key-with-active-session memory scope — the hard isolation boundary
 * for multi-user agents, as ONE predicate with two callers.
 *
 * This helper returns the session's own reach: its memory plus the bound agent's
 * system memory. The read gates additionally admit explicitly named PUBLIC knowledge
 * read-only (0114 B); that exception never enters this discovery set or permits a write.
 * Two surfaces historically implemented the session confinement —
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
import { isAgentInstalledAndLicensed } from '../appAgent.js';
import { isActiveAgentSubscription } from '../agentSubscription.js';
import { validateSessionBinding } from '../../middleware/auth.js';
import { isSessionSupersededError } from '../sessionSuperseded.js';
import { isRunPrincipal } from './runPrincipal.js';

/**
 * Who is asking, beyond the App and the session (#3401, ruling 0203). Required at every call site so no caller
 * can leave out a term: an impersonation reaches nothing through a session, and a run principal never reaches a
 * private memory (#1719 R5a), even when it carries an App and a session.
 */
export interface SessionScopeCaller {
  clientId?: string | null;
  impersonation?: unknown;
}

/**
 * Memory ids an App key may reach while operating inside `sessionId`.
 *
 * @param db      Prisma client.
 * @param appId   The AUTHENTICATED App (a credential, never a selection — the
 *                caller must have established that `sessionId` belongs to this
 *                App, which `src/middleware/auth.ts` does at bind time).
 * @param sessionId The session the caller is bound to. It is re-validated on every call (#3401 D1).
 * @param caller  The rest of the principal (see {@link SessionScopeCaller}).
 * @returns The admissible ids — possibly empty, never null.
 */
export async function sessionScopedMemoryIds(
  db: PrismaClient,
  appId: string,
  sessionId: string,
  caller: SessionScopeCaller,
): Promise<string[]> {
  // #3401 D3: "the call isn't impersonating" is a term of the ruling (0203), not left to construction.
  if (caller.impersonation) return [];
  // #3401 D1 (cor:aut:020:02, only an active session binds): an MCP transport keeps the session it was opened
  // with, so a reach computed from that id alone would outlive the session. Every call re-validates it through the
  // ONE binding check (not ended, not past its hard expiry, not dormant, this App's), never a copy of it. A dead
  // session reaches nothing; a superseded one answers the same, since a read refusal must not differ (D4).
  if (!(await liveBinding(db, appId, sessionId))) return [];
  const app = await db.app.findUnique({
    where: { id: appId },
    select: {
      organizationId:true, ownerUserId:true, deletedAt: true, uninstalledAt: true,
      organization: { select: { deletedAt: true } },
    },
  });
  if (!app || app.deletedAt || app.uninstalledAt || app.organization?.deletedAt) return [];
  const session = await db.session.findUnique({
    where: { id: sessionId },
    select: {
      agentId: true,
      userId: true,
      memory: {
        select: {
          id: true, appId: true, userMemoryOfAgentId: true,
          class: true, userId: true, ownerUserId: true, createdBy: true, deletedAt: true,
          workerOf: { select: { id: true } },
        },
      },
      agent: {
        select: { systemMemoryId: true, deletedAt: true },
      },
    },
  });
  if (!session) return [];

  const ids: string[] = [];
  // Both Agent-derived legs need the same live install license. Cache it so a
  // linked session memory and system memory do not repeat that database walk.
  let licensedInstall: boolean | undefined;
  const hasLicensedInstall = async (): Promise<boolean> => {
    if (session.agentId === null) return false;
    if (licensedInstall === undefined) {
      licensedInstall = await isAgentInstalledAndLicensed(db, appId, session.agentId) &&
        await personalOrgAgentTextAllowed(db,app,session.agentId,session.userId);
    }
    return licensedInstall;
  };

  // The session memory is admissible when it is tied to THIS App or to THIS
  // session's agent. Three legitimate provenances, matching the three ways a
  // session memory legitimately comes to be:
  //
  //   1. provisioned BY this App (`startAgentSession` stamps `appId`);
  //   2. the per-user / anonymous memory OF this session's agent — including
  //      the existing personal-memory REUSE case, where startAgentSession
  //      keys on (agent, user) without the App;
  //   3. a memory this session's agent is LINKED to (`AgentMemoryItem`) — the
  //      schema's "active write-memory for this session" case, which is how a
  //      session names an org knowledge memory rather than a per-user one.
  //
  // Note (3) is checked against THIS session's agent rather than through
  // `getAppMemoryAccess`, which folds in only the App's FIRST installed agent —
  // wrong for a multi-agent App (a team App installs one agent per persona).
  const mem = session.memory;
  // A soft-deleted memory leaves the session row pointing at it (`deleteMemory`
  // stamps only the Memory), so a stale session would keep it readable.
  // `Session.memoryId` is caller-influenced. A same-App team or Worker row
  // satisfies the old App-provenance check but is not session scratch memory.
  if (mem && mem.deletedAt === null &&
      (mem.class !== 'app' ||
        (mem.userMemoryOfAgentId !== null && mem.workerOf.length === 0))) {
    // AgentMemoryItem is global to an Agent. An App B session cannot use it
    // (or the agent-own pointer) to read App A's knowledge or scratch memory.
    // Personal/private rows skip this filter only to meet the stricter App AND
    // Agent match below (#3401 D2); the owner + subscription check still applies.
    const strictClass = mem.class === 'personal' || mem.class === 'private';
    const foreignAppScoped = mem.appId !== null && mem.appId !== appId && !strictClass;
    const tiedToApp = mem.appId === appId;
    const isAgentsOwnMemory =
      !foreignAppScoped && session.agentId !== null && mem.userMemoryOfAgentId === session.agentId;
    // #3401 D2 (ruling 0203 + its NULL-app FIT): a personal or private memory is reached only when the session's
    // App AND Agent are the memory's. A NULL app_id matches no App (no installed-agent chain to line up, and
    // admitting it would hand the row to every App installing that Agent), and a foreign App's row is the
    // (app_id, user_id) isolation of spec 008. Either term alone is not enough for these two classes.
    const admitted = strictClass ? mem.appId !== null && tiedToApp && isAgentsOwnMemory : tiedToApp || isAgentsOwnMemory;
    // #1719 R5a: a run principal never reaches a private memory, whatever it carries.
    const runBarred = mem.class === 'private' && isRunPrincipal(caller);
    // #1376: every caller is a userless key, for which an AgentMemoryItem is never a grant
    // (cor:dmo:050:09), so an item-linked memory is not admitted here.
    if (admitted && !runBarred && (await identityMemoryLicensed(db, session, mem))) {
      ids.push(mem.id);
    }
  }

  // The agent's system memory rides on an ACTIVE install, not on the session
  // binding and not on the join row alone. `deleteAgent` soft-deletes the Agent
  // and its system Memory while leaving `AppAgent` in place, and a cross-org
  // install can have its `AgentOrgGrant` revoked or expire without the join row
  // going anywhere — `getAppMemoryAccess` collapses to an empty map in that
  // state (pinned by 008-multi-install-isolation), so honoring the join alone
  // here would keep serving a de-licensed agent's system memory.
  if (
    session.agentId &&
    session.agent?.systemMemoryId &&
    session.agent.deletedAt === null &&
    (await hasLicensedInstall())
  ) {
    ids.push(session.agent.systemMemoryId);
  }

  return ids;
}

/** The pure App-key leg of the one binding check; a typed supersession is a dead session here. */
async function liveBinding(db: PrismaClient, appId: string, sessionId: string): Promise<boolean> {
  try {
    return (await validateSessionBinding(db, { appId }, sessionId)) !== null;
  } catch (error) {
    if (isSessionSupersededError(error)) return false;
    throw error;
  }
}

/**
 * Per-user memory licensing. A personal/private session memory belongs to ONE
 * user; a legacy knowledge/group holding belongs to its creator. Both are
 * licensed by that user's AgentSubscription for the memory's agent —
 * the same pair `canReadMemory` requires on the user path
 * (`src/mcp/access-control.ts`), which an App-key principal never reaches
 * (`auth.userId !== memory.userId` denies it outright), so without this the
 * session branch would be the one place a revoked subscription still reads.
 *
 * `startAgentSession` calls `ensureAgentSubscription` immediately before
 * provisioning the memory, so this is a no-op for a live, licensed session.
 * Ordinary org knowledge and anonymous `app`-class scratch memories carry no
 * per-user license and pass through; legacy knowledge/group holdings do not.
 */
async function identityMemoryLicensed(
  db: PrismaClient,
  session: { userId: string | null },
  mem: {
    class: string | null;
    userId: string | null;
    ownerUserId: string | null;
    createdBy: string | null;
    userMemoryOfAgentId: string | null;
  },
): Promise<boolean> {
  const strictClass = mem.class === 'personal' || mem.class === 'private';
  // Spec-047 knowledge/group memories are owner-only even though their class
  // is shared. A pure App key has no user principal to satisfy that gate.
  if (mem.ownerUserId !== null && !strictClass) return false;
  const legacyHolding = mem.userMemoryOfAgentId != null &&
    (mem.class === 'knowledge' || mem.class === 'group');
  if (!strictClass && !legacyHolding) return true;
  // The memory belongs to one user; a session driven by anyone else must not
  // reach it even when the App provisioned both.
  const owner = strictClass ? mem.userId : mem.createdBy;
  if (owner === null || owner !== session.userId) return false;
  if (mem.userMemoryOfAgentId === null) return false;
  const sub = await db.agentSubscription.findUnique({
    where: { userId_agentId: { userId: owner, agentId: mem.userMemoryOfAgentId } },
  });
  return sub !== null && isActiveAgentSubscription(sub);
}
