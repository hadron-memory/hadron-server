import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { generateId } from '../../../lib/id.js';
import { computeContentHash } from '../../../lib/contentHash.js';
import {
  enqueueNodeEmbedding,
  backfillMemoryEmbeddings,
} from '../../../services/embedding/enqueue.js';
import {
  deleteMemoryVectors,
  vectorSearchNodes,
  vectorSearchChunks,
} from '../../../services/embedding/vectors.js';
import { getEmbeddingClient, isEmbeddingConfigured } from '../../../lib/embedding/index.js';
import { reciprocalRankFusion } from '../../../lib/rrf.js';
import {
  matchesQuery,
  keywordRelevanceRank,
  expandWithNeighbors,
} from '../../../lib/search.js';
import {
  APP_KEY_PREFIX,
  USER_API_KEY_LABEL_MAX_LEN,
  hashAppKey,
  mintUserApiKey,
} from '../../../middleware/auth.js';
import { canWriteToMemory } from '../../../mcp/access-control.js';
import { ensureAgentSubscription } from '../../../controller/operations/ensureAgentSubscription.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import {
  ensureAppMember,
  InvalidRoleError,
  MaxMembersExceededError,
  OrphanAppError,
} from '../../../controller/operations/ensureAppMember.js';
import {
  publishAgentImport,
  SelfImportError,
  MultiLevelImportError,
  MissingGrantError,
  PositionConflictError,
} from '../../../controller/operations/publishAgentImport.js';
import { removeAgentImport } from '../../../controller/operations/removeAgentImport.js';
import { isLifecycleActive } from '../../../lib/lifecycle.js';
import { getPrimaryAgent, getPrimaryAgentId, isAgentInstalled } from '../../../lib/appAgent.js';
import { isOrgExternalAppMember } from '../../../lib/auth/isOrgExternalAppMember.js';
import { joinApp, NoMemberRolesError, AppUninstalledError } from '../../../controller/operations/joinApp.js';
import { AppNotFoundError } from '../../../lib/entityRef/errors.js';
import {
  createMemoryShare,
  InvalidMemoryClassForShareError,
  MemoryNotFoundForShareError,
  MemoryShareGranteeMissingError,
} from '../../../controller/operations/createMemoryShare.js';
import { revokeMemoryShare } from '../../../controller/operations/revokeMemoryShare.js';
import {
  updateMemoryShareRole,
  MemoryShareNotFoundError,
} from '../../../controller/operations/updateMemoryShareRole.js';
import {
  addMemoryMember,
  InvalidMemoryClassForMemberError,
  MemoryNotFoundForMemberError,
  MemoryMemberUserMissingError,
} from '../../../controller/operations/addMemoryMember.js';
import {
  updateMemoryMemberRole,
  MemoryMemberNotFoundError,
  LastOwnerProtectedError,
} from '../../../controller/operations/updateMemoryMemberRole.js';
import { removeMemoryMember } from '../../../controller/operations/removeMemoryMember.js';
import type {
  MemoryShareRole as MemoryShareRoleType,
  MemoryMemberRole as MemoryMemberRoleType,
} from '../../../generated/prisma/index.js';
import { leaveApp } from '../../../controller/operations/leaveApp.js';
import { parseDataKey, type EncryptionKey } from '../../../lib/crypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import {
  encryptNodeFields,
  encryptNodeFieldsWithKey,
  decryptNodeFields,
  decryptNodesBatch,
  getMemoryEncryptionInfo,
  type MemoryEncryptionInfo,
} from '../../../lib/nodeCrypto.js';
import {
  parseUrnInput,
  validateUrnType,
  formatUrn,
  composeInstalledAgentUrn,
} from '../../../lib/urn.js';
import { validateLoc, InvalidLocError } from '../../../lib/validateLoc.js';
import {
  NodeLocConflictError,
  NodeNotFoundError,
  NodeAbstractTooLongError,
  EncryptedVectorIndexNotAcknowledgedError,
  InvalidChunkConfigError,
} from '../../../lib/entityRef/errors.js';
import { compileTemplate } from '../../../lib/template.js';
import {
  validateEdgeCondition,
  evaluateEdgeCondition,
  validateNodeDataExtractionSpecs,
  userMessageFor,
  type EvaluationError,
  type MemoryLayerHandle,
} from '../../../lib/edge-conditions/index.js';
import { buildPrismaMemoryLayer } from '../../../lib/edge-conditions/prisma-memory-layer.js';
import {
  beginAssetUpload,
  beginAssetUploadV2,
  type BeginAssetUploadInput as AssetUploadInput,
  type BeginAssetUploadV2Input,
} from '../../../controller/operations/beginAssetUpload.js';
import { listMemoryAssets } from '../../../controller/operations/listMemoryAssets.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { completeAssetUpload } from '../../../controller/operations/completeAssetUpload.js';
import { setAgentAssetUploadEnabled } from '../../../controller/operations/setAgentAssetUploadEnabled.js';
import { listAgentAssets } from '../../../controller/operations/listAgentAssets.js';
import { mintAssetDownloadUrl } from '../../../controller/operations/mintAssetDownloadUrl.js';
import { softDeleteAsset } from '../../../controller/operations/softDeleteAsset.js';
import { restoreAsset } from '../../../controller/operations/restoreAsset.js';
import { GraphQLError } from 'graphql';
import type { InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import { Prisma } from '../../../generated/prisma/index.js';
import type {
  PrismaClient,
  Role,
  AppType,
  AppMembershipRole,
  SubscriptionType,
  MemoryVisibility,
  AgentVisibility,
} from '../../../generated/prisma/index.js';
import { deserializeTags, serializeTags, serializeJson, deserializeJson, searchContains, tagsFilter } from '../../../integrations/db/provider.js';
import { writeNodeToGit } from '../../../integrations/github/writeNodeToGit.js';
import { syncGraphFromGithub } from '../../../integrations/github/syncGraphFromGithub.js';
import { createNode } from '../../../controller/operations/createNode.js';
import {
  listInboxMessages,
  replyToMessage,
  moveMessage,
  listFolders,
  extractErrorMessage,
} from '../../../integrations/exchange/exchange.js';
import {
  validateChatScopeInvariants,
  findOrCreateAppClassMemory,
  chatScopeAccessFilter,
  ChatScopeError,
} from './chat-scope.js';

export interface Context {
  db: PrismaClient;
  clientId?: string;       // "github:<username>" / "email:<addr>" — only set for OAuth/JWT users
  userId?: string;         // User.id — only set for OAuth/JWT users
  appId?: string;          // App.id — set when caller authenticated via an App Key
  sessionId?: string;      // Session.id — set when operating inside an active session
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  organizationId?: string; // set when the Client is scoped to an organization
}

const ROLE_ORDER: Record<string, number> = { READER: 0, CONTRIBUTOR: 1, ADMIN: 2, OWNER: 3 };

function requireRole(ctx: Context, required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER') {
  const highest = ctx.roles ? Math.max(...ctx.roles.map((r) => ROLE_ORDER[r] ?? -1)) : -1;
  if (highest < ROLE_ORDER[required]) throw new Error('Forbidden');
}

/**
 * Validate an edge-condition payload at GraphQL save-time. Throws a
 * GraphQLError with the contract's named extension codes on failure.
 * See specs/001-edge-condition-spec/contracts/graphql-edge-condition.md.
 */
function throwOnInvalidCondition(condition: unknown): void {
  const result = validateEdgeCondition(condition);
  if (result.ok) return;
  const err: EvaluationError = result.error;
  throw new GraphQLError(err.message, {
    extensions: {
      code: 'INVALID_EDGE_CONDITION',
      reason: err.code,
      detail: err.detail,
    },
  });
}

/**
 * Validate any extraction-spec arrays carried inside a node-data payload.
 * Rejects writes that try to land an extraction under
 * `message.data.exception(s)` (reserved per spec FR-013 for the future
 * agent-exceptions feature).
 */
function throwOnReservedExtractionSpec(data: unknown): void {
  const result = validateNodeDataExtractionSpecs(data);
  if (result.ok) return;
  const err: EvaluationError = result.error;
  throw new GraphQLError(err.message, {
    extensions: {
      code: 'INVALID_EXTRACTION_SPEC',
      reason: err.code,
      detail: err.detail,
    },
  });
}

async function requireOrgRole(
  ctx: Context,
  orgId: string,
  required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER',
): Promise<void> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;
  if (!ctx.userId) throw new Error('Forbidden');
  const member = await ctx.db.orgMember.findUnique({
    where: { organizationId_userId: { organizationId: orgId, userId: ctx.userId } },
  });
  if (!member || (ROLE_ORDER[member.role] ?? -1) < ROLE_ORDER[required]) {
    throw new Error('Forbidden');
  }
}

// ── Memory access control ──────────────────────────────────────────────

/**
 * Returns the memory IDs accessible to the current caller, or null if the
 * caller has unrestricted access (global ADMIN/OWNER).
 *
 * - Clients: memories from agent subscriptions only
 * - Users: memories from org memberships + cross-org subscriptions + public memories
 * - Unauthenticated: public memories only
 */
async function getAccessibleMemoryIds(ctx: Context): Promise<string[] | null> {
  // App Key with an active session — hard-isolate to the session's memory
  // plus the agent's system memory. Even if an LLM asks to read a different
  // memory by ID, this filter denies it. This is THE security boundary for
  // multi-user agents — checked FIRST, so it can't be widened by an ADMIN role
  // riding on a session context.
  if (ctx.appId && ctx.sessionId) {
    const session = await ctx.db.session.findUnique({
      where: { id: ctx.sessionId },
      select: {
        memoryId: true,
        agent: { select: { systemMemoryId: true } },
      },
    });
    const ids: string[] = [];
    if (session?.memoryId) ids.push(session.memoryId);
    if (session?.agent?.systemMemoryId) ids.push(session.agent.systemMemoryId);
    return ids;
  }

  // Platform ADMIN/OWNER: broad access EXCEPT another user's owner-owned
  // personal/private memory. 034-memory-class-access: we return an explicit id
  // list (not `null` = "no filter") so the owner-only carve-out flows through
  // every node read surface (memoryAccessFilter / nodeSearch) — otherwise an
  // operator could read another user's private memory's nodes.
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) {
    const all = await ctx.db.memory.findMany({
      where: {
        deletedAt: null,
        NOT: {
          class: { in: ['personal', 'private'] as any },
          userId: { not: ctx.userId ?? '__none__' },
        },
      },
      select: { id: true },
    });
    return all.map((m: { id: string }) => m.id);
  }

  // App Key without an active session — management-only context, no memory
  // access at all.
  if (ctx.appId) {
    return [];
  }

  // JWT user — org memories (respecting visibility) + subscribed memories + public memories
  if (ctx.userId) {
    const memberships = await ctx.db.orgMember.findMany({
      where: { userId: ctx.userId, deletedAt: null },
      select: { organizationId: true },
    });
    const orgIds = memberships.map((m: { organizationId: string }) => m.organizationId);
    const memories = await ctx.db.memory.findMany({
      where: {
        deletedAt: null,
        OR: [
          // Org-visible memories: knowledge (PUBLIC/ORGANIZATION) + group
          // (GROUP). 035-visibility-enum-cleanup: this used to admit
          // `class notIn personal/private AND visibility != PRIVATE`, which —
          // given the old PRIVATE default — excluded app/system. `class IN
          // (knowledge, group)` preserves exactly that set (app/system are
          // reached via AppMember / the agent surface, not this node query).
          // Per-user "holding" memories (userMemoryOfAgentId set — e.g. the
          // startChat no-App knowledge downgrade) are owner-only: excluded
          // here, re-admitted by the owner clause below. (Owner-gating moved
          // off visibility=PRIVATE onto userMemoryOfAgentId — mirrors the
          // chathistory-knowledge-class-auth-gap finding.)
          ...(orgIds.length > 0
            ? [
                { organizationId: { in: orgIds }, class: { in: ['knowledge', 'group'] as any }, userMemoryOfAgentId: null },
                // Cross-org subscriptions never reach owner-only personal/private.
                { class: { notIn: ['personal', 'private'] as any }, userMemoryOfAgentId: null, subscriptions: { some: { organizationId: { in: orgIds } } } },
              ]
            : []),
          // 034: owner-owned personal/private memories — only the owner.
          { class: { in: ['personal', 'private'] as any }, userId: ctx.userId },
          // The caller's own per-user holding memories (knowledge/app bound to
          // an agent for this user) — owner-only, gated on creator identity.
          { userMemoryOfAgentId: { not: null }, createdBy: ctx.userId },
          // PUBLIC memories — defensively excluding personal/private and
          // per-user holdings so a mis-set visibility can't expose them.
          { visibility: 'PUBLIC' as any, class: { notIn: ['personal', 'private'] as any }, userMemoryOfAgentId: null },
        ],
      },
      select: { id: true },
    });
    return memories.map((g: { id: string }) => g.id);
  }

  // Unauthenticated — public memories only
  const publicMemories = await ctx.db.memory.findMany({
    where: { visibility: 'PUBLIC', deletedAt: null },
    select: { id: true },
  });
  return publicMemories.map((g) => g.id);
}

/** Prisma `where` clause that restricts sessions to the caller's scope. */
async function sessionScopeFilter(ctx: Context): Promise<Record<string, unknown>> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return {};
  // App Key path — sessions belonging to the authenticated App.
  if (ctx.appId) return { appId: ctx.appId };
  // JWT user — sessions for Apps in any org the user is a member of.
  if (ctx.userId) {
    const memberships = await ctx.db.orgMember.findMany({
      where: { userId: ctx.userId, deletedAt: null },
      select: { organizationId: true },
    });
    const orgIds = memberships.map((m: { organizationId: string }) => m.organizationId);
    if (orgIds.length === 0) return { id: '__none__' };
    const apps = await ctx.db.app.findMany({
      where: { organizationId: { in: orgIds }, deletedAt: null },
      select: { id: true },
    });
    return { appId: { in: apps.map((a) => a.id) } };
  }
  return { id: '__none__' }; // unauthenticated — no sessions
}

/** Prisma `where` clause that restricts nodes to accessible memories. */
async function memoryAccessFilter(ctx: Context): Promise<Record<string, unknown>> {
  const ids = await getAccessibleMemoryIds(ctx);
  return ids === null ? {} : { memoryId: { in: ids } };
}

/**
 * Spec 033 US3 — shared rendering pass for `nodeSearch`. Takes the
 * ranked node IDs from any of the three modes (keyword/vector/hybrid),
 * optionally appends BFS-expanded neighbors, fetches the full node rows
 * (with edges + decryption applied), and re-orders them to match the
 * input ranking. Returns the GraphQL NodeSearchResult envelope.
 *
 * The expand-scope here is the memory set the ranked path searched —
 * for vector/hybrid that's the indexed memories; for keyword that's
 * the broader accessible set.
 */
async function renderNodeSearchResult(
  ctx: Context,
  rankedIds: string[],
  expand: number | undefined,
  expandScope: string[],
  reason: string | null,
  degraded: string | null,
): Promise<{
  nodes: unknown[];
  passages: unknown[];
  reason: string | null;
  degraded: string | null;
}> {
  const neighborIds =
    expand && expand > 0
      ? await expandWithNeighbors(ctx.db, rankedIds, expand, { memoryIds: expandScope })
      : [];
  const allIds = [...rankedIds, ...neighborIds];
  if (allIds.length === 0) {
    return { nodes: [], passages: [], reason, degraded };
  }
  const fetched = await ctx.db.node.findMany({
    where: { id: { in: allIds }, deletedAt: null },
    include: {
      outgoingEdges: { include: { target: true } },
      incomingEdges: { include: { source: true } },
    },
  });
  await decryptNodesBatch(ctx.db, fetched);
  const byId = new Map(fetched.map((n) => [n.id, n]));
  const ordered = allIds
    .map((id) => byId.get(id))
    .filter((n): n is NonNullable<typeof n> => n !== undefined);
  return { nodes: ordered, passages: [], reason, degraded };
}

// Note (PR-227 review, Gemini): a `deduplicateNodes` helper lived here
// pre-2026-06-02 to collapse rows by `(memoryId, loc)` and prefer the
// canonical (isLink=false) over the link variant. The schema's
// `@@unique([loc, memoryId])` on Node makes this a structural no-op
// for any direct `findMany` result — Prisma cannot return two rows for
// the same (memoryId, loc) pair, so the canonical-vs-link tiebreak
// never fires. The function was removed and call sites use the
// findMany result directly. Cross-memory same-loc preservation is
// pinned by src/test/integration/dedup-cross-memory-loc.test.ts so a
// future query shape that re-introduces row duplication (e.g. a UNION
// across memories) would surface there.

/**
 * Verify the caller has write access to a specific memory.
 *
 * Checks (most restrictive wins):
 * 1. Global ADMIN/OWNER — always allowed (except for personal/private memories,
 *    where strict ownership applies per FR-016)
 * 2. App-keyed callers: write resolved by canWriteToMemory which folds
 *    AppAgent.role + AgentMemoryItem.role + AgentSubscription gates
 * 3. Users: org member with CONTRIBUTOR+, or cross-org subscription with CONTRIBUTOR role
 */
async function requireMemoryWriteAccess(ctx: Context, memoryId: string): Promise<void> {
  // App-keyed callers: delegate to the class-aware MCP gate (handles app-scoped
  // personal/private + the app+admin short-circuit). Unchanged.
  if (ctx.appId) {
    if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;
    if (await canWriteToMemory(ctx.db, ctx, memoryId)) return;
    throw new Error('Forbidden: no write access to this memory');
  }

  // JWT user path
  if (!ctx.userId) throw new Error('Unauthenticated');

  const memory = await ctx.db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: { organizationId: true, userId: true, class: true },
  });

  // 034-memory-class-access: owner-owned personal/private memories are
  // owner-only to write — no ADMIN/OWNER bypass, no org-role path.
  if (memory.class === 'personal' || memory.class === 'private') {
    if (memory.userId === ctx.userId) return;
    throw new Error('Forbidden: no write access to this memory');
  }

  // Non-personal/private: global ADMIN/OWNER bypass.
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;

  // Direct org member with CONTRIBUTOR+?
  const member = await ctx.db.orgMember.findUnique({
    where: { organizationId_userId: { organizationId: memory.organizationId, userId: ctx.userId } },
  });
  if (member && (ROLE_ORDER[member.role] ?? -1) >= ROLE_ORDER['CONTRIBUTOR']) return;

  // Cross-org subscription with CONTRIBUTOR role?
  const userOrgs = await ctx.db.orgMember.findMany({
    where: {
      userId: ctx.userId,
      deletedAt: null,
      role: { in: ['CONTRIBUTOR', 'ADMIN', 'OWNER'] as any },
    },
    select: { organizationId: true },
  });
  for (const uo of userOrgs) {
    const memorySub = await ctx.db.memorySubscription.findUnique({
      where: { memoryId_organizationId: { memoryId, organizationId: uo.organizationId } },
    });
    if (memorySub && (ROLE_ORDER[memorySub.role] ?? -1) >= ROLE_ORDER['CONTRIBUTOR']) return;
  }

  throw new Error('Forbidden: no write access to this memory');
}

const MEMORY_INCLUDE = {
  subscriptions: { include: { organization: true }, orderBy: { createdAt: 'asc' as const } },
};

const AGENT_INCLUDE = {
  memoryItems: { where: { deletedAt: null, memory: { deletedAt: null } }, include: { memory: true } },
};

const ORG_INCLUDE = {
  members: { where: { deletedAt: null }, include: { user: true }, orderBy: { createdAt: 'asc' as const } },
  // User memories (per-user, per-agent) and agent system memories are
  // excluded from the org memories listing. User memories live in a
  // separate "Users" view; system memories are surfaced through the
  // agent detail page. This keeps the main memory list focused on
  // regular knowledge memories.
  memories: {
    where: {
      deletedAt: null,
      userMemoryOfAgentId: null,
      // 034-memory-class-access: owner-owned personal/private are never "org
      // memories" — they're owner-only and surfaced via the owner's own views.
      // 035-visibility-enum-cleanup: system memories (was `type !=
      // AGENT_SYSTEM`) are excluded by class — surfaced via the agent surface.
      class: { notIn: ['personal', 'private', 'system'] as any },
    },
    include: MEMORY_INCLUDE,
    orderBy: { name: 'asc' as const },
  },
  agents: { where: { deletedAt: null }, include: AGENT_INCLUDE, orderBy: { name: 'asc' as const } },
  // 023-app-shape Phase 2b: App↔Agent moved from direct FK to the
  // AppAgent N:M join. Eager-load the AppAgent rows (with each Agent's
  // memoryItems) so the GraphQL `App.agent` / `App.agents` /
  // `App.installedAgentUrn` field resolvers can compute their result
  // without re-querying. The first AppAgent row (orderBy createdAt asc)
  // is treated as the "primary" agent for legacy single-Agent reads.
  apps: {
    where: { deletedAt: null },
    include: {
      keys: { where: { revokedAt: null } },
      appAgents: {
        orderBy: { createdAt: 'asc' as const },
        include: { agent: { include: AGENT_INCLUDE } },
      },
    },
    orderBy: { name: 'asc' as const },
  },
  subscriptions: { where: { deletedAt: null }, include: { memory: true, organization: true }, orderBy: { createdAt: 'asc' as const } },
  exchangeConnections: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' as const } },
};

const SESSION_INCLUDE = { events: { orderBy: { createdAt: 'desc' as const }, take: 50 } };

// 023-app-shape Phase 2b: APP_INCLUDE eager-loads the AppAgent rows
// (with each Agent's memoryItems) so the GraphQL `App.agent` /
// `App.agents` / `App.installedAgentUrn` field resolvers can compute
// their result without re-querying. The legacy `agent: { ... }` key
// is gone because the direct FK was dropped; consumers that need the
// "primary" Agent read it via the first appAgents row (orderBy
// createdAt asc) or via `getPrimaryAgent` / `getPrimaryAgentId`.
const APP_INCLUDE = {
  keys: { where: { revokedAt: null }, orderBy: { createdAt: 'desc' as const } },
  appAgents: {
    orderBy: { createdAt: 'asc' as const },
    include: { agent: { include: AGENT_INCLUDE } },
  },
};

const toISO = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

// ─── 023-app-shape Phase 2b — App field-resolver helpers ────────────────
//
// `App.agent` / `App.agentId` / `App.installedAgentUrn` / `App.agents`
// are soft-deprecated convenience reads. They first try the eager-loaded
// `appAgents` collection (populated by APP_INCLUDE / ORG_INCLUDE) and
// fall back to `getPrimaryAgent` / `getPrimaryAgentId` re-fetches when
// the field-resolver is invoked on a parent that wasn't loaded with the
// include.

type EagerAppAgentRow = { agent: { id: string; urn?: string } & Record<string, unknown> };

function readPrimaryAppAgent(parent: { appAgents?: unknown }): EagerAppAgentRow | undefined {
  const rows = parent.appAgents;
  if (!Array.isArray(rows)) return undefined;
  // APP_INCLUDE / ORG_INCLUDE order by createdAt asc; [0] is the primary.
  return rows[0] as EagerAppAgentRow | undefined;
}

function readPrimaryAgentIdFromEager(parent: { appAgents?: unknown }): string | null | undefined {
  if (parent.appAgents === undefined) return undefined;
  const first = readPrimaryAppAgent(parent);
  return first?.agent?.id ?? null;
}

function readPrimaryAgentRecordFromEager(
  parent: { appAgents?: unknown },
): unknown | undefined {
  if (parent.appAgents === undefined) return undefined;
  const first = readPrimaryAppAgent(parent);
  return first?.agent ?? null;
}

function readAllAgentRecordsFromEager(
  parent: { appAgents?: unknown },
): unknown[] | undefined {
  const rows = parent.appAgents;
  if (!Array.isArray(rows)) return undefined;
  return rows.map((r) => (r as EagerAppAgentRow).agent);
}

async function readPrimaryAgentField(
  parent: { id: string; appAgents?: unknown },
  ctx: Context,
  field: 'urn',
): Promise<string | null> {
  const first = readPrimaryAppAgent(parent);
  if (first?.agent && typeof first.agent.urn === 'string') {
    return first.agent.urn;
  }
  // Fall back to a re-fetch only when the parent wasn't loaded with the include.
  if (parent.appAgents === undefined) {
    const primary = await getPrimaryAgent(ctx.db, parent.id, { include: undefined });
    return primary?.[field] ?? null;
  }
  return null;
}

// ─── 023-app-shape US3 — MemoryShare caller-authority guard ────────────
//
// All three MemoryShare mutations (create / revoke / update-role)
// share the same v1 rule: caller MUST be the Memory's principal
// (`memory.userId`). The Agent-mediated path (App backend acting on
// behalf via MCP) is supported by the access-control predicate but
// not by this GraphQL surface — see joinApp.ts header for the
// broader policy discussion.

// ─── 023-app-shape US4 — MemoryMember caller-authority guards ──────────
//
// addMemoryMember / updateMemoryMemberRole require an existing OWNER on
// the memory. removeMemoryMember accepts either an owner OR the member
// being removed (self-removal).

async function requireMemoryMemberOwner(
  ctx: Context,
  memoryId: string,
): Promise<void> {
  if (!ctx.userId) {
    throw new GraphQLError('Authenticated user required', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  // Don't-leak-metadata rule: surface a uniform FORBIDDEN for any
  // unauthorized path. Mirrors requireMemorySharePrincipal — checks
  // memory existence, soft-delete status, and class up-front so the
  // membership row of a deleted or wrong-class memory can't be used
  // to manage members. (Membership rows persist past Memory soft-
  // delete; without this guard an owner could keep managing roles on
  // a deleted memory.)
  const memory = await ctx.db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, deletedAt: true },
  });
  if (!memory || memory.deletedAt || memory.class !== 'group') {
    throw new GraphQLError('You are not authorized to manage members on this memory.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
  const member = await ctx.db.memoryMember.findUnique({
    where: { memoryId_userId: { memoryId, userId: ctx.userId } },
    select: { role: true },
  });
  if (!member || member.role !== 'owner') {
    throw new GraphQLError('You are not authorized to manage members on this memory.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

async function requireMemoryMemberOwnerOrSelf(
  ctx: Context,
  memoryId: string,
  targetUserId: string,
): Promise<void> {
  if (!ctx.userId) {
    throw new GraphQLError('Authenticated user required', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  if (ctx.userId === targetUserId) return; // self-removal always permitted.
  await requireMemoryMemberOwner(ctx, memoryId);
}

async function requireMemorySharePrincipal(
  ctx: Context,
  memoryId: string,
): Promise<void> {
  if (!ctx.userId) {
    throw new GraphQLError('Authenticated user required', {
      extensions: { code: 'UNAUTHENTICATED' },
    });
  }
  const memory = await ctx.db.memory.findUnique({
    where: { id: memoryId },
    select: { userId: true, class: true, deletedAt: true },
  });
  if (!memory || memory.deletedAt) {
    // Surface a generic FORBIDDEN rather than leaking memory existence.
    throw new GraphQLError('You are not authorized to manage shares on this memory.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
  if (memory.userId !== ctx.userId) {
    throw new GraphQLError('You are not authorized to manage shares on this memory.', {
      extensions: { code: 'FORBIDDEN' },
    });
  }
}

// ─── 023-app-shape US1 — install/uninstall Agent core logic ────────────
//
// Shared by both the canonical mutations (`installAgentIntoApp` /
// `uninstallAgentFromApp`, returning Payload types) and the deprecated
// pre-023 mutations (`addAgentToApp` / `removeAgentFromApp`, returning
// `App`). Keeping the logic in one place prevents drift between the two
// surfaces.

class DuplicateAppAgentError extends GraphQLError {
  constructor(appId: string, agentId: string) {
    super(`Agent ${agentId} is already installed in App ${appId}.`, {
      extensions: { code: 'DUPLICATE_APP_AGENT', appId, agentId },
    });
  }
}

async function installAgentIntoAppCore(
  ctx: Context,
  args: { appId: string; agentId: string; trainingMode?: boolean },
): Promise<{
  appId: string;
  agentId: string;
  appAgent: {
    appId: string;
    agentId: string;
    app: unknown;
    agent: unknown;
    createdAt: Date;
    createdBy: string | null;
    updatedAt: Date | null;
    updatedBy: string | null;
  };
}> {
  // 007-entity-id-or-urn: appId + agentId may each be ID, bare URN, or
  // prefixed URN.
  const { id: resolvedAppId } = await resolveAppRef(ctx.db, args.appId);
  const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, args.agentId);
  const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
  // `resolveAppRef` already filters `deletedAt`. The `uninstalledAt`
  // case (spec 021 FR-026 — soft-uninstall) is a separate lifecycle
  // phase where the App row exists but write operations are rejected.
  if (app.uninstalledAt) {
    throw new GraphQLError('Cannot install Agent into an uninstalled App.', {
      extensions: { code: 'APP_UNINSTALLED', appId: resolvedAppId },
    });
  }
  await requireOrgRole(ctx, app.organizationId, 'ADMIN');
  // Agent must belong to the same org (same as pre-023 behavior).
  const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
  if (agent.organizationId !== app.organizationId) {
    throw new GraphQLError('Agent must belong to the same organization as the App.', {
      extensions: { code: 'ORGANIZATION_MISMATCH', appId: resolvedAppId, agentId: resolvedAgentId },
    });
  }
  // Best-effort pre-check for the typed `DUPLICATE_APP_AGENT` error.
  // The race-safe fallback lives inside the transaction below — under
  // concurrent installs of the same (App, Agent), one of the two will
  // hit Prisma's P2002 unique-constraint error on the AppAgent PK and
  // we translate that to DuplicateAppAgentError there.
  const existing = await ctx.db.appAgent.findUnique({
    where: { appId_agentId: { appId: resolvedAppId, agentId: resolvedAgentId } },
    select: { appId: true },
  });
  if (existing) throw new DuplicateAppAgentError(resolvedAppId, resolvedAgentId);
  // Auto-provision AgentOrgGrant (cross-org gate symmetry).
  await ensureAgentOrgGrant(ctx.db, app.organizationId, resolvedAgentId);
  // Wrap the App trainingMode update + the AppAgent create in a single
  // transaction. The App update goes FIRST so a subsequent re-fetch of
  // `appAgent.app` in the same response reflects the new trainingMode
  // (avoiding stale-data-in-payload). The AppAgent create is in a
  // try/catch that translates the P2002 unique violation (concurrent
  // install) to the typed DuplicateAppAgentError.
  const created = await ctx.db.$transaction(async (tx) => {
    if (args.trainingMode !== undefined) {
      await tx.app.update({
        where: { id: resolvedAppId },
        data: {
          trainingMode: args.trainingMode,
          updatedBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null,
        },
      });
    }
    try {
      return await tx.appAgent.create({
        data: {
          appId: resolvedAppId,
          agentId: resolvedAgentId,
          createdBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null,
        },
        include: {
          app: true,
          agent: { include: AGENT_INCLUDE },
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new DuplicateAppAgentError(resolvedAppId, resolvedAgentId);
      }
      throw e;
    }
  });
  return {
    appId: resolvedAppId,
    agentId: resolvedAgentId,
    appAgent: created,
  };
}

async function uninstallAgentFromAppCore(
  ctx: Context,
  args: { appId: string; agentId: string },
): Promise<{ appId: string; agentId: string }> {
  const { id: resolvedAppId } = await resolveAppRef(ctx.db, args.appId);
  const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, args.agentId);
  const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
  await requireOrgRole(ctx, app.organizationId, 'ADMIN');
  // Idempotent delete — `deleteMany` returns a count, never throws on
  // absent rows. The (App, Agent, *) memories persist as orphans per
  // spec 023 FR-005.
  await ctx.db.appAgent.deleteMany({
    where: { appId: resolvedAppId, agentId: resolvedAgentId },
  });
  return { appId: resolvedAppId, agentId: resolvedAgentId };
}

/**
 * Derive a human-readable title for a saved chat. Priority:
 * 1. User-set title (`data.title`)
 * 2. LLM-extracted title (`data.llmTitle`)
 * 3. First user message, truncated to 60 chars
 * 4. Fallback: "Untitled chat"
 */
function deriveChatTitle(
  _node: { loc: string },
  data: Record<string, unknown>,
  firstMessage: string | null,
): string {
  const explicit = typeof data.title === 'string' ? data.title.trim() : '';
  if (explicit) return explicit;
  const llm = typeof data.llmTitle === 'string' ? data.llmTitle.trim() : '';
  if (llm) return llm;
  if (firstMessage) {
    const trimmed = firstMessage.trim().replace(/\s+/g, ' ');
    return trimmed.length > 60 ? trimmed.slice(0, 57) + '…' : trimmed;
  }
  return 'Untitled chat';
}

function getEncryptionKey(): Buffer {
  const key = process.env.HADRON_ENCRYPTION_KEY;
  if (!key) throw new Error('HADRON_ENCRYPTION_KEY env var is required');
  return Buffer.from(key, 'hex');
}

function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptToken(ciphertext: string): string {
  const key = getEncryptionKey();
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function getExchangeRefreshToken(
  ctx: Context,
  connectionId: string,
): Promise<{ refreshToken: string; connection: any }> {
  const connection = await ctx.db.exchangeConnection.findUniqueOrThrow({
    where: { id: connectionId },
  });
  if (connection.deletedAt) throw new Error('Connection not found');
  await requireOrgRole(ctx, connection.organizationId, 'READER');
  return {
    refreshToken: decryptToken(connection.refreshTokenEncrypted),
    connection,
  };
}

// ---------------------------------------------------------------------------
// Chat helpers (used by startChat, sendChatMessage, processChatResponse)
// ---------------------------------------------------------------------------

type ExtractionSpecEntry = { field: string; description?: string; shape?: string };

/**
 * Build the respond() tool schema by merging extractionSpec from three
 * levels: agent (config node) → conversation → stage. Stage-level fields
 * win on conflict. Always includes onTrack + offTrackReason fields for
 * continuous routing.
 */
async function buildRespondToolSchema(
  db: PrismaClient,
  systemMemoryId: string,
  convName: string | null,
  stageData: Record<string, unknown>,
): Promise<Array<{ name: string; description: string; parameters: unknown }> | null> {
  const allSpecs: ExtractionSpecEntry[] = [];

  // 1. Agent-level: config node with agentExtractionSpec
  const configNode = await db.node.findFirst({
    where: { memoryId: systemMemoryId, loc: 'config', deletedAt: null },
    select: { data: true },
  });
  const agentSpec = (configNode?.data as Record<string, unknown>)?.agentExtractionSpec as ExtractionSpecEntry[] | undefined;
  if (agentSpec?.length) allSpecs.push(...agentSpec);

  // 2. Conversation-level
  if (convName) {
    const convNode = await db.node.findFirst({
      where: { memoryId: systemMemoryId, loc: `conversations:${convName}`, deletedAt: null },
      select: { data: true },
    });
    const convSpec = (convNode?.data as Record<string, unknown>)?.extractionSpec as ExtractionSpecEntry[] | undefined;
    if (convSpec?.length) allSpecs.push(...convSpec);
  }

  // 3. Stage-level
  const stageSpec = stageData.extractionSpec as ExtractionSpecEntry[] | undefined;
  if (stageSpec?.length) allSpecs.push(...stageSpec);

  // De-duplicate by field name (stage wins — added last, scanned last)
  const seen = new Set<string>();
  const deduped: ExtractionSpecEntry[] = [];
  for (let i = allSpecs.length - 1; i >= 0; i--) {
    const fieldName = allSpecs[i].field.split('.').pop() ?? allSpecs[i].field;
    if (!seen.has(fieldName)) {
      seen.add(fieldName);
      deduped.unshift(allSpecs[i]);
    }
  }

  const dataProps: Record<string, unknown> = {};
  for (const spec of deduped) {
    const fieldName = spec.field.split('.').pop() ?? spec.field;
    dataProps[fieldName] = { type: spec.shape ?? 'string', description: spec.description ?? fieldName };
  }

  return [{
    name: 'respond',
    description: 'Respond to the user and extract data',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Your response to the user' },
        data: { type: 'object', properties: dataProps },
        next_stage: { type: ['string', 'null'], description: 'Stage to transition to (null to stay in current stage)' },
        onTrack: { type: 'boolean', description: 'Is the current conversation/stage still the right fit for what the user is asking?' },
        offTrackReason: { type: 'string', description: 'If onTrack is false, explain why the conversation seems off-track' },
      },
      required: ['message', 'onTrack'],
    },
  }];
}

// ---------------------------------------------------------------------------
// Goal stack helpers
// ---------------------------------------------------------------------------

interface GoalStackEntry {
  description: string;
  language?: string;
  createdAt: string;
  createdBy: 'ASSISTANT' | 'USER';
  topicUrn?: string;
  conversationUrn?: string;
  nodeUrn?: string;
  edgeUrn?: string;
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  completedAt?: string;
}

function getGoalStack(chatData: Record<string, unknown>): GoalStackEntry[] {
  return (chatData.goalStack as GoalStackEntry[]) ?? [];
}

function pushGoal(
  chatData: Record<string, unknown>,
  goal: Omit<GoalStackEntry, 'status' | 'createdAt'>,
): GoalStackEntry[] {
  const stack = getGoalStack(chatData);
  stack.push({
    ...goal,
    status: 'ACTIVE',
    createdAt: new Date().toISOString(),
  });
  chatData.goalStack = stack;
  return stack;
}

function popGoal(chatData: Record<string, unknown>): GoalStackEntry | null {
  const stack = getGoalStack(chatData);
  // Find the topmost ACTIVE entry and mark it COMPLETED
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].status === 'ACTIVE') {
      stack[i].status = 'COMPLETED';
      stack[i].completedAt = new Date().toISOString();
      chatData.goalStack = stack;
      return stack[i];
    }
  }
  return null;
}

function currentGoal(chatData: Record<string, unknown>): GoalStackEntry | null {
  const stack = getGoalStack(chatData);
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].status === 'ACTIVE') return stack[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route history helpers
// ---------------------------------------------------------------------------

interface RouteHistoryEntry {
  nodeUrn?: string;
  topicUrn?: string;
  conversationUrn?: string;
  action: 'ENTER' | 'EXIT' | 'COMPLETED' | 'FOLLOWED';
  trigger?: { type: string; content?: string };
  edgeUrn?: string;
  timestamp: string;
}

function getRouteHistory(chatData: Record<string, unknown>): RouteHistoryEntry[] {
  return (chatData.routeHistory as RouteHistoryEntry[]) ?? [];
}

function appendRouteEntry(
  chatData: Record<string, unknown>,
  entry: Omit<RouteHistoryEntry, 'timestamp'>,
): void {
  const history = getRouteHistory(chatData);
  history.push({ ...entry, timestamp: new Date().toISOString() });
  chatData.routeHistory = history;
}

/**
 * Check if a conversation was recently visited (within the last N entries)
 * and left — used for loop prevention.
 */
function wasRecentlyVisited(
  chatData: Record<string, unknown>,
  conversationName: string,
  lookback = 3,
): boolean {
  const history = getRouteHistory(chatData);
  const recentExits = history
    .slice(-lookback * 2)  // each visit is ENTER + EXIT, so look back 2x
    .filter((e) =>
      e.action === 'EXIT' &&
      e.conversationUrn?.endsWith(`:${conversationName}`),
    );
  return recentExits.length > 0;
}

// Edge-condition memory layer construction lives in
// `lib/edge-conditions/prisma-memory-layer.ts` (the Prisma adapter).
// It's imported above as `buildPrismaMemoryLayer`.

// ── Asset upload helpers (spec 004-asset-upload) ──────────────────────────

/**
 * Resolve the memory the caller's asset should land in. Picks the
 * existing per-user memory for (agent, user) when present, or returns
 * the first writable memory attached to the agent as a fallback.
 */
async function resolveAssetTargetMemoryId(
  db: PrismaClient,
  agentId: string,
  userId: string,
): Promise<{ memoryId: string }> {
  const userMemory = await db.memory.findFirst({
    where: {
      userMemoryOfAgentId: agentId,
      createdBy: userId,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (userMemory) return { memoryId: userMemory.id };

  // Fallback: first agent-attached memory (single-user agent case).
  const agentMemory = await db.agentMemoryItem.findFirst({
    where: { agentId, deletedAt: null, role: 'read-write' },
    select: { memoryId: true },
  });
  if (agentMemory) return { memoryId: agentMemory.memoryId };

  throw new Error('NO_TARGET_MEMORY: no writable memory available for this agent');
}

/**
 * Pluggable admin check used by `setAgentAssetUploadEnabled`. Returns
 * true for platform-level ADMIN/OWNER roles or for org-level ADMIN/OWNER
 * via OrgMember.
 */
async function isOrgAdminFor(
  db: PrismaClient,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { roles: true },
  });
  if (user && (user.roles.includes('ADMIN') || user.roles.includes('OWNER'))) {
    return true;
  }
  const member = await db.orgMember.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  return !!member && (member.role === 'ADMIN' || member.role === 'OWNER');
}

function assetUrn(memoryUrn: string, assetId: string): string {
  return `${memoryUrn}:assets:${assetId}`;
}

// ---------------------------------------------------------------------------
// Snapshot reader: reads nodes from a published revision snapshot instead
// of the live database. Used by startChat/sendChatMessage when the agent
// has a publishedRevisionLoc set.
// ---------------------------------------------------------------------------

interface SnapshotNode {
  loc: string;
  name: string;
  nodeType?: string;
  description?: string | null;
  content?: string | null;
  data?: unknown;
}

/**
 * Load a published revision's snapshot and return a lookup function
 * that mimics db.node.findFirst for the system memory. Returns null
 * if no published revision exists (caller should fall back to live DB).
 */
async function loadPublishedSnapshot(
  db: PrismaClient,
  systemMemoryId: string,
  publishedRevisionLoc: string | null,
): Promise<((loc: string) => SnapshotNode | null) | null> {
  if (!publishedRevisionLoc) return null;

  const revNode = await db.node.findFirst({
    where: { memoryId: systemMemoryId, loc: publishedRevisionLoc, deletedAt: null },
    select: { data: true },
  });
  if (!revNode) return null;

  const revData = (revNode.data as Record<string, unknown>) ?? {};
  const snapshot = revData.snapshot as { nodes: SnapshotNode[] } | undefined;
  if (!snapshot?.nodes) return null;

  const nodesByLoc = new Map<string, SnapshotNode>();
  for (const n of snapshot.nodes) {
    nodesByLoc.set(n.loc, n);
  }

  return (loc: string) => nodesByLoc.get(loc) ?? null;
}

export const resolvers = {
  Node: {
    tags: (node: { tags: string | string[] }) => deserializeTags(node.tags),
    createdAt: (n: { createdAt: Date | string }) => toISO(n.createdAt)!,
    updatedAt: (n: { updatedAt: Date | string }) => toISO(n.updatedAt)!,
    // Spec 033 embedding-state DateTime fields — Prisma returns Date,
    // portal (and any other GraphQL consumer) needs ISO strings.
    embeddingPendingAt: (n: { embeddingPendingAt?: Date | string | null }) =>
      toISO(n.embeddingPendingAt),
    embeddingFailedAt: (n: { embeddingFailedAt?: Date | string | null }) =>
      toISO(n.embeddingFailedAt),
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
  },
  App: {
    createdAt: (a: { createdAt: Date | string }) => toISO(a.createdAt)!,
    updatedAt: (a: { updatedAt?: Date | string | null }) => toISO(a.updatedAt ?? null),
    expiresAt: (a: { expiresAt?: Date | string | null }) => toISO(a.expiresAt ?? null),
    hasAiApiKey: (a: { aiApiKeyEncrypted?: string | null }) => !!a.aiApiKeyEncrypted,
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
  User: {
    linkedAt: (u: { linkedAt?: Date | string | null }) => toISO(u.linkedAt ?? null),
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
  },
  ExchangeConnection: {
    lastSyncAt: (c: { lastSyncAt?: Date | string | null }) => toISO(c.lastSyncAt),
    createdAt: (c: { createdAt: Date | string }) => toISO(c.createdAt)!,
    updatedAt: (c: { updatedAt: Date | string }) => toISO(c.updatedAt)!,
  },
  Agent: {
    createdAt: (b: { createdAt: Date | string }) => toISO(b.createdAt)!,
    // Never return the encrypted API key itself — only whether one exists.
    hasAiApiKey: (a: { aiApiKeyEncrypted?: string | null }) => !!a.aiApiKeyEncrypted,
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
  },
  UsageEvent: {
    actionArgs: (event: { actionArgs: unknown }) => deserializeJson(event.actionArgs),
    createdAt: (ue: { createdAt: Date | string }) => toISO(ue.createdAt)!,
  },

  Query: {
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
          // Same access gate as nodeById: the node's memory must be in the
          // caller's accessible set ({} = unrestricted for global admins).
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
        default:
          return null;
      }
    },

    node: async (_: unknown, { loc: rawLoc, raw }: { loc: string; raw?: boolean }, ctx: Context) => {
      const parsed = parseUrnInput(rawLoc);
      const typeErr = validateUrnType(parsed, 'node');
      if (typeErr) throw new Error(typeErr);
      const loc = parsed.value;

      const access = await memoryAccessFilter(ctx);
      const candidates = await ctx.db.node.findMany({
        where: { loc, ...access },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      if (candidates.length === 0) return null;
      // Decrypt any nodes that come from encrypted memories (in place).
      await decryptNodesBatch(ctx.db, candidates);
      const node = candidates.find((n) => !n.isLink) ?? candidates[0];

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
      if (!node) return null;
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

    nodes: async (
      _: unknown,
      { nodeType, tags, search, prefix: rawPrefix, limit, offset }: { nodeType?: string; tags?: string[]; search?: string; prefix?: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      const prefix = rawPrefix ? parseUrnInput(rawPrefix).value : undefined;
      const access = await memoryAccessFilter(ctx);
      const results = await ctx.db.node.findMany({
        where: {
          ...access,
          // Exclude system nodes from search by default (unless explicitly requested)
          ...(nodeType ? { nodeType } : search ? { nodeType: { not: 'system' } } : {}),
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
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
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
        mode,
        expand,
        granularity,
        limit,
      }: {
        query: string;
        memoryUrn?: string;
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

      // Resolve scope: a single memory by URN (with access check), or the
      // full accessible set when memoryUrn is omitted.
      let scopeIds: string[];
      const accessible = await getAccessibleMemoryIds(ctx);
      if (memoryUrn) {
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

    nodeUsage: async (_: unknown, { loc, limit }: { loc: string; limit?: number }, ctx: Context) => {
      return ctx.db.usageEvent.findMany({
        where: { nodeLoc: loc },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 50,
      });
    },

    memoryUsageSummary: async (_: unknown, { memoryId }: { memoryId: string }, ctx: Context) => {
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      // Get all node locs belonging to this memory
      const nodes = await ctx.db.node.findMany({
        where: { memoryId: resolvedMemoryId },
        select: { loc: true },
      });
      const locs = nodes.map((n: { loc: string }) => n.loc);
      if (!locs.length) return [];

      const rows = await ctx.db.usageEvent.groupBy({
        by: ['nodeLoc', 'type'],
        where: { nodeLoc: { in: locs } },
        _count: { id: true },
      });
      return rows.map((r: { nodeLoc: string | null; type: string; _count: { id: number } }) => ({
        nodeLoc: r.nodeLoc,
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
      { type, nodeLoc, limit, offset }: { type?: string; nodeLoc?: string; limit?: number; offset?: number },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      return ctx.db.usageEvent.findMany({
        where: {
          ...(type ? { type } : {}),
          ...(nodeLoc ? { nodeLoc: { contains: nodeLoc } } : {}),
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
      if (!agent.aiProvider || !agent.aiModel || !agent.aiApiKeyEncrypted) return null;
      return {
        provider: agent.aiProvider,
        apiKey: decryptToken(agent.aiApiKeyEncrypted),
        model: agent.aiModel,
      };
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
      return ctx.db.user.findMany({
        where: {
          deletedAt: null,
          OR: [
            searchContains('name', query),
            searchContains('email', query),
            searchContains('githubUsername', query),
          ],
        },
        take: 20,
        orderBy: { name: 'asc' },
      });
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
      // Authorization: platform ADMIN or member of the memory's org
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.orgMember.findUnique({
          where: {
            organizationId_userId: {
              organizationId: memory.organizationId,
              userId: ctx.userId,
            },
          },
        });
        if (!member) throw new Error('Forbidden');
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
      if (!app.aiProvider || !app.aiModel || !app.aiApiKeyEncrypted) return null;
      return {
        provider: app.aiProvider,
        apiKey: decryptToken(app.aiApiKeyEncrypted),
        model: app.aiModel,
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
    upsertNode: async (_: unknown, { input }: { input: NodeInput }, ctx: Context) => {
      // Spec 022: `memoryId` MUST be supplied (typeDefs marks it `String!`).
      // Route through `resolveMemoryRef` so:
      //   - ID-shape inputs (CUID / 32-char hex) dispatch via spec 007
      //   - URN-shape inputs trigger `assertFullyQualifiedUrn(_, 'memory')`
      //     and reject relative-form inputs with UrnNotQualifiedError
      //     (mapped to `URN_NOT_QUALIFIED` by Apollo's formatError)
      //
      // The pre-022 fallback that walked all accessible memories looking
      // for a URN prefix of `input.loc` was the API-boundary loose-lookup
      // path the spec exists to close — removed.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, input.memoryId);
      input.memoryId = resolvedMemoryId;
      await requireMemoryWriteAccess(ctx, input.memoryId);

      // Validate loc shape at the GraphQL boundary so any caller — portal,
      // MCP, tests, future — gets the same typed InvalidLocError instead
      // of a downstream Prisma constraint failure leaking as INTERNAL_SERVER_ERROR.
      // The typed-error class is the source of truth for both the code
      // string (extensions.code = e.name) and the user-facing message,
      // matching the pattern at line ~5010.
      try {
        validateLoc(input.loc);
      } catch (e) {
        if (e instanceof InvalidLocError) {
          throw new GraphQLError(e.message, {
            extensions: { code: e.name, loc: e.loc, segment: e.segment },
          });
        }
        throw e;
      }

      // Spec 031 — abstract validation + normalization. Length-cap check
      // on the raw input first; then trim-then-check normalization (empty
      // + whitespace-only collapse to null; non-empty trimmed values
      // persist untrimmed so intentional surrounding whitespace on real
      // paragraphs is lossless). Applied at the resolver layer so this
      // surface matches the MCP h-add-node / h-update-node semantics.
      // `undefined` (key absent) means "preserve existing" and bypasses
      // both checks.
      //
      // The normalized value is reassigned back onto `input.abstract`
      // BELOW (after validation), but we compute it in a local first so
      // the resolver doesn't observe a mutated args object before its
      // validation has settled (defense against future GraphQL runners
      // that freeze args).
      if (input.abstract !== undefined && input.abstract !== null) {
        if (input.abstract.length > 2000) {
          const err = new NodeAbstractTooLongError(input.abstract.length);
          throw new GraphQLError(err.message, {
            extensions: { code: err.name, length: err.length, max: err.max },
          });
        }
        const normalized: string | null =
          input.abstract.trim() === '' ? null : input.abstract;
        input = { ...input, abstract: normalized };
      }

      // Reject saves whose extraction-spec arrays would write into the
      // reserved exception namespace (spec 001-edge-condition-spec FR-013).
      throwOnReservedExtractionSpec(input.data);

      // Snapshot current state before update (for version history)
      const existing = await ctx.db.node.findUnique({
        where: { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
      });

      // Spec 011 follow-up: callers that want pure CREATE semantics pass
      // `createOnly: true`. Reject the mutation if a **live** node already
      // lives at (loc, memoryId), so the portal's create form (and any
      // other create-only caller) surfaces a NodeLocConflictError instead
      // of silently overwriting the existing node. Soft-deleted nodes at
      // the target loc are treated as not-existing for collision purposes
      // — the create resurrects them (the upsert UPDATE branch below
      // clears `deletedAt`/`deletedBy` when this resurrection path runs).
      const isResurrect = !!(input.createOnly && existing?.deletedAt);
      if (input.createOnly && existing && !existing.deletedAt) {
        const err = new NodeLocConflictError(input.loc, input.memoryId);
        throw new GraphQLError(err.message, {
          extensions: { code: err.name, loc: err.loc, memoryId: err.memoryId },
        });
      }

      // Resolve edge targets BEFORE any write so an unresolvable
      // target aborts the mutation without committing the source
      // node, the version snapshot, or any edge changes. Per spec 007
      // (issue #105), `targetId` accepts ID, full URN, memory-prefixed
      // loc, or short loc — `resolveNodeRef` is the single resolver
      // and throws `NodeNotFoundError` on miss.
      let resolvedEdges: Array<{ targetNodeId: string; label: string | null }> | null = null;
      if (input.edges !== undefined) {
        resolvedEdges = [];
        for (const e of input.edges) {
          try {
            const { id: targetNodeId } = await resolveNodeRef(ctx.db, e.targetId, input.memoryId);
            resolvedEdges.push({ targetNodeId, label: e.label ?? null });
          } catch (err) {
            if (err instanceof NodeNotFoundError) {
              throw new GraphQLError(`Edge target not found: "${err.ref}"`, {
                extensions: { code: err.name, ref: err.ref },
              });
            }
            throw err;
          }
        }
      }

      if (existing) {
        await ctx.db.nodeVersion.create({
          data: {
            nodeId: existing.id,
            loc: existing.loc,
            name: existing.name,
            alias: existing.alias,
            description: existing.description,
            abstract: existing.abstract,
            // Spec 032 — snapshot captures the hash so restoreNodeVersion
            // round-trips it.
            abstractOriginHash: existing.abstractOriginHash,
            content: existing.content,
            tags: existing.tags as string[],
            editedBy: ctx.clientId ?? ctx.userId ?? null,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
        });
      }

      const tags = serializeTags(input.tags ?? []) as string[];
      const id = input.id ?? generateId();
      // Strip GraphQL-only flags from the Prisma payload — `createOnly`
      // is a control input, not a column.
      // `edges` is consumed above (resolved into `resolvedEdges`) and
      // applied below; strip it from the Prisma payload along with
      // the GraphQL-only `createOnly` control flag.
      const { edges: _edges, createOnly: _createOnly, ...nodeFields } = input;
      const createdBy = ctx.userId ?? ctx.clientId ?? null;

      // If the target memory is encrypted, encrypt content and data before
      // writing. Throws SESSION_EXPIRED if no session key is cached.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, input.memoryId);

      // Spec 032 — compute abstractOriginHash. MUST happen on PLAINTEXT
      // content (FR-009), so this runs BEFORE the encryption block below
      // that mutates nodeFields.content to ciphertext.
      //
      // Matrix per contracts/h-update-node.md:
      //   - input.abstract === undefined  → preserve hash (omit from payload)
      //   - input.abstract === null       → clear hash
      //   - input.abstract is string      → hash from current content
      //     (current = input.content if supplied else existing.content
      //     decrypted to plaintext — FR-003 reset case)
      //
      // Gating the decrypt on `input.abstract is string` (Gemini review,
      // PR-209): avoids a per-upsert decryptString call on encrypted
      // memories when the caller didn't touch `abstract`, which is the
      // common case for unrelated field updates.
      let nextAbstractOriginHash: string | null | undefined;
      if (input.abstract === undefined) {
        nextAbstractOriginHash = undefined; // preserve
      } else if (input.abstract === null) {
        nextAbstractOriginHash = null;
      } else {
        let postUpdatePlaintextContent: string | null;
        if (input.content !== undefined) {
          postUpdatePlaintextContent = input.content;
        } else if (existing) {
          // Decrypt existing.content for hash computation on encrypted
          // memories. decryptNodeFields mutates `existing` in place;
          // existing.content is PLAINTEXT after this line — do NOT use
          // it as DB ground truth past this point. Safe today because
          // the upsert writes from `nodeFields` (caller input), not
          // from `existing`.
          if (memEncInfo.isEncrypted) {
            decryptNodeFields(existing, memEncInfo);
          }
          postUpdatePlaintextContent = existing.content;
        } else {
          postUpdatePlaintextContent = null;
        }
        nextAbstractOriginHash = computeContentHash(postUpdatePlaintextContent);
      }

      if (memEncInfo.isEncrypted) {
        const key = sessionKeyCache.getByMemoryId(memEncInfo.id);
        if (!key) {
          throw new Error('SESSION_EXPIRED: memory is encrypted but no active session key is available');
        }
        // Spec 031 — `abstract` joins the encrypted-fields set; rationale
        // in nodeCrypto.ts EncryptedNodeFields doc-comment.
        const enc = encryptNodeFieldsWithKey(
          {
            abstract: (nodeFields as { abstract?: string | null }).abstract ?? null,
            content: nodeFields.content ?? null,
            data: nodeFields.data ?? null,
          },
          key,
        );
        (nodeFields as Record<string, unknown>).abstract = enc.abstract ?? undefined;
        (nodeFields as Record<string, unknown>).content = enc.content ?? undefined;
        (nodeFields as Record<string, unknown>).data = enc.data ?? undefined;
      }

      // When createOnly resurrects a soft-deleted node, the UPDATE branch
      // must clear `deletedAt`/`deletedBy` — otherwise the resurrected
      // node ends up with the new content but still flagged as deleted,
      // which is the worst of both worlds.
      const updateExtras: Record<string, unknown> = isResurrect
        ? { deletedAt: null, deletedBy: null }
        : {};
      // Spec 032 — inject abstractOriginHash into the payload. For
      // partial updates we use Prisma's "omit undefined → leave column
      // untouched" semantic for the preserve case. Stripping any
      // caller-supplied abstractOriginHash from nodeFields is
      // belt-and-suspenders (NodeInput doesn't expose the field, so
      // this is defense-in-depth for any future code path).
      const hashPayload =
        nextAbstractOriginHash === undefined
          ? {}
          : { abstractOriginHash: nextAbstractOriginHash };
      const {
        abstractOriginHash: _stripCallerSupplied,
        ...nodeFieldsClean
      } = nodeFields as Record<string, unknown>;
      const node = await ctx.db.node.upsert({
        where: { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
        create: {
          ...nodeFieldsClean,
          id,
          tags,
          createdBy,
          ...hashPayload,
        } as Prisma.NodeUncheckedCreateInput,
        update: {
          ...nodeFieldsClean,
          tags,
          ...updateExtras,
          ...hashPayload,
        } as Prisma.NodeUncheckedUpdateInput,
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });

      // For the return value, decrypt the result back so callers see plaintext.
      if (memEncInfo.isEncrypted) {
        decryptNodeFields(node, memEncInfo);
      }

      let finalNode = node;
      if (resolvedEdges !== null) {
        // Replace the source's outgoing edges with the resolved set.
        // After deleteMany clears every existing edge for `sourceId`
        // there can be no `(sourceId, targetId, label)` collision, so
        // a single createMany with skipDuplicates: true (a defense
        // against a duplicate inside the input array itself) is one
        // round-trip in place of N upserts.
        await ctx.db.edge.deleteMany({ where: { sourceId: node.id } });
        await ctx.db.pendingEdge.deleteMany({ where: { sourceId: node.id } });
        if (resolvedEdges.length > 0) {
          await ctx.db.edge.createMany({
            data: resolvedEdges.map((e) => ({
              sourceId: node.id,
              targetId: e.targetNodeId,
              label: e.label ?? '',
              createdBy,
            })),
            skipDuplicates: true,
          });
        }
        finalNode = (await ctx.db.node.findUnique({
          where: { id: node.id },
          include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
        }))!;
        if (memEncInfo.isEncrypted) {
          decryptNodeFields(finalNode, memEncInfo);
        }
      }

      writeNodeToGit({
        id: finalNode.id,
        loc: finalNode.loc,
        name: finalNode.name,
        alias: finalNode.alias,
        description: finalNode.description,
        abstract: finalNode.abstract,
        abstractOriginHash: finalNode.abstractOriginHash,
        content: finalNode.content,
        tags: deserializeTags(finalNode.tags) as string[],
        outgoingEdges: finalNode.outgoingEdges ?? [],
      }, input.ownerRepo ?? '', ctx.clientId, input.memoryId).catch((err) => {
        console.error('[upsertNode] git write error:', err);
      });

      // 033 — (re-)embed on write. finalNode is decrypted (plaintext) here, so
      // the prompt-drain embeds correctly even on encrypted memories (FR-027).
      void enqueueNodeEmbedding(ctx.db, {
        nodeId: finalNode.id,
        memoryId: input.memoryId,
        plaintext: { content: finalNode.content, abstract: finalNode.abstract },
      });

      return finalNode;
    },

    deleteNode: async (_: unknown, { loc: rawLoc, memoryId }: { loc: string; memoryId: string }, ctx: Context) => {
      const loc = parseUrnInput(rawLoc).value;
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      await requireMemoryWriteAccess(ctx, resolvedMemoryId);
      await ctx.db.node.delete({ where: { loc_memoryId: { loc, memoryId: resolvedMemoryId } } });
      return true;
    },

    // ── Edge CRUD ──────────────────────────────────────────────────────

    createEdge: async (
      _: unknown,
      { sourceNodeId, targetNodeId, label, condition, priority, data }: {
        sourceNodeId: string;
        targetNodeId: string;
        label: string;
        condition?: unknown;
        priority?: number;
        data?: Record<string, unknown>;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'CONTRIBUTOR');
      if (condition !== undefined && condition !== null) {
        throwOnInvalidCondition(condition);
      }
      return ctx.db.edge.create({
        data: {
          id: generateId(),
          sourceId: sourceNodeId,
          targetId: targetNodeId,
          label,
          condition: (condition ?? null) as InputJsonValue,
          ...(priority !== undefined ? { priority } : {}),
          data: (data ?? null) as InputJsonValue,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: { source: true, target: true },
      });
    },

    updateEdge: async (
      _: unknown,
      { edgeId, label, condition, priority, data }: {
        edgeId: string;
        label?: string;
        condition?: unknown;
        priority?: number;
        data?: Record<string, unknown>;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'CONTRIBUTOR');
      if (condition !== undefined && condition !== null) {
        throwOnInvalidCondition(condition);
      }
      return ctx.db.edge.update({
        where: { id: edgeId },
        data: {
          ...(label !== undefined ? { label } : {}),
          ...(condition !== undefined ? { condition: (condition ?? null) as InputJsonValue } : {}),
          ...(priority !== undefined ? { priority } : {}),
          ...(data !== undefined ? { data: data as InputJsonValue } : {}),
          updatedBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: { source: true, target: true },
      });
    },

    deleteEdge: async (
      _: unknown,
      { edgeId }: { edgeId: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'CONTRIBUTOR');
      await ctx.db.edge.delete({ where: { id: edgeId } });
      return true;
    },

    // ── Asset upload (spec 004-asset-upload) ───────────────────────────

    beginAssetUpload: async (
      _: unknown,
      { input }: { input: AssetUploadInput },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const ticket = await beginAssetUpload(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        input,
        resolveAssetTargetMemoryId,
      );
      return {
        uploadId: ticket.uploadId,
        putUrl: ticket.putUrl,
        putHeaders: ticket.putHeaders,
        expiresAt: ticket.expiresAt.toISOString(),
        storageKey: ticket.storageKey,
        maxSizeBytes: ticket.maxSizeBytes,
        allowedMimeType: ticket.allowedMimeType,
      };
    },

    // v2 (spec 006): memory-addressed begin.
    beginAssetUploadV2: async (
      _: unknown,
      { input }: { input: BeginAssetUploadV2Input },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const ticket = await beginAssetUploadV2(
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
        uploadId: ticket.uploadId,
        putUrl: ticket.putUrl,
        putHeaders: ticket.putHeaders,
        expiresAt: ticket.expiresAt.toISOString(),
        storageKey: ticket.storageKey,
        maxSizeBytes: ticket.maxSizeBytes,
        allowedMimeType: ticket.allowedMimeType,
      };
    },

    completeAssetUpload: async (
      _: unknown,
      { input }: { input: { uploadId: string } },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return completeAssetUpload(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        input,
      );
    },

    setAgentAssetUploadEnabled: async (
      _: unknown,
      { input }: { input: { agentUrn: string; enabled: boolean } },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return setAgentAssetUploadEnabled(
        ctx.db,
        { userId: ctx.userId },
        input,
        isOrgAdminFor,
      );
    },

    softDeleteAsset: async (
      _: unknown,
      { assetId }: { assetId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return softDeleteAsset(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        { assetId },
        isOrgAdminFor,
      );
    },

    restoreAsset: async (
      _: unknown,
      { assetId }: { assetId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return restoreAsset(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        { assetId },
        isOrgAdminFor,
      );
    },

    moveNode: async (_: unknown, { from: rawFrom, to: rawTo, memoryId, targetMemoryId }: { from: string; to: string; memoryId: string; targetMemoryId?: string }, ctx: Context) => {
      const from = parseUrnInput(rawFrom).value;
      const to = parseUrnInput(rawTo).value;
      // 007-entity-id-or-urn: memoryId and targetMemoryId may be IDs,
      // bare URNs, or prefixed URNs.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const resolvedTargetMemoryId = targetMemoryId
        ? (await resolveMemoryRef(ctx.db, targetMemoryId)).id
        : undefined;
      await requireMemoryWriteAccess(ctx, resolvedMemoryId);
      if (resolvedTargetMemoryId && resolvedTargetMemoryId !== resolvedMemoryId) {
        await requireMemoryWriteAccess(ctx, resolvedTargetMemoryId);
      }
      const destMemoryId = resolvedTargetMemoryId ?? resolvedMemoryId;
      try {
        return await ctx.db.node.update({
          where: { loc_memoryId: { loc: from, memoryId: resolvedMemoryId } },
          data: { loc: to, memoryId: destMemoryId },
          include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
        });
      } catch (e) {
        // Prisma P2025 = "Record to update not found." Wrap so the resolver
        // surfaces a typed NODE_NOT_FOUND error instead of leaking the raw
        // ORM message as INTERNAL_SERVER_ERROR (issue #100).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
          throw new GraphQLError(`Node "${from}" not found in this memory`, {
            extensions: { code: 'NODE_NOT_FOUND', loc: from, memoryId: resolvedMemoryId },
          });
        }
        throw e;
      }
    },

    replaceSubtree: async (
      _: unknown,
      {
        ownerRepo,
        memoryId,
        nodes,
        edges,
      }: { ownerRepo: string; memoryId: string; nodes: NodeInput[]; edges: EdgeInput[] },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      await requireMemoryWriteAccess(ctx, resolvedMemoryId);

      await ctx.db.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.node.deleteMany({ where: { ownerRepo, memoryId: resolvedMemoryId } });

        for (const input of nodes) {
          await tx.node.create({
            data: {
              id: input.id ?? generateId(),
              ...input,
              tags: serializeTags(input.tags ?? []) as string[],
            } as Prisma.NodeUncheckedCreateInput,
          });
        }

        for (const edge of edges) {
          const source = await tx.node.findUnique({ where: { loc_memoryId: { loc: edge.sourceLoc, memoryId: resolvedMemoryId } } });
          const target = await tx.node.findFirst({ where: { loc: edge.targetLoc } });
          if (source && target) {
            await tx.edge.upsert({
              where: { sourceId_targetId_label: { sourceId: source.id, targetId: target.id, label: edge.label } },
              create: { sourceId: source.id, targetId: target.id, label: edge.label },
              update: {},
            });
          }
        }
      });

      return nodes.length;
    },

    startSession: async (_: unknown, { input }: { input: SessionInput }, ctx: Context) => {
      return ctx.db.session.create({
        data: {
          id: input.id,
          type: (input.type as any) ?? 'DEVELOPER',
          appId: ctx.appId,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
          repo: input.repo,
          branch: input.branch,
          prNumber: input.prNumber,
          customerId: input.customerId,
          language: input.language,
          llmModel: input.llmModel,
          parentSessionId: input.parentSessionId,
          prevSessionId: input.prevSessionId,
        },
        include: SESSION_INCLUDE,
      });
    },

    endSession: async (
      _: unknown,
      {
        id,
        summary,
        inputTokens,
        outputTokens,
        turnCount,
        errorCount,
      }: { id: string; summary?: string; inputTokens?: number; outputTokens?: number; turnCount?: number; errorCount?: number },
      ctx: Context,
    ) => {
      return ctx.db.session.update({
        where: { id },
        data: { endedAt: new Date(), summary, inputTokens, outputTokens, turnCount, errorCount },
        include: SESSION_INCLUDE,
      });
    },

    recordUsage: async (_: unknown, { event }: { event: UsageEventInput }, ctx: Context) => {
      const node = event.nodeLoc
        ? await ctx.db.node.findFirst({ where: { loc: event.nodeLoc, isLink: false } })
          ?? await ctx.db.node.findFirst({ where: { loc: event.nodeLoc } })
        : null;

      await ctx.db.usageEvent.create({
        data: {
          type: event.type,
          nodeLoc: event.nodeLoc,
          nodeId: node?.id,
          actionArgs: serializeJson(event.actionArgs) as InputJsonValue | undefined,
          appId: ctx.appId,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
          sessionId: event.sessionId,
          model: event.model,
          tokensIn: event.tokensIn,
          tokensOut: event.tokensOut,
        },
      });
      return true;
    },

    regenerateAppKey: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveAppRef(ctx.db, id);
      const existing = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) await requireOrgRole(ctx, existing.organizationId, 'ADMIN');

      // Revoke all active keys, then create a fresh one.
      await ctx.db.appKey.updateMany({
        where: { appId: resolvedId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const rawKey = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
      const keyHash = createHash('sha256').update(rawKey).digest('hex');
      await ctx.db.appKey.create({
        data: {
          id: generateId(),
          appId: resolvedId,
          keyHash,
          keyPreview: rawKey.slice(-4),
          label: 'Regenerated key',
          createdBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null,
        },
      });
      const fresh = await ctx.db.app.findUniqueOrThrow({
        where: { id: resolvedId },
        include: APP_INCLUDE,
      });
      return { app: fresh, rawKey };
    },

    updateMyProfile: async (
      _: unknown,
      { name, handle, email }: { name?: string; handle?: string; email?: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return ctx.db.user.update({
        where: { id: ctx.userId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(handle !== undefined ? { handle } : {}),
          ...(email !== undefined ? { email } : {}),
        },
      });
    },

    updateUserRoles: async (
      _: unknown,
      { userId, roles }: { userId: string; roles: Role[] },
      ctx: Context,
    ) => {
      requireRole(ctx, 'ADMIN');
      return ctx.db.user.update({ where: { id: userId }, data: { roles } });
    },

    // ── Organization management ─────────────────────────────────────────

    createOrganization: async (
      _: unknown,
      { name, urn }: { name: string; urn: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');
      const org = await ctx.db.organization.create({
        data: { name, urn, isVisible: true, createdBy: ctx.userId ?? ctx.clientId ?? null },
        include: ORG_INCLUDE,
      });
      if (ctx.userId) {
        await ctx.db.orgMember.create({
          data: { organizationId: org.id, userId: ctx.userId, role: 'OWNER', canInvite: true, createdBy: ctx.userId },
        });
      }
      return ctx.db.organization.findUniqueOrThrow({ where: { id: org.id }, include: ORG_INCLUDE });
    },

    updateOrganization: async (
      _: unknown,
      { id, name, urn, isVisible }: { id: string; name?: string; urn?: string; isVisible?: boolean },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveOrgRef(ctx.db, id);
      await requireOrgRole(ctx, resolvedId, 'ADMIN');
      return ctx.db.organization.update({
        where: { id: resolvedId },
        data: {
          ...(name ? { name } : {}),
          ...(urn ? { urn } : {}),
          ...(isVisible !== undefined ? { isVisible } : {}),
        },
        include: ORG_INCLUDE,
      });
    },

    deleteOrganization: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      requireRole(ctx, 'ADMIN');
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveOrgRef(ctx.db, id);
      await ctx.db.organization.update({ where: { id: resolvedId }, data: { deletedAt: new Date() } });
      return true;
    },

    linkGithubApp: async (
      _: unknown,
      { orgId, installationId }: { orgId: string; installationId: number },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      return ctx.db.organization.update({
        where: { id: resolvedOrgId },
        data: { githubInstallationId: installationId },
        include: ORG_INCLUDE,
      });
    },

    updateOrgGithubApp: async (
      _: unknown,
      { orgId, appId, privateKey }: { orgId: string; appId: string; privateKey: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const encrypted = encryptToken(privateKey);
      return ctx.db.organization.update({
        where: { id: resolvedOrgId },
        data: { githubAppId: appId, githubAppPrivateKeyEncrypted: encrypted },
        include: ORG_INCLUDE,
      });
    },

    unlinkGithubApp: async (
      _: unknown,
      { orgId }: { orgId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      return ctx.db.organization.update({
        where: { id: resolvedOrgId },
        data: {
          githubInstallationId: null,
          githubAppId: null,
          githubAppPrivateKeyEncrypted: null,
        },
        include: ORG_INCLUDE,
      });
    },

    // ── User invitations ────────────────────────────────────────────────

    createUserInvitation: async (
      _: unknown,
      {
        orgId,
        memberRole,
        name,
        email,
        githubUsername,
        maxActivations,
        expiresInDays,
      }: {
        orgId: string; memberRole: string;
        name?: string; email?: string; githubUsername?: string;
        maxActivations?: number; expiresInDays?: number;
      },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const slug = generateId().slice(0, 16);
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : null;
      const invite = await ctx.db.userInvitation.create({
        data: {
          id: generateId(),
          slug,
          senderUserId: ctx.userId ?? null,
          organizationId: resolvedOrgId,
          memberRole: (memberRole as Role) ?? 'READER',
          name: name ?? null,
          email: email ?? null,
          githubUsername: githubUsername ?? null,
          maxActivations: maxActivations ?? 1,
          expiresAt,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: { sender: true, organization: true, activations: true },
      });
      return { ...invite, activationCount: invite.activations.length };
    },

    inviteUser: async (
      _: unknown,
      { name, email, githubUsername, maxActivations, expiresInDays }: {
        name?: string; email?: string; githubUsername?: string;
        maxActivations?: number; expiresInDays?: number;
      },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const slug = generateId().slice(0, 16);
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : null;
      const invite = await ctx.db.userInvitation.create({
        data: {
          id: generateId(),
          slug,
          senderUserId: ctx.userId,
          organizationId: null,
          memberRole: 'READER',
          name: name ?? null,
          email: email ?? null,
          githubUsername: githubUsername ?? null,
          maxActivations: maxActivations ?? 1,
          expiresAt,
          createdBy: ctx.userId,
        },
        include: { sender: true, organization: true, activations: true },
      });
      return { ...invite, activationCount: invite.activations.length };
    },

    acceptInvitation: async (
      _: unknown,
      { slug }: { slug: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('You must be signed in to accept an invitation');

      const invite = await ctx.db.userInvitation.findUnique({
        where: { slug },
        include: { activations: true },
      });
      if (!invite || invite.deletedAt) throw new Error('Invitation not found');
      if (invite.expiresAt && invite.expiresAt < new Date()) throw new Error('Invitation has expired');
      if (invite.maxActivations && invite.activations.length >= invite.maxActivations) {
        throw new Error('Invitation has reached its maximum number of uses');
      }

      // Check if user already activated this invite
      if (invite.activations.some((a: any) => a.userId === ctx.userId)) {
        throw new Error('You have already accepted this invitation');
      }

      // Create activation record
      await ctx.db.userInvitationActivation.create({
        data: {
          id: generateId(),
          invitationId: invite.id,
          userId: ctx.userId!,
          createdBy: ctx.userId ?? null,
        },
      });

      // Add user to org if not already a member
      if (invite.organizationId) {
        const existing = await ctx.db.orgMember.findUnique({
          where: {
            organizationId_userId: {
              organizationId: invite.organizationId,
              userId: ctx.userId!,
            },
          },
        });
        if (!existing) {
          await ctx.db.orgMember.create({
            data: {
              id: generateId(),
              organizationId: invite.organizationId,
              userId: ctx.userId!,
              role: invite.memberRole as Role,
              createdBy: ctx.userId ?? null,
            },
          });
        }
      }

      return true;
    },

    // ── Organization membership ─────────────────────────────────────────

    addOrgMember: async (
      _: unknown,
      { orgId, userId, role }: { orgId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      // (userId is keyed by raw ID — User has no urn column.)
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      return ctx.db.orgMember.create({
        data: { id: generateId(), organizationId: resolvedOrgId, userId, role: role as Role, createdBy: ctx.userId ?? ctx.clientId ?? null },
        include: { user: true },
      });
    },

    updateOrgMember: async (
      _: unknown,
      { orgId, userId, role }: { orgId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      return ctx.db.orgMember.update({
        where: { organizationId_userId: { organizationId: resolvedOrgId, userId } },
        data: { role: role as Role },
        include: { user: true },
      });
    },

    removeOrgMember: async (
      _: unknown,
      { orgId, userId }: { orgId: string; userId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      // Cannot remove the last OWNER
      const owners = await ctx.db.orgMember.findMany({
        where: { organizationId: resolvedOrgId, role: 'OWNER', deletedAt: null },
      });
      const member = await ctx.db.orgMember.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: resolvedOrgId, userId } },
      });
      if (member.role === 'OWNER' && owners.length <= 1) {
        throw new Error('Cannot remove the last owner of an organization');
      }
      await ctx.db.orgMember.delete({
        where: { organizationId_userId: { organizationId: resolvedOrgId, userId } },
      });
      return true;
    },

    // ── Memory management ────────────────────────────────────────────────

    createMemory: async (
      _: unknown,
      {
        orgId,
        name,
        shortDescription,
        description,
        tags,
        license,
        category0,
        category1,
        category2,
        iconUrl,
        heroUrl,
        homeUrl,
        source,
        readBranch,
        writeBranch,
        visibility,
        memoryClass,
      }: {
        orgId: string; name: string;
        shortDescription?: string; description?: string; tags?: string[];
        license?: string; category0?: string; category1?: string; category2?: string;
        iconUrl?: string; heroUrl?: string; homeUrl?: string;
        source?: string | null; readBranch?: string; writeBranch?: string; visibility?: string;
        // GraphQL passes the full MemoryClass enum; the resolver
        // allowlists the user-creatable values below. Spec 034 added
        // `personal`/`private` as owner-only, user-creatable classes
        // (free-standing or app-scoped); `system`/`app` still
        // auto-provision via other paths and are rejected here.
        memoryClass?: 'knowledge' | 'group' | 'system' | 'app' | 'personal' | 'private';
      },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);

      // 023-app-shape US4 + 034-memory-class-access: user-creatable classes are
      // `knowledge` (default), `group`, and the owner-owned `personal`/`private`
      // (free-standing — no app/agent). `system`/`app` still auto-provision via
      // other paths and are rejected here.
      const requestedClass = memoryClass ?? 'knowledge';
      const isUserOwned = requestedClass === 'personal' || requestedClass === 'private';
      if (requestedClass !== 'knowledge' && requestedClass !== 'group' && !isUserOwned) {
        throw new GraphQLError(
          `createMemory does not accept class='${requestedClass}'. Only ` +
            `'knowledge', 'group', 'personal', and 'private' are user-creatable; ` +
            `'${requestedClass}' auto-provisions via a different code path.`,
          { extensions: { code: 'UNSUPPORTED_MEMORY_CLASS' } },
        );
      }

      // Authorization (034-memory-class-access): org-shared classes
      // (knowledge/group) require org ADMIN; owner-owned classes
      // (personal/private) require only that the creator is an authenticated
      // member of the org *container* — the memory is theirs, not the org's,
      // and access is owner-only by class.
      if (isUserOwned) {
        if (!ctx.userId) {
          throw new GraphQLError(
            'Creating a personal/private memory requires an authenticated user (the creator is the owner).',
            { extensions: { code: 'UNAUTHENTICATED' } },
          );
        }
        // Require ACTUAL membership of the org container — NOT requireOrgRole,
        // whose global ADMIN/OWNER bypass would let a platform admin create a
        // personal/private memory in an org they don't belong to.
        const orgMembership = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: resolvedOrgId, userId: ctx.userId } },
        });
        if (!orgMembership || orgMembership.deletedAt) {
          throw new GraphQLError(
            'You must be a member of the organization to create a personal/private memory in it.',
            { extensions: { code: 'FORBIDDEN' } },
          );
        }
      } else {
        await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      }
      // 023-app-shape US4: group-class memories must carry GROUP
      // visibility (enforced by the chk_memory_group_visibility CHECK
      // constraint at the DB level; we surface a clearer error at the
      // API layer instead of letting the constraint fire). The
      // creator becomes the first owner via the bootstrap path below.
      if (requestedClass === 'group') {
        if (visibility !== undefined && visibility !== 'GROUP') {
          throw new GraphQLError(
            'Group-class memory must have visibility=GROUP (spec 023 FR-024).',
            { extensions: { code: 'INVALID_GROUP_MEMORY_VISIBILITY' } },
          );
        }
        if (!ctx.userId) {
          throw new GraphQLError(
            'Creating a group-class memory requires an authenticated user (the creator becomes the first owner).',
            { extensions: { code: 'UNAUTHENTICATED' } },
          );
        }
      } else if (visibility === 'GROUP') {
        // Symmetric guard: non-group class can't claim GROUP visibility.
        throw new GraphQLError(
          'visibility=GROUP requires class=group (spec 023 FR-024).',
          { extensions: { code: 'INVALID_GROUP_MEMORY_VISIBILITY' } },
        );
      }

      const memOrg = await ctx.db.organization.findUniqueOrThrow({ where: { id: resolvedOrgId }, select: { urn: true } });
      const memoryUrn = `${memOrg.urn}:${name}`;
      // Check for existing memory with the same URN
      const existing = await ctx.db.memory.findUnique({ where: { urn: memoryUrn } });
      if (existing) {
        if (existing.deletedAt) {
          await ctx.db.memory.delete({ where: { id: existing.id } });
        } else {
          throw new Error(`A memory with URN "${memoryUrn}" already exists`);
        }
      }

      // For group-class memory: bootstrap the creator as the first
      // owner in the same transaction as the Memory create, so the
      // Memory is never persisted in a zero-owner state (which would
      // be effectively unreachable to anyone, including the creator).
      const memory = await ctx.db.$transaction(async (tx) => {
        const created = await tx.memory.create({
          data: {
            id: generateId(),
            organizationId: resolvedOrgId,
            urn: memoryUrn,
            name,
            shortDescription,
            description,
            tags: tags ?? [],
            license,
            category0,
            category1,
            category2,
            iconUrl,
            heroUrl,
            homeUrl,
            source,
            readBranch,
            writeBranch,
            // 035-visibility-enum-cleanup: group → GROUP; personal/private →
            // NULL (privacy is class-driven, not visibility); knowledge default
            // → ORGANIZATION (was PRIVATE). chk_memory_visibility_class forbids
            // a non-null visibility on personal/private.
            visibility:
              requestedClass === 'group'
                ? 'GROUP'
                : requestedClass === 'personal' || requestedClass === 'private'
                  ? null
                  : ((visibility as MemoryVisibility) ?? 'ORGANIZATION'),
            // 005-agent-subscription: explicit user-driven createMemory
            // creates a knowledge-class memory by default. Personal-class
            // memories are auto-provisioned via the AgentSubscription
            // path; system-class via Agent.systemMemoryId.
            // 023-app-shape US4: a `memoryClass: 'group'` argument lets
            // callers create group-class memories explicitly.
            class: requestedClass,
            // 033 — class-derived default for the vector index (FR-001):
            // a `knowledge`-class memory (non-encrypted, as created here) is
            // searchable by default; `group` and others default off. Flippable
            // later via updateMemory.
            vectorIndexEnabled: requestedClass === 'knowledge',
            // Owner-owned personal/private set the creator as the owner
            // (free-standing: app_id / userMemoryOfAgentId stay NULL). All other
            // classes MUST have userId NULL (chk_personal_visibility_user /
            // chk_memory_group_no_owner) — set it explicitly rather than relying
            // on Prisma omitting the field.
            userId: isUserOwned ? ctx.userId : null,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
          include: MEMORY_INCLUDE,
        });
        if (requestedClass === 'group' && ctx.userId) {
          await tx.memoryMember.create({
            data: {
              memoryId: created.id,
              userId: ctx.userId,
              role: 'owner',
              createdBy: ctx.userId,
            },
          });
        }
        return created;
      });

      // Create the root node for this memory
      const rootName = name.split(':').pop() ?? name;
      await createNode({
        memoryId: memory.id,
        loc: name,
        name: rootName,
      });

      return memory;
    },

    updateMemory: async (
      _: unknown,
      {
        id,
        name,
        urn,
        organizationId: newOrgId,
        shortDescription,
        description,
        tags,
        license,
        category0,
        category1,
        category2,
        iconUrl,
        heroUrl,
        homeUrl,
        source,
        readBranch,
        writeBranch,
        visibility,
        vectorIndexEnabled,
        embeddingSource,
        acknowledgeVectorInversionRisk,
        chunkTokens,
        chunkOverlap,
        forceFixedSize,
      }: {
        id: string; name?: string; urn?: string; organizationId?: string;
        shortDescription?: string; description?: string; tags?: string[];
        license?: string; category0?: string; category1?: string; category2?: string;
        iconUrl?: string; heroUrl?: string; homeUrl?: string;
        source?: string; readBranch?: string; writeBranch?: string; visibility?: string;
        vectorIndexEnabled?: boolean;
        embeddingSource?: 'abstract' | 'contentChunks' | 'both';
        acknowledgeVectorInversionRisk?: boolean;
        chunkTokens?: number | null;
        chunkOverlap?: number | null;
        forceFixedSize?: boolean;
      },
      ctx: Context,
    ) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      // If transferring to a new org, require ADMIN on the target org too
      if (newOrgId && newOrgId !== memory.organizationId) {
        await requireOrgRole(ctx, newOrgId, 'ADMIN');
      }
      // Rebuild URN if slug or org changed
      const effectiveOrgId = newOrgId ?? memory.organizationId;
      let newUrn: string | undefined;
      if (urn !== undefined || (newOrgId && newOrgId !== memory.organizationId)) {
        const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: effectiveOrgId }, select: { urn: true } });
        const slug = urn ?? memory.urn.split(':').slice(1).join(':');
        newUrn = `${org.urn}:${slug}`;
      }

      // 033 US5 FR-026 — enabling the vector index on an encrypted memory
      // requires explicit acknowledgment of the embedding-inversion
      // disclosure (stored vectors are plaintext + partially invertible —
      // see FR_026_DISCLOSURE in src/lib/entityRef/errors.ts for the full
      // four-point text). The friendly typed error fires at the API
      // boundary; the chk_memory_vector_encrypted_ack CHECK is the DB-level
      // backstop.
      //
      // Gate fires only when this call would enable the index AND the row
      // is encrypted AND no prior ack timestamp is recorded.
      //
      // ── First-ack-is-permanent (intentional; PR-222 review item 3) ──
      // `vectorIndexEncryptedAckAt` survives a revoke + re-enable cycle.
      // Once a user has acked, future toggles never re-prompt. The audit-
      // relevant moment is the FIRST opt-in. If the disclosure copy ever
      // changes materially, audit semantics would need an explicit
      // re-consent flow (e.g., bump a disclosure-version column and clear
      // ackAt when the version bumps) — but that's deliberately deferred
      // until/unless the copy actually changes. DO NOT "fix" this by
      // clearing ackAt on revoke without product sign-off; the current
      // semantic is the explicit choice.
      let nextAckAt: Date | undefined;
      const willBeEnabled = vectorIndexEnabled === true ||
        (vectorIndexEnabled === undefined && memory.vectorIndexEnabled);
      const enablingNow = willBeEnabled && !memory.vectorIndexEnabled;
      if (memory.isEncrypted && enablingNow && memory.vectorIndexEncryptedAckAt == null) {
        if (acknowledgeVectorInversionRisk !== true) {
          throw new EncryptedVectorIndexNotAcknowledgedError(memory.urn);
        }
        nextAckAt = new Date();
      }

      // 033 US2 T043 — chunk dial validation (FR-003). Same invariants
      // the chk_memory_chunk_tokens_positive / chk_memory_chunk_overlap_valid
      // CHECK constraints enforce at the DB level; this is the friendly
      // typed error at the API boundary. Compute effective post-update
      // values so partial updates (just chunkTokens, just chunkOverlap)
      // still validate against the row's settled state.
      //
      // PR-225 review (Gemini med + Copilot): when either dial is null in
      // the post-update state, the runtime treats null as "platform
      // default" (512 tokens / 64 overlap; see src/lib/chunking.ts).
      // Validation MUST resolve to those defaults too, otherwise an
      // input like `chunkOverlap: 600` with `chunkTokens: null` would
      // slip past the API and crash at the DB CHECK with a 500.
      const DEFAULT_TOKENS_FOR_VALIDATION = 512;
      const DEFAULT_OVERLAP_FOR_VALIDATION = 64;
      const effectiveTokens = chunkTokens !== undefined ? chunkTokens : memory.chunkTokens;
      const effectiveOverlap = chunkOverlap !== undefined ? chunkOverlap : memory.chunkOverlap;
      if (effectiveTokens !== null && effectiveTokens !== undefined && effectiveTokens <= 0) {
        throw new InvalidChunkConfigError(`chunkTokens must be > 0 (got ${effectiveTokens}).`);
      }
      const resolvedTokens = effectiveTokens ?? DEFAULT_TOKENS_FOR_VALIDATION;
      const resolvedOverlap = effectiveOverlap ?? DEFAULT_OVERLAP_FOR_VALIDATION;
      if (resolvedOverlap < 0 || resolvedOverlap >= resolvedTokens) {
        throw new InvalidChunkConfigError(
          `chunkOverlap must satisfy 0 <= chunkOverlap < chunkTokens (effective: overlap=${resolvedOverlap}, tokens=${resolvedTokens}).`,
        );
      }

      const updated = await ctx.db.memory.update({
        where: { id },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(newOrgId ? { organizationId: newOrgId } : {}),
          ...(newUrn !== undefined ? { urn: newUrn } : {}),
          ...(shortDescription !== undefined ? { shortDescription } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(license !== undefined ? { license } : {}),
          ...(category0 !== undefined ? { category0 } : {}),
          ...(category1 !== undefined ? { category1 } : {}),
          ...(category2 !== undefined ? { category2 } : {}),
          ...(iconUrl !== undefined ? { iconUrl } : {}),
          ...(heroUrl !== undefined ? { heroUrl } : {}),
          ...(homeUrl !== undefined ? { homeUrl } : {}),
          ...(source !== undefined ? { source } : {}),
          ...(readBranch !== undefined ? { readBranch } : {}),
          ...(writeBranch !== undefined ? { writeBranch } : {}),
          ...(visibility !== undefined ? { visibility: visibility as MemoryVisibility } : {}),
          // 033 — vector-index config. The chk_memory_vector_encrypted_ack CHECK
          // constraint blocks enabling on an encrypted memory without the
          // disclosure ack; the resolver-level gate above is the friendly
          // typed-error wrapper.
          ...(vectorIndexEnabled !== undefined ? { vectorIndexEnabled } : {}),
          ...(embeddingSource !== undefined ? { embeddingSource } : {}),
          ...(nextAckAt !== undefined ? { vectorIndexEncryptedAckAt: nextAckAt } : {}),
          // 033 US2 — chunk dials. Validated above against the effective
          // post-update state.
          ...(chunkTokens !== undefined ? { chunkTokens } : {}),
          ...(chunkOverlap !== undefined ? { chunkOverlap } : {}),
          ...(forceFixedSize !== undefined ? { forceFixedSize } : {}),
        },
        include: MEMORY_INCLUDE,
      });

      // 033 — react to vector-index config changes (FR-004/FR-008/FR-026):
      const nowEnabled = updated.vectorIndexEnabled;
      const wasEnabled = memory.vectorIndexEnabled;
      const sourceChanged =
        embeddingSource !== undefined && embeddingSource !== memory.embeddingSource;
      // 033 US2 FR-004 — chunk dial changes also count as a re-index trigger
      // (the existing chunks would otherwise drift from the new boundaries).
      // PR-225 review (Copilot): gate this trigger on the post-update
      // effective embeddingSource actually using chunks — tweaking chunk
      // dials on an abstract-only memory shouldn't force a full re-embed.
      const effectiveSource = updated.embeddingSource;
      const sourceUsesChunks =
        effectiveSource === 'contentChunks' || effectiveSource === 'both';
      const chunkDialsChanged =
        (chunkTokens !== undefined && chunkTokens !== memory.chunkTokens) ||
        (chunkOverlap !== undefined && chunkOverlap !== memory.chunkOverlap) ||
        (forceFixedSize !== undefined && forceFixedSize !== memory.forceFixedSize);
      const chunkConfigChanged = chunkDialsChanged && sourceUsesChunks;
      if (nowEnabled && (!wasEnabled || sourceChanged || chunkConfigChanged)) {
        // When the source itself changes (abstract ↔ contentChunks ↔ both),
        // the previously-stored vectors are now the wrong KIND. vectorSearch
        // doesn't filter by kind today, so leaving them would mix stale
        // vectors of the old kind with whatever the backfill produces.
        // Drop everything first; the backfill re-stamps every node and the
        // sweep re-embeds against the new source (PR-219 review).
        //
        // Chunk-config changes (033 US2 FR-004): the existing chunk vectors
        // were sliced under the OLD chunkTokens / chunkOverlap / forceFixedSize
        // values. New dials produce different boundaries — the sweep will
        // re-derive chunks per the new config, so we drop the old chunk
        // vectors before backfill (preserving abstract vectors when source
        // is `abstract` or `both` would be a bigger change; the simpler
        // shape is "any reconfig triggers a full re-index" matching the
        // sourceChanged path).
        if (sourceChanged || chunkConfigChanged) {
          await deleteMemoryVectors(ctx.db, id);
        }
        // Enabled or re-sourced → backfill: stamp every live node pending.
        await backfillMemoryEmbeddings(ctx.db, id);
      } else if (!nowEnabled && wasEnabled) {
        // Disabled → drop stored vectors and clear markers.
        await deleteMemoryVectors(ctx.db, id);
        await ctx.db.node.updateMany({
          where: { memoryId: id },
          data: {
            embeddingPendingAt: null,
            embeddingFailedAt: null,
            embeddingError: null,
            embeddingAttempts: 0,
          },
        });
      }
      return updated;
    },

    deleteMemory: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // includeDeleted: a re-delete on an already-soft-deleted memory must
      // return true (FR-014 idempotency). The default resolveMemoryRef
      // would throw MemoryNotFoundError on the second call.
      const { id: resolvedId } = await resolveMemoryRef(ctx.db, id, { includeDeleted: true });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedId } });
      // Spec 013: class-aware authz. Personal-class memories have a single
      // owner in Memory.userId. The chk_personal_visibility_user CHECK
      // constraint enforces class IN (personal,private) ⇔ userId IS NOT NULL
      // (re-keyed onto class by spec 034; visibility is NULL for these).
      // Only the owner deletes — matches parent constitution Invariant 13.
      // Private-class memories (added 2026-05-24) follow the same
      // single-owner delete rule. All other classes (system/app/knowledge/
      // group) gate on org-admin role on the parent org. Authz runs first
      // so unauthorized callers can't probe row state via the system-memory
      // guard or idempotency short-circuit.
      if (memory.class === 'personal' || memory.class === 'private') {
        if (!ctx.userId || memory.userId !== ctx.userId) {
          throw new Error(`Forbidden: only the owner can delete a ${memory.class} memory`);
        }
      } else {
        await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      }
      // System-class memories are owned by their agent and can only be
      // removed by deleting the agent. This prevents the agent from ending
      // up with no brain via a stray deleteMemory call.
      if (memory.class === 'system') {
        throw new Error('Cannot delete an agent system memory directly. Delete the owning agent instead.');
      }
      // Spec 013 FR-014: idempotency. A re-delete on an already-soft-deleted
      // memory returns true without overwriting the original deletedAt. The
      // explicit short-circuit avoids an unnecessary write; the conditional
      // updateMany closes the read-then-write race so deletedAt is set once.
      if (memory.deletedAt) return true;
      await ctx.db.memory.updateMany({
        where: { id: resolvedId, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      return true;
    },

    setMemorySourceToken: async (
      _: unknown,
      { id, token, expiresAt }: { id: string; token: string; expiresAt?: string },
      ctx: Context,
    ) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      const encrypted = encryptToken(token);
      return ctx.db.memory.update({
        where: { id },
        data: {
          sourceTokenEncrypted: encrypted,
          sourceTokenExpiresAt: expiresAt ? new Date(expiresAt) : null,
        },
        include: MEMORY_INCLUDE,
      });
    },

    // ── Agent management ──────────────────────────────────────────────────

    createAgent: async (
      _: unknown,
      { orgId, name, description, systemPrompt, systemMemoryId, visibility, type, surfaces }: { orgId: string; name: string; description?: string; systemPrompt?: string; systemMemoryId?: string; visibility?: string; type?: 'ASSISTANT' | 'CHATBOT'; surfaces?: string[] },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: resolvedOrgId }, select: { urn: true } });
      const agentUrn = `${org.urn}:${name}`;
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

      // If a systemMemoryId is provided at create time, validate the target
      // and promote it to class='system' with the synced name. This is the
      // wizard's primary entry point.
      // 035-visibility-enum-cleanup: the memory's `class` (not the dropped
      // `type` column) marks it as a system memory, and its `visibility` is
      // cleared to NULL — agent visibility no longer syncs onto the system
      // memory (chk_memory_visibility_class forbids a non-null visibility on
      // class='system').
      if (systemMemoryId) {
        const target = await ctx.db.memory.findUniqueOrThrow({ where: { id: systemMemoryId } });
        if (target.organizationId !== resolvedOrgId) {
          throw new Error('System memory must belong to the same organization as the agent');
        }
        const otherAgent = await ctx.db.agent.findFirst({
          where: { systemMemoryId, deletedAt: null },
          select: { id: true },
        });
        if (otherAgent) {
          throw new Error('This memory is already the system memory of another agent');
        }
        await ctx.db.memory.update({
          where: { id: systemMemoryId },
          data: {
            class: 'system',
            name: `${name} System`,
            visibility: null,
          },
        });
      }

      return ctx.db.agent.create({
        data: {
          organizationId: resolvedOrgId, urn: agentUrn, name, description, systemPrompt, systemMemoryId: systemMemoryId ?? null,
          visibility: agentVisibility,
          type: inferredType,
          surfaces: surfaces ?? defaultSurfaces,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: AGENT_INCLUDE,
      });
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
        newUrn = `${org.urn}:${urn}`;
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
            },
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

    addMemoryToAgent: async (
      _: unknown,
      { agentId, memoryId, role }: { agentId: string; memoryId: string; role?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId and memoryId may be IDs, bare URNs,
      // or prefixed URNs. Resolve both to definite IDs before any
      // subsequent checks.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      // System-class memories can only be linked via Agent.systemMemoryId.
      // Attaching them as regular memory items would allow access patterns
      // we don't want (e.g. another agent reading the linked agent's prompts).
      const memory = await ctx.db.memory.findUniqueOrThrow({
        where: { id: resolvedMemoryId },
        select: { class: true },
      });
      if (memory.class === 'system') {
        throw new Error('Agent system memories can only be attached via systemMemoryId, not as a memory item');
      }
      await ctx.db.agentMemoryItem.create({ data: { agentId: resolvedAgentId, memoryId: resolvedMemoryId, role: role ?? 'read', createdBy: ctx.userId ?? ctx.clientId ?? null } });
      return ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId }, include: AGENT_INCLUDE });
    },

    updateAgentMemoryRole: async (
      _: unknown,
      { agentId, memoryId, role }: { agentId: string; memoryId: string; role: string },
      ctx: Context,
    ) => {
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      await ctx.db.agentMemoryItem.update({
        where: { agentId_memoryId: { agentId: resolvedAgentId, memoryId: resolvedMemoryId } },
        data: { role },
      });
      return ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId }, include: AGENT_INCLUDE });
    },

    removeMemoryFromAgent: async (
      _: unknown,
      { agentId, memoryId }: { agentId: string; memoryId: string },
      ctx: Context,
    ) => {
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      await ctx.db.agentMemoryItem.delete({
        where: { agentId_memoryId: { agentId: resolvedAgentId, memoryId: resolvedMemoryId } },
      });
      return ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId }, include: AGENT_INCLUDE });
    },

    // ── Memory subscriptions ─────────────────────────────────────────────

    createMemorySubscription: async (
      _: unknown,
      { memoryId, orgId, role }: { memoryId: string; orgId: string; role: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: memoryId and orgId may be IDs, bare URNs,
      // or prefixed URNs.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });

      // 035-visibility-enum-cleanup: only PUBLIC memories are cross-org
      // subscribable. ORGANIZATION/GROUP/NULL (personal/private/app/system)
      // are all rejected (PRIVATE is gone from the enum).
      if (memory.visibility !== 'PUBLIC') {
        throw new Error('Only public memories can be subscribed to by other organizations');
      }

      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');

      if (memory.organizationId === resolvedOrgId) {
        throw new Error('Owner organization has implicit access and cannot subscribe');
      }

      return ctx.db.memorySubscription.create({
        data: { id: generateId(), memoryId: resolvedMemoryId, organizationId: resolvedOrgId, role: role as Role, createdBy: ctx.userId ?? ctx.clientId ?? null },
        include: { memory: { include: MEMORY_INCLUDE }, organization: { include: ORG_INCLUDE } },
      });
    },

    updateMemorySubscription: async (
      _: unknown,
      { memoryId, orgId, role }: { memoryId: string; orgId: string; role: string },
      ctx: Context,
    ) => {
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      return ctx.db.memorySubscription.update({
        where: { memoryId_organizationId: { memoryId: resolvedMemoryId, organizationId: resolvedOrgId } },
        data: { role: role as Role },
        include: { memory: { include: MEMORY_INCLUDE }, organization: { include: ORG_INCLUDE } },
      });
    },

    deleteMemorySubscription: async (
      _: unknown,
      { memoryId, orgId }: { memoryId: string; orgId: string },
      ctx: Context,
    ) => {
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      const isOwnerAdmin = async () => {
        if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return true;
        if (!ctx.userId) return false;
        const m = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: memory.organizationId, userId: ctx.userId } },
        });
        return m?.role === 'ADMIN' || m?.role === 'OWNER';
      };
      const isSubscriberAdmin = async () => {
        if (!ctx.userId) return false;
        const m = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: resolvedOrgId, userId: ctx.userId } },
        });
        return m?.role === 'ADMIN' || m?.role === 'OWNER';
      };
      if (!(await isOwnerAdmin()) && !(await isSubscriberAdmin())) {
        throw new Error('Forbidden');
      }
      await ctx.db.memorySubscription.delete({
        where: { memoryId_organizationId: { memoryId: resolvedMemoryId, organizationId: resolvedOrgId } },
      });
      return true;
    },

    syncMemory: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({
        where: { id },
        include: { organization: true },
      });
      await requireOrgRole(ctx, memory.organizationId, 'CONTRIBUTOR');

      const result = await syncGraphFromGithub(memory);
      if (result.error) throw new Error(result.error);

      return ctx.db.memory.findUniqueOrThrow({ where: { id }, include: MEMORY_INCLUDE });
    },

    pushMemoryToGit: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');

      const { pushMemoryToGit: push } = await import('../../../integrations/github/pushMemoryToGit.js');
      const result = await push(id);
      if (result.error) throw new Error(result.error);
      return true;
    },

    restoreNodeVersion: async (_: unknown, { versionId }: { versionId: string }, ctx: Context) => {
      const version = await ctx.db.nodeVersion.findUniqueOrThrow({ where: { id: versionId } });
      const node = await ctx.db.node.findUniqueOrThrow({ where: { id: version.nodeId } });
      await requireMemoryWriteAccess(ctx, node.memoryId);

      // Snapshot current state before restoring. Spec 031 — `abstract`
      // must be captured here too; without it, a round-trip restore (then
      // restoring this snapshot) silently drops abstract. Spec 032 — same
      // for `abstractOriginHash`.
      await ctx.db.nodeVersion.create({
        data: {
          id: generateId(),
          nodeId: node.id,
          loc: node.loc,
          name: node.name,
          alias: node.alias,
          description: node.description,
          abstract: node.abstract,
          abstractOriginHash: node.abstractOriginHash,
          content: node.content,
          tags: node.tags as string[],
          editedBy: ctx.clientId ?? ctx.userId ?? null,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });

      // Restore the node to the version's state. Spec 031 — `abstract`
      // is part of the restored state; without it, restoring a version
      // that had a non-null abstract leaves the node's current abstract
      // unchanged (and vice versa). Spec 032 — `abstractOriginHash`
      // applied verbatim per plan D4 (no recomputation on restore;
      // legacy null hashes short-circuit the staleness check via the
      // NOT NULL guard in h-read-node).
      const restored = await ctx.db.node.update({
        where: { id: node.id },
        data: {
          name: version.name,
          alias: version.alias,
          description: version.description,
          abstract: version.abstract,
          abstractOriginHash: version.abstractOriginHash,
          content: version.content,
          tags: version.tags as string[],
        },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
      // 033 — re-embed the restored content (version snapshots are plaintext on
      // non-encrypted memories; ciphertext snapshots are handled by embedNode's
      // #206 permanent-fail path).
      void enqueueNodeEmbedding(ctx.db, {
        nodeId: restored.id,
        memoryId: restored.memoryId,
        plaintext: { content: version.content, abstract: version.abstract },
      });
      return restored;
    },

    addToMyMemories: async (_: unknown, { memoryId }: { memoryId: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      if (!ctx.userId) throw new Error('Authentication required');

      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);

      // Verify the memory is public
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      if (memory.visibility !== 'PUBLIC') throw new Error('Memory is not public');

      // Find user's personal org
      const membership = await ctx.db.orgMember.findFirst({
        where: {
          userId: ctx.userId,
          organization: { isVisible: { not: true } },
        },
        include: { organization: { include: { agents: true } } },
      });
      if (!membership) throw new Error('No personal workspace found');

      const org = membership.organization;
      const agent = org.agents[0];
      if (!agent) throw new Error('No default agent found');

      // Create memory subscription (personal org subscribes to the memory)
      await ctx.db.memorySubscription.upsert({
        where: { memoryId_organizationId: { memoryId: resolvedMemoryId, organizationId: org.id } },
        create: {
          id: generateId(),
          memoryId: resolvedMemoryId,
          organizationId: org.id,
          role: 'READER',
          activated: true,
          createdBy: ctx.userId ?? null,
        },
        update: {},
      });

      // Add memory to the default agent
      await ctx.db.agentMemoryItem.upsert({
        where: { agentId_memoryId: { agentId: agent.id, memoryId: resolvedMemoryId } },
        create: { id: generateId(), agentId: agent.id, memoryId: resolvedMemoryId, createdBy: ctx.userId ?? null },
        update: {},
      });

      return true;
    },

    // ── Exchange integration mutations ──────────────────────────────────
    // Connection is created via OAuth at /auth/microsoft (no GraphQL mutation needed)

    deleteExchangeConnection: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const connection = await ctx.db.exchangeConnection.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, connection.organizationId, 'ADMIN');
      await ctx.db.exchangeConnection.update({
        where: { id },
        data: { deletedAt: new Date(), deletedBy: ctx.userId ?? ctx.clientId ?? null },
      });
      return true;
    },

    testExchangeConnection: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, id);
      try {
        await listInboxMessages(refreshToken, { top: 1 });
        await ctx.db.exchangeConnection.update({
          where: { id },
          data: { syncStatus: 'OK', lastError: null, lastSyncAt: new Date() },
        });
        return true;
      } catch (err: unknown) {
        const errMsg = extractErrorMessage(err);
        await ctx.db.exchangeConnection.update({
          where: { id },
          data: { syncStatus: 'ERROR', lastError: errMsg },
        });
        throw new Error(`Exchange connection test failed: ${errMsg}`);
      }
    },

    exchangeReply: async (
      _: unknown,
      { connectionId, messageId, body }: { connectionId: string; messageId: string; body: string },
      ctx: Context,
    ) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, connectionId);
      await replyToMessage(refreshToken, messageId, body);
      return true;
    },

    exchangeMoveMessage: async (
      _: unknown,
      { connectionId, messageId, folderId }: { connectionId: string; messageId: string; folderId: string },
      ctx: Context,
    ) => {
      const { refreshToken } = await getExchangeRefreshToken(ctx, connectionId);
      await moveMessage(refreshToken, messageId, folderId);
      return true;
    },

    joinWaitingList: async (
      _: unknown,
      { email, requestedFeatures }: { email: string; requestedFeatures?: string },
      ctx: Context,
    ) => {
      await ctx.db.waitingListItem.create({
        data: { email: email.trim().toLowerCase(), requestedFeatures: requestedFeatures ?? null },
      });
      return true;
    },

    sendContactMessage: async (
      _: unknown,
      { name, email, message }: { name: string; email: string; message: string },
    ) => {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) throw new Error('Email service not configured');
      const contactEmail = process.env.CONTACT_EMAIL ?? 'info@baragaun.com';

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: 'Hadron <noreply@hadronmemory.com>',
          to: contactEmail,
          subject: `Contact from ${name}`,
          text: `New contact form submission:\n\nFrom: ${name} <${email}>\n\n${message}`,
        }),
      });
      return true;
    },

    // ── Chat API ────────────────────────────────────────────────────────

    startChat: async (
      _: unknown,
      {
        agentId,
        userId,
        conversationName,
        scope,
        isTestRun,
      }: {
        agentId: string;
        userId?: string;
        conversationName?: string;
        // Spec 017: chosen at chat creation, immutable afterward.
        scope?: 'private' | 'shared';
        // Spec 019: skip cross-cutting side-effects when the call comes
        // from the Tester. Defaults to false; see typeDefs for the
        // full rationale.
        isTestRun?: boolean;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      // Spec 017: default per FR-003. The GraphQL schema also defaults
      // scope to `private`; the resolver default is a defensive belt.
      const chatScope: 'private' | 'shared' = scope ?? 'private';

      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);

      // Resolve effective user id. The portal calls with userId omitted and
      // we use ctx.userId. The App Key path can pass an externalUserId.
      // Legacy callers with no user get "anonymous".
      const effectiveUserId = userId ?? ctx.userId ?? 'anonymous';

      // 005-agent-subscription FR-002: auto-provision an AgentSubscription
      // on the first user-attributed contact for (user, agent). Idempotent.
      // Skip for the "anonymous" sentinel — there is no User row.
      //
      // Spec 019: also skip when `isTestRun` is true. AgentSubscription is
      // the platform's license-grant entity, narrowed in
      // 2026-05-12-user-installing-app to "user is licensed to interact
      // with this Agent at all." A side-effect of clicking "Test" once
      // silently granting that license re-broadens what we narrowed.
      if (effectiveUserId !== 'anonymous' && !isTestRun) {
        await ensureAgentSubscription(ctx.db, effectiveUserId, resolvedAgentId);
      }

      // Load agent with system memory
      const agent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedAgentId },
        include: { memoryItems: { include: { memory: true } } },
      });

      const systemMemoryId = (agent as any).systemMemoryId as string | null;
      if (!systemMemoryId) throw new Error('Agent has no system memory configured');

      // If the agent has a published revision, read conversation structure
      // from the snapshot (pin-to-version). Otherwise read from live nodes.
      const publishedLoc = (agent as any).publishedRevisionLoc as string | null;
      const snapshotLookup = await loadPublishedSnapshot(ctx.db, systemMemoryId, publishedLoc);

      // Helper: find a node either from snapshot or live DB
      async function findSystemNode(loc: string): Promise<SnapshotNode | null> {
        if (snapshotLookup) return snapshotLookup(loc);
        const n = await ctx.db.node.findFirst({
          where: { memoryId: systemMemoryId!, loc, deletedAt: null },
          select: { loc: true, name: true, nodeType: true, description: true, content: true, data: true },
        });
        return n as SnapshotNode | null;
      }

      // Helper: find all nodes matching a prefix (for conversation selection)
      async function findSystemNodesByPrefix(prefix: string): Promise<SnapshotNode[]> {
        if (snapshotLookup) {
          // Scan the snapshot — loadPublishedSnapshot builds a Map, but
          // we need prefix matching. Re-load the snapshot nodes.
          const revNode = await ctx.db.node.findFirst({
            where: { memoryId: systemMemoryId!, loc: publishedLoc!, deletedAt: null },
            select: { data: true },
          });
          const snap = ((revNode?.data as any)?.snapshot?.nodes as SnapshotNode[]) ?? [];
          return snap.filter((n) => n.loc.startsWith(prefix));
        }
        const nodes = await ctx.db.node.findMany({
          where: { memoryId: systemMemoryId!, loc: { startsWith: prefix }, deletedAt: null },
          select: { loc: true, name: true, nodeType: true, description: true, content: true, data: true },
        });
        return nodes as SnapshotNode[];
      }

      // ── Conversation selection ───────────────────────────────────────
      let convName: string;
      if (conversationName) {
        convName = conversationName;
      } else {
        const allConvs = await findSystemNodesByPrefix('conversations:');
        const topLevel = allConvs.filter((n) => n.loc.split(':').length === 2);
        const nonSetup = topLevel.find((n) => {
          const d = (n.data as Record<string, unknown>) ?? {};
          return d.isSetup !== true && d.isFallback !== true;
        });
        const chosen = nonSetup ?? topLevel[0];
        if (!chosen) throw new Error('Agent has no conversations configured');
        convName = chosen.loc.split(':')[1];
      }

      const convNode = await findSystemNode(`conversations:${convName}`);
      if (!convNode) throw new Error(`Conversation "${convName}" not found in agent's system memory`);

      const convData = (convNode.data as Record<string, unknown>) ?? {};
      const stageOrder = (convData.stageOrder as string[]) ?? [];
      const firstStage = stageOrder[0];
      if (!firstStage) throw new Error(`Conversation "${convName}" has no stages`);

      // Load the first stage
      const stageNode = await findSystemNode(`conversations:${convName}:${firstStage}`);
      const stageData = (stageNode?.data as Record<string, unknown>) ?? {};

      // Load the prompt
      const promptRef = stageData.promptRef as string | undefined;
      let promptContent = '';
      if (promptRef) {
        const promptNode = await findSystemNode(promptRef);
        promptContent = promptNode?.content ?? '';
      } else if (stageNode?.content) {
        promptContent = stageNode.content;
      }

      // ── Target memory selection ──────────────────────────────────────
      // The chat (and its future messages + extracted data) get stored
      // in a user-scoped memory. Four auth paths:
      //   0. (Spec 017) `scope: 'shared'` → app-class memory for the App
      //      the caller is an AppMember of (and whose agentId matches).
      //      JWT-user only in v1; App-key sessions stay private-only per
      //      research.md Q-R2.
      //   1. App Key session with an active sessionId → use session.memoryId
      //   2. JWT user → find-or-create a per-user memory for (agent, ctx.userId)
      //   3. Legacy fallback → first writable memory attached to the agent
      let targetMemoryId: string | null = null;
      if (chatScope === 'shared') {
        // Spec 017 FR-006 + research.md Q-R2: shared chats require a
        // JWT-user AppMember context. Two distinct rejection paths so
        // SC-005 callers see an actionable message:
        //   - MCP App-key session → shared chats not available in v1
        //   - JWT user but not an AppMember → not a member of any App
        //     that installs this Agent.
        if (ctx.appId) {
          throw new ChatScopeError(
            'SHARED_CHAT_NOT_AVAILABLE_FOR_APP_SESSIONS',
            'Shared chats are not available for MCP App-key sessions — start the chat from a signed-in user surface.',
          );
        }
        if (!ctx.userId) {
          throw new ChatScopeError(
            'SHARED_CHAT_REQUIRES_APP_CONTEXT',
            'Cannot create a shared chat — sign in as a user that belongs to an App that installs this Agent.',
          );
        }
        // 023-app-shape Phase 2b: App↔Agent is N:M via AppAgent. Find an
        // App that the user is an AppMember of AND that has this Agent
        // installed. With multi-Agent Apps, this may return any App that
        // matches both conditions; today it returns at most one.
        const membership = await ctx.db.appMember.findFirst({
          where: {
            userId: ctx.userId,
            app: {
              appAgents: { some: { agentId: resolvedAgentId } },
              deletedAt: null,
            },
          },
          select: {
            app: { select: { id: true, urn: true, name: true, organizationId: true } },
          },
        });
        if (!membership?.app) {
          throw new ChatScopeError(
            'SHARED_CHAT_REQUIRES_APP_CONTEXT',
            "Cannot create a shared chat — you are not a member of any App that installs this Agent.",
          );
        }
        // Idempotent: first shared chat under the (App, Agent) pair
        // provisions the app-class memory; subsequent calls reuse it.
        // Keyed per-agent (not per-app) so multi-Agent Apps — the model
        // the 2026-05-12-user-installing-app session settled on — get
        // one shared memory per installed Agent.
        targetMemoryId = await findOrCreateAppClassMemory({
          appId: membership.app.id,
          appUrn: membership.app.urn,
          appName: membership.app.name,
          agentUrn: agent.urn,
          agentName: agent.name,
          organizationId: membership.app.organizationId,
          actingUserId: ctx.userId,
          db: ctx.db,
        });
      } else if (ctx.appId && ctx.sessionId) {
        const session = await ctx.db.session.findUnique({
          where: { id: ctx.sessionId },
          select: { memoryId: true },
        });
        targetMemoryId = session?.memoryId ?? null;
      } else if (ctx.userId) {
        const existing = await ctx.db.memory.findFirst({
          where: {
            userMemoryOfAgentId: resolvedAgentId,
            createdBy: ctx.userId,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (existing) {
          targetMemoryId = existing.id;
        } else {
          // Lazily provision a per-user memory for this (agent, user).
          // 008: personal-class memory requires app_id (chk_memory_class_app_id).
          // For a JWT-user chat we resolve the App via App.agent_id matching the
          // chat agent inside the user's accessible orgs. If no matching App
          // exists, we downgrade to a knowledge-class memory for this chat —
          // analogous to the migration's R-3 fallback for unattributed personal
          // memories.
          const org = await ctx.db.organization.findUniqueOrThrow({
            where: { id: agent.organizationId }, select: { urn: true },
          });
          const opaqueId = generateId();
          const agentSlug = agent.urn.split(':').slice(1).join(':');
          const memoryUrn = `${org.urn}:${agentSlug}:user:${opaqueId}`;

          const ownerOrgIds = (
            await ctx.db.orgMember.findMany({
              where: { userId: ctx.userId, deletedAt: null },
              select: { organizationId: true },
            })
          ).map((m) => m.organizationId);

          const matchingApp =
            ownerOrgIds.length > 0
              ? await ctx.db.app.findFirst({
                  where: {
                    appAgents: { some: { agentId: resolvedAgentId } },
                    organizationId: { in: ownerOrgIds },
                    deletedAt: null,
                  },
                  select: { id: true },
                })
              : null;

          const memoryClass: 'personal' | 'knowledge' = matchingApp
            ? 'personal'
            : 'knowledge';
          // 035-visibility-enum-cleanup: personal memory → NULL visibility
          // (class-driven privacy); the no-App knowledge holding memory →
          // ORGANIZATION (owner-gating now rides on userMemoryOfAgentId in
          // getAccessibleMemoryIds, not visibility=PRIVATE).
          const visibility: MemoryVisibility | null = matchingApp
            ? null
            : 'ORGANIZATION';

          const created = await ctx.db.memory.create({
            data: {
              organizationId: agent.organizationId,
              urn: memoryUrn,
              name: `${agent.name} — ${ctx.userId}`,
              // 005-agent-subscription: personal-class memory; userId
              // owner-pivot is required by the bidirectional CHECK
              // constraint (class IN (personal,private) ⇔ userId NOT NULL). Note:
              // organizationId stays at agent.organizationId here for
              // the legacy JWT-user path; the spec's FR-015 (use
              // user's personal org) applies to the new App-keyed
              // AgentSubscription auto-provisioning path.
              userId: matchingApp ? ctx.userId : null,
              class: memoryClass,
              visibility,
              userMemoryOfAgentId: resolvedAgentId,
              appId: matchingApp?.id,
              createdBy: ctx.userId,
            },
          });
          targetMemoryId = created.id;
        }
      } else {
        // Legacy: use the agent's first writable attached memory.
        targetMemoryId = agent.memoryItems.find((m) => m.role === 'read-write')?.memory.id ?? null;
      }

      if (!targetMemoryId) {
        throw new Error('No target memory available for this chat');
      }

      // Compile the prompt with Mustache against the target memory's data.
      //
      // Spec 017 D5 — retrieval-time enforcement. compileTemplate spreads
      // the accessFilter AFTER the literal memoryId, so a permissive
      // filter (the caller's full memory set) effectively broadens the
      // ref lookup beyond the chat's holding memory. For SHARED chats
      // we must constrain to the chat's allowedReadSet (excludes any
      // personal memory) — see chat-scope.ts:chatScopeAccessFilter for
      // the full rationale. PRIVATE chats keep the legacy
      // memoryAccessFilter behavior: no regression for existing
      // private-chat templates, which can rely on cross-memory refs
      // within the caller's own access scope.
      let systemMessage = promptContent;
      if (promptContent.includes('{{')) {
        const access =
          chatScope === 'shared'
            ? chatScopeAccessFilter(
                {
                  scope: 'shared',
                  memoryId: targetMemoryId,
                  appId: null, // not needed by allowedReadSet
                  authorUserId: ctx.userId ?? effectiveUserId,
                  agentId: resolvedAgentId,
                },
                {
                  knowledgeMemoryIds: agent.memoryItems
                    .filter((m) => m.memory.class === 'knowledge')
                    .map((m) => m.memory.id),
                  systemMemoryId,
                  appClassMemoryId: targetMemoryId, // for shared, chat.memoryId IS the app-class memory
                },
              )
            : await memoryAccessFilter(ctx);
        systemMessage = await compileTemplate(promptContent, null, targetMemoryId, ctx.db, access);
      }

      // Build tool schema from hierarchical extraction spec
      // (agent-level config node + conversation-level + stage-level)
      const tools = await buildRespondToolSchema(ctx.db, systemMemoryId, convName, stageData);

      // Create chat node in the target memory. The loc needs a unique
      // suffix since two chats started in the same minute by the same user
      // on the same conversation would otherwise collide on (loc, memoryId).
      // Use the last 8 chars of a UUIDv7 (the random portion — the first
      // bytes are a timestamp and collide for calls in the same second).
      //
      // Sanitize `convName` to `[a-zA-Z0-9-]` before embedding in the
      // loc: ':' is the URN structural delimiter, and `myChats` /
      // chat_scope_backfill use `loc NOT LIKE '%:messages%'` to
      // distinguish chat-root nodes from message rows. A user-supplied
      // `conversationName` containing `:messages` would slip out of
      // both filters.
      const safeConvName = convName.replace(/[^a-zA-Z0-9-]/g, '-');
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const shortId = generateId().slice(-8);
      const chatName = `${ts}-${shortId}-${safeConvName}`;
      const chatLoc = `chats:${chatName}`;

      // Ensure the chats parent exists
      try {
        await ctx.db.node.upsert({
          where: { loc_memoryId: { loc: 'chats', memoryId: targetMemoryId } },
          create: {
            id: generateId(), memoryId: targetMemoryId, loc: 'chats',
            name: 'chats', nodeType: 'record',
          },
          update: {},
        });
      } catch { /* exists */ }

      // Look up the conversation's goal for the initial goal stack entry
      const convGoals = (convData.goalDescriptions as string[]) ?? [];
      const initialGoal = convGoals[0] ?? `${convName} conversation`;

      // Create the chat node with initial goal stack and route history.
      // Spec 017: data.scope carries the chosen tier (FR-001/FR-002,
      // immutable post-creation). The target-memory selection above
      // routed the chat into the matching memory class (personal for
      // private, app for shared); data.scope is the denormalization
      // that lets chat-list endpoints surface the tier without joining
      // Memory.class per row (data-model.md §2).
      const initialChatData: Record<string, unknown> = {
        scope: chatScope,
        conversationName: convName,
        stageName: firstStage,
        userId: effectiveUserId,
        startedWithRevision: publishedLoc ?? null,
        messageCount: 0,
        createdAt: new Date().toISOString(),
        goalStack: [{
          description: initialGoal,
          createdBy: 'USER',
          createdAt: new Date().toISOString(),
          conversationUrn: `conversations:${convName}`,
          nodeUrn: `conversations:${convName}:${firstStage}`,
          status: 'ACTIVE',
        }],
        routeHistory: [{
          conversationUrn: `conversations:${convName}`,
          nodeUrn: `conversations:${convName}:${firstStage}`,
          action: 'ENTER',
          trigger: { type: 'CHAT_START', content: convName },
          timestamp: new Date().toISOString(),
        }],
      };

      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: targetMemoryId, loc: chatLoc, name: chatName,
          nodeType: 'record',
          description: `Chat: ${convName}`,
          data: initialChatData as InputJsonValue,
        },
      });

      // Create the messages parent (so the chat subtree is well-formed)
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: targetMemoryId, loc: `${chatLoc}:messages`,
          name: 'messages', nodeType: 'record',
        },
      });

      // Prepend the agent's system prompt to the compiled stage prompt
      if (agent.systemPrompt) {
        systemMessage = agent.systemPrompt + '\n\n' + systemMessage;
      }

      return { chatId: chatLoc, systemMessage, tools, conversationName: convName, stageName: firstStage };
    },

    sendChatMessage: async (
      _: unknown,
      { chatId, userMessage }: { chatId: string; userMessage: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      // Find the chat node
      const chatNode = await ctx.db.node.findFirst({
        where: { loc: chatId, deletedAt: null },
      });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);

      // Decrypt the chat node's metadata (it holds conversationName, stageName,
      // messageCount in `data`) if the memory is encrypted.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) decryptNodeFields(chatNode, memEncInfo);

      const chatData = (chatNode.data as Record<string, unknown>) ?? {};

      // Spec 017 — chat-scope invariant gate (data-model.md §I-1):
      // assert the chat-root node's stored scope matches the holding
      // memory's class before doing any work. `allowMissingScope: true`
      // covers pre-feature chats whose `data.scope` is undefined until
      // the Phase 6 backfill runs (T036/T037); after backfill every chat
      // has an explicit scope and the legacy path falls cold.
      const chatScopeCheckMemory = await ctx.db.memory.findUniqueOrThrow({
        where: { id: chatNode.memoryId },
        select: { class: true },
      });
      validateChatScopeInvariants({
        scope: chatData.scope as 'private' | 'shared' | undefined,
        memoryClass: chatScopeCheckMemory.class,
        allowMissingScope: true,
      });
      const messageCount = ((chatData.messageCount as number) ?? 0) + 1;
      const convName = chatData.conversationName as string;
      const stageName = chatData.stageName as string;

      // Save user message. When the memory is encrypted we need to encrypt
      // the message content AND the chat node's updated `data`.
      // The `data.role` field is what the message-history reader uses to
      // decide user-vs-assistant — agent-agnostic per Constitution Invariant
      // #14 (no hardcoded agent names anywhere in the platform).
      const msgNum = String(messageCount).padStart(3, '0');
      const userId = chatData.userId as string ?? 'user';
      const newMsgFields = encryptNodeFields(
        { content: userMessage, data: { role: 'user' } },
        memEncInfo,
      );
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${msgNum}-${userId}`, name: `${msgNum}-${userId}`,
          nodeType: 'record', content: newMsgFields.content ?? null,
          data: (newMsgFields.data ?? null) as InputJsonValue,
          seq: messageCount,
        },
      });

      // Update message count + lastMessageAt
      const newChatData = {
        ...(chatData as Record<string, unknown>),
        messageCount,
        lastMessageAt: new Date().toISOString(),
      };
      const encUpdate = encryptNodeFields({ content: null, data: newChatData }, memEncInfo);
      await ctx.db.node.update({
        where: { id: chatNode.id },
        data: { data: (encUpdate.data ?? null) as InputJsonValue },
      });

      // Find the agent that owns this chat. Two ways a memory can belong
      // to an agent: (1) it's a user memory via userMemoryOfAgentId, or
      // (2) legacy — it's attached as a regular memoryItem with role
      // read-write. Check the user-memory path first since that's the
      // canonical portal chat path.
      const memory = await ctx.db.memory.findUnique({ where: { id: chatNode.memoryId } });
      if (!memory) throw new Error('Memory not found');
      let agent = null;
      if (memory.userMemoryOfAgentId) {
        agent = await ctx.db.agent.findUnique({
          where: { id: memory.userMemoryOfAgentId },
        });
      } else {
        const legacyAgents = await ctx.db.agent.findMany({
          where: { deletedAt: null, memoryItems: { some: { memoryId: chatNode.memoryId } } },
        });
        agent = legacyAgents.find((a) => (a as any).systemMemoryId) ?? null;
      }
      const systemMemoryId = agent ? (agent as any).systemMemoryId as string : null;

      // Pin to version: if the chat was started with a published revision,
      // read from that snapshot so mid-conversation publishes don't change
      // the prompts/stages under the user.
      const startedWithRevision = chatData.startedWithRevision as string | null;
      const snapshotLookup = systemMemoryId
        ? await loadPublishedSnapshot(ctx.db, systemMemoryId, startedWithRevision)
        : null;

      async function findSystemNode(loc: string): Promise<SnapshotNode | null> {
        if (snapshotLookup) return snapshotLookup(loc);
        if (!systemMemoryId) return null;
        const n = await ctx.db.node.findFirst({
          where: { memoryId: systemMemoryId, loc, deletedAt: null },
          select: { loc: true, name: true, nodeType: true, description: true, content: true, data: true },
        });
        return n as SnapshotNode | null;
      }

      // If the chat is in a fallback conversation, try to re-route on
      // every turn. The user may have clarified their intent — check if
      // any non-fallback conversation's goalSignals match the message.
      let activeConvName = convName;
      let activeStageName = stageName;

      if (systemMemoryId) {
        const currentConv = await findSystemNode(`conversations:${convName}`);
        const currentConvData = (currentConv?.data as Record<string, unknown>) ?? {};
        if (currentConvData.isFallback === true) {
          // Scan all conversations for a goal match
          const allConvNodes = await (async () => {
            if (snapshotLookup) {
              const revNode = await ctx.db.node.findFirst({
                where: { memoryId: systemMemoryId, loc: startedWithRevision!, deletedAt: null },
                select: { data: true },
              });
              return ((revNode?.data as any)?.snapshot?.nodes as SnapshotNode[] ?? [])
                .filter((n: SnapshotNode) => n.loc.startsWith('conversations:') && n.loc.split(':').length === 2);
            }
            const nodes = await ctx.db.node.findMany({
              where: { memoryId: systemMemoryId, loc: { startsWith: 'conversations:' }, deletedAt: null },
              select: { loc: true, name: true, data: true, nodeType: true, description: true, content: true },
            });
            return nodes.filter((n) => n.loc.split(':').length === 2) as SnapshotNode[];
          })();

          const msgLower = userMessage.toLowerCase();
          let bestMatch: { convName: string; firstStage: string } | null = null;

          for (const conv of allConvNodes) {
            const cd = (conv.data as Record<string, unknown>) ?? {};
            if (cd.isSetup === true || cd.isFallback === true) continue;
            const signals = (cd.goalSignals as string[]) ?? [];
            const goals = (cd.goalDescriptions as string[]) ?? [];
            // Simple keyword matching: check if any signal appears in the message
            const matched = signals.some((s) => msgLower.includes(s.toLowerCase())) ||
              goals.some((g) => msgLower.includes(g.toLowerCase().split(' ').slice(0, 3).join(' ')));
            if (matched) {
              const stages = (cd.stageOrder as string[]) ?? [];
              if (stages[0]) {
                bestMatch = { convName: conv.loc.split(':')[1], firstStage: stages[0] };
                break;
              }
            }
          }

          // If no signal matched but the message is substantive (more than
          // a greeting), try picking the first non-setup, non-fallback
          // conversation as a reasonable default.
          if (!bestMatch && userMessage.trim().split(/\s+/).length >= 4) {
            for (const conv of allConvNodes) {
              const cd = (conv.data as Record<string, unknown>) ?? {};
              if (cd.isSetup === true || cd.isFallback === true) continue;
              const stages = (cd.stageOrder as string[]) ?? [];
              if (stages[0]) {
                bestMatch = { convName: conv.loc.split(':')[1], firstStage: stages[0] };
                break;
              }
            }
          }

          if (bestMatch) {
            activeConvName = bestMatch.convName;
            activeStageName = bestMatch.firstStage;
            // Update the chat node to reflect the re-route
            const updatedChatData = {
              ...(chatData as Record<string, unknown>),
              conversationName: activeConvName,
              stageName: activeStageName,
              messageCount,
              lastMessageAt: new Date().toISOString(),
            };
            appendRouteEntry(updatedChatData, {
              conversationUrn: `conversations:${activeConvName}`,
              nodeUrn: `conversations:${activeConvName}:${activeStageName}`,
              action: 'ENTER',
              trigger: { type: 'FALLBACK_REROUTE', content: userMessage.slice(0, 100) },
            });
            const encReroute = encryptNodeFields({ content: null, data: updatedChatData }, memEncInfo);
            await ctx.db.node.update({
              where: { id: chatNode.id },
              data: { data: (encReroute.data ?? null) as InputJsonValue },
            });
          }
        }
      }

      // Load current stage
      let systemMessage = '';
      let tools = null;

      if (systemMemoryId && activeConvName && activeStageName) {
        const stageNode = await findSystemNode(`conversations:${activeConvName}:${activeStageName}`);
        const stageData = (stageNode?.data as Record<string, unknown>) ?? {};

        // Load prompt
        const promptRef = stageData.promptRef as string | undefined;
        let promptContent = '';
        if (promptRef) {
          const promptNode = await findSystemNode(promptRef);
          promptContent = promptNode?.content ?? '';
        } else if (stageNode?.content) {
          promptContent = stageNode.content;
        }

        // Compile with data.
        //
        // Spec 017 D5 — retrieval-time enforcement: for SHARED chats,
        // narrow the access filter to the chat's allowedReadSet so a
        // Mustache reference cannot resolve against the caller's
        // personal memory. PRIVATE chats keep the legacy
        // memoryAccessFilter behavior. See chat-scope.ts:
        // chatScopeAccessFilter for the full rationale.
        const isShared = chatData.scope === 'shared';
        let access: Record<string, unknown>;
        if (isShared && agent) {
          const knowledgeItems = await ctx.db.agentMemoryItem.findMany({
            where: { agentId: agent.id, memory: { class: 'knowledge', deletedAt: null } },
            select: { memoryId: true },
          });
          access = chatScopeAccessFilter(
            {
              scope: 'shared',
              memoryId: chatNode.memoryId,
              appId: null,
              authorUserId: (chatData.userId as string) ?? '',
              agentId: agent.id,
            },
            {
              knowledgeMemoryIds: knowledgeItems.map((k) => k.memoryId),
              systemMemoryId,
              appClassMemoryId: chatNode.memoryId, // chat IS in the app-class memory
            },
          );
        } else {
          access = await memoryAccessFilter(ctx);
        }
        if (promptContent.includes('{{')) {
          systemMessage = await compileTemplate(promptContent, null, chatNode.memoryId, ctx.db, access);
        } else {
          systemMessage = promptContent;
        }

        // Prepend agent system prompt
        if (agent?.systemPrompt) {
          systemMessage = agent.systemPrompt + '\n\n' + systemMessage;
        }

        // Build tools from hierarchical extraction spec
        tools = await buildRespondToolSchema(ctx.db, systemMemoryId, activeConvName, stageData);
      }

      // Build message history (recent messages). For encrypted memories,
      // decrypt each message's content before formatting.
      const messages = await ctx.db.node.findMany({
        where: { loc: { startsWith: `${chatId}:messages:` }, memoryId: chatNode.memoryId, deletedAt: null },
        orderBy: { seq: 'asc' },
        take: 50,
        select: { loc: true, content: true, data: true, seq: true, nodeType: true, memoryId: true },
      });
      if (memEncInfo.isEncrypted) {
        for (const m of messages) decryptNodeFields(m, memEncInfo);
      }

      // Role detection is agent-agnostic (Constitution Invariant #14):
      // - Primary: read `data.role` from the message node. New messages
      //   created post-cleanup always carry this.
      // - Fallback: the loc/name suffix produced by the message-create
      //   path is deterministic — assistant messages always end with
      //   `-assistant`. Anything else is a user message (or a summary,
      //   which we treat as user to preserve pre-cleanup behavior).
      // - Legacy messages without `data.role` and without the suffix
      //   (vanishingly rare; only present in pre-006 fixtures) default
      //   to 'user'.
      const messageHistory = messages.map((m) => {
        const data = (m.data as { role?: unknown } | null) ?? null;
        const explicitRole = typeof data?.role === 'string' ? data.role : null;
        const role: 'user' | 'assistant' =
          explicitRole === 'assistant'
            ? 'assistant'
            : explicitRole === 'user'
              ? 'user'
              : (m.loc.split(':').pop() ?? '').endsWith('-assistant')
                ? 'assistant'
                : 'user';
        return { role, content: m.content ?? '' };
      });

      // Check if summarization is needed
      const triggerCount = 20; // TODO: read from agent/conversation config
      let summarizationNeeded = null;
      if (messageCount > 0 && messageCount % triggerCount === 0) {
        summarizationNeeded = {
          messageCount: triggerCount,
          prompt: 'Summarize the following conversation messages. Focus on key facts, decisions made, and any action items. Keep the summary concise but include all important details.',
        };
      }

      return { systemMessage, tools, messageHistory, summarizationNeeded };
    },

    processChatResponse: async (
      _: unknown,
      { chatId, toolResponse }: { chatId: string; toolResponse: Record<string, unknown> },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      const chatNode = await ctx.db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);

      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) decryptNodeFields(chatNode, memEncInfo);

      const chatData = (chatNode.data as Record<string, unknown>) ?? {};

      // Spec 017 — chat-scope invariant gate (see sendChatMessage for
      // the rationale). The write side (extracted data lands in
      // chatNode.memoryId, line below at line ~4055) is bounded by the
      // chat's holding memory by construction; the validate-call here
      // ensures no corrupted chat-root can slip past.
      //
      // ── Phase-4/T015 (deferred from Phase 3) ──────────────────────
      // When the shared-chat branch lands and tools that accept a
      // memoryUrn/memoryId argument are added to the chat-tool schema,
      // this is the point where each such tool-handler dispatch MUST
      // pass through `allowedReadSet(chat)` and reject any out-of-set
      // reference before any DB content read. The chat-API surface
      // today only exposes the `respond` tool (which takes no memory
      // argument), so the gate has no current target — but the hook
      // belongs here.
      const chatScopeCheckMemory = await ctx.db.memory.findUniqueOrThrow({
        where: { id: chatNode.memoryId },
        select: { class: true },
      });
      validateChatScopeInvariants({
        scope: chatData.scope as 'private' | 'shared' | undefined,
        memoryClass: chatScopeCheckMemory.class,
        allowMissingScope: true,
      });

      const messageCount = ((chatData.messageCount as number) ?? 0) + 1;

      const message = (toolResponse.message as string) ?? '';
      const data = toolResponse.data as Record<string, unknown> | undefined;
      const nextStage = toolResponse.next_stage as string | undefined;
      const onTrack = toolResponse.onTrack as boolean | undefined;
      const offTrackReason = toolResponse.offTrackReason as string | undefined;

      // Save assistant message (encrypted when memory is encrypted).
      // `data.role = 'assistant'` is what the message-history reader uses
      // to identify the role — agent-agnostic per Constitution Invariant
      // #14 (no hardcoded agent names anywhere in the platform).
      const msgNum = String(messageCount).padStart(3, '0');
      const encMsg = encryptNodeFields(
        { content: message, data: { role: 'assistant' } },
        memEncInfo,
      );
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${msgNum}-assistant`, name: `${msgNum}-assistant`,
          nodeType: 'record', content: encMsg.content ?? null,
          data: (encMsg.data ?? null) as InputJsonValue,
          seq: messageCount,
        },
      });

      // Save extracted data to memory's default data node
      if (data && Object.keys(data).length > 0) {
        const dataNode = await ctx.db.node.findFirst({
          where: { loc: 'data', memoryId: chatNode.memoryId, deletedAt: null },
        });
        if (dataNode) {
          if (memEncInfo.isEncrypted) decryptNodeFields(dataNode, memEncInfo);
          const existingData = (dataNode.data as Record<string, unknown>) ?? {};
          const merged = { ...existingData, ...data };
          const encData = encryptNodeFields({ content: null, data: merged }, memEncInfo);
          await ctx.db.node.update({
            where: { id: dataNode.id },
            data: { data: (encData.data ?? null) as InputJsonValue },
          });
        } else {
          const encNew = encryptNodeFields({ content: null, data }, memEncInfo);
          await ctx.db.node.create({
            data: {
              id: generateId(), memoryId: chatNode.memoryId,
              loc: 'data', name: 'data', nodeType: 'info',
              data: (encNew.data ?? null) as InputJsonValue,
            },
          });
        }
      }

      // Handle stage transition + edge evaluation
      let stageTransitioned = false;
      let newStageName: string | null = null;
      let conversationHandoff: string | null = null;
      const updatedData: Record<string, unknown> = {
        ...(chatData as Record<string, unknown>),
        messageCount,
        lastMessageAt: new Date().toISOString(),
      };

      // 1. Explicit stage transition from the LLM
      if (nextStage && nextStage !== chatData.stageName) {
        updatedData.stageName = nextStage;
        stageTransitioned = true;
        newStageName = nextStage;
        appendRouteEntry(updatedData, {
          nodeUrn: `conversations:${chatData.conversationName}:${nextStage}`,
          conversationUrn: `conversations:${chatData.conversationName}`,
          action: 'ENTER',
          trigger: { type: 'STAGE_TRANSITION', content: `next_stage: ${nextStage}` },
        });
      }

      // 2. Evaluate on_complete edges when the conversation ends
      //    (next_stage is null and we're at the last stage)
      if (!nextStage || nextStage === null) {
        // Find the agent's system memory to look up edges
        const memory = await ctx.db.memory.findUnique({ where: { id: chatNode.memoryId } });
        const agentId = memory?.userMemoryOfAgentId;
        if (agentId) {
          const agent = await ctx.db.agent.findUnique({ where: { id: agentId } });
          const sysMemId = (agent as any)?.systemMemoryId as string | null;
          if (sysMemId) {
            // Find the current stage node and look for outgoing edges
            const currentStageLoc = `conversations:${chatData.conversationName}:${chatData.stageName}`;
            const stageNode = await ctx.db.node.findFirst({
              where: { memoryId: sysMemId, loc: currentStageLoc, deletedAt: null },
              select: { id: true },
            });
            if (stageNode) {
              const edges = await ctx.db.edge.findMany({
                where: { sourceId: stageNode.id, deletedAt: null },
                orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
                include: { target: { select: { loc: true, data: true } } },
              });
              // Load agent config once for the agent.* scope.
              const agentConfigNode = await ctx.db.node.findFirst({
                where: { memoryId: sysMemId, loc: 'config', deletedAt: null },
                select: { data: true },
              });
              const agentBag: Record<string, unknown> = {
                config: (agentConfigNode?.data as Record<string, unknown> | null) ?? {},
              };
              // Resolve the system memory's slug-path URN once so error-side
              // sourceNodeUrn composition stays canonical (urn:node:<mem>:<loc>)
              // instead of the legacy urn:memory:<PK>:<loc> form (issue #99).
              // TODO(#99-followup): this lookup-and-format pattern is now
              // duplicated with src/mcp/server.ts:nodeUrn(). Extract a shared
              // composer (likely a small package) per the audit's
              // recommendation in issue #99.
              const sysMem = await ctx.db.memory.findUnique({
                where: { id: sysMemId },
                select: { urn: true },
              });
              const sysMemUrn = sysMem?.urn ?? sysMemId;
              // Build the memory cascade for this turn:
              //   Layer A (defaults): agent's system memory — holds
              //     conversation/stage definitions and any agent-wide
              //     defaults under `loc: 'data'`. The source node lives
              //     here, so its parent-chain walk also happens here.
              //   Layer B (overrides): the user's per-user memory.
              //     Wins over Layer A on conflict (CSS cascade per spec
              //     FR-008/FR-009). For single-memory cases where the
              //     chat memory IS the system memory, we skip the
              //     duplicate layer.
              const memoryLayers: MemoryLayerHandle[] = [];
              memoryLayers.push(await buildPrismaMemoryLayer(
                ctx.db, 'edge-memory', sysMemId, currentStageLoc,
              ));
              if (chatNode.memoryId !== sysMemId) {
                memoryLayers.push(await buildPrismaMemoryLayer(
                  ctx.db, 'user-memory', chatNode.memoryId, currentStageLoc,
                ));
              }
              for (const edge of edges) {
                const edgeData = (edge.data as Record<string, unknown>) ?? {};
                const timing = edgeData.timing as string ?? 'on_complete';
                if (timing !== 'on_complete' && timing !== 'always') continue;

                // Evaluate the JSONLogic condition (Edge.condition column).
                // null = always fires.
                if (edge.condition !== null && edge.condition !== undefined) {
                  const evalResult = await evaluateEdgeCondition({
                    condition: edge.condition,
                    edge: {
                      id: edge.id,
                      sourceNodeUrn: formatUrn('node', `${sysMemUrn}:${currentStageLoc}`),
                    },
                    memoryLayers,
                    chat: {
                      message_count: messageCount,
                      conversation_name: chatData.conversationName,
                      stage: chatData.stageName,
                    },
                    agent: agentBag,
                    messageData: data ?? undefined,
                  });
                  if (!evalResult.ok) {
                    // FR-014/FR-015/FR-016: fail loud rather than silently
                    // firing or skipping the edge. Structured log carries
                    // edge id, field, memory URN, etc.; the user-facing
                    // message comes from the i18n-ready mapping.
                    console.error(
                      `[edge-conditions] evaluation failed`,
                      {
                        edgeId: edge.id,
                        code: evalResult.error.code,
                        message: evalResult.error.message,
                        detail: evalResult.error.detail,
                      },
                    );
                    const userMsg = userMessageFor(evalResult.error);
                    throw new GraphQLError(userMsg.text, {
                      extensions: {
                        code: 'EDGE_CONDITION_FAILED',
                        reason: evalResult.error.code,
                        messageId: userMsg.id,
                        detail: evalResult.error.detail,
                      },
                    });
                  }
                  if (!evalResult.fired) continue;
                }

                // Edge fires! Check behavior
                const targetLoc = edge.target?.loc;
                if (!targetLoc) continue;

                const behavior = edgeData.behavior as string ?? 'transition';

                if (targetLoc.startsWith('conversations:') && targetLoc.split(':').length === 2) {
                  // Target is a conversation — conversation handoff
                  const targetConvName = targetLoc.split(':')[1];

                  if (behavior === 'detour') {
                    // Push current goal, transition to the detour conversation
                    pushGoal(updatedData, {
                      description: (edgeData.label as string) ?? `Detour to ${targetConvName}`,
                      createdBy: 'ASSISTANT',
                      conversationUrn: targetLoc,
                    });
                  }

                  // Switch to the target conversation's first stage
                  const targetConv = await ctx.db.node.findFirst({
                    where: { memoryId: sysMemId, loc: targetLoc, deletedAt: null },
                    select: { data: true },
                  });
                  const targetConvData = (targetConv?.data as Record<string, unknown>) ?? {};
                  const targetStages = (targetConvData.stageOrder as string[]) ?? [];
                  const targetFirstStage = targetStages[0];

                  if (targetFirstStage) {
                    updatedData.conversationName = targetConvName;
                    updatedData.stageName = targetFirstStage;
                    conversationHandoff = targetConvName;
                    stageTransitioned = true;
                    newStageName = targetFirstStage;

                    appendRouteEntry(updatedData, {
                      conversationUrn: targetLoc,
                      nodeUrn: `${targetLoc}:${targetFirstStage}`,
                      action: 'ENTER',
                      edgeUrn: edge.id,
                      trigger: {
                        type: behavior === 'detour' ? 'DETOUR_EDGE' : 'TRANSITION_EDGE',
                        content: (edgeData.label as string) ?? undefined,
                      },
                    });
                  }
                  break; // Only follow one edge
                }
              }
            }
          }
        }
      }

      // 3. Track onTrack status
      if (onTrack === false) {
        updatedData.lastOffTrackReason = offTrackReason ?? 'unspecified';
        updatedData.lastOffTrackAt = new Date().toISOString();
      }

      const encUpdate = encryptNodeFields({ content: null, data: updatedData }, memEncInfo);
      await ctx.db.node.update({
        where: { id: chatNode.id },
        data: { data: (encUpdate.data ?? null) as InputJsonValue },
      });

      return {
        displayMessage: message,
        stageTransitioned,
        newStageName,
        conversationHandoff,
        chatEnded: false,
        onTrack: onTrack ?? true,
        offTrackReason: offTrackReason ?? null,
      };
    },

    saveChatSummary: async (
      _: unknown,
      { chatId, summary }: { chatId: string; summary: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      const chatNode = await ctx.db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);

      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) decryptNodeFields(chatNode, memEncInfo);

      const chatData = (chatNode.data as Record<string, unknown>) ?? {};
      const messageCount = (chatData.messageCount as number) ?? 0;
      const summaryName = `${String(messageCount).padStart(3, '0')}a-summary`;

      const encSummary = encryptNodeFields({ content: summary, data: null }, memEncInfo);
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${summaryName}`, name: summaryName,
          nodeType: 'abstract', content: encSummary.content ?? null, seq: messageCount + 1,
          tags: ['summary'],
        },
      });

      return true;
    },

    // ── Agent AI config (org ADMIN) ─────────────────────────────────

    updateAgentAIConfig: async (
      _: unknown,
      { agentId, provider, apiKey, model }: { agentId: string; provider: string; apiKey?: string | null; model: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      // If apiKey is provided, encrypt it and store a preview (last 4 chars).
      // If omitted/blank, keep the existing encrypted key.
      const keyData: Record<string, unknown> = {};
      if (apiKey) {
        keyData.aiApiKeyEncrypted = encryptToken(apiKey);
        keyData.aiApiKeyPreview = apiKey.length >= 4 ? '…' + apiKey.slice(-4) : '…';
      } else if (!agent.aiApiKeyEncrypted) {
        throw new Error('API key is required when no key is saved yet');
      }
      return ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: {
          aiProvider: provider,
          aiModel: model,
          ...keyData,
          updatedBy: ctx.userId ?? null,
        },
        include: AGENT_INCLUDE,
      });
    },

    clearAgentAIConfig: async (_: unknown, { agentId }: { agentId: string }, ctx: Context) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      return ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: {
          aiProvider: null,
          aiModel: null,
          aiApiKeyEncrypted: null,
          aiApiKeyPreview: null,
          updatedBy: ctx.userId ?? null,
        },
        include: AGENT_INCLUDE,
      });
    },

    // ── Chatbot revisions ─────────────────────────────────────────────

    createRevision: async (
      _: unknown,
      { agentId, description }: { agentId: string; description?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      const sysMemId = (agent as any).systemMemoryId as string;
      if (!sysMemId) throw new Error('Agent has no system memory');

      // Snapshot all non-revision nodes + edges in the system memory
      const nodes = await ctx.db.node.findMany({
        where: { memoryId: sysMemId, deletedAt: null, NOT: { loc: { startsWith: 'revisions' } } },
        select: { loc: true, name: true, nodeType: true, description: true, content: true, data: true, tags: true },
      });
      const nodeIds = (await ctx.db.node.findMany({
        where: { memoryId: sysMemId, deletedAt: null, NOT: { loc: { startsWith: 'revisions' } } },
        select: { id: true },
      })).map((n) => n.id);
      const edges = await ctx.db.edge.findMany({
        where: { sourceId: { in: nodeIds }, deletedAt: null },
        include: { source: { select: { loc: true } }, target: { select: { loc: true } } },
      });
      const edgeSnapshots = edges.map((e) => ({
        sourceLoc: e.source.loc,
        targetLoc: e.target.loc,
        label: e.label,
        data: e.data,
      }));

      // Count existing revisions to auto-increment
      const existingRevisions = await ctx.db.node.count({
        where: { memoryId: sysMemId, loc: { startsWith: 'revisions:' }, deletedAt: null },
      });
      const revNum = existingRevisions + 1;
      const label = `rev-${revNum}`;
      const revLoc = `revisions:${label}`;

      // Ensure revisions parent exists
      try {
        await ctx.db.node.upsert({
          where: { loc_memoryId: { loc: 'revisions', memoryId: sysMemId } },
          create: { id: generateId(), memoryId: sysMemId, loc: 'revisions', name: 'revisions', nodeType: 'system' },
          update: {},
        });
      } catch { /* exists */ }

      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: sysMemId, loc: revLoc, name: label,
          nodeType: 'system',
          description: description ?? `Revision ${revNum}`,
          data: {
            revision: revNum,
            label,
            published: false,
            createdBy: ctx.userId ?? null,
            snapshot: { nodes: nodes.map((n) => ({ ...n, tags: n.tags ?? [] })), edges: edgeSnapshots },
          } as InputJsonValue,
        },
      });

      return { revisionLoc: revLoc, label, published: false, createdAt: new Date().toISOString() };
    },

    publishRevision: async (
      _: unknown,
      { agentId, revisionLoc, versionLabel }: { agentId: string; revisionLoc: string; versionLabel?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      const sysMemId = (agent as any).systemMemoryId as string;
      if (!sysMemId) throw new Error('Agent has no system memory');

      const revNode = await ctx.db.node.findFirst({
        where: { memoryId: sysMemId, loc: revisionLoc, deletedAt: null },
      });
      if (!revNode) throw new Error(`Revision "${revisionLoc}" not found`);

      const revData = (revNode.data as Record<string, unknown>) ?? {};
      const label = versionLabel ?? (revData.label as string) ?? revisionLoc;

      // Mark as published
      await ctx.db.node.update({
        where: { id: revNode.id },
        data: { data: { ...revData, published: true, publishedAt: new Date().toISOString(), versionLabel: label } as InputJsonValue },
      });

      // Update agent to point to this revision
      await ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: { publishedRevisionLoc: revisionLoc },
      });

      return { revisionLoc, label, published: true, createdAt: new Date().toISOString() };
    },

    restoreRevision: async (
      _: unknown,
      { agentId, revisionLoc }: { agentId: string; revisionLoc: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      const sysMemId = (agent as any).systemMemoryId as string;
      if (!sysMemId) throw new Error('Agent has no system memory');

      const revNode = await ctx.db.node.findFirst({
        where: { memoryId: sysMemId, loc: revisionLoc, deletedAt: null },
      });
      if (!revNode) throw new Error(`Revision "${revisionLoc}" not found`);

      const revData = (revNode.data as Record<string, unknown>) ?? {};
      const snapshot = revData.snapshot as { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } | undefined;
      if (!snapshot) throw new Error('Revision has no snapshot data');

      // Auto-save current state before restoring
      await resolvers.Mutation.createRevision({}, { agentId: resolvedAgentId, description: `Auto-save before restoring ${revisionLoc}` }, ctx);

      // Delete all current non-revision nodes in the system memory
      await ctx.db.node.updateMany({
        where: {
          memoryId: sysMemId,
          deletedAt: null,
          NOT: { loc: { startsWith: 'revisions' } },
        },
        data: { deletedAt: new Date() },
      });

      // Delete all edges in the system memory
      const currentNodeIds = (await ctx.db.node.findMany({
        where: { memoryId: sysMemId },
        select: { id: true },
      })).map((n) => n.id);
      await ctx.db.edge.updateMany({
        where: { sourceId: { in: currentNodeIds }, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // Restore nodes from snapshot (upsert to handle soft-deleted rows
      // that still hold the unique (loc, memoryId) constraint)
      const locToId = new Map<string, string>();
      for (const n of snapshot.nodes) {
        const loc = n.loc as string;
        const nodeData = {
          name: n.name as string,
          nodeType: (n.nodeType as string) ?? 'system',
          description: (n.description as string) ?? null,
          content: (n.content as string) ?? null,
          data: (n.data ?? null) as InputJsonValue,
          tags: (n.tags as string[]) ?? [],
          deletedAt: null,
        };
        const upserted = await ctx.db.node.upsert({
          where: { loc_memoryId: { loc, memoryId: sysMemId } },
          create: { id: generateId(), memoryId: sysMemId, loc, ...nodeData },
          update: nodeData,
        });
        locToId.set(loc, upserted.id);
      }

      // Restore edges from snapshot
      for (const e of snapshot.edges) {
        const sourceId = locToId.get(e.sourceLoc as string);
        const targetId = locToId.get(e.targetLoc as string);
        if (sourceId && targetId) {
          await ctx.db.edge.create({
            data: {
              id: generateId(),
              sourceId,
              targetId,
              label: (e.label as string) ?? '',
              data: (e.data ?? null) as InputJsonValue,
            },
          });
        }
      }

      return { revisionLoc, label: (revData.label as string) ?? revisionLoc, published: false, createdAt: new Date().toISOString() };
    },

    // ── Editor lock ────────────────────────────────────────────────────

    acquireEditorLock: async (
      _: unknown,
      { agentId }: { agentId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');

      const now = new Date();
      const lockExpiry = (agent as any).editorLockExpiresAt as Date | null;
      const lockUser = (agent as any).editorLockUserId as string | null;

      // If locked by someone else and not expired, reject
      if (lockUser && lockUser !== ctx.userId && lockExpiry && lockExpiry > now) {
        return { locked: false, lockedBy: lockUser, expiresAt: lockExpiry.toISOString() };
      }

      // Acquire or renew lock (5 minutes)
      const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
      await ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: { editorLockUserId: ctx.userId, editorLockExpiresAt: expiresAt },
      });

      return { locked: true, lockedBy: ctx.userId, expiresAt: expiresAt.toISOString() };
    },

    releaseEditorLock: async (
      _: unknown,
      { agentId }: { agentId: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: agentId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');

      await ctx.db.agent.update({
        where: { id: resolvedAgentId },
        data: { editorLockUserId: null, editorLockExpiresAt: null },
      });
      return true;
    },

    // ── Chat ownership mutations ────────────────────────────────────

    updateChatTitle: async (
      _: unknown,
      { chatId, title }: { chatId: string; title: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const chatNode = await ctx.db.node.findFirst({
        where: { loc: chatId, deletedAt: null },
      });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);
      // Spec 017 — write-ownership is author-only regardless of scope
      // (per design-discussion D7). A non-author AppMember of a shared
      // chat can read it but not rename it.
      const isAdmin = !!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'));
      const isAuthor = chatNode.createdBy === ctx.userId;
      if (!isAdmin && !isAuthor) {
        // Legacy fallback: pre-feature chats may not have createdBy set
        // on the chat-root node (it was added later). Fall back to the
        // historical "memory owner" check for those.
        if (chatNode.createdBy === null) {
          const legacyMem = await ctx.db.memory.findUniqueOrThrow({
            where: { id: chatNode.memoryId },
            select: { createdBy: true },
          });
          if (legacyMem.createdBy !== ctx.userId) throw new Error('Forbidden');
        } else {
          throw new Error('Forbidden');
        }
      }
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, chatNode.memoryId);
      if (memEncInfo.isEncrypted) decryptNodeFields(chatNode, memEncInfo);
      const chatData = (chatNode.data as Record<string, unknown>) ?? {};
      const updated = { ...chatData, title: title.trim() };
      const enc = encryptNodeFields({ content: null, data: updated }, memEncInfo);
      await ctx.db.node.update({
        where: { id: chatNode.id },
        data: { data: (enc.data ?? null) as InputJsonValue },
      });
      return true;
    },

    deleteChat: async (_: unknown, { chatId }: { chatId: string }, ctx: Context) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      const chatNode = await ctx.db.node.findFirst({
        where: { loc: chatId, deletedAt: null },
      });
      if (!chatNode) throw new Error(`Chat "${chatId}" not found`);
      // Spec 017 — author-only deletion (D7). Legacy fallback to
      // memory owner for pre-feature chats that lack chat-root createdBy.
      const isAdmin = !!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'));
      const isAuthor = chatNode.createdBy === ctx.userId;
      if (!isAdmin && !isAuthor) {
        if (chatNode.createdBy === null) {
          const legacyMem = await ctx.db.memory.findUniqueOrThrow({
            where: { id: chatNode.memoryId },
            select: { createdBy: true },
          });
          if (legacyMem.createdBy !== ctx.userId) throw new Error('Forbidden');
        } else {
          throw new Error('Forbidden');
        }
      }
      // Soft-delete the chat node and all its message children by loc prefix
      await ctx.db.node.updateMany({
        where: {
          memoryId: chatNode.memoryId,
          OR: [
            { id: chatNode.id },
            { loc: { startsWith: `${chatId}:` } },
          ],
        },
        data: { deletedAt: new Date(), deletedBy: ctx.userId },
      });
      return true;
    },

    // ── App management (org ADMIN) ──────────────────────────────────

    createApp: async (
      _: unknown,
      {
        orgId,
        agentId,
        name,
        urn,
        appType,
        role,
        description,
        systemPrompt,
        agentTools,
        aiProvider,
        aiModel,
        aiApiKey,
        expiresAt,
        surfaces,
        trainingMode,
        installOptional,
        // App-original fields
        createUserPermission,
        identifyUserMethod,
        sessionTimeoutSeconds,
        anonymousTtlDays,
      }: {
        orgId: string;
        agentId: string;
        name: string;
        urn?: string;
        appType?: AppType;
        role?: AppMembershipRole;
        description?: string;
        systemPrompt?: string;
        agentTools?: string[];
        aiProvider?: string;
        aiModel?: string;
        aiApiKey?: string;
        expiresAt?: string;
        surfaces?: string[];
        trainingMode?: boolean;
        installOptional?: string[];
        createUserPermission?: 'DENY' | 'EXPLICIT' | 'IMPLICIT';
        identifyUserMethod?: 'USER_ID' | 'SECRET';
        sessionTimeoutSeconds?: number;
        anonymousTtlDays?: number;
      },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: orgId may be ID, bare URN, or prefixed URN.
      const { id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId);
      await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      // URN format matches memories and agents: "{org.urn}:{slug}".
      // If the caller provides an explicit slug use it; otherwise derive from
      // the name (lowercase, non-alphanum → hyphens, trimmed).
      const org = await ctx.db.organization.findUniqueOrThrow({
        where: { id: resolvedOrgId }, select: { urn: true },
      });
      const slug = (urn ?? name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!slug) throw new Error('App URN slug cannot be empty');
      const appUrn = `${org.urn}:${slug}`;

      // 009-install-agent-flow: agentId is required (typeDef gate). Resolve
      // the Agent (resolveAgentRef rejects soft-deleted Agents with
      // AgentNotFoundError). Per 009 spec FR-009, the cross-org install
      // restriction is enforced at the *portal* layer (the Install affordance
      // is hidden for non-owned Agents), not at the server. Server-side
      // auto-provisioning of AgentOrgGrant is retained from 008 to preserve
      // the existing 008 test surface and the future marketplace path —
      // tightening to a hard server gate is reserved for the marketplace spec.
      const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, agentId);
      await ensureAgentOrgGrant(ctx.db, resolvedOrgId, resolvedAgentId);

      // Hard-delete a soft-deleted collision so the URN can be reused
      // (same pattern as createAgent/createMemory).
      //
      // Spec 021 FR-027: App.urn is no longer globally unique — the
      // partial unique index `apps_urn_active_uniq` only enforces
      // uniqueness on rows where `uninstalled_at IS NULL`. Resolve the
      // active row via `findFirst` with the active-row filter so
      // uninstalled history rows sharing the same URN don't surface
      // here.
      const existing = await ctx.db.app.findFirst({
        where: { urn: appUrn, uninstalledAt: null },
      });
      if (existing) {
        if (existing.deletedAt) {
          await ctx.db.app.delete({ where: { id: existing.id } });
        } else {
          throw new Error(`An app with URN "${appUrn}" already exists`);
        }
      }
      // 023-app-shape Phase 2b: App↔Agent moved from `App.agentId` to the
      // N:M `AppAgent` join. Create the App, then immediately link the
      // requested Agent via an AppAgent row.
      const createdApp = await ctx.db.app.create({
        data: {
          organizationId: resolvedOrgId,
          name,
          urn: appUrn,
          surfaces: surfaces ?? undefined, // undefined → use the schema default ['chat']
          trainingMode: trainingMode ?? false,
          appType: appType ?? 'WORKSTATION',
          role: role ?? 'READER',
          description: description ?? null,
          systemPrompt: systemPrompt ?? null,
          agentTools: agentTools ?? [],
          aiProvider: aiProvider ?? null,
          aiModel: aiModel ?? null,
          aiApiKeyEncrypted: aiApiKey ? encryptToken(aiApiKey) : null,
          expiresAt: expiresAt ? new Date(expiresAt) : undefined,
          createUserPermission: createUserPermission ?? 'EXPLICIT',
          identifyUserMethod: identifyUserMethod ?? 'USER_ID',
          sessionTimeoutSeconds: sessionTimeoutSeconds ?? 900,
          anonymousTtlDays: anonymousTtlDays ?? 7,
          createdBy: ctx.userId ?? null,
          appAgents: { create: { agentId: resolvedAgentId, createdBy: ctx.userId ?? null } },
        },
        include: APP_INCLUDE,
      });

      // 008-agent-installation T059: cascade-install required deps.
      // Walk AgentImport rows for the parent and install each one as its own
      // App (or reuse an existing App in the same org for the same dep).
      // Required imports always cascade; optional imports cascade only when
      // their id appears in `installOptional`.
      // 009-install-agent-flow: the outer `if (resolvedAgentId)` guard is
      // dropped — agentId is always present post-009.
      {
        const imports = await ctx.db.agentImport.findMany({
          where: { parentAgentId: resolvedAgentId },
          orderBy: { position: 'asc' },
        });

        // Resolve `installOptional` URNs/ids to canonical ids so callers
        // can pass either form.
        const optionalIds = new Set<string>();
        if (installOptional && installOptional.length > 0) {
          for (const ref of installOptional) {
            const { id } = await resolveAgentRef(ctx.db, ref);
            optionalIds.add(id);
          }
        }

        for (const imp of imports) {
          const shouldInstall = imp.required || optionalIds.has(imp.importedAgentId);
          if (!shouldInstall) continue;

          // Reuse an existing App for the same (org, dep agent) — one App per
          // (org, Agent) pair (v1 doesn't support per-bundle namespacing of
          // dep installations, per spec User Story 3 acceptance scenario 4).
          const existingDepApp = await ctx.db.app.findFirst({
            where: {
              organizationId: resolvedOrgId,
              appAgents: { some: { agentId: imp.importedAgentId } },
              deletedAt: null,
            },
            select: { id: true },
          });
          if (existingDepApp) continue;

          // Auto-provision the AgentOrgGrant for the dep too — every App we
          // create is gated on having an active grant.
          await ensureAgentOrgGrant(ctx.db, resolvedOrgId, imp.importedAgentId);

          // Derive a sensible URN for the dep's App. Use the imported
          // Agent's slug; fall back to `dep-${id}` if the URN doesn't have
          // a slug suffix (defensive — all 008-shape Agents have URNs).
          const depAgent = await ctx.db.agent.findUniqueOrThrow({
            where: { id: imp.importedAgentId },
            select: { name: true, urn: true },
          });
          const depSlug =
            depAgent.urn.split(':').slice(1).join(':') || `dep-${imp.importedAgentId}`;
          let depUrn = `${org.urn}:${depSlug}`;
          // If the URN happens to collide with a soft-deleted App, hard-delete
          // it (same pattern as the parent App branch above). For non-deleted
          // collisions, append the imported-agent id as a disambiguator.
          // Spec 021 FR-027: active-row resolution (uninstalled history rows
          // sharing this URN don't count as a collision).
          const depCollision = await ctx.db.app.findFirst({
            where: { urn: depUrn, uninstalledAt: null },
          });
          if (depCollision) {
            if (depCollision.deletedAt) {
              await ctx.db.app.delete({ where: { id: depCollision.id } });
            } else {
              depUrn = `${depUrn}:${imp.importedAgentId.slice(-8)}`;
            }
          }

          await ctx.db.app.create({
            data: {
              organizationId: resolvedOrgId,
              name: `${depAgent.name} (cascaded from ${name})`,
              urn: depUrn,
              surfaces: ['chat'], // dep installs default to chat surface
              trainingMode: false,
              createdBy: ctx.userId ?? null,
              appAgents: {
                create: { agentId: imp.importedAgentId, createdBy: ctx.userId ?? null },
              },
            },
          });
        }
      }

      // 009-install-agent-flow T015: the installer is auto-added as an
      // AppMember with role 'owner' when the Agent's installationPolicy
      // permits it. Routed through ensureAppMember so the memberRoles +
      // maxMembers invariants from 008 R-7 are honored (a raw upsert would
      // bypass them — see hadron-server#98 review).
      //
      // Some Agents customize `memberRoles` without 'owner' (e.g.,
      // ['principal', 'guide']); in that case the install still succeeds
      // but no auto-membership is granted — the installer can add
      // themselves explicitly via ensureAppMember with a role from the
      // policy. ctx.userId is guaranteed by the upstream requireOrgRole
      // check.
      const installerAgent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: resolvedAgentId },
        select: { installationPolicy: true },
      });
      const allowedRoles = (installerAgent.installationPolicy as { memberRoles?: string[] })
        ?.memberRoles ?? ['owner'];
      if (allowedRoles.includes('owner')) {
        await ensureAppMember(ctx.db, createdApp.id, ctx.userId!, 'owner', {
          actorId: ctx.userId,
        });
      }

      return createdApp;
    },

    updateApp: async (
      _: unknown,
      {
        id,
        name,
        urn,
        appType,
        role,
        description,
        systemPrompt,
        agentTools,
        aiProvider,
        aiModel,
        aiApiKey,
        expiresAt,
        surfaces,
        trainingMode,
        // App-original fields
        createUserPermission,
        identifyUserMethod,
        sessionTimeoutSeconds,
        anonymousTtlDays,
      }: {
        id: string; name?: string; urn?: string;
        appType?: AppType;
        role?: AppMembershipRole;
        description?: string;
        systemPrompt?: string;
        agentTools?: string[];
        aiProvider?: string;
        aiModel?: string;
        aiApiKey?: string;
        expiresAt?: string;
        surfaces?: string[];
        trainingMode?: boolean;
        createUserPermission?: 'DENY' | 'EXPLICIT' | 'IMPLICIT';
        identifyUserMethod?: 'USER_ID' | 'SECRET';
        sessionTimeoutSeconds?: number;
        anonymousTtlDays?: number;
      },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveAppRef(ctx.db, id);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      // URN updates: accept a new slug and rebuild the full URN against the
      // app's current org.
      let newUrn: string | undefined;
      if (urn !== undefined) {
        const org = await ctx.db.organization.findUniqueOrThrow({
          where: { id: app.organizationId }, select: { urn: true },
        });
        const slug = urn
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (!slug) throw new Error('App URN slug cannot be empty');
        newUrn = `${org.urn}:${slug}`;
      }
      return ctx.db.app.update({
        where: { id: resolvedId },
        data: {
          ...(name !== undefined ? { name } : {}),
          ...(newUrn !== undefined ? { urn: newUrn } : {}),
          ...(appType !== undefined ? { appType } : {}),
          ...(role !== undefined ? { role } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(systemPrompt !== undefined ? { systemPrompt } : {}),
          ...(agentTools !== undefined ? { agentTools } : {}),
          ...(aiProvider !== undefined ? { aiProvider } : {}),
          ...(aiModel !== undefined ? { aiModel } : {}),
          ...(aiApiKey !== undefined ? { aiApiKeyEncrypted: aiApiKey ? encryptToken(aiApiKey) : null } : {}),
          ...(expiresAt !== undefined ? { expiresAt: expiresAt ? new Date(expiresAt) : null } : {}),
          ...(surfaces !== undefined ? { surfaces } : {}),
          ...(trainingMode !== undefined ? { trainingMode } : {}),
          ...(createUserPermission !== undefined ? { createUserPermission } : {}),
          ...(identifyUserMethod !== undefined ? { identifyUserMethod } : {}),
          ...(sessionTimeoutSeconds !== undefined ? { sessionTimeoutSeconds } : {}),
          ...(anonymousTtlDays !== undefined ? { anonymousTtlDays } : {}),
          updatedBy: ctx.userId ?? null,
        },
        include: APP_INCLUDE,
      });
    },

    deleteApp: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: resolvedId } = await resolveAppRef(ctx.db, id);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedId } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      await ctx.db.app.update({ where: { id: resolvedId }, data: { deletedAt: new Date() } });
      return true;
    },

    installAgentIntoApp: async (
      _: unknown,
      {
        appId,
        agentId,
        trainingMode,
      }: { appId: string; agentId: string; trainingMode?: boolean },
      ctx: Context,
    ) => {
      const { appAgent } = await installAgentIntoAppCore(ctx, {
        appId,
        agentId,
        trainingMode,
      });
      return { appAgent };
    },

    uninstallAgentFromApp: async (
      _: unknown,
      { appId, agentId }: { appId: string; agentId: string },
      ctx: Context,
    ) => {
      const result = await uninstallAgentFromAppCore(ctx, { appId, agentId });
      return { appId: result.appId, agentId: result.agentId };
    },

    // DEPRECATED — pre-023 callers. Delegates to installAgentIntoAppCore
    // and returns the App for source-compat.
    addAgentToApp: async (
      _: unknown,
      {
        appId,
        agentId,
        trainingMode,
      }: { appId: string; agentId: string; trainingMode?: boolean },
      ctx: Context,
    ) => {
      const { appId: resolvedAppId } = await installAgentIntoAppCore(ctx, {
        appId,
        agentId,
        trainingMode,
      });
      return ctx.db.app.findUniqueOrThrow({
        where: { id: resolvedAppId },
        include: APP_INCLUDE,
      });
    },

    // DEPRECATED — pre-023 callers. Delegates to uninstallAgentFromAppCore
    // and returns the App for source-compat.
    removeAgentFromApp: async (
      _: unknown,
      { appId, agentId }: { appId: string; agentId: string },
      ctx: Context,
    ) => {
      const { appId: resolvedAppId } = await uninstallAgentFromAppCore(ctx, { appId, agentId });
      return ctx.db.app.findUniqueOrThrow({
        where: { id: resolvedAppId },
        include: APP_INCLUDE,
      });
    },

    // 008-agent-installation: AppMember management. Per spec FR-004 / FR-016
    // and contracts/agent-app-graphql.md "ensureAppMember".
    ensureAppMember: async (
      _: unknown,
      { appId, userId, role }: { appId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: appId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });

      // Authorization: ADMIN/OWNER of the App's owning org, OR an existing
      // owner-role AppMember. Self-service joins are not allowed in v1.
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        const orgMember = await ctx.db.orgMember.findFirst({
          where: {
            organizationId: app.organizationId,
            userId: ctx.userId ?? '',
            deletedAt: null,
            role: { in: ['ADMIN', 'OWNER'] },
          },
        });
        if (!orgMember) {
          const ownerMember = ctx.userId
            ? await ctx.db.appMember.findUnique({
                where: { appId_userId: { appId: resolvedAppId, userId: ctx.userId } },
              })
            : null;
          if (!ownerMember || ownerMember.role !== 'owner') {
            throw new Error('Forbidden: only org admins or App owners can manage members');
          }
        }
      }

      try {
        await ensureAppMember(ctx.db, resolvedAppId, userId, role, {
          actorId: ctx.userId ?? null,
        });
      } catch (e: unknown) {
        // Surface typed errors with their canonical messages so the portal
        // can render plain-language banners (Constitution Principle III).
        if (
          e instanceof InvalidRoleError ||
          e instanceof MaxMembersExceededError ||
          e instanceof OrphanAppError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }

      return ctx.db.appMember.findUniqueOrThrow({
        where: { appId_userId: { appId: resolvedAppId, userId } },
      });
    },

    // 008-agent-installation: removeAppMember. Idempotent — a missing row
    // returns true (no-op). Personal-class Memory at (appId, userId) is
    // retained as an orphan per FR-015.
    removeAppMember: async (
      _: unknown,
      { appId, userId }: { appId: string; userId: string },
      ctx: Context,
    ) => {
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });

      // Authorization: same gate as ensureAppMember, plus self-removal —
      // a member can remove themselves at any time without org/owner role.
      const isSelfRemoval = ctx.userId === userId;
      if (!isSelfRemoval) {
        const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
        if (!isPlatformAdmin) {
          const orgMember = await ctx.db.orgMember.findFirst({
            where: {
              organizationId: app.organizationId,
              userId: ctx.userId ?? '',
              deletedAt: null,
              role: { in: ['ADMIN', 'OWNER'] },
            },
          });
          if (!orgMember) {
            const ownerMember = ctx.userId
              ? await ctx.db.appMember.findUnique({
                  where: { appId_userId: { appId: resolvedAppId, userId: ctx.userId } },
                })
              : null;
            if (!ownerMember || ownerMember.role !== 'owner') {
              throw new Error('Forbidden: only org admins, App owners, or the user themselves can remove members');
            }
          }
        }
      }

      await ctx.db.appMember
        .delete({ where: { appId_userId: { appId: resolvedAppId, userId } } })
        .catch(() => {}); // idempotent: missing row → no-op
      return true;
    },

    // 023-app-shape US2: self-service user-level install. The
    // currently-logged-in user joins the App as an AppMember.
    //
    // **No OrgMember check** (FR-009) — this is the affordance that
    // unlocks B2C / therapy / consumer use cases. Maxmembers + role
    // validation are delegated to `joinApp` → `ensureAppMember`.
    joinApp: async (
      _: unknown,
      { appId }: { appId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('joinApp requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      // resolveAppRef rejects soft-deleted Apps; the controller layer
      // additionally rejects via AppNotFoundError (race after
      // resolveAppRef) and AppUninstalledError. All lifecycle checks
      // live in the controller so direct callers get them too. The
      // try/catch covers both resolveAppRef + joinApp because
      // resolveAppRef can throw the typed errors we want to surface.
      let resolvedAppId: string;
      try {
        ({ id: resolvedAppId } = await resolveAppRef(ctx.db, appId));
        await joinApp(ctx.db, { appId: resolvedAppId, userId: ctx.userId });
      } catch (e: unknown) {
        // Surface typed errors with their canonical messages (Constitution
        // Principle III — plain-language banner-friendly).
        if (
          e instanceof InvalidRoleError ||
          e instanceof MaxMembersExceededError ||
          e instanceof OrphanAppError ||
          e instanceof NoMemberRolesError ||
          e instanceof AppNotFoundError ||
          e instanceof AppUninstalledError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }
      const appMember = await ctx.db.appMember.findUniqueOrThrow({
        where: { appId_userId: { appId: resolvedAppId, userId: ctx.userId } },
      });
      return { appMember };
    },

    // 023-app-shape US2: self-service user-level uninstall. The
    // currently-logged-in user leaves an App. Idempotent.
    leaveApp: async (
      _: unknown,
      { appId }: { appId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('leaveApp requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      await leaveApp(ctx.db, { appId: resolvedAppId, userId: ctx.userId });
      return { appId: resolvedAppId, userId: ctx.userId };
    },

    // 023-app-shape US3 — create / upsert a MemoryShare on a
    // personal-class Memory. The caller MUST be the principal
    // (memory.userId) in v1; the Agent-mediated path is deferred.
    createMemoryShare: async (
      _: unknown,
      {
        memoryId,
        granteeId,
        role,
      }: { memoryId: string; granteeId: string; role: MemoryShareRoleType },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('createMemoryShare requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      await requireMemorySharePrincipal(ctx, memoryId);
      try {
        const memoryShare = await createMemoryShare(ctx.db, {
          memoryId,
          granteeId,
          role,
          actorId: ctx.userId,
        });
        return { memoryShare };
      } catch (e: unknown) {
        if (
          e instanceof InvalidMemoryClassForShareError ||
          e instanceof MemoryNotFoundForShareError ||
          e instanceof MemoryShareGranteeMissingError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }
    },

    // 023-app-shape US3 — revoke an existing MemoryShare. Idempotent.
    revokeMemoryShare: async (
      _: unknown,
      { memoryId, granteeId }: { memoryId: string; granteeId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('revokeMemoryShare requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      await requireMemorySharePrincipal(ctx, memoryId);
      await revokeMemoryShare(ctx.db, { memoryId, granteeId });
      return { memoryId, granteeId };
    },

    // 023-app-shape US3 — change the role on an existing MemoryShare.
    // Throws MemoryShareNotFoundError when the row doesn't exist
    // (use createMemoryShare to upsert).
    updateMemoryShareRole: async (
      _: unknown,
      {
        memoryId,
        granteeId,
        role,
      }: { memoryId: string; granteeId: string; role: MemoryShareRoleType },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError('updateMemoryShareRole requires an authenticated user', {
          extensions: { code: 'UNAUTHENTICATED' },
        });
      }
      await requireMemorySharePrincipal(ctx, memoryId);
      try {
        const memoryShare = await updateMemoryShareRole(ctx.db, {
          memoryId,
          granteeId,
          role,
          actorId: ctx.userId,
        });
        return { memoryShare };
      } catch (e: unknown) {
        if (e instanceof MemoryShareNotFoundError) {
          throw new GraphQLError(e.message, {
            extensions: { code: e.name },
          });
        }
        throw e;
      }
    },

    // 023-app-shape US4 — add a team member to a group-class memory.
    // Caller MUST be an existing owner of the memory.
    addMemoryMember: async (
      _: unknown,
      {
        memoryId,
        userId,
        role,
      }: { memoryId: string; userId: string; role: MemoryMemberRoleType },
      ctx: Context,
    ) => {
      await requireMemoryMemberOwner(ctx, memoryId);
      try {
        const memoryMember = await addMemoryMember(ctx.db, {
          memoryId,
          userId,
          role,
          actorId: ctx.userId!,
        });
        return { memoryMember };
      } catch (e: unknown) {
        if (
          e instanceof InvalidMemoryClassForMemberError ||
          e instanceof MemoryNotFoundForMemberError ||
          e instanceof MemoryMemberUserMissingError ||
          e instanceof LastOwnerProtectedError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }
    },

    // 023-app-shape US4 — change the role on a team member. Enforces
    // FR-038 last-owner protection.
    updateMemoryMemberRole: async (
      _: unknown,
      {
        memoryId,
        userId,
        role,
      }: { memoryId: string; userId: string; role: MemoryMemberRoleType },
      ctx: Context,
    ) => {
      await requireMemoryMemberOwner(ctx, memoryId);
      try {
        const memoryMember = await updateMemoryMemberRole(ctx.db, {
          memoryId,
          userId,
          role,
          actorId: ctx.userId!,
        });
        return { memoryMember };
      } catch (e: unknown) {
        if (
          e instanceof MemoryMemberNotFoundError ||
          e instanceof InvalidMemoryClassForMemberError ||
          e instanceof MemoryNotFoundForMemberError ||
          e instanceof LastOwnerProtectedError
        ) {
          throw new GraphQLError((e as Error).message, {
            extensions: { code: (e as Error).name },
          });
        }
        throw e;
      }
    },

    // 023-app-shape US4 — remove a team member. Owner OR self-removal.
    // Enforces FR-038 last-owner protection.
    removeMemoryMember: async (
      _: unknown,
      { memoryId, userId }: { memoryId: string; userId: string },
      ctx: Context,
    ) => {
      await requireMemoryMemberOwnerOrSelf(ctx, memoryId, userId);
      try {
        return await removeMemoryMember(ctx.db, { memoryId, userId });
      } catch (e: unknown) {
        if (e instanceof LastOwnerProtectedError) {
          throw new GraphQLError(e.message, {
            extensions: { code: e.name },
          });
        }
        throw e;
      }
    },

    // 008-agent-installation: AgentImport bundling. Per spec FR-005 +
    // contracts/agent-app-graphql.md "publishAgentImport".
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

    createAppKey: async (
      _: unknown,
      { appId, label }: { appId: string; label?: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: appId may be ID, bare URN, or prefixed URN.
      const { id: resolvedAppId } = await resolveAppRef(ctx.db, appId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      // Raw key format: hdr_app_<64 hex chars> (256 bits of entropy)
      const rawKey = APP_KEY_PREFIX + randomBytes(32).toString('hex');
      const keyHash = hashAppKey(rawKey);
      const keyPreview = rawKey.slice(0, 12) + '...' + rawKey.slice(-4);
      const appKey = await ctx.db.appKey.create({
        data: {
          appId: resolvedAppId,
          keyHash,
          keyPreview,
          label: label ?? null,
          createdBy: ctx.userId ?? null,
        },
      });
      return { key: appKey, rawKey };
    },

    revokeAppKey: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const key = await ctx.db.appKey.findUniqueOrThrow({
        where: { id },
        include: { app: true },
      });
      await requireOrgRole(ctx, key.app.organizationId, 'ADMIN');
      await ctx.db.appKey.update({ where: { id }, data: { revokedAt: new Date() } });
      return true;
    },

    // 025-oauth-for-mcp FR-004: mint a user-scoped API key. Self-service
    // only — AppKey-resolved callers (no user in context) MUST be
    // rejected. The raw key is returned exactly once; only the hash is
    // persisted. `createdBy` is the actor's User.id (REV-2 reversal —
    // matches the schema-wide audit-actor convention); `issuedVia` is
    // the path discriminator (REV-2 — `'portal'` here, `'oauth:<id>'`
    // for /oauth/token-issued tokens in Phase 2).
    createUserApiKey: async (
      _: unknown,
      { label }: { label?: string | null },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError(
          'createUserApiKey requires a user-scoped credential; AppKey callers cannot mint user keys.',
          { extensions: { code: 'UNAUTHENTICATED' } },
        );
      }
      // Cap label length to prevent unbounded TEXT writes. The Prisma
      // column is uncapped; 200 chars is plenty for a human-readable
      // display name (e.g., "MacBook Air — Claude Desktop").
      if (label != null && label.length > USER_API_KEY_LABEL_MAX_LEN) {
        throw new GraphQLError(
          `Label exceeds ${USER_API_KEY_LABEL_MAX_LEN}-character limit.`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }
      // Single insert path shared with the OAuth /token endpoint
      // (FR-015) — both call mintUserApiKey so the prefix, entropy,
      // hashing primitive, and persisted-field shape never drift.
      const { rawKey, userApiKey } = await mintUserApiKey(ctx.db, {
        userId: ctx.userId,
        label: label ?? null,
        createdBy: ctx.userId,
        issuedVia: 'portal',
      });
      return { userApiKey, rawKey };
    },

    // 025-oauth-for-mcp FR-004: revoke a user-scoped API key. Returns
    // the updated row (D3 — was Boolean! in PR 137). Idempotent on
    // already-revoked keys.
    //
    // **Atomic + no-info-leak design** (PR #145 review):
    // - The updateMany-with-conditional pattern (`where: { id, userId,
    //   revokedAt: null }`) makes the write race-safe: under concurrent
    //   calls, only one wins the revokedAt timestamp; the loser's
    //   updateMany returns count=0 and no overwrite happens.
    // - Scoping the subsequent read to `{ id, userId }` collapses the
    //   cross-user case to NOT_FOUND, closing the id-enumeration
    //   channel that a separate FORBIDDEN branch would have opened
    //   (an attacker with a guess at someone else's key id would
    //   otherwise learn that the id exists).
    revokeUserApiKey: async (
      _: unknown,
      { id }: { id: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) {
        throw new GraphQLError(
          'revokeUserApiKey requires a user-scoped credential; AppKey callers cannot revoke user keys.',
          { extensions: { code: 'UNAUTHENTICATED' } },
        );
      }
      // Atomic conditional revoke: only flips revokedAt on rows that
      // (a) match the id, (b) are owned by the caller, AND
      // (c) are not already revoked. Returns count=0 for any
      // non-matching row, which we disambiguate below.
      await ctx.db.userApiKey.updateMany({
        where: { id, userId: ctx.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      // Read back via findFirst scoped to `{ id, userId }`. If the row
      // is missing, the id is either unknown OR belongs to a different
      // user — collapse both to NOT_FOUND. If present, return it
      // unchanged (idempotent path: revokedAt was already set, so
      // updateMany did nothing).
      const row = await ctx.db.userApiKey.findFirst({
        where: { id, userId: ctx.userId },
      });
      if (!row) {
        throw new GraphQLError(`UserApiKey ${id} not found.`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }
      return row;
    },

    // 005-agent-subscription FR-023 + FR-028 + FR-029: revoke a user's
    // AgentSubscription. ADMIN/OWNER of the Agent's owning org only.
    // Side effect: if the user's personal Memory of the Agent has zero
    // nodes, hard-delete it alongside the revocation (FR-029); otherwise
    // retain it (FR-028).
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

      // FR-029: empty personal Memory at revocation time → hard-delete.
      const personalMemory = await ctx.db.memory.findFirst({
        where: {
          userId,
          userMemoryOfAgentId: agentId,
          class: 'personal',
          deletedAt: null,
        },
        include: { _count: { select: { nodes: true } } },
      });
      if (personalMemory && personalMemory._count.nodes === 0) {
        await ctx.db.memory.delete({ where: { id: personalMemory.id } });
      }

      return updated;
    },

    // ── Multi-user-agent: identity and sessions (App Key auth) ──────

    createAppUser: async (
      _: unknown,
      { externalId, handle, name, email }: { externalId: string; handle?: string; name?: string; email?: string },
      ctx: Context,
    ) => {
      if (!ctx.appId) throw new Error('Forbidden: App Key required');
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: ctx.appId } });
      if (app.createUserPermission === 'DENY') {
        throw new Error('Forbidden: this app cannot create users');
      }
      // Idempotent: return existing user if already created under this app
      const existing = await ctx.db.user.findFirst({
        where: { externalAppId: ctx.appId, externalId, deletedAt: null },
      });
      if (existing) return existing;

      return ctx.db.user.create({
        data: {
          externalAppId: ctx.appId,
          externalId,
          identityProvider: 'APP',
          handle: handle ?? null,
          name: name ?? null,
          email: email ?? null,
          createdBy: ctx.appId,
        },
      });
    },

    startAgentSession: async (
      _: unknown,
      { agentId, externalUserId, sessionTimeoutSeconds, dataKey }: {
        agentId: string;
        externalUserId?: string;
        sessionTimeoutSeconds?: number;
        dataKey?: string;
      },
      ctx: Context,
    ) => {
      if (!ctx.appId) throw new Error('Forbidden: App Key required');
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: ctx.appId } });

      // 008: App→Agent is a direct FK; the App can operate exactly the Agent
      // referenced by App.agent_id (no AppAgent join). Orphan Apps (agent_id
      // IS NULL) cannot operate any agent.
      // 023-app-shape Phase 2b: App↔Agent goes through AppAgent. Check
      // that the requested Agent is installed in the calling App.
      if (!(await isAgentInstalled(ctx.db, app.id, agentId))) {
        throw new Error('Forbidden: App is not allowed to operate this agent');
      }

      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
      if (agent.deletedAt) throw new Error('Agent not found');

      // SECRET mode requires a data key; USER_ID mode rejects it.
      if (app.identifyUserMethod === 'SECRET' && !dataKey) {
        throw new Error('dataKey is required when the app uses identifyUserMethod: SECRET');
      }
      if (app.identifyUserMethod === 'USER_ID' && dataKey) {
        throw new Error('dataKey is only accepted when the app uses identifyUserMethod: SECRET');
      }

      const parsedKey: EncryptionKey | null = dataKey ? parseDataKey(dataKey) : null;

      // Resolve user (optional — null means anonymous session)
      let userId: string | null = null;
      if (externalUserId) {
        let user = await ctx.db.user.findFirst({
          where: { externalAppId: ctx.appId, externalId: externalUserId, deletedAt: null },
        });
        if (!user) {
          if (app.createUserPermission !== 'IMPLICIT') {
            throw new Error('User not found. Call createAppUser first or set createUserPermission=IMPLICIT.');
          }
          user = await ctx.db.user.create({
            data: {
              externalAppId: ctx.appId,
              externalId: externalUserId,
              identityProvider: 'APP',
              createdBy: ctx.appId,
            },
          });
        }
        userId = user.id;
      }

      // 005-agent-subscription FR-002: auto-provision an AgentSubscription
      // on the first user-attributed contact for (user, agent). Idempotent.
      if (userId) {
        await ensureAgentSubscription(ctx.db, userId, agentId);
      }

      // Find or lazily provision the user memory for (agent, user)
      let memoryId: string;
      let memoryIsEncrypted = false;
      if (userId) {
        const existing = await ctx.db.memory.findFirst({
          where: { userMemoryOfAgentId: agentId, createdBy: userId, deletedAt: null },
        });
        if (existing) {
          memoryId = existing.id;
          memoryIsEncrypted = existing.isEncrypted;
        } else {
          const org = await ctx.db.organization.findUniqueOrThrow({
            where: { id: agent.organizationId }, select: { urn: true },
          });
          const opaqueId = generateId();
          const memoryUrn = `${org.urn}:${agent.urn.split(':').slice(1).join(':')}:user:${opaqueId}`;
          const created = await ctx.db.memory.create({
            data: {
              organizationId: agent.organizationId,
              urn: memoryUrn,
              name: `User memory (${agent.name})`,
              // 005-agent-subscription: per-user memory keyed on userId.
              // Bidirectional CHECK constraint requires class IN
              // (personal,private) ⇔ userId IS NOT NULL.
              userId,
              class: 'personal',
              // 035-visibility-enum-cleanup: personal privacy is class-driven;
              // visibility is NULL (was PERSONAL).
              visibility: null,
              userMemoryOfAgentId: agentId,
              // 008-agent-installation: personal memories pivot on
              // (app_id, user_id). The chk_memory_class_app_id constraint
              // requires app_id when class IN ('app', 'personal').
              appId: ctx.appId,
              // New user memories in SECRET mode are encrypted from creation.
              isEncrypted: parsedKey !== null,
              createdBy: userId,
            },
          });
          memoryId = created.id;
          memoryIsEncrypted = parsedKey !== null;
        }
      } else {
        // Anonymous session — create a scratch memory with expiry. Anonymous
        // memories are always plaintext until linkMemoryToUser promotes them.
        const org = await ctx.db.organization.findUniqueOrThrow({
          where: { id: agent.organizationId }, select: { urn: true },
        });
        const opaqueId = generateId();
        const agentSlug = agent.urn.split(':').slice(1).join(':');
        const memoryUrn = `${org.urn}:${agentSlug}:anon:${opaqueId}`;
        const expires = new Date(Date.now() + app.anonymousTtlDays * 24 * 60 * 60 * 1000);
        const created = await ctx.db.memory.create({
          data: {
            organizationId: agent.organizationId,
            urn: memoryUrn,
            name: `Anonymous session (${agent.name})`,
            // Anonymous: no userId yet (linkMemoryToUser later may set
            // it); class is 'app' since the data belongs to the App's
            // bucket of records-through-this-agent until promoted.
            class: 'app',
            // 035-visibility-enum-cleanup: app-class visibility is NULL.
            visibility: null,
            userMemoryOfAgentId: agentId,
            // 008-agent-installation: app-class memories require app_id
            // (chk_memory_class_app_id).
            appId: ctx.appId,
            anonymousExpiresAt: expires,
            createdBy: ctx.appId,
          },
        });
        memoryId = created.id;
        memoryIsEncrypted = false;
      }

      // If the memory is encrypted, the caller must provide a matching key.
      // (In SECRET mode we already required a dataKey above; this check also
      // handles a later call with USER_ID mode on an already-encrypted mem.)
      if (memoryIsEncrypted && !parsedKey) {
        throw new Error('Memory is encrypted; dataKey is required');
      }

      // Clamp session timeout to the app's configured maximum (ceiling)
      const ttl = Math.min(
        sessionTimeoutSeconds ?? app.sessionTimeoutSeconds,
        app.sessionTimeoutSeconds,
      );
      const expiresAt = new Date(Date.now() + ttl * 1000);

      const session = await ctx.db.session.create({
        data: {
          id: generateId(),
          type: 'CHATBOT',
          appId: ctx.appId,
          userId: userId ?? null,
          agentId,
          memoryId,
          expiresAt,
          createdBy: ctx.appId,
        },
      });

      // Register the key in the session key cache so this session (and any
      // concurrent one for the same memory) can decrypt content.
      if (parsedKey) {
        sessionKeyCache.set(session.id, memoryId, parsedKey);
      }

      return session;
    },

    endAgentSession: async (_: unknown, { sessionId }: { sessionId: string }, ctx: Context) => {
      if (!ctx.appId) throw new Error('Forbidden: App Key required');
      const session = await ctx.db.session.findUnique({ where: { id: sessionId } });
      if (!session || session.appId !== ctx.appId) {
        throw new Error('Session not found');
      }
      if (session.endedAt) {
        sessionKeyCache.evict(sessionId); // defensive — idempotent
        return true;
      }
      await ctx.db.session.update({
        where: { id: sessionId },
        data: { endedAt: new Date() },
      });
      // Evict the data key from the in-memory cache. Ref counting means the
      // key stays available to any other active session on the same memory.
      sessionKeyCache.evict(sessionId);
      return true;
    },

    linkMemoryToUser: async (
      _: unknown,
      { memoryId, externalUserId, dataKey }: { memoryId: string; externalUserId: string; dataKey?: string },
      ctx: Context,
    ) => {
      if (!ctx.appId) throw new Error('Forbidden: App Key required');
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: ctx.appId } });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      if (memory.organizationId !== app.organizationId) {
        throw new Error('Forbidden: memory does not belong to this app\'s organization');
      }
      if (!memory.userMemoryOfAgentId) {
        throw new Error('Only user/anonymous memories can be linked');
      }

      // Resolve or create user
      let user = await ctx.db.user.findFirst({
        where: { externalAppId: ctx.appId, externalId: externalUserId, deletedAt: null },
      });
      if (!user) {
        if (app.createUserPermission === 'DENY') {
          throw new Error('User not found and createUserPermission=DENY');
        }
        user = await ctx.db.user.create({
          data: {
            externalAppId: ctx.appId,
            externalId: externalUserId,
            identityProvider: 'APP',
            createdBy: ctx.appId,
          },
        });
      }

      // Rewrite the URN from anon → user
      const agent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: memory.userMemoryOfAgentId },
      });
      const org = await ctx.db.organization.findUniqueOrThrow({
        where: { id: agent.organizationId }, select: { urn: true },
      });
      const opaqueId = generateId();
      const agentSlug = agent.urn.split(':').slice(1).join(':');
      const newUrn = `${org.urn}:${agentSlug}:user:${opaqueId}`;

      // If a dataKey is provided and the memory isn't already encrypted,
      // encrypt every node in a single transaction, then flip isEncrypted.
      // This is the anonymous → registered promotion path.
      if (dataKey && !memory.isEncrypted) {
        const key = parseDataKey(dataKey);
        const nodes = await ctx.db.node.findMany({
          where: { memoryId: resolvedMemoryId, deletedAt: null },
          select: { id: true, content: true, data: true },
        });
        await ctx.db.$transaction(async (tx) => {
          for (const node of nodes) {
            const encrypted = encryptNodeFieldsWithKey(
              { content: node.content, data: node.data },
              key,
            );
            await tx.node.update({
              where: { id: node.id },
              data: {
                content: encrypted.content ?? null,
                data: (encrypted.data ?? null) as InputJsonValue,
              },
            });
          }
          await tx.memory.update({
            where: { id: resolvedMemoryId },
            data: {
              urn: newUrn,
              createdBy: user.id,
              anonymousExpiresAt: null,
              isEncrypted: true,
              updatedBy: ctx.appId,
            },
          });
        });
        return ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      }

      return ctx.db.memory.update({
        where: { id: resolvedMemoryId },
        data: {
          urn: newUrn,
          createdBy: user.id,
          anonymousExpiresAt: null,
          updatedBy: ctx.appId,
        },
      });
    },

    encryptMemory: async (
      _: unknown,
      { memoryId, dataKey }: { memoryId: string; dataKey: string },
      ctx: Context,
    ) => {
      if (!ctx.appId) throw new Error('Forbidden: App Key required');
      // 007-entity-id-or-urn: memoryId may be ID, bare URN, or prefixed URN.
      const { id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, memoryId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: ctx.appId } });
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
      if (memory.organizationId !== app.organizationId) {
        throw new Error('Forbidden: memory does not belong to this app\'s organization');
      }
      if (memory.isEncrypted) {
        throw new Error('Memory is already encrypted');
      }
      const key = parseDataKey(dataKey);
      const nodes = await ctx.db.node.findMany({
        where: { memoryId: resolvedMemoryId, deletedAt: null },
        select: { id: true, content: true, data: true },
      });
      await ctx.db.$transaction(async (tx) => {
        for (const node of nodes) {
          const encrypted = encryptNodeFieldsWithKey(
            { content: node.content, data: node.data },
            key,
          );
          await tx.node.update({
            where: { id: node.id },
            data: {
              content: encrypted.content ?? null,
              data: (encrypted.data ?? null) as InputJsonValue,
            },
          });
        }
        await tx.memory.update({
          where: { id: resolvedMemoryId },
          data: { isEncrypted: true, updatedBy: ctx.appId },
        });
      });
      return ctx.db.memory.findUniqueOrThrow({ where: { id: resolvedMemoryId } });
    },
  },
};

interface NodeEdgeInput {
  targetId: string;
  label?: string;
}

interface NodeInput {
  id?: string;
  memoryId: string;
  nodeType?: string;
  loc: string;
  name: string;
  alias?: string;
  description?: string;
  /** Paragraph-length summary. Spec 031. Optional; `null` clears, omitted preserves. */
  abstract?: string | null;
  content?: string;
  data?: Record<string, unknown>;
  seq?: number;
  tags?: string[];
  properties?: Record<string, unknown>;
  llmModel?: string;
  aiAgent?: string;
  ownerRepo?: string;
  edges?: NodeEdgeInput[];
  createOnly?: boolean;
}

interface EdgeInput {
  sourceLoc: string;
  targetLoc: string;
  label: string;
}

interface SessionInput {
  id: string;
  type?: string;
  repo?: string;
  branch?: string;
  prNumber?: number;
  customerId?: string;
  language?: string;
  llmModel?: string;
  parentSessionId?: string;
  prevSessionId?: string;
}

interface UsageEventInput {
  type: string;
  nodeLoc?: string;
  actionArgs?: Record<string, unknown>;
  sessionId?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}
