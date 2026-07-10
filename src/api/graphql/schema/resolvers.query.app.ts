// appQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { decryptToken } from '../../../lib/tokenCrypto.js';
import { DEFAULT_AI_CONFIG_NAME } from '../../../lib/aiConfig.js';
import { getDeploymentInfo } from '../../../mcp/deploymentInfo.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { GraphQLError } from 'graphql';
import {
  type Context,
  clampListTake,
  requireOrgRole,
  resolveOrgScope,
  APP_INCLUDE,
} from './resolvers.helpers.js';

export const appQueries = {
    serverInfo: async (_: unknown, __: unknown, ___: Context) => getDeploymentInfo(),

    // #473 — the uniform paginated app list; replaces the org-ADMIN
    // apps(orgId!) and the member myApps. App doesn't carry a userId, so org
    // membership is the routing; platform ADMIN/OWNER unscoped get every
    // live App. orgId follows cor:api:100:01 (member -> scope, non-member ->
    // empty page, no disclosure, no admin bypass).
    apps: async (
      _: unknown,
      {
        orgId,
        limit,
        offset,
      }: { orgId?: string | null; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const scope = await resolveOrgScope(ctx, orgId);
      if (!scope) return { items: [], total: 0 };
      const isPlatformAdmin =
        !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
      // Admin unscoped reach applies only WITHOUT an orgId — the active-org
      // selection is a membership concept (cor:api:100:01).
      const where =
        isPlatformAdmin && scope.scopedOrgId == null
          ? { deletedAt: null }
          : { organizationId: { in: scope.memberOrgIds }, deletedAt: null };
      const [total, items] = await Promise.all([
        ctx.db.app.count({ where }),
        take === 0
          ? Promise.resolve([])
          : ctx.db.app.findMany({
              where,
              include: APP_INCLUDE,
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              skip,
              take,
            }),
      ]);
      return { items, total };
    },

    app: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      // 007-entity-id-or-urn: ref may be ID, bare URN, or prefixed URN.
      // Soft "not found" (return null) preserves existing semantics —
      // resolveAppRef would throw on missing/deleted, so swallow.
      let resolvedId: string;
      try {
        ({ id: resolvedId } = await resolveAppRef(ctx.db, ref));
      } catch {
        return null;
      }
      const app = await ctx.db.app.findUnique({ where: { id: resolvedId }, include: APP_INCLUDE });
      if (!app || app.deletedAt) return null;
      // #473: org MEMBER (or platform ADMIN) — the myApps exposure bar; the
      // pre-473 org-ADMIN gate was stricter than the list a plain member
      // could already read this App through. Admin-only material (keys,
      // decrypted AI config) keeps its own gates (appKeys / appAIConfig).
      await requireOrgRole(ctx, app.organizationId, 'READER');
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

    appAIConfig: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
      // 007-entity-id-or-urn: appRef may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appRef);
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

    appKeys: async (_: unknown, { appRef }: { appRef: string }, ctx: Context) => {
      // 007-entity-id-or-urn: appRef may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appRef);
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

