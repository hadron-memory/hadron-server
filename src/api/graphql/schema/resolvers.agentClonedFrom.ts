/**
 * #2281 — `Agent.clonedFromAgentRef`: the URN of the Agent this one was cloned from (#2245, R145/R146),
 * shown only to a caller who can read that source.
 *
 * It names ANOTHER tenant's Agent, so the parent's read gate is not relied on (#552): the source must
 * pass `readableNestedAgent`, the shared nested-Agent gate. The stored column is a URN with no FK, and a
 * URN is reusable (rename, retire, re-create), so it is only a presence marker here. The source is
 * resolved by IDENTITY: the clone audit row (`newAgentId` -> `sourceAgentId`) written in the clone's own
 * transaction. A replacement Agent that later took the old URN is therefore never authorized or shown.
 * The value returned is the source's CURRENT `urn`. A non-clone, an unreadable source, a soft-deleted
 * source and a clone with no audit row all answer null, indistinguishably.
 */
import type { Context } from './resolvers.helpers.js';
import { readableNestedAgent } from './resolvers.types.js';

export async function resolveClonedFromAgentRef(
  parent: { id: string; clonedFromAgentRef?: string | null },
  _args: unknown,
  ctx: Context,
): Promise<string | null> {
  const ref = parent.clonedFromAgentRef;
  if (!ref) return null;
  // Missing or ambiguous identity fails closed: exactly one distinct recorded source, or null.
  const audits = await ctx.db.agentCloneAudit.findMany({ where: { newAgentId: parent.id }, select: { sourceAgentId: true }, take: 2 });
  if (audits.length === 0 || (audits.length === 2 && audits[0].sourceAgentId !== audits[1].sourceAgentId)) return null;
  const audit = audits[0];
  const source = await ctx.db.agent.findUnique({
    where: { id: audit.sourceAgentId },
    select: { id: true, urn: true, deletedAt: true, visibility: true, organizationId: true, ownerUserId: true },
  });
  const readable = await readableNestedAgent(ctx, source);
  return readable ? readable.urn : null;
}

export const agentClonedFromFieldResolvers = {
  Agent: { clonedFromAgentRef: resolveClonedFromAgentRef },
};
