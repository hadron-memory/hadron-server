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

/**
 * May a pure App key start a chat on behalf of `userId` (#1581; Ada #6055,
 * #6070, #6098)? Only for a LIVE AppMember of that very App, or a user that
 * very App minted (`User.externalAppId`, not deleted). An
 * `AgentSubscription` does not count: it is keyed (user, Agent) with no App,
 * so a user licensed through App X would otherwise pass App Y's check whenever
 * Y installs the same Agent. A session-bound key may act only for its
 * session's own user, and an anonymous session (no user) names nobody.
 * Callers refuse anything else as an unknown user.
 */
export async function appKeyMayActFor(ctx: Context, userId: string): Promise<boolean> {
  if (!ctx.appId) return false;
  if (ctx.sessionId) {
    const session = await ctx.db.session.findUnique({
      where: { id: ctx.sessionId },
      select: { appId: true, userId: true },
    });
    if (!session || session.appId !== ctx.appId) return false;
    if (session.userId === null || session.userId !== userId) return false;
  }
  const member = await ctx.db.appMember.findUnique({
    where: { appId_userId: { appId: ctx.appId, userId } },
    select: { userId: true },
  });
  if (member !== null) return true;
  // Ada #6098: or a user THIS App minted (createAppUser stamps externalAppId).
  // App-scoped by construction, and the only satisfying path for App-created
  // users, who never get an AppMember row (Chip, #1583 QA).
  const minted = await ctx.db.user.findFirst({
    where: { id: userId, externalAppId: ctx.appId, deletedAt: null },
    select: { id: true },
  });
  return minted !== null;
}

/**
 * Is a session-bound pure App key starting a chat with the Agent its session
 * is bound to (#1581, Atilla; Ada #6070)? `startChat` hosts the chat in the
 * session's memory, so a key with Agents A and B installed must not put B's
 * chat into A's session.
 */
export async function appKeySessionMatchesAgent(ctx: Context, agentId: string): Promise<boolean> {
  if (!ctx.appId || !ctx.sessionId) return true;
  const session = await ctx.db.session.findUnique({
    where: { id: ctx.sessionId },
    select: { appId: true, agentId: true },
  });
  return session !== null && session.appId === ctx.appId && session.agentId === agentId;
}
