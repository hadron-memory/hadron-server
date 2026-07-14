// agentMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import { encryptToken } from '../../../lib/tokenCrypto.js';
import {
  AiServiceConfigNotFoundError,
  AiConfigValidationError,
  DuplicateAiServiceConfigNameError,
  DEFAULT_AI_CONFIG_NAME,
  apiKeyWriteFields,
  apiKeyPreviewOf,
  validateAiConfigName,
  validateProviderAndParams,
  type AiConfigOwnerType,
} from '../../../lib/aiConfig.js';
import {
  publishAgentImport,
  SelfImportError,
  MultiLevelImportError,
  MissingGrantError,
  PositionConflictError,
} from '../../../controller/operations/publishAgentImport.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import { removeAgentImport } from '../../../controller/operations/removeAgentImport.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { deriveSlugFromName } from '../../../lib/urn.js';
import { generateId } from '../../../lib/id.js';
import { isLifecycleActive } from '@hadron-memory/access-control';
import { GraphQLError } from 'graphql';
import { type InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import {
  Prisma,
  type AgentVisibility,
} from '../../../generated/prisma/index.js';
import {
  type Context,
  requireOrgRole,
  aiConfigOwnerOf,
  toGqlAiServiceConfig,
  requireAiConfigOwnerAdmin,
  rethrowAiConfigTyped,
  AGENT_INCLUDE,
} from './resolvers.helpers.js';

export const agentMutations = {
    createAgent: async (
      _: unknown,
      { orgId, name, description, systemPrompt, systemMemoryId, visibility, type, surfaces }: { orgId: string; name: string; description?: string; systemPrompt?: string; systemMemoryId?: string; visibility?: string; type?: 'ASSISTANT' | 'CHATBOT'; surfaces?: string[] },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: resolvedOrgId }, select: { urn: true } });
      // #574: slugify the display name — a raw name would persist a
      // case-sensitive / space-bearing URN (and the system memory URN derives
      // from this one, so it inherits the clean slug).
      const agentUrn = `${org.urn}:${deriveSlugFromName(name)}`;
      // Check for existing agent with the same URN
      const existing = await ctx.db.agent.findUnique({ where: { urn: agentUrn } });
      if (existing) {
        if (existing.deletedAt) {
          await ctx.db.agent.delete({ where: { id: existing.id } });
        } else {
          throw new Error(`An agent with URN "${agentUrn}" already exists`);
        }
      }
      // Defaults: CHATBOT when systemMemoryId is set (wizard flow), otherwise ASSISTANT.
      const inferredType = type ?? (systemMemoryId ? 'CHATBOT' : 'ASSISTANT');
      const defaultSurfaces = inferredType === 'CHATBOT' ? ['api'] : ['mcp'];
      const agentVisibility = (visibility as AgentVisibility) ?? 'PERSONAL';

      // Every agent owns a system memory (cor:dmo:050:01 — the Agent carries a
      // pointer to its own class='system' memory). Two entry points:
      //   1. systemMemoryId supplied (wizard flow) → promote that existing
      //      memory to class='system'.
      //   2. no systemMemoryId → auto-provision a fresh class='system' memory.
      // This applies regardless of the legacy ASSISTANT/CHATBOT type, which is
      // not load-bearing (cor:dmo:050:01 "what invalidates this spec").
      // The memory-provision + agent-create run in one transaction so a
      // failure never leaves a dangling system memory or an ownerless agent.
      //
      // 035-visibility-enum-cleanup: a system memory is marked by `class` (not
      // the dropped `type` column) and its `visibility` is always NULL
      // (chk_memory_visibility_class forbids a non-null visibility on
      // class='system'); agent visibility does not sync onto it.
      const createdAgent = await ctx.db.$transaction(async (tx) => {
        let resolvedSystemMemoryId: string;
        if (systemMemoryId) {
          const target = await tx.memory.findUniqueOrThrow({ where: { id: systemMemoryId } });
          if (target.organizationId !== resolvedOrgId) {
            throw new Error('System memory must belong to the same organization as the agent');
          }
          const otherAgent = await tx.agent.findFirst({
            where: { systemMemoryId, deletedAt: null },
            select: { id: true },
          });
          if (otherAgent) {
            throw new Error('This memory is already the system memory of another agent');
          }
          await tx.memory.update({
            where: { id: systemMemoryId },
            data: {
              class: 'system',
              name: `${name} System`,
              visibility: null,
              // system-class memories must opt out of uploads (schema.prisma,
              // 006-asset-upload-redesign). Applies when promoting too, not
              // just on auto-provision. #519 review.
              acceptsUploads: false,
            },
          });
          resolvedSystemMemoryId = systemMemoryId;
        } else {
          // Auto-provision. The memory URN derives from the (unique) agent URN
          // so it's collision-free and stable. If a soft-deleted memory still
          // holds that URN (e.g. an earlier agent at this URN was deleted),
          // hard-delete it first — mirrors createMemory's URN-reclaim path.
          const systemMemoryUrn = `${agentUrn}-system`;
          const staleHolder = await tx.memory.findUnique({ where: { urn: systemMemoryUrn } });
          if (staleHolder) {
            if (staleHolder.deletedAt) {
              await tx.memory.delete({ where: { id: staleHolder.id } });
            } else {
              throw new Error(`A memory with URN "${systemMemoryUrn}" already exists`);
            }
          }
          const systemMemory = await tx.memory.create({
            data: {
              id: generateId(),
              organizationId: resolvedOrgId,
              urn: systemMemoryUrn,
              name: `${name} System`,
              class: 'system',
              // system-class memories must opt out of uploads (schema.prisma,
              // 006-asset-upload-redesign — DB default is true; the asset gate
              // only checks Memory.acceptsUploads after write auth). #519 review.
              acceptsUploads: false,
              createdBy: ctx.userId ?? ctx.clientId ?? null,
            },
          });
          resolvedSystemMemoryId = systemMemory.id;
        }

        return tx.agent.create({
          data: {
            organizationId: resolvedOrgId, urn: agentUrn, name, description, systemPrompt, systemMemoryId: resolvedSystemMemoryId,
            visibility: agentVisibility,
            type: inferredType,
            surfaces: surfaces ?? defaultSurfaces,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
          include: AGENT_INCLUDE,
        });
      });
      return createdAgent;
    },

    updateAgent: async (
      _: unknown,
      { id, name, urn, description, systemPrompt, systemMemoryId, visibility, type, surfaces }: { id: string; name?: string; urn?: string; description?: string; systemPrompt?: string; systemMemoryId?: string; visibility?: string; type?: 'ASSISTANT' | 'CHATBOT'; surfaces?: string[] },
      ctx: Context,
    ) => {
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      let newUrn: string | undefined;
      if (urn !== undefined) {
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: agent.organizationId }, select: { urn: true } });
        newUrn = `${org.urn}:${deriveSlugFromName(urn)}`; // #574: slugify the explicit rename slug
      }

      // ── systemMemoryId: first-attach is allowed, but unset/change are not.
      // Rationale: once an agent has a brain, swapping it destroys the
      // scaffold and confuses the UX. Users who want a different brain
      // should delete the agent and create a new one.
      if (systemMemoryId !== undefined) {
        const incoming = systemMemoryId === '' ? null : systemMemoryId;
        if (agent.systemMemoryId && incoming !== agent.systemMemoryId) {
          throw new Error('Cannot unset or change an agent\'s system memory. Delete the agent to replace it.');
        }
        if (!agent.systemMemoryId && incoming) {
          // First-attach: verify the target memory exists, belongs to this
          // org, isn't already another agent's system memory, and promote it
          // to class='system'.
          const target = await ctx.db.memory.findUniqueOrThrow({ where: { id: incoming } });
          if (target.organizationId !== agent.organizationId) {
            throw new Error('System memory must belong to the same organization as the agent');
          }
          const otherAgent = await ctx.db.agent.findFirst({
            where: { systemMemoryId: incoming, deletedAt: null, id: { not: id } },
            select: { id: true },
          });
          if (otherAgent) {
            throw new Error('This memory is already the system memory of another agent');
          }
          await ctx.db.memory.update({
            where: { id: incoming },
            data: {
              // 035-visibility-enum-cleanup: mark via class; clear visibility
              // (forbidden non-null on class='system'). Agent visibility no
              // longer propagates onto the system memory.
              class: 'system',
              name: `${name ?? agent.name} System`,
              visibility: null,
              // system-class memories must opt out of uploads (schema.prisma,
              // 006-asset-upload-redesign). #519 review.
              acceptsUploads: false,
            },
          });
        }
      }

      // ── URN sync for an auto-derived system memory.
      // An auto-provisioned system memory's URN is `${agentUrn}-system` (see
      // createAgent). If the agent's URN changes we must move the memory's URN
      // in lockstep — otherwise the stale `${oldUrn}-system` memory keeps the
      // old slug reserved, and re-creating an agent at that slug fails the
      // system-memory URN-reclaim check (#519 review). Only touch a memory whose
      // URN still matches the derived pattern: a wizard-supplied system memory
      // carries its own author-chosen URN we must not rewrite.
      if (agent.systemMemoryId && newUrn !== undefined && newUrn !== agent.urn) {
        const derivedOldUrn = `${agent.urn}-system`;
        const sys = await ctx.db.memory.findUnique({
          where: { id: agent.systemMemoryId },
          select: { urn: true },
        });
        if (sys?.urn === derivedOldUrn) {
          await ctx.db.memory.update({
            where: { id: agent.systemMemoryId },
            data: {
              urn: `${newUrn}-system`,
              updatedBy: ctx.userId ?? ctx.clientId ?? null,
            },
          }).catch((err) => {
            // Best-effort, like the name sync below: a rare collision on the
            // new URN shouldn't fail the whole agent rename.
            console.warn('[updateAgent] system memory URN sync failed:', err);
          });
        }
      }

      // ── Name sync for existing system memory.
      // If the agent already has a system memory and the caller is updating
      // the agent's name, propagate so they stay in lockstep.
      // 035-visibility-enum-cleanup: visibility no longer propagates — a
      // system memory's visibility is always NULL.
      if (agent.systemMemoryId && name !== undefined) {
        await ctx.db.memory.update({
          where: { id: agent.systemMemoryId },
          data: {
            name: `${name} System`,
            updatedBy: ctx.userId ?? ctx.clientId ?? null,
          },
        }).catch((err) => {
          // Log but don't block the agent update — if the system memory
          // has been manually renamed or deleted, we don't want to fail
          // the whole operation.
          console.warn('[updateAgent] system memory sync failed:', err);
        });
      }

      return ctx.db.agent.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(newUrn !== undefined ? { urn: newUrn } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(systemMemoryId !== undefined ? { systemMemoryId } : {}),
          ...(visibility !== undefined ? { visibility: visibility as AgentVisibility } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(surfaces !== undefined ? { surfaces } : {}),
        },
        include: AGENT_INCLUDE,
      });
    },

    deleteAgent: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      // Soft-delete the agent and its owned system memory (if any) in the
      // same pass. System memories are owned by the agent and cannot be
      // detached, so deleting the agent is the only way they get cleaned up.
      await ctx.db.agent.update({ where: { id }, data: { deletedAt: new Date() } });
      if (agent.systemMemoryId) {
        await ctx.db.memory
          .update({ where: { id: agent.systemMemoryId }, data: { deletedAt: new Date() } })
          .catch((err) => console.warn('[deleteAgent] system memory cleanup failed:', err));
      }
      return true;
    },

    createAgentOrgGrant: async (
      _: unknown,
      { agentRef, orgRef }: { agentRef: string; orgRef: string },
      ctx: Context,
    ) => {
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgRef);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');

      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      if (agent.organizationId === resolvedOrgId) {
        throw new GraphQLError(
          'Owner organization has implicit authority for its own Agent and cannot subscribe.',
          { extensions: { code: 'SELF_AGENT_ORG_GRANT' } },
        );
      }
      if (agent.visibility !== 'PUBLIC') {
        throw new GraphQLError('Only PUBLIC agents can be subscribed to by other organizations.', {
          extensions: { code: 'AGENT_NOT_PUBLIC', agentId: resolvedAgentId },
        });
      }

      await ensureAgentOrgGrant(ctx.db, resolvedOrgId, resolvedAgentId, {
        createdBy: ctx.userId ?? ctx.clientId ?? null,
      });

      const grant = await ctx.db.agentOrgGrant.findUniqueOrThrow({
        where: { orgId_agentId: { orgId: resolvedOrgId, agentId: resolvedAgentId } },
      });
      if (!isLifecycleActive(grant)) {
        throw new GraphQLError(
          'An AgentOrgGrant already exists for this organization and Agent, but it is not active. Ask the Agent owner to issue a new grant or clear the revocation.',
          {
            extensions: {
              code: 'AGENT_ORG_GRANT_INACTIVE',
              orgId: resolvedOrgId,
              agentId: resolvedAgentId,
              revokedAt: grant.revokedAt?.toISOString() ?? null,
              expiresAt: grant.expiresAt?.toISOString() ?? null,
              activatedAt: grant.activatedAt?.toISOString() ?? null,
            },
          },
        );
      }
      return grant;
    },

    revokeAgentOrgGrant: async (
      _: unknown,
      { agentRef, orgRef }: { agentRef: string; orgRef: string },
      ctx: Context,
    ) => {
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentRef);
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgRef);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });

      await requireAgentOrgGrantRevokeRole(ctx, resolvedOrgId, agent.organizationId);

      await ctx.db.agentOrgGrant.updateMany({
        where: {
          orgId: resolvedOrgId,
          agentId: resolvedAgentId,
          revokedAt: null,
        },
        data: {
          revokedAt: new Date(),
          revokedBy: ctx.userId ?? null,
          updatedBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });

      const grant = await ctx.db.agentOrgGrant.findUnique({
        where: { orgId_agentId: { orgId: resolvedOrgId, agentId: resolvedAgentId } },
      });
      if (!grant) {
        throw new GraphQLError('AgentOrgGrant not found for this organization and Agent.', {
          extensions: {
            code: 'AGENT_ORG_GRANT_NOT_FOUND',
            orgId: resolvedOrgId,
            agentId: resolvedAgentId,
          },
        });
      }
      return grant;
    },

    publishAgentImport: async (
      _: unknown,
      {
        parentAgentId,
        importedAgentId,
        position,
        required,
      }: {
        parentAgentId: string;
        importedAgentId: string;
        position: number;
        required?: boolean;
      },
      ctx: Context,
    ) => {
      const { id: resolvedParentId } = await resolveAgentRef(ctx.db, parentAgentId);
      const { id: resolvedImportedId } = await resolveAgentRef(ctx.db, importedAgentId);
      const parent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedParentId },
      });
      // Authorization: ADMIN/OWNER of the parent Agent's owning org.
      await requireOrgRole(ctx, parent.organizationId, 'ADMIN');

      try {
        return await publishAgentImport(ctx.db, {
          parentAgentId: resolvedParentId,
          importedAgentId: resolvedImportedId,
          position,
          required: required ?? true,
          actorId: ctx.userId ?? null,
        });
      } catch (e: unknown) {
        if (
          e instanceof SelfImportError ||
          e instanceof MultiLevelImportError ||
          e instanceof MissingGrantError ||
          e instanceof PositionConflictError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }
    },

    removeAgentImport: async (
      _: unknown,
      { parentAgentId, importedAgentId }: { parentAgentId: string; importedAgentId: string },
      ctx: Context,
    ) => {
      const { id: resolvedParentId } = await resolveAgentRef(ctx.db, parentAgentId);
      const { id: resolvedImportedId } = await resolveAgentRef(ctx.db, importedAgentId);
      const parent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedParentId },
      });
      await requireOrgRole(ctx, parent.organizationId, 'ADMIN');
      await removeAgentImport(ctx.db, resolvedParentId, resolvedImportedId);
      return true;
    },

    revokeAgentSubscription: async (
      _: unknown,
      { userId, agentId }: { userId: string; agentId: string },
      ctx: Context,
    ) => {
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');

      const updated = await ctx.db.agentSubscription.update({
        where: { userId_agentId: { userId, agentId } },
        data: {
          revokedAt: new Date(),
          revokedBy: ctx.userId ?? null,
        },
      });

      // FR-029: empty per-user Memory at revocation time → hard-delete. The
      // auto-provisioned memory is class='personal' (plaintext USER_ID mode) or
      // 'private' (encrypted SECRET mode, 041/#516); scope by userMemoryOfAgentId
      // so free-standing user memories (agent NULL) never match.
      const userMemory = await ctx.db.memory.findFirst({
        where: {
          userId,
          userMemoryOfAgentId: agentId,
          class: { in: ['personal', 'private'] },
          deletedAt: null,
        },
        include: { _count: { select: { nodes: true } } },
      });
      if (userMemory && userMemory._count.nodes === 0) {
        await ctx.db.memory.delete({ where: { id: userMemory.id } });
      }

      return updated;
    },

    // ── Multi-user-agent: identity and sessions (App Key auth) ──────

    updateAgentAIConfig: async (
      _: unknown,
      { agentId, provider, apiKey, model }: { agentId: string; provider: string; apiKey?: string | null; model: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      // 036-ai-service-config: upsert the Agent's 'default' registry
      // config. Legacy key semantics preserved: a provided apiKey is
      // encrypted with a preview; omitted/blank keeps the stored key,
      // which must then already exist.
      try {
        validateProviderAndParams(provider, null);
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
      const existing = await ctx.db.aiServiceConfig.findFirst({
        where: { agentId: resolvedAgentId, name: DEFAULT_AI_CONFIG_NAME },
      });
      const keyData: Record<string, string> = {};
      if (apiKey) {
        keyData.apiKeyEncrypted = encryptToken(apiKey);
        keyData.apiKeyPreview = apiKeyPreviewOf(apiKey);
      } else if (!existing?.apiKeyEncrypted) {
        rethrowAiConfigTyped(
          new AiConfigValidationError('API key is required when no key is saved yet'),
        );
      }
      if (existing) {
        await ctx.db.aiServiceConfig.update({
          where: { id: existing.id },
          data: { provider, model, ...keyData, updatedBy: ctx.userId ?? null },
        });
      } else {
        // apiKey is guaranteed non-blank here (guard above); P2002 from a
        // concurrent create surfaces as the duplicate-name typed error
        // rather than a retry (upsert is not race-safe on the cold path).
        try {
          await ctx.db.aiServiceConfig.create({
            data: {
              agentId: resolvedAgentId,
              name: DEFAULT_AI_CONFIG_NAME,
              provider,
              model,
              ...keyData,
              createdBy: ctx.userId ?? null,
            },
          });
        } catch (e: unknown) {
          if ((e as { code?: string }).code === 'P2002') {
            rethrowAiConfigTyped(new DuplicateAiServiceConfigNameError(DEFAULT_AI_CONFIG_NAME));
          }
          throw e;
        }
      }
      return ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedAgentId },
        include: AGENT_INCLUDE,
      });
    },

    clearAgentAIConfig: async (_: unknown, { agentId }: { agentId: string }, ctx: Context) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      // 036-ai-service-config: clearing deletes the 'default' registry
      // config (idempotent).
      await ctx.db.aiServiceConfig.deleteMany({
        where: { agentId: resolvedAgentId, name: DEFAULT_AI_CONFIG_NAME },
      });
      return ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedAgentId },
        include: AGENT_INCLUDE,
      });
    },

    // ── 036-ai-service-config CRUD ────────────────────────────────────

    createAiServiceConfig: async (
      _: unknown,
      args: {
        ownerType: AiConfigOwnerType;
        ownerId: string;
        name: string;
        provider: string;
        model: string;
        apiKey?: string | null;
        params?: unknown;
        enabled?: boolean | null;
      },
      ctx: Context,
    ) => {
      try {
        const { ownerWhere } = await requireAiConfigOwnerAdmin(ctx, args.ownerType, args.ownerId);
        const name = validateAiConfigName(args.name);
        validateProviderAndParams(args.provider, args.params ?? null);
        // No upsert: a P2002 from the partial unique (owner, name) index is
        // the duplicate-name typed error, not a retry (upsert is not
        // race-safe on the cold path).
        const config = await ctx.db.aiServiceConfig.create({
          data: {
            ...ownerWhere,
            name,
            provider: args.provider,
            model: args.model,
            ...(args.apiKey
              ? {
                  apiKeyEncrypted: encryptToken(args.apiKey),
                  apiKeyPreview: apiKeyPreviewOf(args.apiKey),
                }
              : {}),
            params:
              args.params === undefined || args.params === null
                ? undefined
                : (args.params as InputJsonValue),
            enabled: args.enabled ?? true,
            createdBy: ctx.userId ?? null,
          },
        });
        return toGqlAiServiceConfig(config);
      } catch (e: unknown) {
        if ((e as { code?: string }).code === 'P2002') {
          // Echo the canonical (trimmed) name the unique index actually saw.
          rethrowAiConfigTyped(new DuplicateAiServiceConfigNameError(args.name.trim()));
        }
        rethrowAiConfigTyped(e);
      }
    },

    updateAiServiceConfig: async (
      _: unknown,
      args: {
        id: string;
        name?: string | null;
        provider?: string | null;
        model?: string | null;
        apiKey?: string | null;
        params?: unknown;
        enabled?: boolean | null;
      },
      ctx: Context,
    ) => {
      try {
        const existing = await ctx.db.aiServiceConfig.findUnique({ where: { id: args.id } });
        if (!existing) throw new AiServiceConfigNotFoundError(args.id);
        const owner = aiConfigOwnerOf(existing);
        await requireAiConfigOwnerAdmin(ctx, owner.ownerType, owner.ownerId);
        const provider = args.provider ?? existing.provider;
        const params = args.params === undefined ? existing.params : args.params;
        validateProviderAndParams(provider, params ?? null);
        const config = await ctx.db.aiServiceConfig.update({
          where: { id: existing.id },
          data: {
            ...(args.name != null ? { name: validateAiConfigName(args.name) } : {}),
            provider,
            ...(args.model != null ? { model: args.model } : {}),
            ...apiKeyWriteFields(args.apiKey),
            ...(args.params === undefined
              ? {}
              : { params: args.params === null ? Prisma.DbNull : (args.params as InputJsonValue) }),
            ...(args.enabled == null ? {} : { enabled: args.enabled }),
            updatedBy: ctx.userId ?? null,
          },
        });
        return toGqlAiServiceConfig(config);
      } catch (e: unknown) {
        if ((e as { code?: string }).code === 'P2002') {
          // P2002 here can only come from renaming onto a conflict, so
          // args.name is set; trim to match the canonical stored form.
          rethrowAiConfigTyped(new DuplicateAiServiceConfigNameError((args.name ?? '').trim()));
        }
        rethrowAiConfigTyped(e);
      }
    },

    deleteAiServiceConfig: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      try {
        const existing = await ctx.db.aiServiceConfig.findUnique({ where: { id } });
        if (!existing) throw new AiServiceConfigNotFoundError(id);
        const owner = aiConfigOwnerOf(existing);
        await requireAiConfigOwnerAdmin(ctx, owner.ownerType, owner.ownerId);
        await ctx.db.aiServiceConfig.delete({ where: { id: existing.id } });
        return true;
      } catch (e) {
        rethrowAiConfigTyped(e);
      }
    },

    // ── Chatbot revisions ─────────────────────────────────────────────

};

async function requireAgentOrgGrantRevokeRole(
  ctx: Context,
  subscriberOrgId: string,
  agentOwnerOrgId: string,
): Promise<void> {
  try {
    await requireOrgRole(ctx, subscriberOrgId, 'ADMIN');
    return;
  } catch (subscriberErr) {
    try {
      await requireOrgRole(ctx, agentOwnerOrgId, 'ADMIN');
      return;
    } catch {
      throw subscriberErr;
    }
  }
}
