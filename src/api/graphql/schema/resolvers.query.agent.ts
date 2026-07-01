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
import {
  type Context,
  requireOrgRole,
  isPlatformAdmin,
  toGqlAiServiceConfig,
  requireAiConfigOwnerAdmin,
  requireAiConfigPickerAccess,
  rethrowAiConfigTyped,
} from './resolvers.helpers.js';

export const agentQueries = {
    agentAIConfig: async (_: unknown, { agentId }: { agentId: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
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

    aiServiceConfigs: async (
      _: unknown,
      { ownerType, ownerId }: { ownerType: AiConfigOwnerType; ownerId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId && !isPlatformAdmin(ctx)) throw new Error('Unauthenticated');
      try {
        const { ownerWhere } = await requireAiConfigOwnerAdmin(ctx, ownerType, ownerId);
        const configs = await ctx.db.aiServiceConfig.findMany({
          where: ownerWhere,
          orderBy: { name: 'asc' },
        });
        return configs.map(toGqlAiServiceConfig);
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    resolveAIConfig: async (
      _: unknown,
      { name, appId, agentId }: { name?: string | null; appId?: string | null; agentId?: string | null },
      ctx: Context,
    ) => {
      try {
        // Resolve refs (007 ID-or-URN) and compute the effective org for
        // the auth gate — the same org the walk itself will consult.
        let resolvedAppId: string | null = null;
        let resolvedAgentId: string | null = null;
        let effectiveOrgId: string | null = null;
        if (appId) {
          const { id } = await resolveAppRef(ctx.db, appId);
          resolvedAppId = id;
          const app = await ctx.db.app.findUniqueOrThrow({ where: { id } });
          effectiveOrgId = app.organizationId;
        }
        if (agentId) {
          const { id } = await resolveAgentRef(ctx.db, agentId);
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
      { appId, agentId }: { appId?: string | null; agentId?: string | null },
      ctx: Context,
    ) => {
      try {
        // 007-entity-id-or-urn: appId/agentId may be ID or URN. A ref that
        // doesn't resolve to a row simply contributes nothing to the walk.
        const resolvedAppId = appId ? (await resolveAppRef(ctx.db, appId)).id : null;
        const resolvedAgentId = agentId ? (await resolveAgentRef(ctx.db, agentId)).id : null;
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
      { agentId }: { agentId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      return ctx.db.agentSubscription.findMany({
        where: { agentId: resolvedAgentId },
        orderBy: { createdAt: 'desc' },
      });
    },

};

