// agentQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { decryptToken } from '../../../lib/tokenCrypto.js';
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
import {
  type Context,
  aiConfigOwnerOf,
  clampListTake,
  requireOrgRole,
  resolveOrgScope,
  isPlatformAdmin,
  toGqlAiServiceConfig,
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
    // otherwise member of the Agent's org or platform ADMIN/OWNER. Field-level
    // exposure stays slim for non-members (Agent.systemPrompt / memoryItems /
    // imports are member-gated).
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
        await requireOrgRole(ctx, agent.organizationId, 'READER');
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
        filter?: { type?: string | null; visibility?: string | null } | null;
        orgId?: string | null;
        limit?: number | null;
        offset?: number | null;
      },
      ctx: Context,
    ) => {
      const take = clampListTake(limit);
      const skip = Math.max(0, offset ?? 0);
      const f = filter ?? {};
      const scope = await resolveOrgScope(ctx, orgId);
      if (!scope) return { items: [], total: 0 };
      // Admin unscoped reach applies only WITHOUT an orgId — the active-org
      // selection is a membership concept (cor:api:100:01).
      const orgWhere =
        isPlatformAdmin(ctx) && scope.scopedOrgId == null
          ? {}
          : { organizationId: { in: scope.memberOrgIds } };
      const where = {
        ...orgWhere,
        deletedAt: null,
        ...(f.type ? { type: f.type as never } : {}),
        ...(f.visibility ? { visibility: f.visibility as never } : {}),
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

    agentAIConfig: async (_: unknown, { agentRef }: { agentRef: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // 007-entity-id-or-urn: agentRef may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      // Org ADMIN on the agent's org can read the decrypted key.
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
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
        // Resolve refs (007 ID-or-URN) and compute the effective org for
        // the auth gate — the same org the walk itself will consult.
        let resolvedAppId: string | null = null;
        let resolvedAgentId: string | null = null;
        let effectiveOrgId: string | null = null;
        if (appRef) {
          const { id } = await resolveAppRef(ctx.db, appRef);
          resolvedAppId = id;
          const app = await ctx.db.app.findUniqueOrThrow({ where: { id } });
          effectiveOrgId = app.organizationId;
        }
        if (agentRef) {
          const { id } = await resolveAgentRef(ctx.db, agentRef);
          resolvedAgentId = id;
          if (!effectiveOrgId) {
            const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id } });
            effectiveOrgId = agent.organizationId;
          }
        }
        // Privileged surface (decrypted key): org ADMIN of the effective
        // org — same gate as the legacy agentAIConfig/appAIConfig queries
        // this supersedes. Without app/agent context, platform admin only.
        if (effectiveOrgId) {
          await requireOrgRole(ctx, effectiveOrgId, 'ADMIN');
        } else if (!isPlatformAdmin(ctx)) {
          throw new Error('Forbidden');
        }
        const resolved = await resolveAiConfigWithFallback(ctx.db, name ?? null, {
          appId: resolvedAppId,
          agentId: resolvedAgentId,
          organizationId: effectiveOrgId,
        });
        const { config, ownerType } = resolved;
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
        };
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

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
        return resolved.map((r) => toGqlAiServiceConfig(r.config));
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    myAgentSubscriptions: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return [];
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
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      return ctx.db.agentSubscription.findMany({
        where: { agentId: resolvedAgentId },
        orderBy: { createdAt: 'desc' },
      });
    },

};

