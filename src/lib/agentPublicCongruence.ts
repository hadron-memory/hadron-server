/**
 * cor:acl:080:03 — the Agent-PUBLIC congruence invariant.
 *
 * An Agent may be `visibility = PUBLIC` only when every memory in its COVERED
 * SET is itself `visibility = PUBLIC`. The covered set is the memories linked
 * via an ACTIVE `AgentMemoryItem`, EXCLUDING memories that can never be part of
 * an agent's public surface:
 *   - per-user personal/private (`class IN ('personal','private')`) — owner-only
 *     by class, never PUBLIC;
 *   - app-scoped (`appId != null`) — App-internal even at `visibility=PUBLIC`
 *     (#653: `effectiveAccess` blocks public read via `!isAppScopedShared`), so
 *     it is never publicly readable regardless of its visibility value.
 * The agent's system memory is `class='system'` (visibility is always NULL —
 * `chk_memory_visibility_class`) and is governed by its class, NOT this check;
 * it is linked via `Agent.systemMemoryId`, never `AgentMemoryItem`.
 *
 * Enforced at WRITE time on both sides so a read may trust `Agent.visibility ===
 * PUBLIC` alone (Phase-3 `hasPublicResources`) without walking the agent's
 * memories:
 *   - setting an agent PUBLIC (updateAgent),
 *   - un-PUBLIC-ing a covered memory linked to a PUBLIC agent (updateMemory),
 *   - linking a covered non-PUBLIC memory to a PUBLIC agent (addMemoryToAgent).
 */
import { GraphQLError } from 'graphql';
import type { PrismaClient, Prisma } from '../generated/prisma/index.js';

type Db = PrismaClient | Prisma.TransactionClient;

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/** True when a memory is excluded from the covered set (never publicly readable). */
function isExcludedFromCoveredSet(memory: { class: string; appId: string | null }): boolean {
  return memory.class === 'personal' || memory.class === 'private' || memory.appId != null;
}

/**
 * The agent's covered-set memories that would VIOLATE congruence — active
 * `AgentMemoryItem` links to non-excluded memories that are not PUBLIC.
 */
export async function nonPublicLinkedMemories(
  db: Db,
  agentId: string,
): Promise<{ id: string; name: string }[]> {
  return db.memory.findMany({
    where: {
      deletedAt: null,
      class: { notIn: ['personal', 'private'] }, // per-user owner-only: excluded
      appId: null, // app-scoped: App-internal even if PUBLIC (#653) — excluded
      visibility: { not: 'PUBLIC' },
      agentItems: { some: { agentId, deletedAt: null } },
    },
    select: { id: true, name: true },
  });
}

/**
 * Guard for setting an agent PUBLIC: reject if any covered-set memory is not
 * PUBLIC. Call before persisting `visibility = PUBLIC`.
 */
export async function assertAgentPublicAllowed(db: Db, agentId: string): Promise<void> {
  const bad = await nonPublicLinkedMemories(db, agentId);
  if (bad.length === 0) return;
  const names = bad.map((m) => m.name).join(', ');
  throw badInput(
    `Cannot make this agent PUBLIC: it links ${bad.length} non-public ` +
      `memor${bad.length === 1 ? 'y' : 'ies'} (${names}). Make ${bad.length === 1 ? 'it' : 'them'} ` +
      `PUBLIC first, or unlink — a PUBLIC agent may reference only PUBLIC knowledge (cor:acl:080:03).`,
  );
}

/**
 * Guard for the reverse side (un-PUBLIC-ing a memory): reject if a COVERED
 * memory whose visibility is about to become non-PUBLIC is linked to any PUBLIC
 * agent. Excluded memories (per-user, app-scoped) never block. Pass the memory
 * row (class + appId) and its INTENDED next visibility.
 */
export async function assertMemoryVisibilityChangeAllowed(
  db: Db,
  memory: { id: string; class: string; appId: string | null },
  nextVisibility: string | null | undefined,
): Promise<void> {
  if (isExcludedFromCoveredSet(memory)) return; // not part of any public surface
  if (nextVisibility === 'PUBLIC') return; // still public — congruence preserved
  const publicAgent = await db.agent.findFirst({
    where: {
      deletedAt: null,
      visibility: 'PUBLIC',
      memoryItems: { some: { memoryId: memory.id, deletedAt: null } },
    },
    select: { name: true },
  });
  if (publicAgent) {
    throw badInput(
      `Cannot make this memory non-public: it is knowledge of the PUBLIC agent ` +
        `"${publicAgent.name}". Make the agent non-public first, or unlink the memory ` +
        `(cor:acl:080:03).`,
    );
  }
}

/**
 * Guard for linking a memory to an agent: reject if the target agent is PUBLIC
 * and the memory is a COVERED, non-PUBLIC memory. Excluded memories (per-user,
 * app-scoped) may always be linked. `memory` is the row being linked.
 */
export async function assertLinkAllowedForPublicAgent(
  agentVisibility: string | null,
  memory: { class: string; appId: string | null; visibility: string | null },
): Promise<void> {
  if (agentVisibility !== 'PUBLIC') return;
  if (isExcludedFromCoveredSet(memory)) return; // per-user / app-scoped: allowed
  if (memory.visibility === 'PUBLIC') return;
  throw badInput(
    `Cannot link a non-public memory to a PUBLIC agent — a PUBLIC agent may ` +
      `reference only PUBLIC knowledge. Make the memory PUBLIC first, or make the ` +
      `agent non-public (cor:acl:080:03).`,
  );
}
