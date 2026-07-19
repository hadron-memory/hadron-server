/**
 * cor:acl:080:03 — the Agent-PUBLIC congruence invariant.
 *
 * An Agent may be `visibility = PUBLIC` only when every memory it links via an
 * ACTIVE `AgentMemoryItem` (excluding per-user personal/private, which are
 * owner-only by class and can never be PUBLIC) is itself `visibility = PUBLIC`.
 * The agent's system memory is `class='system'` (visibility is always NULL —
 * `chk_memory_visibility_class`) and is governed by its class, NOT this check;
 * it is linked via `Agent.systemMemoryId`, never `AgentMemoryItem`.
 *
 * Enforced at WRITE time on both sides so a read may trust `Agent.visibility ===
 * PUBLIC` alone (Phase-3 `hasPublicResources`) without walking the agent's
 * memories:
 *   - setting an agent PUBLIC (updateAgent),
 *   - un-PUBLIC-ing a memory linked to a PUBLIC agent (updateMemory),
 *   - linking a non-PUBLIC memory to a PUBLIC agent (addMemoryToAgent).
 */
import { GraphQLError } from 'graphql';
import type { PrismaClient, Prisma } from '../generated/prisma/index.js';

type Db = PrismaClient | Prisma.TransactionClient;

const badInput = (message: string) =>
  new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });

/**
 * The agent's covered-set memories that would VIOLATE congruence — active
 * `AgentMemoryItem` links to non-per-user memories that are not PUBLIC.
 */
export async function nonPublicLinkedMemories(
  db: Db,
  agentId: string,
): Promise<{ id: string; name: string }[]> {
  return db.memory.findMany({
    where: {
      deletedAt: null,
      class: { notIn: ['personal', 'private'] }, // per-user owner-only: excluded
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
 * Guard for the reverse side (un-PUBLIC-ing a memory): reject if a memory whose
 * visibility is about to become non-PUBLIC is linked to any PUBLIC agent. Pass
 * the memory's INTENDED next visibility. No-op when it stays PUBLIC.
 */
export async function assertMemoryVisibilityChangeAllowed(
  db: Db,
  memoryId: string,
  nextVisibility: string | null | undefined,
): Promise<void> {
  if (nextVisibility === 'PUBLIC') return; // still public — congruence preserved
  const publicAgent = await db.agent.findFirst({
    where: {
      deletedAt: null,
      visibility: 'PUBLIC',
      memoryItems: { some: { memoryId, deletedAt: null } },
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
 * and the memory is a non-per-user, non-PUBLIC memory. `memory` is the row being
 * linked (its class + visibility).
 */
export async function assertLinkAllowedForPublicAgent(
  agentVisibility: string | null,
  memory: { class: string; visibility: string | null },
): Promise<void> {
  if (agentVisibility !== 'PUBLIC') return;
  if (memory.class === 'personal' || memory.class === 'private') return; // excluded
  if (memory.visibility === 'PUBLIC') return;
  throw badInput(
    `Cannot link a non-public memory to a PUBLIC agent — a PUBLIC agent may ` +
      `reference only PUBLIC knowledge. Make the memory PUBLIC first, or make the ` +
      `agent non-public (cor:acl:080:03).`,
  );
}
