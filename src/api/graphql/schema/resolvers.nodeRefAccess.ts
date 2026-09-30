import type { Context } from './resolvers.helpers.js';
import { isMemoryReadableCached } from './resolvers.helpers.js';
import { NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveNodeRef, isConcealedNodeRefAmbiguity } from '../../../lib/entityRef/nodeRef.js';

/**
 * Apply the node-content gate before exposing an ambiguous historical URN.
 * A caller who can read no current claimant gets the same not-found as a
 * nonexistent ref; if any claimant is readable, the globally ambiguous ref
 * is refused without selecting a claimant by visibility (cor:urn:030:01/:02).
 */
export async function resolveNodeRefForCaller(
  ctx: Context,
  ref: string,
  contextMemoryId?: string,
  options?: { includeDeleted?: boolean },
): Promise<{ id: string }> {
  try {
    return await resolveNodeRef(ctx.db, ref, contextMemoryId, options);
  } catch (error) {
    if (await isConcealedNodeRefAmbiguity(ctx.db, error,
      (memoryId) => isMemoryReadableCached(ctx, memoryId))) {
      throw new NodeNotFoundError(ref);
    }
    throw error;
  }
}
