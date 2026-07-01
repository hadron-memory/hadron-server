// appQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { decryptToken } from '../../../lib/tokenCrypto.js';
import { DEFAULT_AI_CONFIG_NAME } from '../../../lib/aiConfig.js';
import { getDeploymentInfo } from '../../../mcp/deploymentInfo.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { GraphQLError } from 'graphql';
import {
  type Context,
  requireOrgRole,
  APP_INCLUDE,
} from './resolvers.helpers.js';

export const appQueries = {
    serverInfo: async (_: unknown, __: unknown, ___: Context) => getDeploymentInfo(),

    apps: async (_: unknown, { orgId }: { orgId: string }, ctx: Context) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      return ctx.db.app.findMany({
        where: { organizationId: resolvedOrgId, deletedAt: null },
        include: APP_INCLUDE,
        orderBy: { name: 'asc' },
      });
    },

    app: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      // Soft "not found" (return null) preserves existing semantics —
      // resolveAppRef would throw on missing/deleted, so swallow.
      let resolvedId: string;
      try {
        ({ id: resolvedId } = await resolveAppRef(ctx.db, id));
      } catch {
        return null;
      }
      const app = await ctx.db.app.findUnique({ where: { id: resolvedId }, include: APP_INCLUDE });
      if (!app || app.deletedAt) return null;
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      return app;
    },

    myApp: async (_: unknown, __: unknown, ctx: Context) => {
      // Returns the App for the current AppKey (ctx.appId set by auth middleware).
      if (!ctx.appId) return null;
      return ctx.db.app.findUnique({
        where: { id: ctx.appId, deletedAt: null },
        include: APP_INCLUDE,
      });
    },

    myApps: async (_: unknown, __: unknown, ctx: Context) => {
      // Apps where the current user is a member of the App's org. App doesn't
      // carry userId, so org membership is the routing.
      if (!ctx.userId) return [];
      const memberships = await ctx.db.orgMember.findMany({
        where: { userId: ctx.userId, deletedAt: null },
        select: { organizationId: true },
      });
      const orgIds = memberships.map((m) => m.organizationId);
      if (orgIds.length === 0) return [];
      return ctx.db.app.findMany({
        where: { organizationId: { in: orgIds }, deletedAt: null },
        include: APP_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    },

    appAIConfig: async (_: unknown, { appId }: { appId: string }, ctx: Context) => {
      // 007-entity-id-or-urn: appId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      // Org-scoped auth: ADMIN of the App's org (or platform ADMIN) sees the
      // decrypted key.
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      }
      // 036-ai-service-config: registry-backed — the App's 'default'
      // config (single-entity contract preserved; no resolution walk).
      const config = await ctx.db.aiServiceConfig.findFirst({
        where: { appId: resolvedAppId, name: DEFAULT_AI_CONFIG_NAME },
      });
      if (!config?.apiKeyEncrypted) return null;
      return {
        provider: config.provider,
        apiKey: decryptToken(config.apiKeyEncrypted),
        model: config.model,
      };
    },

    appKeys: async (_: unknown, { appId }: { appId: string }, ctx: Context) => {
      // 007-entity-id-or-urn: appId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      }
      return ctx.db.appKey.findMany({
        where: { appId: resolvedAppId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    },

    // 025-oauth-for-mcp FR-004: list caller's own user-scoped API keys
    // (active + revoked — deliberate difference from `appKeys` query,
    // which returns active-only for the admin app-key list; this query
    // powers the user's self-service audit log so revoked keys must
    // remain visible). AppKey-resolved callers rejected (no user
    // context).
    //
    // `id desc` tiebreaker on createdAt ties (cuid is monotonic-ish so
    // this is effectively a fingerprint); guarantees deterministic
    // ordering regardless of millisecond ties.
    myUserApiKeys: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) {
        throw new GraphQLError(
          'myUserApiKeys requires a user-scoped credential.',
          { extensions: { code: 'UNAUTHENTICATED' } },
        );
      }
      return ctx.db.userApiKey.findMany({
        where: { userId: ctx.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    },
};

