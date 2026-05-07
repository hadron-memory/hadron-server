/**
 * Typed errors for the Memory soft-delete lifecycle (011-soft-delete-memory).
 *
 * These are plain `Error` subclasses; the resolver layer wraps them as
 * `GraphQLError` with the appropriate `extensions.code` when they cross the
 * API boundary (see the existing wrap pattern at `resolvers.ts:112`).
 *
 * Each error carries the data the typed-error consumer needs, so the
 * portal's deleted-memory overlay (FR-014) can render the deletedAt
 * timestamp and deleter name without a second round-trip.
 */

/**
 * Thrown by `assertMemoryReadable` when a caller tries to read a memory or
 * its child entities and the memory has `deletedAt` set. The portal renders
 * this into the deleted-memory overlay; MCP clients format the message into
 * `isError = true` content for the agent.
 */
export class MemoryDeletedError extends Error {
  public readonly code = 'MEMORY_DELETED' as const;
  constructor(
    public readonly memoryId: string,
    public readonly deletedAt: Date,
    public readonly deleterName: string | null,
  ) {
    const deleterPhrase = deleterName ?? '[unknown]';
    super(
      `MEMORY_DELETED: Memory ${memoryId} was deleted by ${deleterPhrase} on ${deletedAt.toISOString()}.`,
    );
    this.name = 'MemoryDeletedError';
  }
}

/**
 * Thrown by `assertMemoryClassDeletable` when the caller targets a memory
 * whose class is not `knowledge`. Each non-knowledge class points the caller
 * at the correct alternative path (FR-003).
 *
 * The message is meant to be surfaced verbatim — agents and the portal
 * should not paraphrase it. The alternative-path sentence is what makes the
 * error actionable.
 */
export class ProtectedMemoryError extends Error {
  public readonly code = 'PROTECTED_MEMORY' as const;
  constructor(
    public readonly memoryId: string,
    public readonly memoryClass:
      | 'system'
      | 'app'
      | 'personal'
      | 'agent_system',
    message: string,
  ) {
    super(`PROTECTED_MEMORY: ${message}`);
    this.name = 'ProtectedMemoryError';
  }
}

/**
 * Thrown by `Mutation.createMemory` when the URN being claimed is occupied
 * by a memory currently in soft-delete (FR-008). The message surfaces the
 * conflict and points at the resolution paths.
 *
 * Distinct from a normal URN-already-exists error so callers (especially the
 * portal) can offer the right next step (Restore the soft-deleted memory, or
 * wait for retention).
 */
export class MemoryUrnOccupiedByDeletedError extends Error {
  public readonly code = 'MEMORY_URN_OCCUPIED_BY_DELETED' as const;
  constructor(
    public readonly urn: string,
    public readonly occupyingMemoryId: string,
    public readonly deletedAt: Date,
  ) {
    super(
      `MEMORY_URN_OCCUPIED_BY_DELETED: URN "${urn}" is occupied by a memory in Trash. Restore that memory or wait for the retention sweep before reusing this URN.`,
    );
    this.name = 'MemoryUrnOccupiedByDeletedError';
  }
}
