/**
 * Slack-connection write surface (spec 043 Phase 2). Registration is the
 * whole "OAuth" story for a Socket Mode install: the org admin holds the
 * bot (xoxb-) + app-level (xapp-) tokens from the manifest-created Slack
 * app; core authorizes, the TOOL validates both live and stores them
 * encrypted, core stores identity only.
 */
import { GraphQLError } from 'graphql';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { createSlackToolConnection, deleteSlackToolConnection } from '../../../lib/slackClient.js';
import type { Context } from './resolvers.helpers.js';
import { requireOrgRole } from './resolvers.helpers.js';

export const slackMutations = {
  /**
   * Register a workspace install: org ADMIN/OWNER, App must belong to the
   * org, one live connection per (org, workspace).
   */
  createSlackConnection: async (
    _: unknown,
    { orgRef, appRef, botToken, appToken }: { orgRef: string; appRef: string; botToken: string; appToken: string },
    ctx: Context,
  ) => {
    // cor:api:140 — orgRef/appRef accept ID, bare URN, or prefixed URN.
    const { id: organizationId } = await resolveOrgRef(ctx.db, orgRef);
    await requireOrgRole(ctx, organizationId, 'ADMIN');
    const { id: defaultAppId } = await resolveAppRef(ctx.db, appRef);
    const app = await ctx.db.app.findUniqueOrThrow({ where: { id: defaultAppId }, select: { organizationId: true } });
    if (app.organizationId !== organizationId) {
      throw new GraphQLError('The App must belong to the organization.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    // The tool validates both tokens live and derives the workspace + BOTH
    // bot ids; the tokens go no further than this call.
    const identity = await createSlackToolConnection('slack', { botToken, appToken });

    const existing = await ctx.db.slackConnection.findFirst({
      where: { organizationId, teamId: identity.teamId, deletedAt: null },
      select: { id: true },
    });
    if (existing) {
      // Roll back the tool row we just created — the org already has a live
      // connection for this workspace.
      void deleteSlackToolConnection('slack', identity.id);
      throw new GraphQLError(`This workspace is already connected (${existing.id}).`, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }

    try {
      return await ctx.db.slackConnection.create({
        data: {
          organizationId,
          defaultAppId,
          toolConnectionId: identity.id,
          teamId: identity.teamId,
          teamName: identity.teamName,
          botUserId: identity.botUserId,
          botId: identity.botId,
          createdBy: ctx.userId ?? null,
        },
      });
    } catch (err) {
      // The identity row failed to land — don't leave an orphaned tool
      // connection holding a socket.
      void deleteSlackToolConnection('slack', identity.id);
      // A concurrent duplicate hits the PARTIAL unique
      // (slack_connections_org_team_active_uniq) — same answer as the
      // pre-check, which only exists for the friendly common case.
      if ((err as { code?: string } | null)?.code === 'P2002') {
        throw new GraphQLError('This workspace is already connected.', {
          extensions: { code: 'BAD_USER_INPUT' },
        });
      }
      throw err;
    }
  },

  /** Soft-delete + best-effort tool teardown (fire-and-forget by contract). */
  deleteSlackConnection: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    const connection = await ctx.db.slackConnection.findFirst({ where: { id: ref, deletedAt: null } });
    if (!connection) {
      throw new GraphQLError('Slack connection not found.', { extensions: { code: 'NOT_FOUND' } });
    }
    await requireOrgRole(ctx, connection.organizationId, 'ADMIN');
    await ctx.db.slackConnection.update({
      where: { id: connection.id },
      data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null },
    });
    void deleteSlackToolConnection(connection.provider, connection.toolConnectionId);
    return true;
  },
};
