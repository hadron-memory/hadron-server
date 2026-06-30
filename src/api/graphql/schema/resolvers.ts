import { decryptToken } from '../../../lib/tokenCrypto.js';
import {
  NoAiConfigAvailableError,
  DEFAULT_AI_CONFIG_NAME,
  resolveAiConfigWithFallback,
  resolveAiConfigs,
  type AiConfigOwnerType,
} from '../../../lib/aiConfig.js';
import {
  renderNodeExport,
  type NodeExportFormat,
  type NodeExportSection,
} from '../../../lib/nodeExport.js';
import { renderMarkdownToPdf } from '../../../lib/pdfClient.js';
import { type EdgeForGit } from '../../../integrations/github/nodeFrontmatter.js';
import {
  BATCH_READ_MAX_NODES,
  BATCH_READ_MAX_BYTES,
} from '../../../lib/batchRead.js';
import {
  vectorSearchNodes,
  vectorSearchChunks,
} from '../../../services/embedding/vectors.js';
import {
  getEmbeddingClient,
  isEmbeddingConfigured,
} from '../../../lib/embedding/index.js';
import { getDeploymentInfo } from '../../../mcp/deploymentInfo.js';
import { reciprocalRankFusion } from '../../../lib/rrf.js';
import {
  matchesQuery,
  keywordRelevanceRank,
} from '../../../lib/search.js';
import { isLifecycleActive } from '../../../lib/lifecycle.js';
import {
  getPrimaryAgent,
  getPrimaryAgentId,
} from '../../../lib/appAgent.js';
import {
  decryptNodeFields,
  decryptNodesBatch,
  getMemoryEncryptionInfo,
} from '../../../lib/nodeCrypto.js';
import {
  parseUrnInput,
  validateUrnType,
  composeInstalledAgentUrn,
  assertFullyQualifiedUrn,
  hasSchemePrefix,
  legacyMemoryUrnToCanonical,
} from '../../../lib/urn.js';
import { compileTemplate } from '../../../lib/template.js';
import { listMemoryAssets } from '../../../controller/operations/listMemoryAssets.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { UserNotFoundError } from '../../../lib/entityRef/errors.js';
import { userUrn } from '../../../lib/userHandle.js';
import { isId } from '../../../lib/entityRef/shape.js';
import {
  resolveResource as resolveAccessResource,
  callerCanAudit,
  computeEffectiveAccess,
} from '../../../lib/auth/effectiveAccess.js';
import {
  globalSearch as runGlobalSearch,
  type SearchEntityType,
  type SearchField,
  type SearchPrincipal,
} from '../../../lib/global-search/index.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';
import {
  canSeeUserPersonalFields,
  canSeeOrgMemberRole,
} from '../../../lib/auth/userVisibility.js';
import { listAgentAssets } from '../../../controller/operations/listAgentAssets.js';
import { mintAssetDownloadUrl } from '../../../controller/operations/mintAssetDownloadUrl.js';
import { GraphQLError } from 'graphql';
import { type AgentVisibility } from '../../../generated/prisma/index.js';
import {
  deserializeTags,
  deserializeJson,
  searchContains,
  tagsFilter,
} from '../../../integrations/db/provider.js';
import {
  listInboxMessages,
  listFolders,
} from '../../../integrations/exchange/exchange.js';

// ── Helpers extracted to resolvers.helpers.ts (Step 1 of the resolver split) ──
import {
  type Context,
  loadEdgeEndpointNode,
  ROLE_ORDER,
  requireRole,
  requireOrgRole,
  isPlatformAdmin,
  toGqlAiServiceConfig,
  requireAiConfigOwnerAdmin,
  requireAiConfigPickerAccess,
  rethrowAiConfigTyped,
  defaultAiConfigOf,
  getAccessibleMemoryIds,
  sessionScopeFilter,
  memoryAccessFilter,
  safeCanonicalUrn,
  renderNodeSearchResult,
  MEMORY_INCLUDE,
  AGENT_INCLUDE,
  ORG_INCLUDE,
  SESSION_INCLUDE,
  APP_INCLUDE,
  toISO,
  readPrimaryAgentIdFromEager,
  readPrimaryAgentRecordFromEager,
  readAllAgentRecordsFromEager,
  readPrimaryAgentField,
  deriveChatTitle,
  getExchangeRefreshToken,
  resolveAssetTargetMemoryId,
  assetUrn,
} from './resolvers.helpers.js';

// Re-export Context so existing importers (mcp/server.ts + the resolver test
// suite, ~80 files) keep importing it from './resolvers.js' unchanged.
export type { Context };

// Mutation resolvers, carved into domain modules (split step 2).
import { nodeMutations } from './resolvers.mutation.node.js';
import { assetMutations } from './resolvers.mutation.asset.js';
import { memoryMutations } from './resolvers.mutation.memory.js';
import { orgMutations } from './resolvers.mutation.org.js';
import { agentMutations } from './resolvers.mutation.agent.js';
import { appMutations } from './resolvers.mutation.app.js';
import { chatMutations } from './resolvers.mutation.chat.js';
import { sessionMutations } from './resolvers.mutation.session.js';

export const resolvers = {
  Node: {
    tags: (node: { tags: string | string[] }) => deserializeTags(node.tags),
    createdAt: (n: { createdAt: Date | string }) => toISO(n.createdAt)!,
    updatedAt: (n: { updatedAt: Date | string }) => toISO(n.updatedAt)!,
    // `node { memory { urn … } }` powers full-URN rendering in clients
    // (the portal composes `<memory.urn>::<loc>`). The generic `nodes`
    // query doesn't `include` the relation, so resolve it lazily by
    // memoryId — use the preloaded relation when a resolver already
    // included it (e.g. appNodes). Same pattern as MemoryShare.memory.
    memory: async (n: { memoryId: string; memory?: unknown }, _: unknown, ctx: Context) =>
      n.memory ?? ctx.db.memory.findUnique({ where: { id: n.memoryId } }),
    // Spec 033 embedding-state DateTime fields — Prisma returns Date,
    // portal (and any other GraphQL consumer) needs ISO strings.
    embeddingPendingAt: (n: { embeddingPendingAt?: Date | string | null }) =>
      toISO(n.embeddingPendingAt),
    embeddingFailedAt: (n: { embeddingFailedAt?: Date | string | null }) =>
      toISO(n.embeddingFailedAt),
  },
  Edge: {
    // `Edge.source` / `Edge.target` are non-null (`Node!`) in the schema, but
    // callers preload only the relevant endpoint per direction (e.g. nodeById
    // does `outgoingEdges: { include: { target: true } }` — source is NOT
    // loaded — and the mirror for incomingEdges). A client selecting the
    // unloaded side would otherwise resolve to null, violate the non-null
    // field, and bubble up to error the WHOLE query (e.g. the portal edge
    // detail page selecting `source` on an outgoing edge → 500). Lazily load
    // the endpoint by FK when it wasn't preloaded — same pattern as
    // Node.memory. The fast path (preloaded) returns the relation unchanged.
    //
    // The lazy path runs once per Edge in a list, and edges commonly SHARE an
    // endpoint — e.g. `nodeById { outgoingEdges { source } }`, where every
    // edge's source is the same parent node. `loadEdgeEndpointNode` memoizes
    // the fetch in a request-scoped cache on the Context so each node is read
    // at most once per request (no N+1 of identical findUnique). PR #381 review.
    source: (e: { sourceId: string; source?: unknown }, _: unknown, ctx: Context) =>
      e.source ?? loadEdgeEndpointNode(ctx, e.sourceId),
    target: (e: { targetId: string; target?: unknown }, _: unknown, ctx: Context) =>
      e.target ?? loadEdgeEndpointNode(ctx, e.targetId),
  },
  NodeVersion: {
    createdAt: (nv: { createdAt: Date | string }) => toISO(nv.createdAt)!,
  },
  Asset: {
    uploadedAt: (a: { uploadedAt: Date | string }) => toISO(a.uploadedAt)!,
    deletedAt: (a: { deletedAt?: Date | string | null }) => toISO(a.deletedAt),
    urn: async (a: { id: string; memoryId: string }, _: unknown, ctx: Context) => {
      const memory = await ctx.db.memory.findUnique({
        where: { id: a.memoryId },
        select: { urn: true },
      });
      return memory ? assetUrn(memory.urn, a.id) : `unknown:assets:${a.id}`;
    },
  },
  Memory: {
    lastSyncedAt: (g: { lastSyncedAt?: Date | string | null }) => toISO(g.lastSyncedAt),
    createdAt: (g: { createdAt: Date | string }) => toISO(g.createdAt)!,
    updatedAt: (g: { updatedAt: Date | string }) => toISO(g.updatedAt)!,
    // Spec 033 FR-026 — readback for the encrypted-memory vector-
    // inversion disclosure ack.
    vectorIndexEncryptedAckAt: (g: {
      vectorIndexEncryptedAckAt?: Date | string | null;
    }) => toISO(g.vectorIndexEncryptedAckAt),
    organization: (g: { organizationId: string; organization?: unknown }, _: unknown, ctx: Context) =>
      (g as Record<string, unknown>).organization ??
      ctx.db.organization.findUnique({ where: { id: g.organizationId } }),
    // 008-agent-installation: app pivot for app/personal-class memories.
    app: async (g: { appId?: string | null; app?: unknown }, _: unknown, ctx: Context) => {
      if (g.app !== undefined) return g.app ?? null;
      if (!g.appId) return null;
      return ctx.db.app.findUnique({ where: { id: g.appId } });
    },
    // 005-agent-subscription FR-024: userId is gated. Resolves to the
    // actual User.id only for the memory owner or ADMIN/OWNER of the
    // memory's organization. End users querying other users' memories
    // get null even when the underlying value is non-null.
    userId: (
      g: { userId?: string | null; organizationId: string },
      _: unknown,
      ctx: Context,
    ) => {
      if (!g.userId) return null;
      // Memory owner can always see
      if (ctx.userId === g.userId) return g.userId;
      // ADMIN/OWNER of the memory's org can see (for governance)
      if (
        ctx.organizationId === g.organizationId &&
        (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'))
      ) {
        return g.userId;
      }
      // Platform ADMIN/OWNER also see
      if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) {
        return g.userId;
      }
      return null;
    },
    // For system-class memories, find the agent that owns this memory.
    // Returns null for regular knowledge memories. We use a findFirst because
    // there's no FK from Memory → Agent — the relationship is expressed on
    // the Agent side via Agent.systemMemoryId.
    agent: async (g: { id: string; class?: string }, _: unknown, ctx: Context) => {
      if (g.class !== 'system') return null;
      return ctx.db.agent.findFirst({
        where: { systemMemoryId: g.id, deletedAt: null },
        include: AGENT_INCLUDE,
      });
    },
    // 023-app-shape US3: cross-user grants on this Memory. Empty for
    // non-personal-class memories. Visible to (a) the principal
    // (memory.userId), (b) an OrgMember of the memory's owning org
    // with ADMIN/OWNER role, or (c) a platform ADMIN/OWNER.
    // Grantees can read their own shares via User.memorySharesGranted
    // (out of scope here; can be added if a portal page needs it).
    shares: async (
      g: { id: string; class: string; userId?: string | null; organizationId: string },
      _: unknown,
      ctx: Context,
    ) => {
      if (g.class !== 'personal') return [];
      const isPrincipal = ctx.userId !== undefined && ctx.userId === g.userId;
      const isPlatformAdmin =
        ctx.roles?.includes('ADMIN') === true || ctx.roles?.includes('OWNER') === true;
      if (!isPrincipal && !isPlatformAdmin) {
        // Verify the caller is an ADMIN/OWNER of the memory's owning
        // org. The earlier `ctx.organizationId === g.organizationId`
        // shortcut was incomplete — most callers don't have
        // organizationId scoped per-request, which would have made
        // non-platform org admins fall through to an empty list.
        if (!ctx.userId) return [];
        const member = await ctx.db.orgMember.findUnique({
          where: {
            organizationId_userId: {
              organizationId: g.organizationId,
              userId: ctx.userId,
            },
          },
          select: { role: true, deletedAt: true },
        });
        if (
          !member ||
          member.deletedAt ||
          (member.role !== 'ADMIN' && member.role !== 'OWNER')
        ) {
          return [];
        }
      }
      return ctx.db.memoryShare.findMany({
        where: { memoryId: g.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    // 023-app-shape US4: team membership rows on this memory. Empty
    // for non-group-class memories. Visible to current members (any
    // role), ADMIN/OWNER of the memory's owning org, and platform
    // ADMIN/OWNER. Non-members of a group memory get an empty list
    // even if they happen to be in the org but not on the team.
    members: async (
      g: { id: string; class?: string; organizationId?: string },
      _: unknown,
      ctx: Context,
    ) => {
      // Partial-select-safe: some query paths (e.g. `appNodes`)
      // select Memory with only { id, urn, name, organizationId }
      // or even less. Fetch the missing scoping fields rather than
      // silently returning `[]` for a real group memory.
      let cls = g.class;
      let orgId = g.organizationId;
      if (cls === undefined || orgId === undefined) {
        const m = await ctx.db.memory.findUnique({
          where: { id: g.id },
          select: { class: true, organizationId: true },
        });
        if (!m) return [];
        cls = m.class;
        orgId = m.organizationId;
      }
      if (cls !== 'group') return [];
      const isPlatformAdmin =
        ctx.roles?.includes('ADMIN') === true || ctx.roles?.includes('OWNER') === true;
      if (!isPlatformAdmin) {
        if (!ctx.userId) return [];
        // Self-membership check (any role).
        const selfMember = await ctx.db.memoryMember.findUnique({
          where: { memoryId_userId: { memoryId: g.id, userId: ctx.userId } },
          select: { userId: true },
        });
        if (!selfMember) {
          // Fall back to org admin.
          const orgMember = await ctx.db.orgMember.findUnique({
            where: {
              organizationId_userId: {
                organizationId: orgId,
                userId: ctx.userId,
              },
            },
            select: { role: true, deletedAt: true },
          });
          if (
            !orgMember ||
            orgMember.deletedAt ||
            (orgMember.role !== 'ADMIN' && orgMember.role !== 'OWNER')
          ) {
            return [];
          }
        }
      }
      return ctx.db.memoryMember.findMany({
        where: { memoryId: g.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    // 298/318/352: Canonicalize URN on read. Converts legacy single-colon
    // hierarchy (e.g. `org:slug`) to canonical spec-021 double-colon form
    // (`org::slug`) for both legacy and migrated rows. For install-shape
    // memories with role markers (system, app-mem, app-user, group-mem, priv,
    // anon), `legacyMemoryUrnToCanonical` preserves the marker:id boundary so
    // the canonical form round-trips through `parseUrn`
    // (e.g. `org:agent:app-user:id` → `org::agent::app-user:id`, NOT
    // `…::app-user::id`). #352: the marker set is now the single source of
    // truth in urn.ts — `user` (a reserved type word) and `anon` used to
    // bypass the inline list here and serve non-canonical.
    urn: (g: { urn?: string | null }) => {
      const urn = g.urn;
      if (!urn) throw new Error('Memory URN is required but not found (partial query?)');

      // Already canonical (contains `::`) — pass through
      if (urn.includes('::')) return safeCanonicalUrn('memory', urn);

      // Legacy single-colon form — promote hierarchy to `::` while preserving
      // any role-marker:id boundary.
      return safeCanonicalUrn('memory', legacyMemoryUrnToCanonical(urn));
    },
  },
  App: {
    createdAt: (a: { createdAt: Date | string }) => toISO(a.createdAt)!,
    updatedAt: (a: { updatedAt?: Date | string | null }) => toISO(a.updatedAt ?? null),
    expiresAt: (a: { expiresAt?: Date | string | null }) => toISO(a.expiresAt ?? null),
    // 036-ai-service-config: registry-backed reads of the App's
    // 'default' config (legacy ai_* columns dropped).
    aiProvider: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'appId', ctx))?.provider ?? null,
    aiModel: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'appId', ctx))?.model ?? null,
    hasAiApiKey: async (a: { id: string }, _: unknown, ctx: Context) =>
      !!(await defaultAiConfigOf(a, 'appId', ctx))?.apiKeyEncrypted,
    organization: (a: { organizationId: string; organization?: unknown }, _: unknown, ctx: Context) =>
      (a as Record<string, unknown>).organization ??
      ctx.db.organization.findUnique({ where: { id: a.organizationId } }),
    // Spec 021 US1: R2 canonical install URN combining App + Agent URNs.
    // 023-app-shape Phase 2b: read the primary installed Agent's URN via
    // the eager-loaded `appAgents` (preferred — APP_INCLUDE / ORG_INCLUDE
    // both surface it), with a fallback to `getPrimaryAgent`. Returns
    // null when no Agent is installed.
    installedAgentUrn: async (
      a: { id: string; urn: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      const agentUrn = await readPrimaryAgentField(a, ctx, 'urn');
      if (!agentUrn) return null;
      return composeInstalledAgentUrn(a.urn, agentUrn);
    },
    // 023-app-shape Phase 2b: `App.agent` and `App.agents` are
    // soft-deprecated convenience fields that resolve via the AppAgent
    // join. `App.agent` returns the first installed Agent (orderBy
    // createdAt asc); `App.agents` returns every installed Agent.
    //
    // Agent.memoryItems is non-null in the schema, so the resolved
    // value must include AGENT_INCLUDE — `appAgents` from APP_INCLUDE /
    // ORG_INCLUDE already does, and the fallback re-fetch via
    // `getPrimaryAgent({ include: AGENT_INCLUDE })` does too.
    agentId: async (
      a: { id: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ): Promise<string | null> => {
      const id = readPrimaryAgentIdFromEager(a);
      if (id !== undefined) return id;
      return getPrimaryAgentId(ctx.db, a.id);
    },
    agent: async (
      a: { id: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      const eager = readPrimaryAgentRecordFromEager(a);
      if (eager !== undefined) return eager;
      return getPrimaryAgent(ctx.db, a.id, { include: AGENT_INCLUDE });
    },
    agents: async (
      a: { id: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      const eagerAll = readAllAgentRecordsFromEager(a);
      if (eagerAll !== undefined) {
        return eagerAll.filter((ag): ag is { deletedAt: Date | null } & object =>
          ag !== null && !(ag as { deletedAt?: Date | null }).deletedAt,
        );
      }
      const rows = await ctx.db.appAgent.findMany({
        where: { appId: a.id },
        orderBy: { createdAt: 'asc' },
        include: { agent: { include: AGENT_INCLUDE } },
      });
      return rows.map((r) => r.agent).filter((ag) => ag && !ag.deletedAt);
    },
    members: async (a: { id: string }, _: unknown, ctx: Context) => {
      return ctx.db.appMember.findMany({
        where: { appId: a.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    memberCount: async (a: { id: string }, _: unknown, ctx: Context) => {
      return ctx.db.appMember.count({ where: { appId: a.id } });
    },
    keys: async (a: { id: string; keys?: unknown[] }, _: unknown, ctx: Context) => {
      if (a.keys) return a.keys;
      return ctx.db.appKey.findMany({
        where: { appId: a.id, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    },
    // 023-app-shape US1: AppAgent join rows for this App. Filters out
    // join rows whose Agent is soft-deleted, keeping App.appAgents
    // and App.agents in sync (App.agents already filters deletedAt;
    // App.appAgents.map(aa => aa.agent) should return the same set).
    //
    // The eager-loaded rows from APP_INCLUDE don't carry `aa.app`
    // (it would be redundant — the parent IS that App). Attach the
    // parent App onto each row so `AppAgent.app` resolves without an
    // N+1 DB lookup per row.
    appAgents: async (a: { id: string; appAgents?: unknown } & Record<string, unknown>, _: unknown, ctx: Context) => {
      if (Array.isArray(a.appAgents)) {
        return a.appAgents
          .filter((aa) => {
            const agent = (aa as { agent?: { deletedAt?: Date | null } | null }).agent;
            return agent != null && !agent.deletedAt;
          })
          .map((aa) => ({ ...(aa as object), app: a }));
      }
      return ctx.db.appAgent.findMany({
        where: { appId: a.id, agent: { deletedAt: null } },
        orderBy: { createdAt: 'asc' },
        include: { app: true, agent: { include: AGENT_INCLUDE } },
      });
    },
    // 298: Canonicalize URN on read. Converts legacy single-colon hierarchy
    // to canonical spec-021 double-colon form for both legacy and migrated rows.
    urn: (a: { urn?: string | null }) => {
      if (!a.urn) throw new Error('App URN is required but not found (partial query?)');
      return safeCanonicalUrn('app', a.urn);
    },
  },
  // 023-app-shape US1: the App↔Agent N:M join.
  AppAgent: {
    createdAt: (aa: { createdAt: Date | string }) => toISO(aa.createdAt)!,
    updatedAt: (aa: { updatedAt?: Date | string | null }) => toISO(aa.updatedAt ?? null),
    app: async (aa: { appId: string; app?: unknown }, _: unknown, ctx: Context) =>
      aa.app ?? ctx.db.app.findUniqueOrThrow({ where: { id: aa.appId } }),
    agent: async (aa: { agentId: string; agent?: unknown }, _: unknown, ctx: Context) =>
      aa.agent ??
      ctx.db.agent.findUniqueOrThrow({
        where: { id: aa.agentId },
        include: AGENT_INCLUDE,
      }),
  },
  AgentSubscription: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    activatedAt: (s: { activatedAt?: Date | string | null }) => toISO(s.activatedAt ?? null),
    expiresAt: (s: { expiresAt?: Date | string | null }) => toISO(s.expiresAt ?? null),
    revokedAt: (s: { revokedAt?: Date | string | null }) => toISO(s.revokedAt ?? null),
    isActive: (s: { activatedAt?: Date | null; revokedAt?: Date | null; expiresAt?: Date | null }) =>
      isLifecycleActive({
        activatedAt: s.activatedAt ?? null,
        revokedAt: s.revokedAt ?? null,
        expiresAt: s.expiresAt ?? null,
      }),
    user: async (s: { userId: string; user?: unknown }, _: unknown, ctx: Context) =>
      s.user ?? ctx.db.user.findUnique({ where: { id: s.userId } }),
    agent: async (s: { agentId: string; agent?: unknown }, _: unknown, ctx: Context) =>
      s.agent ?? ctx.db.agent.findUnique({ where: { id: s.agentId } }),
  },
  // 008-agent-installation: User↔App membership join.
  AppMember: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    updatedAt: (s: { updatedAt?: Date | string | null }) => toISO(s.updatedAt ?? null),
    app: async (s: { appId: string; app?: unknown }, _: unknown, ctx: Context) =>
      s.app ?? ctx.db.app.findUnique({ where: { id: s.appId } }),
    user: async (s: { userId: string; user?: unknown }, _: unknown, ctx: Context) =>
      s.user ?? ctx.db.user.findUnique({ where: { id: s.userId } }),
    // 023-app-shape US2 / FR-011: derived from the absence of an
    // OrgMember row in the App's owning Organization. No `appOnly`
    // column on AppMember.
    //
    // The parent is ALREADY an AppMember row by GraphQL contract, so
    // the resolver bypasses the wrapper helper's AppMember-existence
    // check (which would be wasted work — pure N+1 on list fields
    // like Organization.appMembers). The wrapper's contract still
    // matters for auth-side callers that may not have a parent row.
    isOrgExternal: async (
      s: { appId: string; userId: string; app?: { organizationId?: string } | null },
      _: unknown,
      ctx: Context,
    ) => {
      // Prefer the eager-loaded organizationId from APP_INCLUDE; fall
      // back to a re-fetch otherwise.
      const organizationId =
        s.app?.organizationId ??
        (
          await ctx.db.app.findUnique({
            where: { id: s.appId },
            select: { organizationId: true },
          })
        )?.organizationId;
      if (!organizationId) return false;
      const orgMember = await ctx.db.orgMember.findFirst({
        where: { userId: s.userId, organizationId, deletedAt: null },
        select: { userId: true },
      });
      return orgMember === null;
    },
  },
  // 023-app-shape US3: asymmetric cross-user grant on personal-class memory.
  MemoryShare: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    updatedAt: (s: { updatedAt?: Date | string | null }) => toISO(s.updatedAt ?? null),
    memory: async (s: { memoryId: string; memory?: unknown }, _: unknown, ctx: Context) =>
      s.memory ?? ctx.db.memory.findUnique({ where: { id: s.memoryId } }),
    grantee: async (s: { granteeId: string; grantee?: unknown }, _: unknown, ctx: Context) =>
      s.grantee ?? ctx.db.user.findUnique({ where: { id: s.granteeId } }),
    grantor: async (s: { grantorId: string; grantor?: unknown }, _: unknown, ctx: Context) =>
      s.grantor ?? ctx.db.user.findUnique({ where: { id: s.grantorId } }),
  },
  // 023-app-shape US4: symmetric team membership on group-class memory.
  MemoryMember: {
    createdAt: (m: { createdAt: Date | string }) => toISO(m.createdAt)!,
    updatedAt: (m: { updatedAt?: Date | string | null }) => toISO(m.updatedAt ?? null),
    memory: async (m: { memoryId: string; memory?: unknown }, _: unknown, ctx: Context) =>
      m.memory ?? ctx.db.memory.findUnique({ where: { id: m.memoryId } }),
    user: async (m: { userId: string; user?: unknown }, _: unknown, ctx: Context) =>
      m.user ?? ctx.db.user.findUnique({ where: { id: m.userId } }),
  },
  // 008-agent-installation: Agent dependency edge.
  AgentImport: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    parentAgent: async (s: { parentAgentId: string }, _: unknown, ctx: Context) =>
      ctx.db.agent.findUnique({ where: { id: s.parentAgentId } }),
    importedAgent: async (s: { importedAgentId: string }, _: unknown, ctx: Context) =>
      ctx.db.agent.findUnique({ where: { id: s.importedAgentId } }),
  },
  // 008-agent-installation: Org↔Agent license — sibling to AgentSubscription.
  AgentOrgGrant: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    activatedAt: (s: { activatedAt?: Date | string | null }) => toISO(s.activatedAt ?? null),
    expiresAt: (s: { expiresAt?: Date | string | null }) => toISO(s.expiresAt ?? null),
    revokedAt: (s: { revokedAt?: Date | string | null }) => toISO(s.revokedAt ?? null),
    isActive: (s: { activatedAt?: Date | null; revokedAt?: Date | null; expiresAt?: Date | null }) =>
      isLifecycleActive({
        activatedAt: s.activatedAt ?? null,
        revokedAt: s.revokedAt ?? null,
        expiresAt: s.expiresAt ?? null,
      }),
    organization: async (s: { orgId: string }, _: unknown, ctx: Context) =>
      ctx.db.organization.findUnique({ where: { id: s.orgId } }),
    agent: async (s: { agentId: string }, _: unknown, ctx: Context) =>
      ctx.db.agent.findUnique({ where: { id: s.agentId } }),
  },
  // 008-agent-installation: Agent declarative knobs are stored as JSON on
  // the row; the type resolvers pluck the known keys for ergonomic client
  // access. Both come back from `Agent.findUnique` already shaped — these
  // resolvers exist so GraphQL knows MemoryProvisioning/InstallationPolicy
  // are passthrough types, not auto-resolved scalars.
  MemoryProvisioning: {
    appMemory: (p: { appMemory: 'shared' | 'user' | 'none' }) => p.appMemory,
  },
  InstallationPolicy: {
    maxMembers: (p: { maxMembers: number | 'unlimited' }) => String(p.maxMembers),
    memberRoles: (p: { memberRoles: string[] }) => p.memberRoles,
  },
  AppKey: {
    createdAt: (k: { createdAt: Date | string }) => toISO(k.createdAt)!,
    lastUsedAt: (k: { lastUsedAt?: Date | string | null }) => toISO(k.lastUsedAt ?? null),
    revokedAt: (k: { revokedAt?: Date | string | null }) => toISO(k.revokedAt ?? null),
  },
  // 025-oauth-for-mcp: serialize timestamp fields the same way AppKey
  // does. `userId` is intentionally NOT exposed (PR-137 delta D1).
  UserApiKey: {
    createdAt: (k: { createdAt: Date | string }) => toISO(k.createdAt)!,
    lastUsedAt: (k: { lastUsedAt?: Date | string | null }) => toISO(k.lastUsedAt ?? null),
    revokedAt: (k: { revokedAt?: Date | string | null }) => toISO(k.revokedAt ?? null),
  },
  // #384: a member's org role is itself gated. Visible only to the member
  // themselves, platform admins, and co-members whose own role in that org is
  // ADMIN/OWNER. Withheld (null) otherwise — so a READER/CONTRIBUTOR member
  // can't read everyone else's role off the member list. Other OrgMember
  // fields keep default resolution.
  OrgMember: {
    role: async (
      m: { userId: string; organizationId: string; role: string },
      _: unknown,
      ctx: Context,
    ) => ((await canSeeOrgMemberRole(ctx, m)) ? m.role : null),
  },
  User: {
    linkedAt: (u: { linkedAt?: Date | string | null }) => toISO(u.linkedAt ?? null),
    // Canonical hrn:user:<handle> URN (spec cor:urn:010:01) — lowercase, and
    // null for a handle-less or not-URN-legal (grandfathered) handle.
    urn: (u: { handle?: string | null }) => userUrn(u.handle),
    // #384: field-level visibility. name/email are PII — withheld (null)
    // from any viewer who isn't the user themselves, a platform admin, or a
    // co-member of one of the user's orgs. Applied here so EVERY surface that
    // returns a User (searchUsers, me, OrgMember.user, MemoryShare.*, the
    // public invitation.sender, …) gets the same guarantee server-side.
    name: async (u: { id: string; name?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.name ?? null) : null,
    email: async (u: { id: string; email?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.email ?? null) : null,
    // 008-agent-installation: User↔App memberships. Resolves to a non-empty
    // list only when the queried User is the authenticated user (mirrors
    // 005's User.agentSubscriptions resolver-side gate).
    appMemberships: async (u: { id: string }, _: unknown, ctx: Context) => {
      if (ctx.userId !== u.id) return [];
      return ctx.db.appMember.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: 'asc' },
      });
    },
  },
  Session: {
    startedAt: (s: { startedAt: Date | string }) => toISO(s.startedAt)!,
    endedAt: (s: { endedAt?: Date | string | null }) => toISO(s.endedAt ?? null),
    expiresAt: (s: { expiresAt?: Date | string | null }) => toISO(s.expiresAt ?? null),
    autoExpiredAt: (s: { autoExpiredAt?: Date | string | null }) => toISO(s.autoExpiredAt ?? null),
    outcomeMeta: (session: { outcomeMeta: unknown }) => deserializeJson(session.outcomeMeta),
  },
  Organization: {
    createdAt: (o: { createdAt: Date | string }) => toISO(o.createdAt)!,
    updatedAt: (o: { updatedAt: Date | string }) => toISO(o.updatedAt)!,
    hasGithubAppPrivateKey: (o: { githubAppPrivateKeyEncrypted?: string | null }) => !!o.githubAppPrivateKeyEncrypted,
    apps: async (org: { id: string; apps?: unknown[] }, _: unknown, ctx: Context) => {
      if (org.apps) return org.apps;
      return ctx.db.app.findMany({
        where: { organizationId: org.id, deletedAt: null },
        include: APP_INCLUDE,
        orderBy: { name: 'asc' },
      });
    },
    agents: async (org: { id: string }, _: unknown, ctx: Context) => {
      const where: Record<string, unknown> = { organizationId: org.id, deletedAt: null };
      if (ctx.userId) {
        // PERSONAL: only creator; ORGANIZATION + PUBLIC: all org members.
        // 035-visibility-enum-cleanup: agents use AgentVisibility now; the
        // creator-only draft value is PERSONAL (was PRIVATE).
        where.OR = [
          { visibility: { not: 'PERSONAL' as AgentVisibility } },
          { visibility: 'PERSONAL' as AgentVisibility, createdBy: ctx.userId },
        ];
      }
      return ctx.db.agent.findMany({
        where,
        include: { memoryItems: { where: { deletedAt: null, memory: { deletedAt: null } }, include: { memory: true } } },
        orderBy: { name: 'asc' },
      });
    },
    // 008-agent-installation: list grants for this Org. Resolvable only to
    // ADMIN/OWNER of the org. Non-admins get an empty list (silent rather
    // than erroring — same shape as User.appMemberships).
    agentOrgGrants: async (org: { id: string }, _: unknown, ctx: Context) => {
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin && ctx.organizationId !== org.id) return [];
      if (!isPlatformAdmin) {
        const member = await ctx.db.orgMember.findFirst({
          where: {
            organizationId: org.id,
            userId: ctx.userId ?? '',
            deletedAt: null,
            role: { in: ['ADMIN', 'OWNER'] },
          },
        });
        if (!member) return [];
      }
      return ctx.db.agentOrgGrant.findMany({
        where: { orgId: org.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    // 298: Canonicalize URN on read. Converts legacy single-colon hierarchy
    // to canonical spec-021 double-colon form for both legacy and migrated rows.
    urn: (o: { urn?: string | null }) => {
      if (!o.urn) throw new Error('Organization URN is required but not found (partial query?)');
      return safeCanonicalUrn('org', o.urn);
    },
  },
  ExchangeConnection: {
    lastSyncAt: (c: { lastSyncAt?: Date | string | null }) => toISO(c.lastSyncAt),
    createdAt: (c: { createdAt: Date | string }) => toISO(c.createdAt)!,
    updatedAt: (c: { updatedAt: Date | string }) => toISO(c.updatedAt)!,
  },
  Agent: {
    createdAt: (b: { createdAt: Date | string }) => toISO(b.createdAt)!,
    // 036-ai-service-config: registry-backed reads of the Agent's
    // 'default' config (legacy ai_* columns dropped). Never return the
    // encrypted key itself — only whether one exists + the preview.
    aiProvider: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'agentId', ctx))?.provider ?? null,
    aiModel: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'agentId', ctx))?.model ?? null,
    hasAiApiKey: async (a: { id: string }, _: unknown, ctx: Context) =>
      !!(await defaultAiConfigOf(a, 'agentId', ctx))?.apiKeyEncrypted,
    aiApiKeyPreview: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'agentId', ctx))?.apiKeyPreview ?? null,
    // 008-agent-installation: declarative knobs come back from Prisma as
    // JSON columns. Pass through with sensible defaults (the column has a
    // schema-level DEFAULT, so this is belt-and-braces against partial
    // selects that omit the column).
    memoryProvisioning: (a: { memoryProvisioning?: unknown }) =>
      (a.memoryProvisioning as { appMemory: 'shared' | 'user' | 'none' } | undefined) ??
      { appMemory: 'shared' },
    installationPolicy: (a: { installationPolicy?: unknown }) =>
      (a.installationPolicy as { maxMembers: number | 'unlimited'; memberRoles: string[] } | undefined) ??
      { maxMembers: 'unlimited', memberRoles: ['owner'] },
    imports: async (a: { id: string }, _: unknown, ctx: Context) =>
      ctx.db.agentImport.findMany({
        where: { parentAgentId: a.id },
        orderBy: { position: 'asc' },
      }),
    importedBy: async (a: { id: string }, _: unknown, ctx: Context) =>
      ctx.db.agentImport.findMany({
        where: { importedAgentId: a.id },
        orderBy: { position: 'asc' },
      }),
    // Apps that deploy this Agent. Resolvable to ADMIN/OWNER of the
    // Agent's owning org; everyone else gets an empty list.
    apps: async (a: { id: string; organizationId: string }, _: unknown, ctx: Context) => {
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        const member = await ctx.db.orgMember.findFirst({
          where: {
            organizationId: a.organizationId,
            userId: ctx.userId ?? '',
            deletedAt: null,
            role: { in: ['ADMIN', 'OWNER'] },
          },
        });
        if (!member) return [];
      }
      // 023-app-shape Phase 2b: App↔Agent is N:M via AppAgent. List Apps
      // that have this Agent installed.
      return ctx.db.app.findMany({
        where: { appAgents: { some: { agentId: a.id } }, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
    },
    appCount: async (a: { id: string }, _: unknown, ctx: Context) =>
      ctx.db.app.count({
        where: { appAgents: { some: { agentId: a.id } }, deletedAt: null },
      }),
    // 023-app-shape US1: the AppAgent join rows where this Agent is
    // installed. ADMIN/OWNER-gated like `apps` — non-admins of the
    // Agent's owning org see an empty list.
    appAgents: async (a: { id: string; organizationId: string }, _: unknown, ctx: Context) => {
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        const member = await ctx.db.orgMember.findFirst({
          where: {
            organizationId: a.organizationId,
            userId: ctx.userId ?? '',
            deletedAt: null,
            role: { in: ['ADMIN', 'OWNER'] },
          },
        });
        if (!member) return [];
      }
      return ctx.db.appAgent.findMany({
        where: {
          agentId: a.id,
          app: { deletedAt: null },
          agent: { deletedAt: null },
        },
        orderBy: { createdAt: 'asc' },
        include: { app: true, agent: { include: AGENT_INCLUDE } },
      });
    },
    orgGrants: async (a: { id: string; organizationId: string }, _: unknown, ctx: Context) => {
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        const member = await ctx.db.orgMember.findFirst({
          where: {
            organizationId: a.organizationId,
            userId: ctx.userId ?? '',
            deletedAt: null,
            role: { in: ['ADMIN', 'OWNER'] },
          },
        });
        if (!member) return [];
      }
      return ctx.db.agentOrgGrant.findMany({
        where: { agentId: a.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    // 298: Canonicalize URN on read. Converts legacy single-colon hierarchy
    // to canonical spec-021 double-colon form for both legacy and migrated rows.
    urn: (a: { urn?: string | null }) => {
      if (!a.urn) throw new Error('Agent URN is required but not found (partial query?)');
      return safeCanonicalUrn('agent', a.urn);
    },
  },
  UsageEvent: {
    actionArgs: (event: { actionArgs: unknown }) => deserializeJson(event.actionArgs),
    createdAt: (ue: { createdAt: Date | string }) => toISO(ue.createdAt)!,
  },

  Query: {
    // Identity of the running hadron-server: the server-identity version
    // (HADRON_SERVER_VERSION) + canonical base URL. Public (no auth) — the
    // GraphQL counterpart to the hadron_server_info MCP tool, reading the
    // same getDeploymentInfo() helper so both surfaces agree on "which
    // server/API am I talking to?". Never exposes the DATABASE_URL.
    serverInfo: async (_: unknown, __: unknown, ___: Context) => getDeploymentInfo(),

    // hadron-portal#262: resolve a `urn:<type>:`-prefixed URN to the ids the
    // portal needs to redirect to the resource's canonical page. Dispatches
    // on the URN type segment; reuses the same entity-ref resolvers and
    // per-kind authorization as the dedicated memory/node/org/agent/app
    // queries. No-access and not-found both collapse to null (→ the portal
    // route turns it into a 404), so this never discloses existence of a
    // resource the caller can't reach. Bare URNs without a type prefix are
    // ambiguous across kinds and return null.
    resolveUrn: async (_: unknown, { urn }: { urn: string }, ctx: Context) => {
      const isGlobalAdmin =
        !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
      // Membership check mirroring the per-kind queries' "member of the org"
      // gate, but returning a boolean instead of throwing so we can collapse
      // no-access to null.
      const isOrgMember = async (orgId: string): Promise<boolean> => {
        if (isGlobalAdmin) return true;
        if (!ctx.userId) return false;
        const member = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: orgId, userId: ctx.userId } },
        });
        return !!member;
      };

      const { type } = parseUrnInput(urn);
      switch (type) {
        case 'memory': {
          let id: string;
          try {
            ({ id } = await resolveMemoryRef(ctx.db, urn));
          } catch {
            return null;
          }
          const memory = await ctx.db.memory.findUnique({
            where: { id },
            select: { organizationId: true },
          });
          if (!memory) return null;
          if (!(await isOrgMember(memory.organizationId))) return null;
          return { kind: 'memory', id };
        }
        case 'node': {
          let id: string;
          try {
            ({ id } = await resolveNodeRef(ctx.db, urn));
          } catch {
            return null;
          }
          const node = await ctx.db.node.findUnique({
            where: { id },
            select: { memoryId: true },
          });
          if (!node) return null;
          // Same access gate as nodeById. memoryAccessFilter returns either an
          // explicit allow-list filter (`{ memoryId: { in: [...] } }`) — which
          // for platform ADMIN/OWNER still carves out other users' personal/
          // private memories (034) — or `{}` (no `memoryId` key) when the
          // caller's access is genuinely unrestricted. We only apply the
          // allow-list when the `memoryId` key is present; an empty filter
          // falls through and admits the node, exactly as nodeById does.
          const access = await memoryAccessFilter(ctx);
          if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
            if (!(access.memoryId.in as string[]).includes(node.memoryId)) return null;
          }
          return { kind: 'node', id, memoryId: node.memoryId };
        }
        case 'org': {
          let id: string;
          try {
            ({ id } = await resolveOrgRef(ctx.db, urn));
          } catch {
            return null;
          }
          if (!(await isOrgMember(id))) return null;
          return { kind: 'org', id };
        }
        case 'agent': {
          let id: string;
          try {
            ({ id } = await resolveAgentRef(ctx.db, urn));
          } catch {
            return null;
          }
          const agent = await ctx.db.agent.findUnique({
            where: { id },
            select: { organizationId: true },
          });
          if (!agent) return null;
          if (!(await isOrgMember(agent.organizationId))) return null;
          return { kind: 'agent', id };
        }
        case 'app': {
          let id: string;
          try {
            ({ id } = await resolveAppRef(ctx.db, urn));
          } catch {
            return null;
          }
          const app = await ctx.db.app.findUnique({
            where: { id },
            select: { organizationId: true },
          });
          if (!app) return null;
          // The dedicated app(id) query requires org ADMIN; mirror that.
          if (!isGlobalAdmin) {
            if (!ctx.userId) return null;
            const member = await ctx.db.orgMember.findUnique({
              where: { organizationId_userId: { organizationId: app.organizationId, userId: ctx.userId } },
            });
            if (!member || (ROLE_ORDER[member.role] ?? -1) < ROLE_ORDER['ADMIN']) return null;
          }
          return { kind: 'app', id, organizationId: app.organizationId };
        }
        case 'user': {
          let id: string;
          try {
            ({ id } = await resolveUserRef(ctx.db, urn));
          } catch {
            return null;
          }
          // A user reference resolves for the user themselves, a platform admin,
          // or a caller who shares at least one organization with the target —
          // mirroring the org-membership gate the other kinds use. (Returns only
          // a {kind,id} ref, no PII; the user's own pages enforce data access.)
          if (!isGlobalAdmin && ctx.userId !== id) {
            if (!ctx.userId) return null;
            // Caller shares ≥1 org with the target — a single query via the
            // org-membership relation (no extra round-trip / in-memory mapping).
            const shared = await ctx.db.orgMember.findFirst({
              where: {
                userId: ctx.userId,
                deletedAt: null,
                organization: { members: { some: { userId: id, deletedAt: null } } },
              },
              select: { organizationId: true },
            });
            if (!shared) return null;
          }
          return { kind: 'user', id };
        }
        default:
          return null;
      }
    },

    effectiveAccess: async (
      _: unknown,
      { user, resource }: { user: string; resource: string },
      ctx: Context,
    ) => {
      // Subject — the user whose access we are auditing. Accepts a User id OR a
      // `hrn:user:<handle>` URN (spec cor:urn:010:01), resolved via the same
      // resolveUserRef the `resource` side uses. Unknown / soft-deleted subject
      // → NOT_FOUND.
      let subjectUser: Awaited<ReturnType<typeof ctx.db.user.findUnique>> = null;
      try {
        const { id: subjectId } = await resolveUserRef(ctx.db, user);
        subjectUser = await ctx.db.user.findUnique({ where: { id: subjectId } });
      } catch (e) {
        // Only a genuine miss collapses to NOT_FOUND. A malformed URN
        // (UrnNotQualifiedError → URN_NOT_QUALIFIED) and unexpected DB/runtime
        // errors must propagate, not be masked as a misleading NOT_FOUND.
        if (!(e instanceof UserNotFoundError)) throw e;
        subjectUser = null;
      }
      if (!subjectUser) {
        throw new GraphQLError('User not found', { extensions: { code: 'NOT_FOUND' } });
      }

      // Resolve the resource ref (id or fully-qualified URN). Dispatches on
      // URN type exactly like resolveUrn; a bare id falls through to
      // AiServiceConfig (the only URN-less kind). Unresolvable → NOT_FOUND.
      const resolved = await resolveAccessResource(ctx.db, resource, {
        parseType: (ref) => parseUrnInput(ref).type,
        resolveMemoryRef,
        resolveNodeRef,
        resolveAppRef,
        resolveAgentRef,
        resolveOrgRef,
        resolveUserRef,
      });
      if (!resolved) {
        throw new GraphQLError('Resource not found', { extensions: { code: 'NOT_FOUND' } });
      }

      // Who may CALL this — the same visibility bar as the underlying grant
      // tables. A non-privileged caller gets FORBIDDEN, never a silent empty
      // result, so the audit command can't probe access it isn't allowed to.
      //
      // Self-audit is always allowed (issue #364): a user auditing their OWN
      // effective access learns nothing they couldn't already infer by trying
      // the operation, so there's no info-leak. Every other (cross-subject)
      // case stays gated by callerCanAudit exactly as before.
      const isSelfAudit = !!ctx.userId && subjectUser.id === ctx.userId;
      if (
        !isSelfAudit &&
        !(await callerCanAudit(ctx.db, { userId: ctx.userId, roles: ctx.roles }, resolved))
      ) {
        throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });
      }

      const result = await computeEffectiveAccess(
        ctx.db,
        { id: subjectUser.id, roles: subjectUser.roles },
        resolved,
      );
      // Attach the loaded User row so the User field resolvers work off it.
      return { ...result, user: subjectUser };
    },

    node: async (_: unknown, { loc: rawLoc, memory: memoryRef, raw }: { loc: string; memory?: string; raw?: boolean }, ctx: Context) => {
      const parsed = parseUrnInput(rawLoc);
      const typeErr = validateUrnType(parsed, 'node');
      if (typeErr) throw new Error(typeErr);
      const loc = parsed.value;

      const access = await memoryAccessFilter(ctx);

      // #335: optional `memory` scope (ID or URN per 007-entity-id-or-urn).
      // Without it, node(loc:) resolves across EVERY readable memory; since
      // `loc` is unique only per (loc, memoryId), the same loc can live in
      // many memories, and the old code silently returned one — a false read
      // from the wrong memory. Scoping pins the lookup; the access filter is
      // still intersected so `memory` can never widen visibility.
      let where: Record<string, unknown>;
      if (memoryRef != null && memoryRef !== '') {
        const { id: scopedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);
        if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
          if (!(access.memoryId.in as string[]).includes(scopedMemoryId)) return null;
        }
        where = { loc, memoryId: scopedMemoryId };
      } else {
        where = { loc, ...access };
      }
      // #391: exclude soft-deleted nodes so node(loc:) matches resolveUrn — a
      // leaked deleted row is what makes a node list/open but 404 by URN.
      where.deletedAt = null;

      const candidates = await ctx.db.node.findMany({
        where,
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      if (candidates.length === 0) return null;

      // #335: fail loud on a cross-memory loc collision instead of silently
      // picking one. The (loc, memoryId) unique guarantees >1 candidate ⇒
      // distinct memories, so this only fires for a genuinely ambiguous
      // unscoped read. Callers disambiguate with `memory:` (above) or
      // nodeById(id:) for a single-node read.
      if (candidates.length > 1) {
        const memoryIds = candidates.map((n) => n.memoryId);
        throw new GraphQLError(
          `loc "${loc}" matches ${candidates.length} readable memories ` +
            `(${memoryIds.join(', ')}). Pass \`memory:\` to scope the lookup, ` +
            `or use nodeById(id:) for an unambiguous single-node read.`,
          { extensions: { code: 'AMBIGUOUS_NODE_LOC', loc, memoryIds } },
        );
      }

      // Decrypt any nodes that come from encrypted memories (in place).
      await decryptNodesBatch(ctx.db, candidates);
      const node = candidates[0];

      // Compile Mustache templates unless raw: true
      if (!raw && node.content?.includes('{{')) {
        const compiled = await compileTemplate(
          node.content, node.data as Record<string, unknown> | null, node.memoryId, ctx.db, access,
        );
        return { ...node, content: compiled };
      }
      return node;
    },

    nodeById: async (_: unknown, { id, raw }: { id: string; raw?: boolean }, ctx: Context) => {
      const access = await memoryAccessFilter(ctx);
      const node = await ctx.db.node.findUnique({
        where: { id },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      // #391: a soft-deleted node must not resolve by PK either (findUnique
      // can't carry deletedAt in its where, so guard post-fetch) — matches
      // resolveUrn and keeps the by-PK page from opening a deleted node.
      if (!node || node.deletedAt) return null;
      if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
        if (!(access.memoryId.in as string[]).includes(node.memoryId)) return null;
      }
      await decryptNodesBatch(ctx.db, [node]);

      if (!raw && node.content?.includes('{{')) {
        const compiled = await compileTemplate(
          node.content, node.data as Record<string, unknown> | null, node.memoryId, ctx.db, access,
        );
        return { ...node, content: compiled };
      }
      return node;
    },

    // #386: render one node to its portable single-node file. Same node-read
    // gate as nodeById; uses RAW content (the export must round-trip, so it
    // never template-compiles) and the same unordered edge include the CLI's
    // nodeBatch uses, so edge order agrees.
    nodeExport: async (
      _: unknown,
      { id, format, full, sections }: { id: string; format?: NodeExportFormat | null; full?: boolean | null; sections?: NodeExportSection[] | null },
      ctx: Context,
    ) => {
      const access = await memoryAccessFilter(ctx);
      const node = await ctx.db.node.findUnique({
        where: { id },
        include: { outgoingEdges: { include: { target: true } } },
      });
      // #391: don't export a soft-deleted node (denied ≡ not-found).
      if (!node || node.deletedAt) throw new GraphQLError('Node not found', { extensions: { code: 'NOT_FOUND' } });
      if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
        // Denied and not-found are indistinguishable on purpose (same as nodeById).
        if (!(access.memoryId.in as string[]).includes(node.memoryId)) {
          throw new GraphQLError('Node not found', { extensions: { code: 'NOT_FOUND' } });
        }
      }
      await decryptNodesBatch(ctx.db, [node]);
      const memory = await ctx.db.memory.findUnique({
        where: { id: node.memoryId },
        select: { urn: true },
      });

      const fmt: NodeExportFormat = format ?? 'MD';

      // PDF is a presentation render produced by the external hadrontool-pdf
      // service from the node's (already-decrypted) Markdown content. Unlike
      // MD/JSON it is not the canonical round-trippable file, so `full` /
      // `sections` do not apply. Delivered BASE64.
      if (fmt === 'PDF') {
        const markdown =
          node.content && node.content.trim().length > 0 ? node.content : `# ${node.name}`;
        const { base64, bytes } = await renderMarkdownToPdf(markdown, { title: node.name });
        const leaf = node.loc ? node.loc.split(':').pop() || node.loc : node.name || 'node';
        return {
          format: 'PDF',
          mimeType: 'application/pdf',
          filename: `${leaf}.pdf`,
          encoding: 'BASE64',
          data: base64,
          bytes,
        };
      }

      const { mimeType, data } = renderNodeExport(
        {
          id: node.id,
          memoryUrn: memory?.urn ?? '',
          loc: node.loc,
          name: node.name,
          nodeType: node.nodeType,
          alias: node.alias,
          description: node.description,
          abstract: node.abstract,
          abstractOriginHash: node.abstractOriginHash,
          content: node.content,
          tags: deserializeTags(node.tags) as string[],
          seq: node.seq,
          data: node.data,
          properties: node.properties,
          edges: node.outgoingEdges as unknown as EdgeForGit[],
        },
        { format: fmt, full: full !== false, sections: sections ?? null },
      );

      const leaf = node.loc ? node.loc.split(':').pop() || node.loc : node.name || 'node';
      return {
        format: fmt,
        mimeType,
        filename: `${leaf}.${fmt === 'JSON' ? 'json' : 'md'}`,
        encoding: 'TEXT',
        data,
        bytes: Buffer.byteLength(data, 'utf8'),
      };
    },

    nodes: async (
      _: unknown,
      { memory, memoryIds, nodeType, isRunnable, tags, search, prefix: rawPrefix, limit, offset }: { memory?: string; memoryIds?: string[]; nodeType?: string; isRunnable?: boolean; tags?: string[]; search?: string; prefix?: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      const prefix = rawPrefix ? parseUrnInput(rawPrefix).value : undefined;
      const access = await memoryAccessFilter(ctx);
      // Memory scoping (ID or URN per 007-entity-id-or-urn) is
      // intersected with the access filter's own memoryId clause
      // in-place. Composing via a separate AND key is unsafe here:
      // tagsFilter also emits { AND: [...] } on SQLite, and a spread
      // collision would silently drop the memory scope (the same
      // overwrite class as #253/#255).
      if (memoryIds && memoryIds.length > 0) {
        // Plural memory-set scope (issue #355 — content search across an
        // agent's / app's memories). Each entry is an ID or a fully-qualified
        // URN (007-entity-id-or-urn); resolve to IDs first, dropping
        // unresolvable refs rather than throwing — the singular `memory`
        // branch throws on a bad ref, but a multi-select set shouldn't fail
        // wholesale over one bad entry (same forgiving posture as the
        // inaccessible-id drop below). Then intersect the requested set with
        // the access filter in-place, same composition discipline as the
        // singular `memory` branch. Takes precedence over `memory` when both
        // are supplied.
        const resolved = await Promise.all(
          memoryIds.map((ref) =>
            // An ID-shaped ref needs no lookup — pass it straight through; the
            // access-filter intersection below is the real gate (a bogus or
            // inaccessible id matches nothing). Only URN refs hit the DB.
            isId(ref)
              ? Promise.resolve(ref)
              : resolveMemoryRef(ctx.db, ref).then((r) => r.id).catch(() => null)),
        );
        const resolvedIds = resolved.filter((id): id is string => id !== null);
        if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
          const allowed = new Set((access.memoryId as { in: string[] }).in);
          access.memoryId = { in: resolvedIds.filter((id) => allowed.has(id)) };
        } else {
          access.memoryId = { in: resolvedIds };
        }
      } else if (memory) {
        const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memory);
        if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
          const allowedIds = (access.memoryId as { in: string[] }).in;
          access.memoryId = allowedIds.includes(resolvedMemoryId)
            ? resolvedMemoryId
            : { in: [] };
        } else {
          access.memoryId = resolvedMemoryId;
        }
      }
      const results = await ctx.db.node.findMany({
        where: {
          ...access,
          // #391: never surface soft-deleted nodes (MCP delete soft-deletes by
          // default). resolveUrn already excludes them, so a leak here is what
          // makes a node show in lists but 404 by URN.
          deletedAt: null,
          // Exclude system nodes from search by default (unless explicitly requested)
          ...(nodeType ? { nodeType } : search ? { nodeType: { not: 'system' } } : {}),
          // Runnable filter (cor:api:060): isRunnable=true is the canonical
          // "tasks I can run" predicate. Map the boolean straight through —
          // `false` matches strictly-false rows, NOT the NULL majority.
          ...(isRunnable != null ? { isRunnable } : {}),
          ...(tags?.length ? tagsFilter(tags) : {}),
          ...(prefix ? { loc: { startsWith: prefix } } : {}),
          ...(search
            ? {
                OR: [
                  searchContains('name', search),
                  searchContains('description', search),
                  searchContains('content', search),
                ],
              }
            : {}),
        },
        orderBy: { loc: 'asc' },
        // Eager-load `memory` so the Node.memory field resolver serves it
        // from the preloaded relation instead of firing one findUnique per
        // node (N+1) — clients select `memory { urn }` to render full node
        // URNs across a whole list.
        include: { memory: true, outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      // Decrypt in place before sorting/slicing — the priority sort doesn't
      // touch content, and the slice is a small window, so decrypting the
      // whole result set is correct.
      await decryptNodesBatch(ctx.db, results);
      // Sort by nodeType priority: abstract first, then info/reference, then record
      const typePriority: Record<string, number> = { abstract: 0, info: 1, reference: 1, record: 2, system: 3 };
      const sorted = results.sort((a, b) =>
        (typePriority[a.nodeType] ?? 1) - (typePriority[b.nodeType] ?? 1)
      );
      return sorted.slice(offset ?? 0, (offset ?? 0) + (limit ?? 100));
    },

    /**
     * Spec 033 — vector/hybrid-aware search. The legacy `nodes` query stays
     * keyword-only (`[Node!]!`); `nodeSearch` is the structured envelope
     * surface that returns `{ nodes, reason, degraded }` so flag conditions
     * stay machine-readable (the MCP path renders them as text lines).
     *
     * v1 / US1 scope (this resolver):
     *   - mode: vector (and the default when mode is omitted) is fully wired.
     *   - mode: keyword / hybrid throw GraphQLError until US3 (T050) lands
     *     them. Throwing keeps the schema stable AND tells the caller exactly
     *     when each capability arrives — silently returning empty would
     *     conflate "not implemented yet" with "no hits."
     *   - granularity: chunk and expand>0 throw the same way until US2 (T042)
     *     and US3 (T049) respectively.
     *
     * Access control mirrors the keyword `nodes` query — `getAccessibleMemoryIds`
     * gates the memory scope, and the raw-SQL similarity query is scoped to
     * those IDs (never cross-memory).
     */
    nodeSearch: async (
      _: unknown,
      {
        query,
        memoryUrn,
        memoryIds,
        mode,
        expand,
        granularity,
        limit,
      }: {
        query: string;
        memoryUrn?: string;
        memoryIds?: string[];
        mode?: 'keyword' | 'vector' | 'hybrid';
        expand?: number;
        granularity?: 'node' | 'chunk';
        limit?: number;
      },
      ctx: Context,
    ) => {
      const effectiveMode = mode ?? 'vector';
      // Spec 033 US2 — chunk-granularity is supported only in mode:vector
      // today. Keyword has no chunks; hybrid's RRF fusion produces
      // node-level scores, not passage-level (PR-225 review, Gemini high).
      // If hybrid+chunk grows real demand later, the design call is whether
      // to RRF over passages (different semantics) or fuse keyword node
      // hits with vector passages (asymmetric output). Out of v1.
      if (granularity === 'chunk' && effectiveMode !== 'vector') {
        throw new GraphQLError(
          `nodeSearch granularity:chunk is only supported in mode:vector (got mode:${effectiveMode}). Hybrid + chunk passages is out of v1 — please use mode:vector for passage retrieval.`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      // Validate expand bounds (PR-223 review, Copilot): the MCP surface
      // clamps via zod min(0).max(3); GraphQL has no equivalent unless
      // we check here. Without this guard a caller could pass expand: 1000
      // and force unbounded BFS work.
      if (expand != null && (expand < 0 || expand > 3 || !Number.isInteger(expand))) {
        throw new GraphQLError(
          'nodeSearch `expand` must be an integer in [0, 3].',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      const finalLimit = limit ?? 50;

      // Resolve scope: a SET of memories by ID (issue #355), a single memory
      // by URN (with access check), or the full accessible set when both are
      // omitted.
      let scopeIds: string[];
      const accessible = await getAccessibleMemoryIds(ctx);
      if (memoryIds && memoryIds.length > 0) {
        // Plural memory-set scope: intersect with the accessible set.
        // Inaccessible ids are silently dropped — unlike the singular
        // `memoryUrn` path below, which throws FORBIDDEN. Precedence over
        // `memoryUrn` when both are supplied. The vector/hybrid branches
        // further narrow this to vector-indexed memories downstream.
        // Set membership keeps the intersection O(N+M), matching the `nodes`
        // resolver (PR #308 review — bito/gemini).
        if (accessible === null) {
          scopeIds = memoryIds;
        } else {
          const allowed = new Set(accessible);
          scopeIds = memoryIds.filter((id) => allowed.has(id));
        }
      } else if (memoryUrn) {
        const { id } = await resolveMemoryRef(ctx.db, memoryUrn);
        if (accessible !== null && !accessible.includes(id)) {
          throw new GraphQLError('Memory not accessible.', {
            extensions: { code: 'FORBIDDEN' },
          });
        }
        scopeIds = [id];
      } else if (accessible === null) {
        // Admin/all scope: for vector/hybrid, restrict to vector-indexed
        // memories explicitly. For keyword, restrict to ALL accessible
        // memories — substring search shouldn't artificially exclude
        // non-indexed ones.
        if (effectiveMode === 'vector' || effectiveMode === 'hybrid') {
          const all = await ctx.db.memory.findMany({
            where: { vectorIndexEnabled: true, deletedAt: null },
            select: { id: true },
          });
          scopeIds = all.map((m) => m.id);
        } else {
          const all = await ctx.db.memory.findMany({
            where: { deletedAt: null },
            select: { id: true },
          });
          scopeIds = all.map((m) => m.id);
        }
      } else {
        scopeIds = accessible;
      }

      // Helper: run the keyword half (used by keyword + hybrid). Mirrors
      // the MCP fall-through: findMany over scope → filter by matchesQuery.
      // No (memoryId, loc) dedup needed — the Node model's
      // @@unique([loc, memoryId]) makes that a structural no-op
      // (PR-227 review). Cross-memory same-loc preservation is pinned by
      // src/test/integration/dedup-cross-memory-loc.test.ts.
      const runKeyword = async (): Promise<typeof keywordMatchesType> => {
        const candidates = await ctx.db.node.findMany({
          where: { memoryId: { in: scopeIds }, deletedAt: null },
          take: 1000,
        });
        return candidates.filter((n) => matchesQuery(n, query));
      };
      // Type alias for the helper's return — TS infers via the call site.
      let keywordMatchesType!: Awaited<ReturnType<typeof ctx.db.node.findMany>>;

      // ── KEYWORD MODE ──────────────────────────────────────────────
      if (effectiveMode === 'keyword') {
        const matches = await runKeyword();
        const rankedIds = matches.slice(0, finalLimit).map((n) => n.id);
        return await renderNodeSearchResult(ctx, rankedIds, expand, scopeIds, null, null);
      }

      // ── VECTOR + HYBRID common: resolve indexed-memory subset ─────
      const indexed = await ctx.db.memory.findMany({
        where: { id: { in: scopeIds }, vectorIndexEnabled: true, deletedAt: null },
        select: { id: true },
      });
      const indexedIds = indexed.map((m) => m.id);

      // Hybrid + no indexed memory → degrade to keyword-only.
      if (effectiveMode === 'hybrid' && indexedIds.length === 0) {
        const matches = await runKeyword();
        const rankedIds = matches.slice(0, finalLimit).map((n) => n.id);
        return await renderNodeSearchResult(
          ctx,
          rankedIds,
          expand,
          scopeIds,
          null,
          'no_vector_index',
        );
      }
      if (effectiveMode === 'vector' && indexedIds.length === 0) {
        return { nodes: [], passages: [], reason: 'no_vector_index', degraded: null };
      }
      if (!isEmbeddingConfigured()) {
        return { nodes: [], passages: [], reason: 'embedding_unavailable', degraded: null };
      }
      // #234 — wrap the embed() call so any failure at query time
      // (endpoint unreachable, HTTP 5xx, malformed response, dimension
      // mismatch — anything getEmbeddingClient().embed() can throw)
      // degrades gracefully instead of propagating the error out of
      // the resolver. Mirrors the already-correct `no_vector_index`
      // degrade path a few lines up:
      //   - hybrid → fall back to keyword + `degraded: 'embedding_unavailable'`
      //   - vector → empty envelope with `reason: 'embedding_unavailable'`
      // The `!qvec` defensive branch below is preserved (handles an
      // embedder that resolves to an empty array rather than throwing).
      let qvec: number[] | undefined;
      try {
        [qvec] = await getEmbeddingClient().embed([query], 'query');
      } catch (err) {
        // Log the full error object — preserves stack + any typed
        // shape (EmbeddingRequestError, EmbeddingDimensionMismatchError)
        // so operators can tell endpoint-down from dim-mismatch from
        // HTTP 500 without chasing a "search returns fewer results
        // than expected" ticket.
        console.warn(
          `[nodeSearch] embed() failed in mode:${effectiveMode}; degrading to ` +
            (effectiveMode === 'hybrid' ? 'keyword-only.' : 'empty result.'),
          err,
        );
        if (effectiveMode === 'hybrid') {
          const matches = await runKeyword();
          const rankedIds = matches.slice(0, finalLimit).map((n) => n.id);
          return await renderNodeSearchResult(
            ctx,
            rankedIds,
            expand,
            scopeIds,
            null,
            'embedding_unavailable',
          );
        }
        return { nodes: [], passages: [], reason: 'embedding_unavailable', degraded: null };
      }
      if (!qvec) {
        return { nodes: [], passages: [], reason: 'embedding_unavailable', degraded: null };
      }

      // ── VECTOR MODE ───────────────────────────────────────────────
      if (effectiveMode === 'vector') {
        // Spec 033 US2 (T042) — chunk-level granularity returns
        // passages with span text + offsets + parent URN. Default
        // (node) granularity returns the existing node-collapsed
        // ranking.
        if (granularity === 'chunk') {
          const chunkHits = await vectorSearchChunks(ctx.db, {
            memoryIds: indexedIds,
            queryEmbedding: qvec,
            limit: finalLimit,
          });
          if (chunkHits.length === 0) {
            return { nodes: [], passages: [], reason: null, degraded: null };
          }
          // Batch-fetch parent nodes + memory URNs for URN composition.
          // Build canonical `<memory-urn>::<loc>` URNs inline rather than
          // importing nodeUrn() from mcp/server.ts (which would recreate
          // the circular dep that PR-223 review eliminated).
          const uniqueNodeIds = Array.from(new Set(chunkHits.map((h) => h.nodeId)));
          const parents = await ctx.db.node.findMany({
            where: { id: { in: uniqueNodeIds }, deletedAt: null },
            select: { id: true, loc: true, memory: { select: { urn: true } } },
          });
          const parentById = new Map(parents.map((p) => [p.id, p]));
          const passages = [];
          for (const hit of chunkHits) {
            const parent = parentById.get(hit.nodeId);
            if (!parent) continue;
            // Canonical form: `<memory.urn>::<loc>`. New paths emit
            // canonical memory URNs; legacy `:`-separated memory URNs
            // are tolerated by downstream consumers via the spec-021/022
            // canonicalization layer.
            const parentNodeUrn = `${parent.memory.urn}::${parent.loc}`;
            passages.push({
              parentNodeId: parent.id,
              parentNodeUrn,
              chunkIndex: hit.chunkIndex,
              charStart: hit.charStart,
              charEnd: hit.charEnd,
              text: hit.chunkText,
              score: hit.score,
            });
          }
          return { nodes: [], passages, reason: null, degraded: null };
        }
        const hits = await vectorSearchNodes(ctx.db, {
          memoryIds: indexedIds,
          queryEmbedding: qvec,
          limit: finalLimit,
        });
        const rankedIds = hits.map((h) => h.nodeId);
        return await renderNodeSearchResult(ctx, rankedIds, expand, indexedIds, null, null);
      }

      // ── HYBRID MODE ───────────────────────────────────────────────
      // Run keyword + vector in parallel; re-rank keyword by relevance
      // for RRF; fuse with reciprocalRankFusion. Mirrors the MCP path.
      // PR-223 review (Gemini): vector half pulls a DEEPER candidate
      // pool than finalLimit so RRF can promote items ranked slightly
      // outside the top-N on the vector side that ALSO show up on the
      // keyword side. Without this, small `limit` values silently
      // degrade fusion quality.
      const candidateLimit = Math.max(100, finalLimit);
      const [kwMatches, vecHits] = await Promise.all([
        runKeyword(),
        vectorSearchNodes(ctx.db, {
          memoryIds: indexedIds,
          queryEmbedding: qvec,
          limit: candidateLimit,
        }),
      ]);
      const kwRanked = keywordRelevanceRank(kwMatches, query);
      const fusedIds = reciprocalRankFusion(
        [kwRanked.map((n) => n.id), vecHits.map((h) => h.nodeId)],
        (id) => id,
      ).slice(0, finalLimit);
      return await renderNodeSearchResult(ctx, fusedIds, expand, indexedIds, null, null);
    },

    subtree: async (_: unknown, { prefix: rawPrefix }: { prefix: string }, ctx: Context) => {
      const prefix = parseUrnInput(rawPrefix).value;
      const access = await memoryAccessFilter(ctx);
      const results = await ctx.db.node.findMany({
        where: { ...access, loc: { startsWith: prefix } },
        orderBy: { loc: 'asc' },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      await decryptNodesBatch(ctx.db, results);
      return results;
    },

    /**
     * Spec cor:api:040 — batch node read. Returns the full per-node projection
     * for MANY nodes in one round-trip (the durable server-side primitive that
     * lets `spec lint --all` stop doing one nodeById per node). Two mutually-
     * exclusive forms: an explicit `ids` set (input order) or a `memory` +
     * `locPrefix` subtree (loc order).
     *
     * Authorization is per-node and identical to the single-node read: the
     * memoryAccessFilter scopes the fetch to readable memories, so a denied OR
     * missing id simply isn't in the result and lands in `unavailable` —
     * indistinguishable, never failing the call (cor:api:040:03, BOLA). Hard
     * caps (cor:api:040:02): over the node-count cap throws; over the
     * response-size cap returns a partial result flagged `truncated` — never a
     * silent short read. No UsageEvent is recorded, matching the single-node
     * GraphQL reads (nodeById / node), which don't either — per-surface parity.
     */
    nodeBatch: async (
      _: unknown,
      { ids, memory, locPrefix }: { ids?: string[]; memory?: string; locPrefix?: string },
      ctx: Context,
    ) => {
      const hasSet = Array.isArray(ids) && ids.length > 0;
      const hasPrefix = memory != null && locPrefix != null;
      if (hasSet === hasPrefix) {
        throw new GraphQLError(
          'nodeBatch: provide EITHER `ids` (an explicit set) OR `memory` + `locPrefix` (a subtree) — not both, not neither.',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }

      const access = await memoryAccessFilter(ctx);
      const include = {
        outgoingEdges: { include: { target: true } },
        incomingEdges: { include: { source: true } },
      };

      let ordered: Array<{
        id: string;
        content: string | null;
        abstract: string | null;
        data?: unknown;
        properties?: unknown;
      }> = [];
      const unavailable: string[] = [];

      if (hasSet) {
        // Count cap (cor:api:040:02) — caller knows the count; fail loud up front.
        if (ids!.length > BATCH_READ_MAX_NODES) {
          throw new GraphQLError(
            `nodeBatch: ${ids!.length} ids exceeds the ${BATCH_READ_MAX_NODES}-node cap. Split into smaller batches; the batch read does not silently truncate.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        // The access filter scopes to readable memories, so a denied OR missing
        // id is simply absent from the result — reported indistinguishably.
        // Dedup so a repeated id isn't returned twice (the single nodeById
        // can't duplicate); first-occurrence order preserved.
        const uniqueIds = [...new Set(ids!)];
        const rows = await ctx.db.node.findMany({
          where: { id: { in: uniqueIds }, deletedAt: null, ...access },
          include,
        });
        await decryptNodesBatch(ctx.db, rows);
        const byId = new Map(rows.map((n) => [n.id, n]));
        for (const id of uniqueIds) {
          const n = byId.get(id);
          if (n) ordered.push(n);
          else unavailable.push(id);
        }
      } else {
        const { id: memId } = await resolveMemoryRef(ctx.db, memory!);
        const accessible = await getAccessibleMemoryIds(ctx);
        if (accessible !== null && !accessible.includes(memId)) {
          throw new GraphQLError('Memory not accessible.', { extensions: { code: 'FORBIDDEN' } });
        }
        // Count cap: take MAX+1 to detect overflow, then fail loud rather than
        // silently returning a truncated subtree.
        const rows = await ctx.db.node.findMany({
          where: { memoryId: memId, loc: { startsWith: locPrefix! }, deletedAt: null },
          orderBy: { loc: 'asc' },
          take: BATCH_READ_MAX_NODES + 1,
          include,
        });
        if (rows.length > BATCH_READ_MAX_NODES) {
          throw new GraphQLError(
            `nodeBatch: prefix "${locPrefix}" matches more than the ${BATCH_READ_MAX_NODES}-node cap. Narrow the prefix; the batch read does not silently truncate.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        await decryptNodesBatch(ctx.db, rows);
        ordered = rows;
      }

      // Response-size cap (cor:api:040:02) — pack until the byte ceiling, then
      // stop and flag `truncated` with the omitted ids. At least one node always
      // returns (a single oversize node still comes back). Size is measured on
      // the decrypted content + abstract; the client selects the rest.
      const nodes: unknown[] = [];
      const omitted: string[] = [];
      let bytes = 0;
      let truncated = false;
      for (const n of ordered) {
        if (truncated) {
          omitted.push(n.id);
          continue;
        }
        // Approximate the serialized payload from the heavy scalar fields a
        // client is likely to select — content + abstract + the JSON columns.
        // Edges are relational + client-selected, so they aren't measured here.
        const size = Buffer.byteLength(
          (n.content ?? '') +
            (n.abstract ?? '') +
            (n.data != null ? JSON.stringify(n.data) : '') +
            (n.properties != null ? JSON.stringify(n.properties) : ''),
          'utf8',
        );
        if (nodes.length > 0 && bytes + size > BATCH_READ_MAX_BYTES) {
          truncated = true;
          omitted.push(n.id);
          continue;
        }
        nodes.push(n);
        bytes += size;
      }

      return { nodes, unavailable, truncated, omitted };
    },

    nodeUsage: async (_: unknown, { loc, limit }: { loc: string; limit?: number }, ctx: Context) => {
      return ctx.db.usageEvent.findMany({
        where: { nodeLoc: loc },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
    },

    memoryUsageSummary: async (_: unknown, { memoryId }: { memoryId: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);

      // Access control (#250, extended from usageEvents): deny a memory the
      // caller can't read with [] (no existence leak), mirroring usageEvents
      // and nodeById. getAccessibleMemoryIds encodes principals + the memory-
      // class rules (spec 034). Previously this resolver had no gate at all —
      // any authenticated caller could read any tenant's per-node usage counts.
      const accessibleMemoryIds = await getAccessibleMemoryIds(ctx);
      if (accessibleMemoryIds !== null && !accessibleMemoryIds.includes(resolvedMemoryId)) {
        return [];
      }

      // #253: scope via the UsageEvent→Node relation, not `nodeLoc: { in: locs }`.
      // FK-precise (no cross-memory loc collision — a node named `alpha` in
      // another memory no longer inflates this memory's counts), a single query,
      // and no IN-parameter limit on large memories. Like usageEvents post-#251
      // this excludes events with a null nodeId (orphaned after node deletion,
      // or the older recordUsage path's ambiguous loc lookup) — arguably more
      // correct, since an unattributable event shouldn't count toward a memory.
      //
      // `nodeLoc: { not: null }` restores a guarantee the old loc-IN scoping had
      // implicitly: the result feeds UsageSummaryEntry.nodeLoc (String!), so a
      // null-nodeLoc group (an event with nodeId set but nodeLoc null) would
      // violate the schema at the GraphQL layer. The IN-filter could never
      // produce one; the relation filter can, so exclude it explicitly.
      const rows = await ctx.db.usageEvent.groupBy({
        by: ['nodeLoc', 'type'],
        where: { node: { memoryId: resolvedMemoryId }, nodeLoc: { not: null } },
        _count: { id: true },
      });
      return rows.map((r: { nodeLoc: string | null; type: string; _count: { id: number } }) => ({
        // nodeLoc is non-null here (guarded in the where above); Prisma's
        // groupBy result type still widens it to string | null.
        nodeLoc: r.nodeLoc as string,
        type: r.type,
        count: r._count.id,
      }));
    },

    nodeVersions: async (_: unknown, { nodeId, limit }: { nodeId: string; limit?: number }, ctx: Context) => {
      return ctx.db.nodeVersion.findMany({
        where: { nodeId },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
    },

    sessions: async (
      _: unknown,
      { type, repo, customerId, limit, offset }: { type?: string; repo?: string; customerId?: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      // ADMIN/OWNER see all; App-keyed callers see their own sessions;
      // users see sessions for any App in an org they belong to.
      const scopeFilter = await sessionScopeFilter(ctx);
      return ctx.db.session.findMany({
        where: {
          ...scopeFilter,
          ...(type ? { type: type as any } : {}),
          ...(repo ? { repo } : {}),
          ...(customerId ? { customerId } : {}),
        },
        orderBy: { startedAt: 'desc' },
        take: limit ?? 50,
        skip: offset ?? 0,
        include: SESSION_INCLUDE,
      });
    },

    session: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const session = await ctx.db.session.findUnique({ where: { id }, include: SESSION_INCLUDE });
      if (!session) return null;
      // ADMIN/OWNER can see any session
      if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return session;
      // App-keyed caller can see sessions belonging to their App
      if (ctx.appId && session.appId === ctx.appId) return session;
      // User can see sessions from Apps in any org they belong to
      if (ctx.userId && session.appId) {
        const app = await ctx.db.app.findUnique({
          where: { id: session.appId },
          select: { organizationId: true },
        });
        if (app) {
          const member = await ctx.db.orgMember.findUnique({
            where: {
              organizationId_userId: { organizationId: app.organizationId, userId: ctx.userId },
            },
          });
          if (member && !member.deletedAt) return session;
        }
      }
      return null;
    },

    usageEvents: async (
      _: unknown,
      {
        type,
        memoryId,
        nodeId,
        limit,
        offset,
      }: {
        type?: string;
        memoryId?: string;
        nodeId?: string;
        limit?: number;
        offset?: number;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      // Per-node scoping (issue #249 follow-up): a single node addressed by a
      // node *token* — PK, URN, or bare loc — no memoryId required. Mirrors the
      // memoryId pattern (resolveMemoryRef accepts ID or URN), generalized to a
      // node ref. Branches by token shape:
      //
      //   - PK, or any `urn:`-prefixed / fully-qualified node URN →
      //     resolveNodeRef → exact nodeId FK filter. Memory-precise: it can't
      //     collide with a same-loc node in another memory. Events whose nodeId
      //     is null (orphaned post node-deletion, or the older recordUsage
      //     path's ambiguous loc lookup) are excluded; a resolvable ref implies
      //     a live node. Routing every `urn:`-prefixed input through
      //     resolveNodeRef (rather than the loc fallback) keeps its wrong-type
      //     URN handling loud — `urn:memory:…` fails instead of silently
      //     degrading to a loc filter that returns [].
      //   - bare loc (unprefixed AND fails node-URN qualification — a node URN
      //     needs ≥3 segments) → exact nodeLoc match, like nodeUsage(loc).
      //     Cross-memory: UsageEvent has no memoryId, so this matches that loc
      //     in every memory; it does NOT validate node existence (a filter, not
      //     a lookup, so an unknown loc yields [] rather than NODE_NOT_FOUND).
      let nodeIdFilter: string | undefined;
      let nodeLocExact: string | undefined;
      if (nodeId) {
        // Scheme-prefixed inputs (`hrn:` / legacy `urn:`) are always node refs
        // (resolveNodeRef validates the type marker and throws on mismatch).
        // Unprefixed inputs are refs only if they have full node-URN shape;
        // otherwise they're a bare loc.
        let isNodeRef = isId(nodeId) || hasSchemePrefix(nodeId);
        if (!isNodeRef) {
          // assertFullyQualifiedUrn checks shape only (≥3 segments for 'node').
          try {
            assertFullyQualifiedUrn(nodeId, 'node');
            isNodeRef = true;
          } catch {
            isNodeRef = false;
          }
        }
        if (isNodeRef) {
          // 007/022-entity-id-or-urn: PK or fully-qualified node URN. No
          // contextMemoryId at the API boundary (spec 022).
          const { id: resolvedNodeId } = await resolveNodeRef(ctx.db, nodeId);
          nodeIdFilter = resolvedNodeId;
        } else {
          nodeLocExact = nodeId;
        }
      }

      // Access scoping (issue #250): restrict results to memories the caller
      // may read. getAccessibleMemoryIds is the canonical helper — it
      // encapsulates every principal type and the memory-class rules (spec
      // 034): a JWT / user-API-key caller gets their org + subscription +
      // public + owned personal/private set; ADMIN/OWNER get all memories
      // except other users' personal/private. App keys carry roles:[] and are
      // already rejected by requireRole above (App usage reads aren't a GraphQL
      // surface — they go through MCP).
      //
      // The return type is `string[] | null`, where null would mean
      // "unrestricted (no filter)". In practice every branch returns an
      // explicit list — ADMIN/OWNER included, so the personal/private carve-out
      // still applies — so the `!== null` guards below are defensive for that
      // type contract rather than a live code path today.
      const accessibleMemoryIds = await getAccessibleMemoryIds(ctx);

      // Per-memory scoping (issue #249): filter on the UsageEvent→Node relation
      // by the resolved memory. FK-precise (no cross-memory nodeLoc collision)
      // and a single SQL query — unlike fetching every node loc and using
      // `nodeLoc: { in }`, which collides on shared locs and can blow the
      // IN-parameter limit on large memories. Like the nodeId path, it excludes
      // events with a null nodeId (orphaned / legacy). memoryUsageSummary uses
      // the same relation-scoping approach (aligned in #253).
      let memoryNodeFilter: { memoryId: string } | undefined;
      if (memoryId) {
        // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
        const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
        // #250: deny a memory the caller can't read. Return [] (not a thrown
        // Forbidden) to avoid leaking existence — mirrors nodeById returning
        // null for an out-of-scope target.
        if (accessibleMemoryIds !== null && !accessibleMemoryIds.includes(resolvedMemoryId)) {
          return [];
        }
        memoryNodeFilter = { memoryId: resolvedMemoryId };
      }

      // Resolve the UsageEvent→Node relation filter:
      //  - memoryId scoped path → the single, already access-checked memory.
      //  - otherwise → the caller's full accessible-memory set (#250). This
      //    bounds both the global feed and any bare-loc nodeId filter to
      //    readable memories. A `null` accessible set = unrestricted.
      const nodeRelationFilter: { memoryId: string } | { memoryId: { in: string[] } } | undefined =
        memoryNodeFilter ??
        (accessibleMemoryIds !== null ? { memoryId: { in: accessibleMemoryIds } } : undefined);

      return ctx.db.usageEvent.findMany({
        where: {
          ...(type ? { type } : {}),
          ...(nodeIdFilter ? { nodeId: nodeIdFilter } : {}),
          ...(nodeRelationFilter ? { node: nodeRelationFilter } : {}),
          // nodeId-as-bare-loc → exact nodeLoc match (the supported loc filter
          // since the deprecated nodeLoc substring arg was removed in #252).
          ...(nodeLocExact ? { nodeLoc: nodeLocExact } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
        skip: offset ?? 0,
      });
    },

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

    myChats: async (
      _: unknown,
      { agentId, limit, offset }: { agentId: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);

      // Spec 017 — collect the memories the caller may read chats from:
      //  - the caller's own personal memory for this agent (private chats)
      //  - app-class memories of every App where the caller is an
      //    AppMember and App.agentId == this agent (shared chats)
      //
      // The DB query is filtered by memory id; the visibility rule is
      // enforced at the query layer (no application-side post-filter).
      const readableMemoryIds: string[] = [];

      const personalMemory = await ctx.db.memory.findFirst({
        where: {
          userMemoryOfAgentId: resolvedAgentId,
          createdBy: ctx.userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (personalMemory) readableMemoryIds.push(personalMemory.id);

      // 023-app-shape Phase 2b: App↔Agent moved from `App.agentId` to the
      // N:M `AppAgent` join. Match Apps that have the resolved Agent
      // installed via the join.
      const sharedMemberships = await ctx.db.appMember.findMany({
        where: {
          userId: ctx.userId,
          app: {
            appAgents: { some: { agentId: resolvedAgentId } },
            deletedAt: null,
          },
        },
        select: { app: { select: { id: true } } },
      });
      if (sharedMemberships.length > 0) {
        const sharedMemories = await ctx.db.memory.findMany({
          where: {
            appId: { in: sharedMemberships.map((m) => m.app.id) },
            class: 'app',
            deletedAt: null,
          },
          select: { id: true },
        });
        for (const m of sharedMemories) readableMemoryIds.push(m.id);
      }

      if (readableMemoryIds.length === 0) return [];

      // Top-level chat nodes live at loc "chats:<id>" (depth 2). The only
      // sub-shapes today are `chats:UUID:messages` (container) and
      // `chats:UUID:messages:NNN-*` (message rows) — both contain
      // ':messages', and chat-root locs do not, so we can filter them out
      // at the DB layer instead of pulling every message body just to
      // discard it.
      //
      // Sort by Node.updatedAt (Prisma's @updatedAt) — bumped automatically
      // each time sendChatMessage / processChatResponse writes the new
      // `data.lastMessageAt` back to the chat-root row. That makes the
      // column an exact proxy for the previous "lastMessageAt || createdAt"
      // ordering, sortable at the DB layer with `take`/`skip` — no
      // application-side resort, no JS slice.
      const tops = await ctx.db.node.findMany({
        where: {
          memoryId: { in: readableMemoryIds },
          loc: { startsWith: 'chats:' },
          NOT: { loc: { contains: ':messages' } },
          deletedAt: null,
        },
        orderBy: { updatedAt: 'desc' as const },
        take: limit ?? 100,
        skip: offset ?? 0,
      });
      if (tops.length === 0) return [];

      // First-message lookup, scoped to the visible page only (was: every
      // candidate chat). Parallelized via Promise.all.
      const firstMessageEntries = await Promise.all(
        tops.map(async (top) => {
          const firstMsg = await ctx.db.node.findFirst({
            where: {
              memoryId: top.memoryId,
              loc: { startsWith: `${top.loc}:messages:` },
              deletedAt: null,
            },
            orderBy: { seq: 'asc' as const },
            select: { content: true },
          });
          return [top.loc, firstMsg?.content ?? null] as const;
        }),
      );
      const firstMessagesByChat = new Map<string, string>();
      for (const [loc, content] of firstMessageEntries) {
        if (content) firstMessagesByChat.set(loc, content);
      }

      return tops.map((node) => {
        const data = (node.data as Record<string, unknown>) ?? {};
        const title = deriveChatTitle(node, data, firstMessagesByChat.get(node.loc) ?? null);
        // Spec 017: scope comes from chat-root data.scope, denormalized
        // at chat creation. Legacy chats predating the feature have no
        // scope on disk; they're treated as 'private' (which matches
        // their storage class) until the Phase 6 backfill runs.
        const scope: 'private' | 'shared' =
          data.scope === 'shared' ? 'shared' : 'private';
        return {
          id: node.id,
          loc: node.loc,
          title,
          conversationName: (data.conversationName as string) ?? null,
          stageName: (data.stageName as string) ?? null,
          messageCount: (data.messageCount as number) ?? 0,
          createdAt: node.createdAt,
          lastMessageAt: (data.lastMessageAt as string) ?? null,
          scope,
          createdBy: node.createdBy ?? null,
        };
      });
    },

    chatHistory: async (
      _: unknown,
      { chatId, limit }: { chatId: string; limit?: number },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const chatNode = await ctx.db.node.findFirst({
        where: { loc: chatId, deletedAt: null },
        select: { id: true, memoryId: true, createdBy: true },
      });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);
      // Spec 017 — read-visibility check (FR-007/FR-008):
      //   - shared (app-class memory)         → any AppMember of memory.appId
      //   - per-user agent memory             → memory.createdBy only.
      //     Covers both class='personal' AND class='knowledge': startChat
      //     provisions the chat's holding memory as 'personal' when the
      //     agent has a matching App in the caller's orgs, and downgrades
      //     to 'knowledge' otherwise (see startChat target-memory selection,
      //     and the chk_memory_class_app_id CHECK constraint that forces
      //     personal-class to carry an appId). Both shapes are bound to a
      //     single user via userMemoryOfAgentId — so authorize on
      //     createdBy in either case rather than the class label.
      //   - other classes                     → no chat-read path
      //   - global ADMIN/OWNER bypass remains for ops
      const mem = await ctx.db.memory.findUniqueOrThrow({
        where: { id: chatNode.memoryId },
        select: { createdBy: true, class: true, appId: true, userMemoryOfAgentId: true },
      });
      const isAdmin = !!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'));
      let canRead = isAdmin;
      if (!canRead) {
        if (mem.class === 'app' && mem.appId) {
          const member = await ctx.db.appMember.findFirst({
            where: { appId: mem.appId, userId: ctx.userId },
            select: { userId: true },
          });
          canRead = !!member;
        } else if (mem.userMemoryOfAgentId) {
          canRead = mem.createdBy === ctx.userId;
        } else if (mem.class === 'personal') {
          // Defensive fallback for any pre-spec personal-class chat
          // memory that wasn't bound via userMemoryOfAgentId. Modern
          // chat creation always sets the binding (see startChat).
          canRead = mem.createdBy === ctx.userId;
        }
      }
      if (!canRead) throw new Error('Forbidden');
      const rows = await ctx.db.node.findMany({
        where: {
          memoryId: chatNode.memoryId,
          loc: { startsWith: `${chatId}:messages:` },
          deletedAt: null,
        },
        orderBy: { seq: 'asc' as const },
        take: limit ?? 100,
        select: { loc: true, content: true, data: true, seq: true, createdAt: true, memoryId: true, nodeType: true },
      });
      // Decrypt before reading `data.role` / returning `content` — for
      // encrypted memories `data` is an opaque wrapper until decrypted, so
      // role detection would otherwise always fall through to the loc
      // suffix.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) {
        for (const m of rows) decryptNodeFields(m, memEncInfo);
      }
      return rows.map((m) => {
        // Agent-agnostic role detection (Constitution Invariant #14):
        //   - Primary: data.role on the message node.
        //   - Fallback: deterministic loc suffix from message creation —
        //     assistant messages always end with `-assistant`. Summary
        //     nodes (loc suffix `${NNN}a-summary`, created by
        //     saveChatSummary) and anything else default to 'user',
        //     matching the LLM-facing history builder in sendChatMessage.
        const name = m.loc.split(':').pop() ?? '';
        const data = (m.data as { role?: unknown } | null) ?? null;
        const explicitRole = typeof data?.role === 'string' ? data.role : null;
        const role: 'user' | 'assistant' =
          explicitRole === 'assistant'
            ? 'assistant'
            : explicitRole === 'user'
              ? 'user'
              : name.endsWith('-assistant')
                ? 'assistant'
                : 'user';
        return {
          role,
          content: m.content ?? '',
          seq: m.seq,
          createdAt: m.createdAt,
        };
      });
    },

    // ── Asset queries (spec 004-asset-upload) ─────────────────────────

    agentAssets: async (
      _: unknown,
      input: {
        agentUrn: string;
        mimeType?: string;
        skip?: number;
        count?: number;
        includeDeleted?: boolean;
      },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const result = await listAgentAssets(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        input,
        resolveAssetTargetMemoryId,
      );
      return {
        assets: result.assets,
        total: result.total,
        hasMore: result.hasMore,
      };
    },

    // v2 (spec 006): memory-addressed listing.
    memoryAssets: async (
      _: unknown,
      input: {
        memoryId: string;
        mimeType?: string;
        skip?: number;
        count?: number;
        includeDeleted?: boolean;
      },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const result = await listMemoryAssets(
        ctx.db,
        {
          userId: ctx.userId,
          appId: ctx.appId,
          roles: ctx.roles,
          organizationId: ctx.organizationId,
        },
        input,
      );
      return {
        assets: result.assets,
        total: result.total,
        hasMore: result.hasMore,
      };
    },

    assetDownloadUrl: async (
      _: unknown,
      { assetId, ttlSeconds }: { assetId: string; ttlSeconds?: number },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const result = await mintAssetDownloadUrl(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        { assetId, ttlSeconds },
      );
      return {
        url: result.url,
        expiresAt: result.expiresAt.toISOString(),
        filename: result.filename,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
      };
    },

    users: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' } });
    },

    searchUsers: async (_: unknown, { query }: { query: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const q = query.trim();
      // A blank query would make `contains: ''` match every row, re-opening the
      // enumeration path #384 closes — return nothing instead.
      if (q === '') return [];

      // #384: name/email are PII gated to co-members (enforced on output by the
      // User.name/email field resolvers). To stop searchUsers from also being a
      // name/email enumeration oracle for non-co-members, MATCHING is scoped
      // (Spec: cor:acl:070:02): public identifiers (handle, githubUsername)
      // match by substring, email by EXACT equality, and a `name` match counts
      // only for a viewer allowed to see that name (self/admin via platform
      // role, or a co-member). The co-member restriction is pushed INTO the
      // query — not a post-filter — so the `take` cap can't drop a legitimately
      // visible co-member behind a wall of name-only stranger matches.
      const isPlatformAdmin = !!ctx.roles?.some((r) => r === 'ADMIN' || r === 'OWNER');
      const viewerOrgIds = isPlatformAdmin ? [] : await getMemberOrgIds(ctx.db, ctx.userId);
      const nameMatch = isPlatformAdmin
        ? searchContains('name', q)
        : {
            AND: [
              searchContains('name', q),
              // target shares an org with the viewer (so the viewer may see the name)
              { memberships: { some: { organizationId: { in: viewerOrgIds }, deletedAt: null } } },
            ],
          };

      return ctx.db.user.findMany({
        where: {
          deletedAt: null,
          OR: [
            searchContains('handle', q),
            searchContains('githubUsername', q),
            { email: { equals: q, mode: 'insensitive' } },
            nameMatch,
          ],
        },
        take: 20,
        orderBy: { name: 'asc' },
      });
    },

    globalSearch: async (
      _: unknown,
      {
        query,
        entityTypes,
        fields,
        limit,
      }: {
        query: string;
        entityTypes?: SearchEntityType[] | null;
        fields?: SearchField[] | null;
        limit?: number | null;
      },
      ctx: Context,
    ) => {
      // Build the access principal from ctx using the SAME gates as the
      // per-kind queries, so a global hit can never reach something the caller
      // couldn't open directly. getAccessibleMemoryIds already carves out other
      // users' personal/private (even for admin); getMemberOrgIds scopes the
      // org-rooted slices. App-Key callers (no userId) get no org-read → [].
      const isPlatformAdmin = !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
      const accessibleMemoryIds = await getAccessibleMemoryIds(ctx);
      const orgIds = isPlatformAdmin
        ? null
        : ctx.userId
          ? await getMemberOrgIds(ctx.db, ctx.userId)
          : [];
      const principal: SearchPrincipal = {
        viewerUserId: ctx.userId ?? null,
        isPlatformAdmin,
        accessibleMemoryIds,
        orgIds,
      };
      return runGlobalSearch(ctx.db, { query, entityTypes, fields, limit }, principal);
    },

    me: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return null;
      return ctx.db.user.findUnique({ where: { id: ctx.userId } });
    },

    organizations: async (_: unknown, __: unknown, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.organization.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' }, include: ORG_INCLUDE });
    },

    myOrganizations: async (_: unknown, __: unknown, ctx: Context) => {
      if (!ctx.userId) return [];
      const memberships = await ctx.db.orgMember.findMany({
        where: { userId: ctx.userId, deletedAt: null },
        include: { organization: { include: ORG_INCLUDE } },
      });
      return memberships.map((m: any) => m.organization);
    },

    organization: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveOrgRef(ctx.db, id);
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: resolvedId, userId: ctx.userId } },
        });
        if (!member) throw new Error('Forbidden');
      }
      return ctx.db.organization.findUnique({ where: { id: resolvedId }, include: ORG_INCLUDE });
    },

    invitation: async (_: unknown, { slug }: { slug: string }, ctx: Context) => {
      const invite = await ctx.db.userInvitation.findUnique({
        where: { slug },
        include: {
          sender: true,
          organization: true,
          activations: true,
        },
      });
      if (!invite || invite.deletedAt) return null;
      return {
        ...invite,
        activationCount: invite.activations.length,
      };
    },

    publicMemories: async (_: unknown, __: unknown, ctx: Context) => {
      return ctx.db.memory.findMany({
        where: { visibility: 'PUBLIC', deletedAt: null },
        orderBy: { name: 'asc' },
        include: MEMORY_INCLUDE,
      });
    },

    memory: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const memory = await ctx.db.memory.findUnique({
        where: { id },
        include: MEMORY_INCLUDE,
      });
      if (!memory || memory.deletedAt) return null;
      // 034-memory-class-access: owner-owned personal/private are owner-only —
      // no ADMIN/OWNER bypass, no org-member path. Check before the org logic.
      if (memory.class === 'personal' || memory.class === 'private') {
        if (!ctx.userId || memory.userId !== ctx.userId) throw new Error('Forbidden');
        return memory;
      }
      // Authorization: platform ADMIN/OWNER, a member of the memory's org, OR
      // any caller the shared read gate already admits — PUBLIC visibility,
      // a cross-org subscription, or an App session scoped to this memory.
      // The node queries (nodeById/nodes) authorize through that same set via
      // memoryAccessFilter → getAccessibleMemoryIds, so without the fallback a
      // public-visibility reader could read the memory's NODES but not the
      // memory record itself; the portal's uncaught MEMORY_BY_ID_QUERY then
      // turned that Forbidden into an HTTP 500 (issue #362). The org-member
      // fast-path is kept because getAccessibleMemoryIds (via
      // getOrgReadableMemoryIds) intentionally omits app/system-class org
      // memories, which members can still open here as they do today.
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        // findFirst (not findUnique) so a REVOKED (soft-deleted) membership no
        // longer grants access — matches getOrgReadableMemoryIds' own
        // `deletedAt: null` membership filter.
        const member = ctx.userId
          ? await ctx.db.orgMember.findFirst({
              where: {
                organizationId: memory.organizationId,
                userId: ctx.userId,
                deletedAt: null,
              },
            })
          : null;
        if (!member) {
          // Scope the shared gate to THIS memory so it's an indexed point-read,
          // not an enumeration of the whole accessible set.
          const accessibleIds = await getAccessibleMemoryIds(ctx, memory.id);
          if (accessibleIds !== null && !accessibleIds.includes(memory.id)) {
            throw new Error('Forbidden');
          }
        }
      }
      return memory;
    },

    orgSystemMemories: async (
      _: unknown,
      { orgId }: { orgId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      // Authorization: platform ADMIN or member of the org
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: resolvedOrgId, userId: ctx.userId } },
        });
        if (!member) throw new Error('Forbidden');
      }
      return ctx.db.memory.findMany({
        where: {
          organizationId: resolvedOrgId,
          deletedAt: null,
          class: 'system',
          userMemoryOfAgentId: null,
        },
        include: MEMORY_INCLUDE,
        orderBy: { name: 'asc' },
      });
    },

    myMemories: async (
      _: unknown,
      { includeAgentSystem }: { includeAgentSystem?: boolean },
      ctx: Context,
    ) => {
      // Agent system memories are hidden by default on listing pages. The
      // portal passes includeAgentSystem: true only when the user toggles
      // "Show system memories" at the top of /app/memories.
      const typeFilter = includeAgentSystem
        ? {}
        : { class: { not: 'system' as const } };

      // 023-app-shape Phase 2b: App↔Agent is N:M via AppAgent. Surface
      // memoryItems for every installed Agent (the "primary" notion is
      // not load-bearing here — the resolver returns the union). Apps
      // with no installed Agents see zero memories.
      if (ctx.appId) {
        const app = await ctx.db.app.findUnique({
          where: { id: ctx.appId },
          select: {
            appAgents: {
              select: {
                agent: {
                  include: {
                    memoryItems: { include: { memory: { include: MEMORY_INCLUDE } } },
                  },
                },
              },
            },
          },
        });
        if (!app || app.appAgents.length === 0) return [];
        const memoryMap = new Map<string, any>();
        for (const aa of app.appAgents) {
          for (const item of aa.agent.memoryItems) {
            if (!includeAgentSystem && item.memory.class === 'system') continue;
            memoryMap.set(item.memory.id, item.memory);
          }
        }
        return Array.from(memoryMap.values());
      }
      // JWT/OAuth user — union of all org-accessible memories
      if (ctx.userId) {
        const memberships = await ctx.db.orgMember.findMany({
          where: { userId: ctx.userId, deletedAt: null },
          select: { organizationId: true },
        });
        const orgIds = memberships.map((m: { organizationId: string }) => m.organizationId);
        if (orgIds.length === 0) return [];
        return ctx.db.memory.findMany({
          where: {
            deletedAt: null,
            ...typeFilter,
            // Also exclude per-user agent memories — they belong to the chatbot
            // flow, not the user's regular memory list.
            userMemoryOfAgentId: null,
            OR: [
              // Org-shared classes via membership; 034: owner-owned
              // personal/private never come in via the org.
              { organizationId: { in: orgIds }, class: { notIn: ['personal', 'private'] as any } },
              { class: { notIn: ['personal', 'private'] as any }, subscriptions: { some: { organizationId: { in: orgIds } } } },
              // 034: the user's own owner-owned personal/private memories.
              { class: { in: ['personal', 'private'] as any }, userId: ctx.userId },
            ],
          },
          include: MEMORY_INCLUDE,
          orderBy: { name: 'asc' },
        });
      }
      throw new Error('Unauthenticated');
    },

    // ── Exchange integration queries ────────────────────────────────────

    exchangeConnections: async (_: unknown, { orgId }: { orgId: string }, ctx: Context) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      return ctx.db.exchangeConnection.findMany({
        where: { organizationId: resolvedOrgId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
    },

    exchangeMessages: async (
      _: unknown,
      { connectionId, top, filter }: { connectionId: string; top?: number; filter?: string },
      ctx: Context,
    ) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, connectionId);
      const result = await listInboxMessages(refreshToken, { top: top ?? 25, filter: filter ?? undefined });
      return result.data.map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from?.emailAddress?.address ?? null,
        receivedDateTime: m.receivedDateTime,
        isRead: m.isRead,
        bodyPreview: m.bodyPreview,
        body: m.body?.content ?? null,
        hasAttachments: m.hasAttachments,
      }));
    },

    exchangeFolders: async (_: unknown, { connectionId }: { connectionId: string }, ctx: Context) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, connectionId);
      const result = await listFolders(refreshToken);
      return result.data;
    },

    // ── Apps (multi-user agent callers) ─────────────────────────────
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

    // 005-agent-subscription FR-005: AgentSubscriptions held by the
    // authenticated user.
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

    appNodes: async (
      _: unknown,
      { appId, limit }: { appId: string; limit?: number },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: appId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      // Org-scoped auth: anyone with org membership at READER+ on the App's
      // org may read its accessible nodes; platform ADMIN/OWNER bypasses.
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        await requireOrgRole(ctx, app.organizationId, 'READER');
      }
      // 023-app-shape Phase 2b: App↔Agent is N:M via AppAgent. Gather
      // memoryItems for every installed Agent. Apps with no installed
      // Agents have no accessible nodes.
      const appWithAgents = await ctx.db.app.findUnique({
        where: { id: resolvedAppId },
        select: {
          appAgents: {
            select: { agent: { select: { memoryItems: true } } },
          },
        },
      });
      const memoryIds = [
        ...new Set(
          (appWithAgents?.appAgents ?? []).flatMap((aa) =>
            aa.agent.memoryItems.map((m) => m.memoryId),
          ),
        ),
      ];
      if (memoryIds.length === 0) return [];

      const results = await ctx.db.node.findMany({
        where: { memoryId: { in: memoryIds }, deletedAt: null },
        orderBy: { loc: 'asc' },
        take: limit ?? 500,
        include: {
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
          memory: { select: { id: true, urn: true, name: true, organizationId: true } },
        },
      });
      await decryptNodesBatch(ctx.db, results);
      return results;
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
  },

  Mutation: {
    ...nodeMutations,
    ...assetMutations,
    ...memoryMutations,
    ...orgMutations,
    ...agentMutations,
    ...appMutations,
    ...chatMutations,
    ...sessionMutations,
  },
};

