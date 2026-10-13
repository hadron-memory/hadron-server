import { requireProviderCredentialOwner } from './resolvers.helpers.js';
// agentQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { GraphQLError } from 'graphql';
import { decryptToken } from '../../../lib/tokenCrypto.js';
import { AI_PROVIDER_ENDPOINTS, effectiveApiStyle, effectiveEndpoint } from '../../../lib/aiEndpoint.js';
import {
  NoAiConfigAvailableError,
  DEFAULT_AI_CONFIG_NAME,
  resolveAiConfigWithFallback,
  resolveAiConfigs,
  type AiConfigOwnerType,
} from '../../../lib/aiConfig.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AgentNotFoundError } from '../../../lib/entityRef/errors.js';
import { isAgentInstalled } from '../../../lib/appAgent.js';
import {
  type Context,
  aiConfigOwnerOf,
  clampListTake,
  requireOrgRole,
  requireAgentAccess,
  requireOwnerOrOrgRole,
  resolveOrgScope,
  isPlatformAdmin,
  toGqlAiServiceConfig,
  toGqlAiServiceConfigForPicker,
  requireAiConfigOwnerAdmin,
  requireAiConfigPickerAccess,
  rethrowAiConfigTyped,
  AGENT_INCLUDE,
} from './resolvers.helpers.js';

export const agentQueries = {
    // #473 — the uniform single-agent read; the first top-level Agent query
    // (previously reachable only via Organization.agents / App.agents
    // nesting). Gate mirrors resolveUrn's agent branch: a PUBLIC agent
    // resolves for any caller (#551 — marketplace discovery / share links),
    // otherwise member of the Agent's org or platform ADMIN/OWNER. A PUBLIC
    // agent publishes its OWN definition (systemPrompt / memoryItems /
    // imports); the fields that surface OTHER tenants (apps / appAgents /
    // appCount / orgGrants / importedBy) are scoped to the caller's own access
    // and come back empty for an outsider (#552, #757).
    agent: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      let resolvedId: string;
      try {
        ({ id: resolvedId } = await resolveAgentRef(ctx.db, ref));
      } catch (e) {
        // Genuine miss (AgentNotFoundError) → null. A malformed /
        // under-qualified URN throws UrnNotQualifiedError from
        // resolveAgentRef's assertFullyQualifiedUrn and propagates — input
        // errors surface, only not-found is masked to null.
        if (!(e instanceof AgentNotFoundError)) throw e;
        return null;
      }
      const agent = await ctx.db.agent.findUnique({
        where: { id: resolvedId },
        include: AGENT_INCLUDE,
      });
      if (!agent || agent.deletedAt) return null;
      // #551: PUBLIC visibility widens the READ gate to everyone (mirrors the
      // memories PUBLIC carve-out, #362). Non-public falls through to the
      // membership gate.
      if (agent.visibility !== 'PUBLIC') {
        await requireAgentAccess(ctx, agent, 'READER');
      }
      return agent;
    },

    // #551 — the public-agent marketplace slice: ALL live PUBLIC agents,
    // readable by ANY caller (member or not, authenticated or not), so an org
    // can discover foreign public agents to subscribe to (008/009
    // AgentOrgGrant; hadron-portal#486). Deliberately a SEPARATE query from the
    // member-scoped agents() list so the cross-org widening is an explicit,
    // bounded surface — never a side effect of a filter value on the default
    // list (contrast memories(filter: { visibility: PUBLIC })). Field-level
    // exposure is slim for non-members (Agent.systemPrompt / systemMemoryId /
    // memoryItems / imports gates). filter.type narrows; filter.visibility is
    // ignored (the slice is PUBLIC by definition).
    publicAgents: async (
      _: unknown,
      {
        filter,
        limit,
        offset,
      }: {
        filter?: { type?: string | null } | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const f = filter ?? {};
      const where = {
        visibility: 'PUBLIC' as never,
        deletedAt: null,
        ...(f.type ? { type: f.type as never } : {}),
      };
      const [total, items] = await Promise.all([
        ctx.db.agent.count({ where }),
        take === 0
          ? Promise.resolve([])
          : ctx.db.agent.findMany({
              where,
              include: AGENT_INCLUDE,
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              skip,
              take,
            }),
      ]);
      return { items, total };
    },

    // #473 — the uniform paginated agent list. Scope: Agents owned by the
    // caller's member orgs; platform ADMIN/OWNER unscoped get every live
    // Agent. orgId follows cor:api:100:01 (member -> scope, non-member ->
    // empty page, no disclosure, no admin bypass).
    agents: async (
      _: unknown,
      {
        filter,
        orgId,
        limit,
        offset,
      }: {
        filter?: {
          type?: string | null;
          visibility?: string | null;
          ownedByMe?: boolean | null;
        } | null;
        orgId?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const f = filter ?? {};
      const filters = {
        deletedAt: null,
        ...(f.type ? { type: f.type as never } : {}),
        ...(f.visibility ? { visibility: f.visibility as never } : {}),
      };
      let where: Record<string, unknown>;
      if (f.ownedByMe) {
        // #782 — the caller's OWN user-owned (org-less) agents only, for ALL
        // callers INCLUDING platform ADMIN/OWNER: owner scope is never an
        // admin-bypass surface (mirrors the owner-only personal/private
        // memories slice). Org-less by definition, so orgId is not consulted;
        // App-key callers (no ctx.userId) get an empty page.
        // #876: user-owned agents are identity-scoped, so an impersonated
        // session sees none — matching callerReadableAgentFilter, which drops
        // its ownerUserId clause the same way. Without this the list returned
        // the target's private agents (definitions AND systemPrompt) while
        // Query.agent(ref:) correctly refused them via requireOwnerOrOrgRole.
        if (!ctx.userId || ctx.impersonation) return { items: [], total: 0 };
        where = { ...filters, organizationId: null, ownerUserId: ctx.userId };
      } else {
        const scope = await resolveOrgScope(ctx, orgId);
        if (!scope) return { items: [], total: 0 };
        const scopedToOrg = scope.scopedOrgId != null;
        // Admin unscoped reach applies only WITHOUT an orgId — the active-org
        // selection is a membership concept (cor:api:100:01).
        if (isPlatformAdmin(ctx) && !scopedToOrg) {
          // Every live agent EXCEPT another user's user-owned agent — spec 047
          // strict ownership: a user-owned (org NULL, ownerUserId set) agent is
          // owner-only, so even a platform admin doesn't see someone else's in
          // the list (their OWN still show). "org-owned OR mine" as a flat OR is
          // clearer + more index-friendly than a nested NOT/AND (gemini review,
          // #682).
          where = {
            ...filters,
            OR: [{ ownerUserId: null }, { ownerUserId: ctx.userId ?? '__none__' }],
          };
        } else {
          // Org-scoped view. In the DEFAULT (no orgId) view, also surface the
          // caller's OWN user-owned agents (org NULL) — otherwise a personal
          // agent the caller just created is invisible in their agent list. A
          // specific-org selection excludes them (they belong to no org).
          const ownerClauses: Record<string, unknown>[] = [
            { organizationId: { in: scope.memberOrgIds } },
          ];
          // #876: the DEFAULT view (no orgId) folded the caller's user-owned
          // agents in too, so the leak did not require filter.ownedByMe —
          // an unfiltered `agents { items }`, which is what the portal issues,
          // exposed them. Identity-scoped ⇒ dropped under impersonation.
          if (!scopedToOrg && ctx.userId && !ctx.impersonation) {
            ownerClauses.push({ ownerUserId: ctx.userId });
          }
          where = { ...filters, OR: ownerClauses };
        }
      }
      const [total, items] = await Promise.all([
        ctx.db.agent.count({ where }),
        take === 0
          ? Promise.resolve([])
          : ctx.db.agent.findMany({
              where,
              include: AGENT_INCLUDE,
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              skip,
              take,
            }),
      ]);
      return { items, total };
    },

    agentAIConfig: async (_: unknown, { agentRef }: { agentRef: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // 007-entity-id-or-urn: agentRef may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      // Org ADMIN on the agent's org can read the decrypted key.
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN', 'agent');
      // 036-ai-service-config: registry-backed — the Agent's 'default'
      // config (single-entity contract preserved; no resolution walk).
      const config = await ctx.db.aiServiceConfig.findFirst({
        where: { agentId: resolvedAgentId, name: DEFAULT_AI_CONFIG_NAME },
      });
      if (!config?.apiKeyEncrypted) return null;
      return {
        provider: config.provider,
        apiKey: decryptToken(config.apiKeyEncrypted),
        model: config.model,
      };
    },

    // ── 036-ai-service-config ─────────────────────────────────────────

    // #473 — the uniform single-config read. AiServiceConfig is the one
    // URN-less entity (ref = ID only, matching resolveUrn / effectiveAccess
    // dispatch). Masked (no key material); auth mirrors the list gate:
    // platform ADMIN/OWNER for HADRON_SERVER-owned rows, org ADMIN of the
    // owning org otherwise.
    aiServiceConfig: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
      if (!ctx.userId && !isPlatformAdmin(ctx)) throw new Error('Unauthenticated');
      const config = await ctx.db.aiServiceConfig.findUnique({ where: { id: ref } });
      if (!config) return null;
      try {
        const owner = aiConfigOwnerOf(config);
        await requireAiConfigOwnerAdmin(ctx, owner.ownerType, owner.ownerId);
        return toGqlAiServiceConfig(config);
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    // #473 — paginated; filter carries the owner. Omitted filter = the
    // platform ADMIN/OWNER cross-owner view of every config.
    aiServiceConfigs: async (
      _: unknown,
      {
        filter,
        limit,
        offset,
      }: {
        filter?: { ownerType: AiConfigOwnerType; ownerId: string } | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      if (!ctx.userId && !isPlatformAdmin(ctx)) throw new Error('Unauthenticated');
      try {
        let ownerWhere: Record<string, string> = {};
        if (filter) {
          ({ ownerWhere } = await requireAiConfigOwnerAdmin(ctx, filter.ownerType, filter.ownerId));
        } else if (!isPlatformAdmin(ctx)) {
          // No owner filter = the cross-owner ops view — platform staff only.
          throw new Error('Forbidden');
        }
        const take = clampListTake(limit);
        const skip = Math.max(0, offset ?? 0);
        const [total, configs] = await Promise.all([
          ctx.db.aiServiceConfig.count({ where: ownerWhere }),
          take === 0
            ? Promise.resolve([])
            : ctx.db.aiServiceConfig.findMany({
                where: ownerWhere,
                orderBy: [{ name: 'asc' }, { id: 'asc' }],
                skip,
                take,
              }),
        ]);
        return { items: configs.map(toGqlAiServiceConfig), total };
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    resolveAIConfig: async (
      _: unknown,
      { name, appRef, agentRef }: { name?: string | null; appRef?: string | null; agentRef?: string | null },
      ctx: Context,
    ) => {
      try {
        // Resolve refs (007 ID-or-URN). The named App has its own auth gate;
        // an unrelated Agent's org cannot authorize its decrypted key.
        let resolvedAppId: string | null = null;
        let resolvedAgentId: string | null = null;
        let effectiveOrgId: string | null = null;
        let userOwnedAgent = false;
        let personalAgentOwnerId: string | null = null;
        let appOwnerUserId: string | null = null;
        let agentOwner: { organizationId: string | null; ownerUserId: string | null } | null = null;
        if (appRef) {
          const { id } = await resolveAppRef(ctx.db, appRef);
          resolvedAppId = id;
          const app = await ctx.db.app.findUniqueOrThrow({ where: { id } });
          effectiveOrgId = app.organizationId;
          appOwnerUserId = app.ownerUserId;
          // Decrypted user-owned App credentials never receive the management bypass.
          await requireProviderCredentialOwner(ctx, app);
        }
        if (agentRef) {
          const { id } = await resolveAgentRef(ctx.db, agentRef);
          resolvedAgentId = id;
          const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id } });
          agentOwner = agent;
          userOwnedAgent = agent.ownerUserId !== null;
          personalAgentOwnerId = agent.ownerUserId;
          if (userOwnedAgent) {
            // A personal Agent is strictly owner-only, even for platform
            // admins and impersonated sessions (spec 047).
            await requireOwnerOrOrgRole(ctx, agent, 'ADMIN', 'agent');
          }
          if (!effectiveOrgId) {
            effectiveOrgId = agent.organizationId;
          }
        }
        if (resolvedAppId && resolvedAgentId && !(await isAgentInstalled(ctx.db, resolvedAppId, resolvedAgentId))) {
          throw new Error('Forbidden');
        }
        // A user-owned App's config is eligible only when it belongs to the
        // same owner as the named personal Agent. Otherwise naming another
        // user's App would turn the Agent-owner gate into a cross-user decrypt.
        if (userOwnedAgent && resolvedAppId && !effectiveOrgId && appOwnerUserId !== personalAgentOwnerId) {
          throw new Error('Forbidden');
        }
        // Privileged surface (decrypted key): org ADMIN of the effective
        // org — same gate as the legacy agentAIConfig/appAIConfig queries
        // this supersedes. Without app/agent context, platform admin only.
        if (!resolvedAppId) {
          if (effectiveOrgId) {
            await requireOrgRole(ctx, effectiveOrgId, 'ADMIN');
          } else if (!userOwnedAgent && !isPlatformAdmin(ctx)) {
            throw new Error('Forbidden');
          }
        }
        const resolved = await resolveAiConfigWithFallback(ctx.db, name ?? null, {
          appId: resolvedAppId,
          agentId: resolvedAgentId,
          organizationId: effectiveOrgId,
        });
        const { config, ownerType } = resolved;
        if (appOwnerUserId !== null) {
          // The shared walk can derive an installed Agent's org even when the
          // App is user-owned. The App's owner may decrypt their own App row,
          // but an outer org or Agent row still needs its own owner gate.
          if (ownerType === 'ORGANIZATION') {
            await requireOrgRole(ctx, config.organizationId!, 'ADMIN');
          } else if (ownerType === 'AGENT' && agentOwner) {
            await requireOwnerOrOrgRole(ctx, agentOwner, 'ADMIN', 'agent');
          } else if (ownerType === 'HADRON_SERVER') {
            throw new NoAiConfigAvailableError(name ?? DEFAULT_AI_CONFIG_NAME, 'this App');
          }
        }
        if (userOwnedAgent && !effectiveOrgId && ownerType === 'HADRON_SERVER') {
          // A personal Agent may use its own config or one on the user-owned
          // App it runs through. Neither context may reach the platform key.
          throw new NoAiConfigAvailableError(name ?? DEFAULT_AI_CONFIG_NAME, 'this Agent');
        }
        if (ownerType === 'HADRON_SERVER' && config.apiKeyEncrypted && !isPlatformAdmin(ctx)) {
          // Tenant admins may use the platform fallback for server-side calls,
          // but the platform's provider credential must not leave the server.
          throw new GraphQLError(
            `AI configuration '${config.name}' resolved at the HADRON_SERVER level; only a platform administrator may decrypt its API key.`,
            { extensions: { code: 'FORBIDDEN' } },
          );
        }
        if (!config.apiKeyEncrypted) {
          // Resolvable but unusable: a config without a key cannot back an
          // LLM call (spec 036 edge case — name the config + level, never
          // key material).
          throw new NoAiConfigAvailableError(
            config.name,
            `this context — config '${config.name}' at the ${ownerType} level has no API key stored`,
          );
        }
        return {
          configId: config.id,
          name: config.name,
          ownerType,
          provider: config.provider,
          model: config.model,
          apiKey: decryptToken(config.apiKeyEncrypted),
          params: config.params ?? null,
          effectiveEndpoint: effectiveEndpoint(config),
          effectiveApiStyle: effectiveApiStyle(config),
        };
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    aiProviderEndpoints: async (_: unknown, { provider }: { provider: string }) =>
      (Object.hasOwn(AI_PROVIDER_ENDPOINTS, provider)
        ? AI_PROVIDER_ENDPOINTS[provider as keyof typeof AI_PROVIDER_ENDPOINTS]
        : []
      ).map((e) => ({ ...e })),

    resolveAiServiceConfigs: async (
      _: unknown,
      { appRef, agentRef }: { appRef?: string | null; agentRef?: string | null },
      ctx: Context,
    ) => {
      try {
        // 007-entity-id-or-urn: appRef/agentRef may be ID or URN. A ref that
        // doesn't resolve to a row simply contributes nothing to the walk.
        const resolvedAppId = appRef ? (await resolveAppRef(ctx.db, appRef)).id : null;
        const resolvedAgentId = agentRef ? (await resolveAgentRef(ctx.db, agentRef)).id : null;
        // Masked picker: ALL App members may list the configs their chat
        // context can resolve (not just org admins — no key material leaves).
        await requireAiConfigPickerAccess(ctx, resolvedAppId, resolvedAgentId);
        const resolved = await resolveAiConfigs(ctx.db, {
          appId: resolvedAppId,
          agentId: resolvedAgentId,
        });
        return resolved.map((r) => toGqlAiServiceConfigForPicker(r.config));
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    myAgentSubscriptions: async (_: unknown, __: unknown, ctx: Context) => {
      // #876 class sweep: identity-scoped and org-unconstrained — this listed
      // the target's subscriptions across every org.
      if (!ctx.userId || ctx.impersonation) return [];
      return ctx.db.agentSubscription.findMany({
        where: { userId: ctx.userId },
        orderBy: { createdAt: 'desc' },
      });
    },

    // 005-agent-subscription FR-022: list all AgentSubscriptions to an Agent.
    // Authorized for ADMIN/OWNER of the Agent's owning org.
    agentSubscriptions: async (
      _: unknown,
      { agentRef }: { agentRef: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentRef may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireAgentAccess(ctx, agent, 'ADMIN');
      return ctx.db.agentSubscription.findMany({
        where: { agentId: resolvedAgentId },
        orderBy: { createdAt: 'desc' },
      });
    },

};
