import type { Context } from './resolvers.helpers.js';
import { isAuthorizationDenial, requireOwnerOrOrgRole } from './resolvers.helpers.js';
import { activeAppInstallLicenseIdsForAgent } from '../../../lib/appAgent.js';
import type { AuthorityAnchor } from '../../../lib/auth/authorityAnchors.js';

/** The Agent columns {@link canChatWithAgent} decides from. */
export interface ChatAgentRow {
  id: string;
  organizationId: string | null;
  ownerUserId: string | null;
  visibility: string | null;
  deletedAt: Date | null;
}

/**
 * The Apps that can carry this caller's right to chat with this Agent (#1585
 * review, Atilla): ONE set shared by the gate (`canChatWithAgent`) and the
 * anchor selection (`chatAuthorityAnchors`), so the two cannot drift apart.
 * An App qualifies only if it is live, not uninstalled, its owner is live (a
 * dead tenant's App grants nothing, the #1370 rule; `withAuthorizedTx` also
 * refuses a deleted org or user anchor), and its install of the Agent holds a
 * live license. The candidates are the calling App for a pure App key, or for
 * a user every App they are a member of that installs the Agent.
 */
export async function chatCarrierApps(
  ctx: Context,
  agentId: string,
): Promise<Array<{ id: string; organizationId: string | null; ownerUserId: string | null }>> {
  const candidateIds = ctx.appId && !ctx.userId
    ? [ctx.appId]
    : ctx.userId
      ? (await ctx.db.appMember.findMany({
          where: { userId: ctx.userId, app: { appAgents: { some: { agentId } } } },
          select: { appId: true },
        })).map((m) => m.appId)
      : [];
  if (candidateIds.length === 0) return [];
  const apps = await ctx.db.app.findMany({
    where: {
      id: { in: candidateIds },
      deletedAt: null,
      uninstalledAt: null,
      OR: [{ organizationId: null }, { organization: { deletedAt: null } }],
      AND: [{ OR: [{ ownerUserId: null }, { ownerUser: { deletedAt: null } }] }],
    },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (apps.length === 0) return [];
  const licensed = await activeAppInstallLicenseIdsForAgent(ctx.db, agentId, apps.map((a) => a.id));
  return apps.filter((a) => licensed.has(a.id));
}

/**
 * May this caller start a chat with this Agent (#1581)? Starting a chat reads
 * the Agent's definition (its system prompt and conversation structure) and
 * auto-provisions the caller's `AgentSubscription`, so it needs the same reach
 * as reading the Agent, plus the one extra path an App's end users rely on:
 *
 * - a pure App key: the Agent is installed in that App with a live license
 *   with a live owner (`chatCarrierApps`; the #1526 App-key rule);
 * - a user: the Agent is PUBLIC, the user's own, or in an org the user can
 *   read (`requireOwnerOrOrgRole(…, 'READER')`, the `Query.agent` gate), OR the
 *   user is an AppMember of an App with a live owner and a live, licensed
 *   install of the Agent, which is how an App's end users who are not org
 *   members reach it (`chatCarrierApps`, shared with the anchor selection).
 *
 * Anything else, including an anonymous caller and a soft-deleted Agent, is
 * refused. `opts.carriers` lets a caller decide from a carrier set it has
 * already read and verified (startChat's anchored transaction, #1585), so the
 * admission and the anchor-coverage proof come from ONE read. Callers answer a refusal exactly as an unknown Agent, so it
 * discloses nothing.
 */
export async function canChatWithAgent(
  ctx: Context,
  agent: ChatAgentRow,
  opts: { carriers?: ReadonlyArray<{ id: string }> } = {},
): Promise<boolean> {
  if (agent.deletedAt) return false;

  if (ctx.appId && !ctx.userId) {
    return (opts.carriers ?? await chatCarrierApps(ctx, agent.id)).length > 0;
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

  return (opts.carriers ?? await chatCarrierApps(ctx, agent.id)).length > 0;
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

/**
 * The authority anchors a chat start must hold (#1573; Atilla's anchor-set
 * review): every source `canChatWithAgent` can admit, so no revoker of any of
 * them can return while the new subscription is still about to commit.
 *
 * - the Agent, and the subscription's TARGET user (an App key has no actor
 *   user for `withAuthorizedTx` to add);
 * - the Agent's owner (org or user), which a direct read right comes from;
 * - each App that can carry the right, plus its owner: exactly
 *   `chatCarrierApps`, the same set the gate admits through.
 *
 * Only live Apps with a live owner are anchored, because `withAuthorizedTx`
 * refuses a deleted App, org or user among its anchors; the gate re-runs on
 * the transaction afterwards.
 */
export async function chatAuthorityAnchors(
  ctx: Context,
  agent: { id: string; organizationId: string | null; ownerUserId: string | null },
  subjectUserId: string | null,
): Promise<AuthorityAnchor[]> {
  const anchors: AuthorityAnchor[] = [{ kind: 'agent', id: agent.id }];
  if (subjectUserId) anchors.push({ kind: 'user', id: subjectUserId });
  if (agent.organizationId) anchors.push({ kind: 'org', id: agent.organizationId });
  if (agent.ownerUserId) anchors.push({ kind: 'user', id: agent.ownerUserId });

  for (const app of await chatCarrierApps(ctx, agent.id)) {
    anchors.push({ kind: 'app', id: app.id });
    if (app.organizationId) anchors.push({ kind: 'org', id: app.organizationId });
    if (app.ownerUserId) anchors.push({ kind: 'user', id: app.ownerUserId });
  }
  return anchors;
}
