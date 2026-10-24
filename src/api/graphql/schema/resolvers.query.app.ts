import { requireAppKeyManager } from './appKeyManagement.js';
// appQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { decryptToken } from '../../../lib/tokenCrypto.js';
import { DEFAULT_AI_CONFIG_NAME } from '../../../lib/aiConfig.js';
import { getDeploymentInfo } from '../../../mcp/deploymentInfo.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { AgentNotFoundError, AmbiguousLegacyUrnError, UrnNotQualifiedError } from '../../../lib/entityRef/errors.js';
import { readableNestedAgent } from './resolvers.types.js';
import { GraphQLError } from 'graphql';
import {
  type Context,
  clampListTake,
  requireOrgRole,
  requireOwnerOrOrgRole,
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
        filter,
        orgId,
        limit,
        offset,
      }: {
        filter?: { ownedByMe?: boolean | null; agentId?: string | null } | null;
        orgId?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const f = filter ?? {};
      // #2343: apps that install an Agent. The match is the AppAgent join
      // (there is no primary-agent column), so `App.agents`' read-gate drops
      // cannot hide the target. The VALUE goes through the Agent read gate
      // first: an unreadable, deleted, malformed or nonexistent agent all
      // answer the same empty page, so the filter is no existence oracle.
      // Only "this ref names nothing" is swallowed; a database error is not.
      let agentClause: Record<string, unknown> = {};
      if (f.agentId) {
        let target: { id: string } | null = null;
        try {
          const { id } = await resolveAgentRef(ctx.db, f.agentId);
          target = await readableNestedAgent(ctx, await ctx.db.agent.findUnique({
            where: { id },
            select: { id: true, deletedAt: true, visibility: true, organizationId: true, ownerUserId: true },
          }));
        } catch (error) {
          if (!(error instanceof AgentNotFoundError || error instanceof UrnNotQualifiedError || error instanceof AmbiguousLegacyUrnError)) throw error;
        }
        if (!target) return { items: [], total: 0 };
        agentClause = { appAgents: { some: { agentId: target.id } } };
      }
      let where: Record<string, unknown>;
      if (f.ownedByMe) {
        // #782 — the caller's OWN user-owned (org-less) Apps only, for ALL
        // callers INCLUDING platform ADMIN/OWNER: owner scope is never an
        // admin-bypass surface (mirrors the owner-only personal/private
        // memories slice). Org-less by definition, so orgId is not consulted;
        // App-key callers (no ctx.userId) get an empty page.
        // #876: identical to the agents list — user-owned Apps are
        // identity-scoped and invisible under impersonation. These carry the
        // sharper payload: a leaked App handed over its own scalar fields;
        // keys and members now also enforce their own read gate (#1521).
        if (!ctx.userId || ctx.impersonation) return { items: [], total: 0 };
        where = { deletedAt: null, organizationId: null, ownerUserId: ctx.userId, ...agentClause };
      } else {
        const scope = await resolveOrgScope(ctx, orgId);
        if (!scope) return { items: [], total: 0 };
        const isPlatformAdmin =
          !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
        const scopedToOrg = scope.scopedOrgId != null;
        // Admin unscoped reach applies only WITHOUT an orgId — the active-org
        // selection is a membership concept (cor:api:100:01).
        if (isPlatformAdmin && !scopedToOrg) {
          // Every live App EXCEPT another user's user-owned App — spec 047
          // strict ownership (a user-owned App is owner-only; an admin sees
          // only their own). "org-owned OR mine" as a flat OR.
          where = {
            deletedAt: null,
            OR: [{ ownerUserId: null }, { ownerUserId: ctx.userId ?? '__none__' }],
            ...agentClause,
          };
        } else {
          // Org-scoped view. In the DEFAULT (no orgId) view, also surface the
          // caller's OWN user-owned Apps (org NULL) so a personal App the caller
          // just created is visible. A specific-org selection excludes them.
          const ownerClauses: Record<string, unknown>[] = [
            { organizationId: { in: scope.memberOrgIds } },
          ];
          // #876: as with agents, the DEFAULT view folded user-owned Apps in,
          // so the leak did not depend on filter.ownedByMe.
          if (!scopedToOrg && ctx.userId && !ctx.impersonation) {
            ownerClauses.push({ ownerUserId: ctx.userId });
          }
          where = { deletedAt: null, OR: ownerClauses, ...agentClause };
        }
      }
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
      await requireOwnerOrOrgRole(ctx, app, 'READER');
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
      // Auth via the shared gate (unconditional): it grants a platform admin on
      // an ORG-owned App but enforces OWNER-ONLY on a user-owned App. The old
      // `if (!isPlatformAdmin)` skip leaked a user-owned App's decrypted AI key
      // to a platform admin (spec 047 blocker 3, #682 security review).
      await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
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
      // #1744: inventory is manager-only, including under impersonation.
      await requireAppKeyManager(ctx, app);
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
      // #876 class sweep: the target's personal API-credential inventory
      // (previews, labels, last-used stamps, active AND revoked) is
      // identity-scoped — never part of a shared-org support view.
      if (ctx.impersonation) throw new Error('Forbidden');
      return ctx.db.userApiKey.findMany({
        where: { userId: ctx.userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
    },
};
