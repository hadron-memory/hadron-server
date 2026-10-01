import type { Context } from './resolvers.helpers.js';
import { isAuthorizationDenial, requireOwnerOrOrgRole } from './resolvers.helpers.js';
import { activeAppInstallLicenseIdsForAgent, isAgentInstalledAndLicensed } from '../../../lib/appAgent.js';

/** The Agent columns {@link canChatWithAgent} decides from. */
export interface ChatAgentRow {
  id: string;
  organizationId: string | null;
  ownerUserId: string | null;
  visibility: string | null;
  deletedAt: Date | null;
}

/**
 * May this caller start a chat with this Agent (#1581)? Starting a chat reads
 * the Agent's definition (its system prompt and conversation structure) and
 * auto-provisions the caller's `AgentSubscription`, so it needs the same reach
 * as reading the Agent, plus the one extra path an App's end users rely on:
 *
 * - a pure App key: the Agent is installed in that App with a live license
 *   (`isAgentInstalledAndLicensed`, the #1526 App-key rule);
 * - a user: the Agent is PUBLIC, the user's own, or in an org the user can
 *   read (`requireOwnerOrOrgRole(…, 'READER')`, the `Query.agent` gate), OR the
 *   user is an AppMember of an App with a live, licensed install of the Agent,
 *   which is how an App's end users who are not org members reach it
 *   (`activeAppInstallLicenseIdsForAgent`, the shared-chat rule).
 *
 * Anything else, including an anonymous caller and a soft-deleted Agent, is
 * refused. Callers answer a refusal exactly as an unknown Agent, so it
 * discloses nothing.
 */
export async function canChatWithAgent(ctx: Context, agent: ChatAgentRow): Promise<boolean> {
  if (agent.deletedAt) return false;

  if (ctx.appId && !ctx.userId) {
    return isAgentInstalledAndLicensed(ctx.db, ctx.appId, agent.id);
  }
  if (!ctx.userId) return false;

  if (agent.visibility === 'PUBLIC') return true;
  if (agent.ownerUserId !== null && agent.ownerUserId === ctx.userId) return true;
  if (agent.organizationId !== null) {
    try {
      await requireOwnerOrOrgRole(ctx, agent, 'READER');
      return true;
    } catch (error) {
      if (!isAuthorizationDenial(error)) throw error;
    }
  }

  const memberships = await ctx.db.appMember.findMany({
    where: { userId: ctx.userId, app: { appAgents: { some: { agentId: agent.id } } } },
    select: { appId: true },
  });
  if (memberships.length === 0) return false;
  const licensed = await activeAppInstallLicenseIdsForAgent(
    ctx.db, agent.id, memberships.map((m) => m.appId),
  );
  return licensed.size > 0;
}
