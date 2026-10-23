/**
 * #2281 — `Agent.clonedFromAgentRef`: the URN of the Agent this one was cloned from (#2245, R145/R146),
 * shown only to a caller who can read that source.
 *
 * The stored column is the source's URN as of clone time, with no FK (the source may be retired or
 * renamed). It names ANOTHER tenant's Agent, so the parent's read gate is not relied on (#552): the
 * source is looked up and must pass `readableNestedAgent`, the shared nested-Agent gate. The lookup
 * also matches `legacyUrn`, so a source whose URN was flipped to the v2 form since the clone still
 * resolves, and the value returned is the source's CURRENT `urn`. A non-clone, an unreadable source, a
 * soft-deleted source and a source that no longer resolves all answer null, indistinguishably.
 */
import type { Context } from './resolvers.helpers.js';
import { readableNestedAgent } from './resolvers.types.js';

export async function resolveClonedFromAgentRef(
  parent: { clonedFromAgentRef?: string | null },
  _args: unknown,
  ctx: Context,
): Promise<string | null> {
  const ref = parent.clonedFromAgentRef;
  if (!ref) return null;
  const source = await ctx.db.agent.findFirst({
    where: { OR: [{ urn: ref }, { legacyUrn: ref }] },
    select: { id: true, urn: true, deletedAt: true, visibility: true, organizationId: true, ownerUserId: true },
  });
  const readable = await readableNestedAgent(ctx, source);
  return readable ? readable.urn : null;
}

export const agentClonedFromFieldResolvers = {
  Agent: { clonedFromAgentRef: resolveClonedFromAgentRef },
};
