/**
 * Read-side filter helpers for soft-deleted memories
 * (011-soft-delete-memory FR-001, FR-006).
 *
 * Two shapes:
 *
 * 1. `whereNotDeleted()` — composable Prisma WHERE fragment that excludes
 *    soft-deleted rows. Use in list-style queries (`myMemories`,
 *    marketplace, agent-attachment pickers, blended-graph aggregation).
 *
 * 2. `assertMemoryReadable(memory)` — throws `MemoryDeletedError` if the
 *    given Memory record has `deletedAt` set. Use in single-row resolvers
 *    (`memory(id)`, `memoryByUrn(urn)`, every node-resolving query that
 *    joins Memory). The thrown error carries the deletedAt timestamp and
 *    the deleter's display name (when known) so the portal's
 *    deleted-memory overlay can render without a second query.
 */

import { MemoryDeletedError } from './errors.js';

/** Composable Prisma WHERE fragment: `Memory.deletedAt IS NULL`. */
export function whereNotDeleted(): { deletedAt: null } {
  return { deletedAt: null };
}

/**
 * Composable Prisma WHERE fragment for the inverse view (Trash).
 * Pairs with `Query.deletedMemories` and the admin-only
 * `myMemories(includeDeleted: true)` branch.
 */
export function whereDeleted(): { deletedAt: { not: null } } {
  return { deletedAt: { not: null } };
}

/** The minimum-shaped Memory record `assertMemoryReadable` needs. */
export type ReadableMemoryInput = {
  id: string;
  deletedAt: Date | null;
  /** Joined `deletedBy → User` display name. Null when unknown. */
  deleterName?: string | null;
};

/**
 * Throws `MemoryDeletedError` if the memory has `deletedAt` set. The error
 * carries the timestamp and deleter name in its fields so the resolver can
 * surface them in `extensions` of the wrapping `GraphQLError`.
 */
export function assertMemoryReadable(memory: ReadableMemoryInput): void {
  if (memory.deletedAt !== null) {
    throw new MemoryDeletedError(memory.id, memory.deletedAt, memory.deleterName ?? null);
  }
}
