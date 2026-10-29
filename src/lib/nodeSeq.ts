/**
 * Sibling ordering helper, shared by the two single-node create surfaces
 * (the GraphQL `upsertNode` resolver and the MCP `hadron_create_node` tool) so they
 * assign `seq` identically.
 *
 * Rule (task): when a new node is added to an ALREADY-ORDERED sibling list it
 * should get the next seq, landing at the end. "Ordered" means at least one
 * sibling already carries a `seq`; an unordered (or empty) list is left alone
 * so we never impose an order that wasn't there.
 *
 * Spec: hrn:node:hadronmemory.com:specs:cor:dmo:020:01 (Node ordering).
 */

import type { Prisma } from '../generated/prisma/index.js';

/**
 * The `seq` a NEW node at `loc` should take to append to its sibling list, or
 * `null` when the list isn't ordered (no sibling has a seq) — in which case the
 * caller leaves `seq` null.
 *
 * Siblings = the direct children of the new node's parent loc within the same
 * memory (same depth, same parent prefix) — the same direct-child rule
 * `hadron_get_next_node` uses to walk ordered children.
 * For automatic nested creates, call on the writing transaction AFTER its
 * existing ancestor locks; the parent key serializes read-max plus insert (#443).
 * Root callers retain their historical behavior and have no sibling lock.
 *
 * Soft-deleted rows and the node itself are excluded (harmless on a fresh create,
 * correct when an upsert targets an existing loc).
 */
export async function nextSiblingSeq(
  db: Prisma.TransactionClient,
  memoryId: string,
  loc: string,
): Promise<number | null> {
  const depth = loc.split(':').length;
  const parentPrefix = depth > 1 ? loc.slice(0, loc.lastIndexOf(':') + 1) : null;

  // Only seq-bearing siblings matter; narrow by the parent prefix when the new
  // node isn't root-level so we don't scan the whole memory.
  const candidates = await db.node.findMany({
    where: {
      memoryId,
      deletedAt: null,
      seq: { not: null },
      ...(parentPrefix ? { loc: { startsWith: parentPrefix } } : {}),
      // Exclude the node itself; for root-level locs (no parentPrefix) also let
      // the DB drop nested nodes so we don't scan the whole memory's ordered
      // rows (PR #309 review). Array NOT = AND of negations.
      NOT: parentPrefix ? { loc } : [{ loc }, { loc: { contains: ':' } }],
    },
    select: { loc: true, seq: true },
  });

  let max: number | null = null;
  for (const c of candidates) {
    // Direct children only: a `startsWith` prefix also matches deeper
    // descendants, so keep just those at the new node's own depth.
    if (c.loc.split(':').length !== depth) continue;
    if (c.seq != null && (max === null || c.seq > max)) max = c.seq;
  }
  return max === null ? null : max + 1;
}
