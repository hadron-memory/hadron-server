/**
 * Resolve which memory an asset upload should target when the caller
 * (typically an agent's MCP tool, or a v1 GraphQL caller) has not
 * specified one explicitly.
 *
 * v2 spec (006-asset-upload-redesign): for an agent that has exactly
 * one writable memory under the calling user, that memory is the
 * implicit target. For agents with multiple writable memories, the
 * caller MUST specify — we do not silently pick. The v1 convention
 * "always pick the personal-per-agent memory" does not survive
 * multi-writable-memory agents (e.g. the coding agent attaches one
 * memory per repo) and can land assets in the wrong place.
 *
 * Used by:
 *  - The MCP tool `h-asset-request-upload` when the agent omits
 *    `memoryId` (per contracts/mcp-asset.md).
 *  - The v1 GraphQL `beginAssetUpload(agentUrn, ...)` deprecation path,
 *    which fails with AMBIGUOUS_MEMORY_TARGET when the agent has
 *    multiple writable memories rather than guessing (per FR-023).
 */

import type { PrismaClient } from '../../generated/prisma/index.js';

export interface ResolvedMemory {
  ok: true;
  memoryId: string;
}

export interface AmbiguousMemoryResult {
  ok: false;
  reason: 'AMBIGUOUS_MEMORY_TARGET';
  candidates: Array<{ id: string; urn: string; name: string }>;
}

export interface NoWritableMemoryResult {
  ok: false;
  reason: 'NO_WRITABLE_MEMORY';
}

export type MemoryResolutionResult =
  | ResolvedMemory
  | AmbiguousMemoryResult
  | NoWritableMemoryResult;

/**
 * Resolve the (user, agent) → memory function.
 *
 * Returns:
 *  - `{ ok: true, memoryId }` when exactly one writable memory exists
 *    under the agent in the calling user's context.
 *  - `{ ok: false, reason: 'AMBIGUOUS_MEMORY_TARGET', candidates }` when
 *    multiple writable memories exist. The caller surfaces the
 *    candidates so the agent can disambiguate on the next turn.
 *  - `{ ok: false, reason: 'NO_WRITABLE_MEMORY' }` when zero writable
 *    memories exist (e.g. a stateless email-receiver agent that writes
 *    only to the App memory).
 *
 * "Writable" here means an `AgentMemoryItem` row with `role = 'read-write'`
 * linking the agent to a memory. The userId parameter is currently
 * unused at the storage layer (the agent's writable-memory list is
 * shared across users today) but is part of the function signature
 * because future per-user memory scoping is anticipated; passing it
 * now means callers don't need to refactor when that lands.
 */
export async function resolveAgentWritableMemory(
  db: Pick<PrismaClient, 'agent'>,
  _userId: string,
  agentUrn: string,
): Promise<MemoryResolutionResult> {
  const agent = await db.agent.findUnique({
    where: { urn: agentUrn },
    select: {
      memoryItems: {
        where: { role: 'read-write' },
        select: {
          memory: {
            select: { id: true, urn: true, name: true, deletedAt: true },
          },
        },
      },
    },
  });
  if (!agent) {
    return { ok: false, reason: 'NO_WRITABLE_MEMORY' };
  }
  const writable = (agent.memoryItems ?? [])
    .map((item) => item.memory)
    .filter((m): m is { id: string; urn: string; name: string; deletedAt: Date | null } =>
      m !== null && m.deletedAt === null,
    );
  if (writable.length === 0) {
    return { ok: false, reason: 'NO_WRITABLE_MEMORY' };
  }
  if (writable.length === 1) {
    return { ok: true, memoryId: writable[0]!.id };
  }
  return {
    ok: false,
    reason: 'AMBIGUOUS_MEMORY_TARGET',
    candidates: writable.map((m) => ({ id: m.id, urn: m.urn, name: m.name })),
  };
}
