import { createHash, randomBytes } from 'crypto';
import { generateId } from '../../../lib/id.js';
import { encryptToken, decryptToken } from '../../../lib/tokenCrypto.js';
import {
  AiServiceConfigNotFoundError,
  AiConfigValidationError,
  DuplicateAiServiceConfigNameError,
  NoAiConfigAvailableError,
  UnknownAiProviderError,
  DEFAULT_AI_CONFIG_NAME,
  apiKeyWriteFields,
  apiKeyPreviewOf,
  resolveAiConfigWithFallback,
  resolveAiConfigs,
  validateAiConfigName,
  validateProviderAndParams,
  type AiConfigOwnerType,
} from '../../../lib/aiConfig.js';
import { computeContentHash } from '../../../lib/contentHash.js';
import {
  buildReplacer,
  replaceInTags,
  SearchReplaceInvalidPatternError,
  type Replacer,
} from '../../../lib/searchReplace.js';
import { BATCH_READ_MAX_NODES, BATCH_READ_MAX_BYTES } from '../../../lib/batchRead.js';
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
import { canWriteToMemory, canReadMemory } from '../../../mcp/access-control.js';
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
import { getOrgReadableMemoryIds } from '../../../lib/auth/orgReadableMemory.js';
import { AppNotFoundError } from '../../../lib/entityRef/errors.js';
import {
  createMemoryShare,
  InvalidMemoryClassForShareError,
  MemoryNotFoundForShareError,
  MemoryShareGranteeMissingError,
} from '../../../controller/operations/createMemoryShare.js';
import { cloneMemoryGraph } from '../../../controller/operations/cloneMemory.js';
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
  formatCanonicalUrn,
  validateUserSlug,
  type CanonicalUrnType,
} from '../../../lib/urn.js';
import { validateLoc, InvalidLocError } from '../../../lib/validateLoc.js';
import { deriveEdgeLoc } from '../../../lib/edgeLoc.js';
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
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { UserNotFoundError } from '../../../lib/entityRef/errors.js';
import { propagateOrgUrnRename } from '../../../lib/org/propagateOrgUrnRename.js';
import { isId } from '../../../lib/entityRef/shape.js';
import {
  resolveResource as resolveAccessResource,
  callerCanAudit,
  computeEffectiveAccess,
} from '../../../lib/auth/effectiveAccess.js';
import { globalSearch as runGlobalSearch } from '../../../lib/global-search/index.js';
import type {
  SearchEntityType,
  SearchField,
  SearchPrincipal,
} from '../../../lib/global-search/index.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';
import { assertFullyQualifiedUrn, hasSchemePrefix, UrnNotQualifiedError, splitNodeUrn, composeNodeUrn, normalizeUrnForLookup } from '../../../lib/urn.js';
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
import { nextSiblingSeq } from '../../../lib/nodeSeq.js';
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

// ── 036-ai-service-config helpers ──────────────────────────────────────

function isPlatformAdmin(ctx: Context): boolean {
  return !!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'));
}

/** Row shape shared by the masked mappers below (no key material leaves). */
interface AiServiceConfigRow {
  id: string;
  name: string;
  hadronServerId: string | null;
  organizationId: string | null;
  appId: string | null;
  agentId: string | null;
  provider: string;
  model: string;
  apiKeyEncrypted: string | null;
  apiKeyPreview: string | null;
  params: unknown;
  enabled: boolean;
  createdAt: Date | string;
  updatedAt?: Date | string | null;
}

function aiConfigOwnerOf(c: AiServiceConfigRow): { ownerType: AiConfigOwnerType; ownerId: string } {
  if (c.appId) return { ownerType: 'APP', ownerId: c.appId };
  if (c.agentId) return { ownerType: 'AGENT', ownerId: c.agentId };
  if (c.organizationId) return { ownerType: 'ORGANIZATION', ownerId: c.organizationId };
  return { ownerType: 'HADRON_SERVER', ownerId: c.hadronServerId! };
}

/** Masked management view — never carries key material beyond the preview. */
function toGqlAiServiceConfig(c: AiServiceConfigRow) {
  return {
    id: c.id,
    name: c.name,
    ...aiConfigOwnerOf(c),
    provider: c.provider,
    model: c.model,
    hasApiKey: !!c.apiKeyEncrypted,
    apiKeyPreview: c.apiKeyPreview,
    params: c.params ?? null,
    enabled: c.enabled,
    createdAt: toISO(c.createdAt)!,
    updatedAt: toISO(c.updatedAt ?? null),
  };
}

/**
 * Resolve + authorize an AI-config owner reference. Platform ADMIN/OWNER
 * for HADRON_SERVER; org ADMIN of the owning org for the other levels
 * (requireOrgRole short-circuits for platform admins). ownerId accepts
 * ID or URN for org/app/agent owners (007 pattern); HADRON_SERVER is
 * ID-only.
 */
async function requireAiConfigOwnerAdmin(
  ctx: Context,
  ownerType: AiConfigOwnerType,
  ownerId: string,
): Promise<{ ownerWhere: Record<string, string>; resolvedOwnerId: string }> {
  switch (ownerType) {
    case 'HADRON_SERVER': {
      if (!isPlatformAdmin(ctx)) throw new Error('Forbidden');
      const server = await ctx.db.hadronServer.findUnique({ where: { id: ownerId } });
      if (!server) throw new AiServiceConfigNotFoundError(`hadron server ${ownerId}`);
      return { ownerWhere: { hadronServerId: server.id }, resolvedOwnerId: server.id };
    }
    case 'ORGANIZATION': {
      const { id } = await resolveOrgRef(ctx.db, ownerId);
      await requireOrgRole(ctx, id, 'ADMIN');
      return { ownerWhere: { organizationId: id }, resolvedOwnerId: id };
    }
    case 'APP': {
      const { id } = await resolveAppRef(ctx.db, ownerId);
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      return { ownerWhere: { appId: id }, resolvedOwnerId: id };
    }
    case 'AGENT': {
      const { id } = await resolveAgentRef(ctx.db, ownerId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      return { ownerWhere: { agentId: id }, resolvedOwnerId: id };
    }
  }
}

/**
 * Read gate for the masked config picker (resolveAiServiceConfigs). The picker
 * is scoped to ONE App's chat context, so for a non-admin caller all three of
 * these are required:
 *   1. an `appId` (the picker is meaningless without an installation),
 *   2. membership of that App, and
 *   3. the named Agent (if any) must be installed in that App.
 *
 * All three matter because the walk returns the App's configs AND the named
 * Agent's configs AND the org's, deriving the org from the App. Tying the
 * Agent to the App (isAgentInstalled) stops a member from pointing the walk at
 * an unrelated Agent's configs; requiring the App (instead of resolving an
 * Agent's home org when no appId is given) stops a member of an installing org
 * from reading the Agent author org's configs. The output is masked (no key
 * material), so App membership — not org admin — is the bar: anyone who can
 * use the chatbot can see what it may pick from. Platform admins bypass.
 */
async function requireAiConfigPickerAccess(
  ctx: Context,
  appId: string | null,
  agentId: string | null,
): Promise<void> {
  if (isPlatformAdmin(ctx)) return;
  if (!ctx.userId) throw new Error('Forbidden');
  if (!appId) throw new Error('Forbidden');
  const member = await ctx.db.appMember.findUnique({
    where: { appId_userId: { appId, userId: ctx.userId } },
  });
  if (!member) throw new Error('Forbidden');
  // The named Agent must be installed in this App, or the walk could be
  // pointed at an unrelated Agent's (masked) configs.
  if (agentId && !(await isAgentInstalled(ctx.db, appId, agentId))) {
    throw new Error('Forbidden');
  }
}

/** Map lib-level typed AI-config errors to GraphQL errors (S2). */
function rethrowAiConfigTyped(e: unknown): never {
  if (
    e instanceof AiServiceConfigNotFoundError ||
    e instanceof DuplicateAiServiceConfigNameError ||
    e instanceof UnknownAiProviderError ||
    e instanceof NoAiConfigAvailableError ||
    e instanceof AiConfigValidationError
  ) {
    throw new GraphQLError(e.message, { extensions: { code: e.name } });
  }
  throw e;
}

/**
 * Per-source memoized fetch of an entity's 'default' config so the
 * registry-backed Agent/App field resolvers (aiProvider, aiModel,
 * hasAiApiKey, aiApiKeyPreview) cost one query per parent object, not
 * one per field. Management view: the row is returned even when
 * disabled (resolution, not display, is what skips disabled configs).
 */
const defaultAiConfigMemo = new WeakMap<object, Promise<AiServiceConfigRow | null>>();
function defaultAiConfigOf(
  src: { id: string },
  ownerFk: 'agentId' | 'appId',
  ctx: Context,
): Promise<AiServiceConfigRow | null> {
  let p = defaultAiConfigMemo.get(src);
  if (!p) {
    p = ctx.db.aiServiceConfig.findFirst({
      where: { [ownerFk]: src.id, name: DEFAULT_AI_CONFIG_NAME },
    }) as Promise<AiServiceConfigRow | null>;
    defaultAiConfigMemo.set(src, p);
  }
  return p;
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

  // JWT user — org/public/subscription memories + owner-only personal/private
  // + the caller's own per-user holdings.
  if (ctx.userId) {
    // Org-visible (knowledge/group) + cross-org subscriptions + PUBLIC are
    // computed by the shared getOrgReadableMemoryIds helper so this gate and
    // the MCP gate (mcp/access-control.ts getMemoryAccess) stay in lockstep —
    // a freshly-onboarded org member must see the same org memories over MCP
    // as in the portal (the 2026-06-13 Micromentor onboarding incident).
    // 035-visibility-enum-cleanup rationale for `class IN (knowledge, group)`
    // (app/system reached via AppMember/the agent surface, not this node
    // query) now lives in that helper's header.
    const orgPublicIds = await getOrgReadableMemoryIds(ctx.db, ctx.userId);
    // Identity-scoped clauses stay local — owner-only, not org-wide:
    //   - 034: owner-owned personal/private memories (only the owner).
    //   - the caller's own per-user "holding" memories (userMemoryOfAgentId
    //     set — e.g. the startChat no-App knowledge downgrade), gated on
    //     creator identity (mirrors the chathistory-knowledge-class-auth-gap
    //     finding).
    const ownAndHoldings = await ctx.db.memory.findMany({
      where: {
        deletedAt: null,
        OR: [
          { class: { in: ['personal', 'private'] as any }, userId: ctx.userId },
          { userMemoryOfAgentId: { not: null }, createdBy: ctx.userId },
        ],
      },
      select: { id: true },
    });
    const accessibleIds = new Set(orgPublicIds);
    for (const g of ownAndHoldings as { id: string }[]) accessibleIds.add(g.id);
    return [...accessibleIds];
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

// 298 follow-up: canonicalizing a stored URN on read must never take down the
// whole query. A single legacy or corrupted row — e.g. a pre-fix updateMemory
// that persisted `<org>:memory:<org>::<slug>` — would otherwise throw inside a
// non-nullable `urn` field resolver and null out the entire parent list (the
// myOrganizations / organization 500 that took down every memory-listing page).
// Fall back to the raw stored value so the row still renders; the corrupted
// data is repaired separately and can't hold the rest of the response hostage.
function safeCanonicalUrn(type: CanonicalUrnType, raw: string): string {
  try {
    return formatCanonicalUrn(type, raw);
  } catch (err) {
    // Log so operators can locate + repair corrupted rows — the fallback keeps
    // the query alive, but the bad data still needs a one-off fix.
    console.warn(`[safeCanonicalUrn] failed to canonicalize ${type} URN "${raw}"; serving raw value:`, err);
    return raw;
  }
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

// encryptToken/decryptToken moved to src/lib/tokenCrypto.ts (spec 036) so
// the AI-config lib and this resolver layer share one implementation.

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

// Rank runnable candidates against a loose hint: case-insensitive, matching
// name/alias/loc/description, exact > prefix > substring.
// Extracted from hadron_run_task (spec cor:api:060).
function rankByHint<
  T extends { name: string; alias?: string | null; loc: string; description?: string | null },
>(items: T[], hint: string): T[] {
  const h = hint.trim().toLowerCase();
  if (!h) return [];
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    const alias = (item.alias ?? '').toLowerCase();
    const loc = item.loc.toLowerCase();
    const desc = (item.description ?? '').toLowerCase();
    let score = 0;
    if (name === h || alias === h) score = 100;
    else if (
      name.startsWith(h) ||
      alias.startsWith(h) ||
      loc === h ||
      loc.endsWith(`:${h}`)
    )
      score = 80;
    else if (name.includes(h) || alias.includes(h) || loc.includes(h))
      score = 60;
    else if (desc.includes(h)) score = 40;
    if (score > 0) scored.push({ item, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

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
    // 298: Canonicalize URN on read. Converts legacy single-colon hierarchy
    // (e.g. `org:slug`) to canonical spec-021 double-colon form (`org::slug`)
    // for both legacy and migrated rows. For install-shape memories with
    // role markers, preserves the marker:id boundary to avoid breaking the
    // canonical form (e.g. `org:agent:app-user:id` → `org::agent::app-user:id`).
    urn: (g: { urn?: string | null }) => {
      const urn = g.urn;
      if (!urn) throw new Error('Memory URN is required but not found (partial query?)');

      // Already canonical (contains `::`) — pass through
      if (urn.includes('::')) return safeCanonicalUrn('memory', urn);

      // Check for install-shape pattern with role markers. The canonical role
      // markers are: system, app-mem, app-user, group-mem, priv. A role marker
      // is always followed by either `:` (if parameterized, e.g., app-user:id)
      // or `::` (hierarchy separator in canonical form).
      // Pattern: `org:agent:role-marker[:id]` where role-marker is one of the
      // canonical markers. We need to detect this and preserve marker:id boundary.
      const roleMarkerPattern = /:(?:system|app-mem|app-user|group-mem|priv)(?::|$)/;
      if (roleMarkerPattern.test(urn)) {
        // Install-shape memory — carefully convert to canonical form while
        // preserving the role-marker:id boundary. Split on `:`, but rejoin
        // hierarchy levels with `::` and single-colon-attached role markers
        // with `:`. This is tricky: `org:agent:app-user:id` should become
        // `org::agent::app-user:id`, not `org::agent::app-user::id`.
        const parts = urn.split(':');
        // Try to detect the role marker position (it's typically after the
        // agent slug in install-shape URNs). Walk backwards from the end to
        // find the role marker.
        let roleMarkerIdx = -1;
        for (let i = parts.length - 1; i >= 0; i--) {
          const part = parts[i];
          if (['system', 'app-mem', 'app-user', 'group-mem', 'priv'].includes(part)) {
            roleMarkerIdx = i;
            break;
          }
        }

        if (roleMarkerIdx >= 0) {
          // Found the role marker. Reconstruct: join everything before the
          // marker with `::`, keep marker, then `:` + id(s) if present.
          const beforeMarker = parts.slice(0, roleMarkerIdx).join('::');
          const marker = parts[roleMarkerIdx];
          const afterMarker = parts.slice(roleMarkerIdx + 1).join(':');
          const normalized = afterMarker ? `${beforeMarker}::${marker}:${afterMarker}` : `${beforeMarker}::${marker}`;
          return safeCanonicalUrn('memory', normalized);
        }
      }

      // Standard memory (no role markers) — use default canonicalization
      return safeCanonicalUrn('memory', urn);
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
  User: {
    linkedAt: (u: { linkedAt?: Date | string | null }) => toISO(u.linkedAt ?? null),
    // Canonical hrn:user:<handle> URN, computed from the handle (spec
    // cor:urn:010:01). Null for a handle-less user, OR a handle that isn't
    // URN-legal — handle-charset validation on write is a #325 follow-up, so
    // until it lands we must not emit an invalid "canonical" URN here.
    urn: (u: { handle?: string | null }) => {
      if (!u.handle) return null;
      try {
        validateUserSlug(u.handle);
      } catch {
        return null;
      }
      return formatUrn('user', u.handle);
    },
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
      if (!(await callerCanAudit(ctx.db, { userId: ctx.userId, roles: ctx.roles }, resolved))) {
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
      { memory, memoryIds, nodeType, tags, search, prefix: rawPrefix, limit, offset }: { memory?: string; memoryIds?: string[]; nodeType?: string; tags?: string[]; search?: string; prefix?: string; limit?: number; offset?: number },
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
        // agent's / app's memories). Intersect the requested set with the
        // access filter in-place, same composition discipline as the singular
        // `memory` branch. Inaccessible ids are silently dropped (a
        // multi-select search shouldn't fail wholesale over one unreadable
        // id). Takes precedence over `memory` when both are supplied.
        if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
          const allowed = new Set((access.memoryId as { in: string[] }).in);
          access.memoryId = { in: memoryIds.filter((id) => allowed.has(id)) };
        } else {
          access.memoryId = { in: memoryIds };
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
      // surface matches the MCP hadron_create_node / hadron_update_node semantics.
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
      // Spec 037: edges are first-class. Carry the target's loc so the
      // edge loc can be derived (<sourceLoc>:<name>:<targetLoc>) when the
      // caller doesn't author one; validate any author-supplied loc here.
      let resolvedEdges: Array<{
        targetNodeId: string;
        targetLoc: string;
        name: string | null;
        loc: string | null;
        description: string | null;
        isRunnable: boolean | null;
      }> | null = null;
      if (input.edges !== undefined) {
        resolvedEdges = [];
        for (const e of input.edges) {
          if (e.loc != null && e.loc !== '') {
            try {
              validateLoc(e.loc);
            } catch (err) {
              if (err instanceof InvalidLocError) {
                throw new GraphQLError(err.message, {
                  extensions: { code: err.name, loc: err.loc, segment: err.segment },
                });
              }
              throw err;
            }
          }
          try {
            const { id: targetNodeId } = await resolveNodeRef(ctx.db, e.targetId, input.memoryId);
            const tgt = await ctx.db.node.findUnique({
              where: { id: targetNodeId },
              select: { loc: true },
            });
            resolvedEdges.push({
              targetNodeId,
              targetLoc: tgt?.loc ?? '',
              name: e.name ?? null,
              loc: e.loc ?? null,
              description: e.description ?? null,
              isRunnable: e.isRunnable ?? null,
            });
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

      // Tags partial-update semantics (hadron-cli#37). A create always
      // sets the column; an update only writes it when the caller actually
      // sent `tags`. `input.tags === undefined` (key omitted) means
      // "preserve existing" — the same omit→leave-untouched contract the
      // scalar fields and abstractOriginHash follow — so a partial update
      // (e.g. content-only) no longer silently clears tags. An explicit
      // array (including [], and a runtime `null` coerced via `?? []`)
      // replaces.
      const tags = serializeTags(input.tags ?? []) as string[];
      const updateTagsPayload = input.tags === undefined ? {} : { tags };
      const id = input.id ?? generateId();
      // Strip GraphQL-only flags + `tags` from the Prisma payload.
      // `createOnly` is a control input, not a column. `edges` is consumed
      // above (resolved into `resolvedEdges`) and applied below. `tags` is
      // re-applied per-branch below (serialized, and update-gated) — leaving
      // the raw array in `nodeFields` would write the wrong shape on SQLite
      // and clobber the preserve-on-omit gating above.
      const { edges: _edges, createOnly: _createOnly, tags: _tags, ...nodeFields } = input;
      const createdBy = ctx.userId ?? ctx.clientId ?? null;

      // If the target memory is encrypted, encrypt content and data before
      // writing. Throws SESSION_EXPIRED if no session key is cached.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, input.memoryId);

      // Spec 032 — compute abstractOriginHash. MUST happen on PLAINTEXT
      // content (FR-009), so this runs BEFORE the encryption block below
      // that mutates nodeFields.content to ciphertext.
      //
      // Matrix per contracts/hadron_update_node.md:
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

      // Spec: cor:dmo:020:01 (Node ordering).
      // Auto-assign `seq` for a NEW node joining an already-ordered sibling
      // list: with no explicit seq it inherits max(sibling seq)+1 and lands at
      // the end. Create-only; an explicit input.seq always wins; an unordered /
      // empty sibling list leaves seq null (nextSiblingSeq returns null).
      const seqForCreate =
        existing == null && input.seq == null
          ? await nextSiblingSeq(ctx.db, input.memoryId, input.loc)
          : undefined;

      const node = await ctx.db.node.upsert({
        where: { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
        create: {
          ...nodeFieldsClean,
          id,
          tags,
          createdBy,
          ...hashPayload,
          ...(seqForCreate != null ? { seq: seqForCreate } : {}),
        } as Prisma.NodeUncheckedCreateInput,
        update: {
          ...nodeFieldsClean,
          ...updateTagsPayload,
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
        // skipDuplicates: true defends against a duplicate (loc, memoryId)
        // inside the input array itself (e.g. two edges that derive the
        // same loc). Spec 037: each edge carries memoryId (= source's
        // memory) and a loc (author-supplied or derived).
        await ctx.db.edge.deleteMany({ where: { sourceId: node.id } });
        await ctx.db.pendingEdge.deleteMany({ where: { sourceId: node.id } });
        if (resolvedEdges.length > 0) {
          await ctx.db.edge.createMany({
            data: resolvedEdges.map((e) => ({
              memoryId: node.memoryId,
              sourceId: node.id,
              targetId: e.targetNodeId,
              loc: e.loc ?? deriveEdgeLoc(node.loc, e.name, e.targetLoc),
              name: e.name,
              description: e.description,
              isRunnable: e.isRunnable,
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
        nodeType: finalNode.nodeType,
        alias: finalNode.alias,
        description: finalNode.description,
        abstract: finalNode.abstract,
        abstractOriginHash: finalNode.abstractOriginHash,
        contentHash: finalNode.contentHash,
        content: finalNode.content,
        tags: deserializeTags(finalNode.tags) as string[],
        seq: finalNode.seq,
        data: finalNode.data,
        properties: finalNode.properties,
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

    // Bulk literal/regex search-and-replace across selected nodes. Reuses the
    // single-write invariants from upsertNode (per-memory write auth,
    // decrypt→replace→re-encrypt, NodeVersion snapshot, abstractOriginHash
    // recompute, re-embed, git mirror) but keyed off existing node rows rather
    // than a full NodeInput. Selection is the union of nodeIds + (memoryIds,
    // optionally narrowed by a loc `prefix`). See SearchReplaceInNodesInput.
    searchReplaceInNodes: async (
      _: unknown,
      { input }: { input: SearchReplaceInNodesInput },
      ctx: Context,
    ) => {
      const {
        oldText,
        newText,
        nodeIds,
        memoryIds,
        prefix,
        fields,
        caseInsensitive = false,
        regex = false,
        dryRun = false,
      } = input;

      const hasNodeIds = Array.isArray(nodeIds) && nodeIds.length > 0;
      const hasMemoryIds = Array.isArray(memoryIds) && memoryIds.length > 0;
      const usePrefix = prefix != null && prefix !== '';

      if (!hasNodeIds && !hasMemoryIds) {
        throw new GraphQLError(
          'searchReplaceInNodes requires at least one of `nodeIds` or `memoryIds`.',
          { extensions: { code: 'SEARCH_REPLACE_NO_SELECTION' } },
        );
      }
      if (usePrefix && !hasMemoryIds) {
        throw new GraphQLError(
          'searchReplaceInNodes: `prefix` requires `memoryIds` (loc is only unique within a memory).',
          { extensions: { code: 'SEARCH_REPLACE_PREFIX_WITHOUT_MEMORY' } },
        );
      }
      if (!Array.isArray(fields) || fields.length === 0) {
        throw new GraphQLError(
          'searchReplaceInNodes requires at least one field in `fields`.',
          { extensions: { code: 'SEARCH_REPLACE_NO_FIELDS' } },
        );
      }
      const fieldSet = new Set<string>(fields);

      // Build (and validate) the replacer up front — a bad pattern fails the
      // whole request before any node is touched.
      let replacer: Replacer;
      try {
        replacer = buildReplacer(oldText, newText, { caseInsensitive, regex });
      } catch (e) {
        if (e instanceof SearchReplaceInvalidPatternError) {
          throw new GraphQLError(e.message, {
            extensions: { code: e.name, pattern: e.pattern, reason: e.reason },
          });
        }
        throw e;
      }

      // ── Resolve selection → deduped raw node rows (write-auth per memory) ──
      type NodeRow = NonNullable<Awaited<ReturnType<typeof ctx.db.node.findUnique>>>;
      const nodeById = new Map<string, NodeRow>();
      const authedMemories = new Set<string>();
      const ensureAuthed = async (memoryId: string) => {
        if (authedMemories.has(memoryId)) return;
        await requireMemoryWriteAccess(ctx, memoryId);
        authedMemories.add(memoryId);
      };

      if (hasMemoryIds) {
        for (const ref of memoryIds!) {
          const { id: memId } = await resolveMemoryRef(ctx.db, ref);
          await ensureAuthed(memId);
          const where: Prisma.NodeWhereInput = { memoryId: memId, deletedAt: null };
          if (usePrefix) {
            // Match the node at `prefix` plus its descendants, on `:` path
            // boundaries (so 'auth' won't catch 'authoring').
            where.OR = [{ loc: prefix }, { loc: { startsWith: `${prefix}:` } }];
          }
          const rows = await ctx.db.node.findMany({ where });
          for (const r of rows) nodeById.set(r.id, r as NodeRow);
        }
      }

      if (hasNodeIds) {
        for (const ref of nodeIds!) {
          // Explicit refs must be IDs or fully-qualified URNs (no memory ctx).
          const { id } = await resolveNodeRef(ctx.db, ref);
          if (nodeById.has(id)) continue;
          const row = await ctx.db.node.findUnique({ where: { id } });
          if (!row || row.deletedAt) continue;
          await ensureAuthed(row.memoryId);
          nodeById.set(id, row);
        }
      }

      const rawNodes = [...nodeById.values()];

      // ── Compute pass: replace on PLAINTEXT, validate, plan writes ──
      // All validation (empty name, abstract cap, SESSION_EXPIRED) happens here
      // so the request fails before the write transaction opens.
      const memEncCache = new Map<string, { id: string; isEncrypted: boolean }>();
      const getMemEnc = async (memoryId: string) => {
        let info = memEncCache.get(memoryId);
        if (!info) {
          info = await getMemoryEncryptionInfo(ctx.db, memoryId);
          memEncCache.set(memoryId, info);
        }
        return info;
      };

      interface Plan {
        raw: NodeRow;
        isEncrypted: boolean;
        changed: Record<string, unknown>; // plaintext field → new value
        plaintext: { content: string | null; abstract: string | null };
        fieldResults: Array<{ field: string; matches: number }>;
        total: number;
        abstractChanged: boolean;
        contentChanged: boolean;
        ownerRepo: string;
      }
      const plans: Plan[] = [];

      for (const raw of rawNodes) {
        const memEnc = await getMemEnc(raw.memoryId);
        if (memEnc.isEncrypted && !sessionKeyCache.getByMemoryId(memEnc.id)) {
          throw new GraphQLError(
            `SESSION_EXPIRED: memory ${memEnc.id} is encrypted but no active session key is available.`,
            { extensions: { code: 'SESSION_EXPIRED', memoryId: memEnc.id } },
          );
        }
        // Decrypt a working copy to plaintext; `raw` stays ciphertext so the
        // NodeVersion snapshot below matches upsertNode's snapshot shape.
        const pt = { ...raw } as NodeRow;
        if (memEnc.isEncrypted) decryptNodeFields(pt, memEnc);

        const changed: Record<string, unknown> = {};
        const fieldResults: Array<{ field: string; matches: number }> = [];
        let total = 0;
        let abstractChanged = false;
        let contentChanged = false;

        if (fieldSet.has('name')) {
          const r = replacer.apply(pt.name ?? '');
          if (r.count > 0) {
            if (r.value.trim() === '') {
              throw new GraphQLError(
                `searchReplaceInNodes: replacing in 'name' of node ${pt.loc} (${pt.id}) would leave it empty.`,
                { extensions: { code: 'SEARCH_REPLACE_EMPTY_NAME', nodeId: pt.id, loc: pt.loc } },
              );
            }
            changed.name = r.value;
            total += r.count;
            fieldResults.push({ field: 'name', matches: r.count });
          }
        }

        for (const f of ['alias', 'description'] as const) {
          if (!fieldSet.has(f)) continue;
          const cur = pt[f];
          if (cur == null) continue;
          const r = replacer.apply(cur);
          if (r.count > 0) {
            changed[f] = r.value;
            total += r.count;
            fieldResults.push({ field: f, matches: r.count });
          }
        }

        if (fieldSet.has('abstract') && pt.abstract != null) {
          const r = replacer.apply(pt.abstract);
          if (r.count > 0) {
            if (r.value.length > 2000) {
              const err = new NodeAbstractTooLongError(r.value.length);
              throw new GraphQLError(`${err.message} (node ${pt.loc} / ${pt.id})`, {
                extensions: {
                  code: err.name,
                  length: err.length,
                  max: err.max,
                  nodeId: pt.id,
                  loc: pt.loc,
                },
              });
            }
            // Whitespace-only result normalizes to null, matching upsertNode.
            changed.abstract = r.value.trim() === '' ? null : r.value;
            abstractChanged = true;
            total += r.count;
            fieldResults.push({ field: 'abstract', matches: r.count });
          }
        }

        if (fieldSet.has('content') && pt.content != null) {
          const r = replacer.apply(pt.content);
          if (r.count > 0) {
            changed.content = r.value;
            contentChanged = true;
            total += r.count;
            fieldResults.push({ field: 'content', matches: r.count });
          }
        }

        if (fieldSet.has('tags')) {
          const curTags = deserializeTags(pt.tags) as string[];
          const r = replaceInTags(curTags, replacer);
          if (r.count > 0) {
            changed.tags = r.value;
            total += r.count;
            fieldResults.push({ field: 'tags', matches: r.count });
          }
        }

        if (total > 0) {
          plans.push({
            raw,
            isEncrypted: memEnc.isEncrypted,
            changed,
            plaintext: {
              content: contentChanged ? (changed.content as string) : pt.content,
              abstract: abstractChanged ? (changed.abstract as string | null) : pt.abstract,
            },
            fieldResults,
            total,
            abstractChanged,
            contentChanged,
            ownerRepo: (raw as { ownerRepo?: string | null }).ownerRepo ?? '',
          });
        }
      }

      const buildResult = () => ({
        nodesScanned: rawNodes.length,
        nodesChanged: plans.length,
        totalReplacements: plans.reduce((a, p) => a + p.total, 0),
        dryRun,
        results: plans.map((p) => ({
          nodeId: p.raw.id,
          loc: p.raw.loc,
          memoryId: p.raw.memoryId,
          replacements: p.total,
          fields: p.fieldResults,
        })),
      });

      if (dryRun) return buildResult();

      // ── Write pass: version snapshot + node update, all-or-nothing ──
      await ctx.db.$transaction(async (tx) => {
        for (const p of plans) {
          const raw = p.raw;
          await tx.nodeVersion.create({
            data: {
              nodeId: raw.id,
              loc: raw.loc,
              name: raw.name,
              alias: raw.alias,
              description: raw.description,
              abstract: raw.abstract,
              abstractOriginHash: raw.abstractOriginHash,
              content: raw.content,
              tags: raw.tags as string[],
              editedBy: ctx.clientId ?? ctx.userId ?? null,
              createdBy: ctx.userId ?? ctx.clientId ?? null,
            },
          });

          const data: Record<string, unknown> = {};
          // Encrypt content/abstract for encrypted memories before persisting.
          if (p.isEncrypted && ('content' in p.changed || 'abstract' in p.changed)) {
            const key = sessionKeyCache.getByMemoryId(raw.memoryId)!; // validated above
            const enc = encryptNodeFieldsWithKey(
              {
                content: 'content' in p.changed ? (p.changed.content as string | null) : null,
                abstract: 'abstract' in p.changed ? (p.changed.abstract as string | null) : null,
              },
              key,
            );
            if ('content' in p.changed) data.content = enc.content;
            if ('abstract' in p.changed) data.abstract = enc.abstract;
          } else {
            if ('content' in p.changed) data.content = p.changed.content;
            if ('abstract' in p.changed) data.abstract = p.changed.abstract;
          }
          if ('name' in p.changed) data.name = p.changed.name;
          if ('alias' in p.changed) data.alias = p.changed.alias;
          if ('description' in p.changed) data.description = p.changed.description;
          if ('tags' in p.changed) data.tags = serializeTags(p.changed.tags as string[]);

          // abstractOriginHash tracks "content when the abstract was authored".
          // Recompute (against post-replace plaintext content) only when the
          // abstract itself changed — a content-only edit intentionally leaves
          // the hash so staleness detection fires (matches upsertNode).
          if (p.abstractChanged) {
            data.abstractOriginHash = computeContentHash(p.plaintext.content);
          }

          await tx.node.update({ where: { id: raw.id }, data });
        }
      });

      // ── Post-commit side effects (best-effort, mirror upsertNode) ──
      for (const p of plans) {
        // Re-embed when the embedded text (content/abstract) changed.
        if (p.contentChanged || p.abstractChanged) {
          void enqueueNodeEmbedding(ctx.db, {
            nodeId: p.raw.id,
            memoryId: p.raw.memoryId,
            plaintext: { content: p.plaintext.content, abstract: p.plaintext.abstract },
          });
        }
        // Mirror to git so a later (repo-wins) sync can't revert the edit.
        // Re-fetch with edges and decrypt to plaintext, as writeNodeToGit needs.
        void (async () => {
          const fresh = await ctx.db.node.findUnique({
            where: { id: p.raw.id },
            include: { outgoingEdges: { include: { target: true } } },
          });
          if (!fresh) return;
          if (p.isEncrypted) {
            const memEnc = await getMemEnc(fresh.memoryId);
            decryptNodeFields(fresh, memEnc);
          }
          await writeNodeToGit(
            {
              id: fresh.id,
              loc: fresh.loc,
              name: fresh.name,
              nodeType: fresh.nodeType,
              alias: fresh.alias,
              description: fresh.description,
              abstract: fresh.abstract,
              abstractOriginHash: fresh.abstractOriginHash,
              contentHash: fresh.contentHash,
              content: fresh.content,
              tags: deserializeTags(fresh.tags) as string[],
              seq: fresh.seq,
              data: fresh.data,
              properties: fresh.properties,
              outgoingEdges: fresh.outgoingEdges ?? [],
            },
            p.ownerRepo,
            ctx.clientId,
            fresh.memoryId,
          );
        })().catch((err) => {
          console.error('[searchReplaceInNodes] git write error:', err);
        });
      }

      return buildResult();
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
      { sourceNodeId, targetNodeId, name, loc, description, isRunnable, condition, priority, data }: {
        sourceNodeId: string;
        targetNodeId: string;
        // GraphQL nullable args: non-JS clients send explicit nulls.
        name?: string | null;
        loc?: string | null;
        description?: string | null;
        isRunnable?: boolean | null;
        condition?: unknown;
        priority?: number | null;
        data?: Record<string, unknown> | null;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'CONTRIBUTOR');
      if (condition !== undefined && condition !== null) {
        throwOnInvalidCondition(condition);
      }
      // #322: each endpoint may be an ID-shape PK (preferred — immutable
      // across move/rename, so the edge survives a later URN change) OR a
      // fully-qualified node URN. resolveNodeRef dispatches on shape; a URN
      // must be fully qualified (spec 022 — no contextMemoryId at the API
      // boundary). Previously this path was PK-only (a bare findUnique by
      // id), so a URN caller got a spurious not-found.
      // Only map a genuine miss (NodeNotFoundError) to NODE_NOT_FOUND. Let
      // UrnNotQualifiedError propagate so server.ts formatError surfaces the
      // spec-022 URN_NOT_QUALIFIED code/message GraphQL callers rely on
      // (PR-348 review: previously both were collapsed into NODE_NOT_FOUND).
      let resolvedSourceId: string;
      let resolvedTargetId: string;
      try {
        ({ id: resolvedSourceId } = await resolveNodeRef(ctx.db, sourceNodeId));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Source node not found: "${sourceNodeId}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
        throw e;
      }
      try {
        ({ id: resolvedTargetId } = await resolveNodeRef(ctx.db, targetNodeId));
      } catch (e) {
        if (e instanceof NodeNotFoundError)
          throw new GraphQLError(`Target node not found: "${targetNodeId}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
        throw e;
      }
      // Spec 037: an edge carries a memory-unique `loc` (its identity + URN
      // suffix), with `memoryId` denormalized from the source node. Fetch
      // both endpoints to compose/derive the loc + gate access.
      const [src, tgt] = await Promise.all([
        ctx.db.node.findUnique({ where: { id: resolvedSourceId }, select: { loc: true, memoryId: true } }),
        ctx.db.node.findUnique({ where: { id: resolvedTargetId }, select: { loc: true, memoryId: true } }),
      ]);
      if (!src) throw new GraphQLError(`Source node not found: "${sourceNodeId}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
      if (!tgt) throw new GraphQLError(`Target node not found: "${targetNodeId}"`, { extensions: { code: 'NODE_NOT_FOUND' } });

      // PR-348 review (Gemini, critical): the global CONTRIBUTOR role gate
      // above is not memory-scoped. Mirror the MCP addEdge posture (and the
      // sibling upsertNode/moveNode mutations): require write access to the
      // SOURCE memory, and at least read on the TARGET. Without this any
      // CONTRIBUTOR could write an edge into a memory they can't touch. The
      // target denial returns the same NODE_NOT_FOUND wording as a genuine
      // miss so it can't be used as a cross-memory existence oracle.
      await requireMemoryWriteAccess(ctx, src.memoryId);
      if (!(await canReadMemory(ctx.db, ctx, tgt.memoryId))) {
        throw new GraphQLError(`Target node not found: "${targetNodeId}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
      }
      const edgeLoc = loc != null && loc !== '' ? loc : deriveEdgeLoc(src.loc, name ?? null, tgt.loc);
      try {
        validateLoc(edgeLoc);
      } catch (e) {
        if (e instanceof InvalidLocError) {
          throw new GraphQLError(e.message, { extensions: { code: e.name, loc: e.loc, segment: e.segment } });
        }
        throw e;
      }
      return ctx.db.edge.create({
        data: {
          id: generateId(),
          memoryId: src.memoryId,
          sourceId: resolvedSourceId,
          targetId: resolvedTargetId,
          loc: edgeLoc,
          name: name ?? null,
          description: description ?? null,
          isRunnable: isRunnable ?? null,
          condition: (condition ?? null) as InputJsonValue,
          // != null: the GraphQL arg is nullable, and non-JS clients (the
          // Go CLI) send explicit nulls for unset args. priority is a
          // non-nullable Int @default(0) — passing null to Prisma fails
          // validation with a misleading "Argument source is missing"
          // (the invalid field disqualifies the scalar-FK input variant).
          // Issue #263.
          ...(priority != null ? { priority } : {}),
          data: (data ?? null) as InputJsonValue,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: { source: true, target: true },
      });
    },

    updateEdge: async (
      _: unknown,
      { edgeId, name, loc, description, isRunnable, condition, priority, data }: {
        edgeId: string;
        name?: string | null;
        loc?: string | null;
        description?: string | null;
        isRunnable?: boolean | null;
        condition?: unknown;
        priority?: number | null;
        data?: Record<string, unknown> | null;
      },
      ctx: Context,
    ) => {
      requireRole(ctx, 'CONTRIBUTOR');
      if (condition !== undefined && condition !== null) {
        throwOnInvalidCondition(condition);
      }
      if (loc != null && loc !== '') {
        try {
          validateLoc(loc);
        } catch (e) {
          if (e instanceof InvalidLocError) {
            throw new GraphQLError(e.message, { extensions: { code: e.name, loc: e.loc, segment: e.segment } });
          }
          throw e;
        }
      }
      // Null semantics differ per arg (#263):
      // - condition/data: null CLEARS the stored value — the spec'd
      //   edge-conditions contract ("null = always fires") that the portal
      //   condition editor relies on.
      // - name/description: null CLEARS (both nullable since spec 037).
      // - loc: null/empty = UNSET (keep stored); loc is the identity and
      //   can't be cleared. isRunnable: undefined preserves, else set.
      // - priority: null = UNSET (keep stored). The column is a
      //   non-nullable Int, so null is never meaningful — and forwarding
      //   it makes Prisma fail with a misleading "Argument source is
      //   missing".
      // Non-JS clients that serialize unset args as explicit nulls (the
      // Go CLI's genqlient layer) must omit unset variables instead —
      // tracked as a hadron-cli fix.
      return ctx.db.edge.update({
        where: { id: edgeId },
        data: {
          ...(name !== undefined ? { name: name ?? null } : {}),
          ...(loc != null && loc !== '' ? { loc } : {}),
          ...(description !== undefined ? { description: description ?? null } : {}),
          ...(isRunnable !== undefined ? { isRunnable: isRunnable ?? null } : {}),
          ...(condition !== undefined ? { condition: (condition ?? null) as InputJsonValue } : {}),
          ...(priority != null ? { priority } : {}),
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
            const edgeLoc = edge.loc ?? deriveEdgeLoc(source.loc, edge.name ?? null, target.loc);
            await tx.edge.upsert({
              where: { loc_memoryId: { loc: edgeLoc, memoryId: resolvedMemoryId } },
              create: {
                memoryId: resolvedMemoryId,
                sourceId: source.id,
                targetId: target.id,
                loc: edgeLoc,
                name: edge.name ?? null,
                description: edge.description ?? null,
                isRunnable: edge.isRunnable ?? null,
              },
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

      const data = {
        ...(name ? { name } : {}),
        ...(urn ? { urn } : {}),
        ...(isVisible !== undefined ? { isVisible } : {}),
      };

      // Fast path: no URN change requested → a plain update.
      if (!urn) {
        return ctx.db.organization.update({
          where: { id: resolvedId },
          data,
          include: ORG_INCLUDE,
        });
      }

      // The org URN is denormalized into the `urn` column of every Memory,
      // Agent and App it owns (baked in at creation as `<orgUrn>::…`). Renaming
      // the org URN must rewrite those child copies too, or they dangle (issue
      // #337) — `propagateOrgUrnRename`. Lock the org row and read its current
      // urn INSIDE the transaction (FOR UPDATE) so a concurrent rename can't make
      // the rewrite source stale, then rewrite the children in the same tx so
      // they commit (or roll back) together.
      return ctx.db.$transaction(async (tx: Prisma.TransactionClient) => {
        const [locked] = await tx.$queryRaw<{ urn: string }[]>`
          SELECT urn FROM organizations WHERE id = ${resolvedId} FOR UPDATE
        `;
        const oldUrn = locked?.urn;
        const updated = await tx.organization.update({
          where: { id: resolvedId },
          data,
          include: ORG_INCLUDE,
        });
        if (oldUrn && oldUrn !== urn) {
          await propagateOrgUrnRename(tx, resolvedId, oldUrn, urn);
        }
        return updated;
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
        data,
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
        vectorIndexEnabled,
        embeddingSource,
      }: {
        orgId: string; name: string;
        shortDescription?: string; description?: string; data?: Record<string, unknown> | null; tags?: string[];
        license?: string; category0?: string; category1?: string; category2?: string;
        iconUrl?: string; heroUrl?: string; homeUrl?: string;
        source?: string | null; readBranch?: string; writeBranch?: string; visibility?: string;
        // Both are nullable in the GraphQL schema — a client may pass an
        // explicit `null`, which we treat as "unspecified" (the `??` / `!= null`
        // guards below coalesce it to the class default).
        vectorIndexEnabled?: boolean | null;
        embeddingSource?: 'abstract' | 'contentChunks' | 'both' | null;
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
            // Free-form metadata bag (no server-side semantics). Mirrors the
            // Node.data / Edge.data null-handling: undefined omits the field
            // (column stays NULL on create), explicit null writes NULL.
            ...(data !== undefined ? { data: data as InputJsonValue } : {}),
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
            // 033 — class-derived defaults for the vector index (FR-001 + #281):
            // a `knowledge`-class memory (non-encrypted, as created here) is
            // searchable by default. The default source is `contentChunks` —
            // it embeds `Node.content` directly (no authored abstract / no LLM),
            // so any node with content is retrievable immediately (the `abstract`
            // column default would leave most knowledge nodes unindexed until
            // abstracts are written). `group` and others keep the column defaults
            // (off / `abstract`). Explicit caller values win for every class.
            // All flippable later via updateMemory.
            vectorIndexEnabled: vectorIndexEnabled ?? requestedClass === 'knowledge',
            ...(embeddingSource != null
              ? { embeddingSource }
              : requestedClass === 'knowledge'
                ? { embeddingSource: 'contentChunks' as const }
                : {}),
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
        data,
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
        shortDescription?: string; description?: string; data?: Record<string, unknown> | null; tags?: string[];
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
        // Guard: a memory slug must be BARE — not a full or embedded URN. The
        // portal settings form once mis-derived the slug from a canonical
        // `hrn:memory:<org>::<slug>` and sent `memory:<org>::<slug>`, which
        // composed into `<org>:memory:<org>::<slug>` and corrupted the row
        // (the prod /app/orgs outage). Reject a client-supplied slug carrying a
        // scheme prefix, a URN type marker at the start, or a `::` hierarchy
        // separator BEFORE the write, so a bad value can never be persisted.
        // (The org-transfer fallback above derives the slug from the stored,
        // already-valid URN, so it's only the client `urn` arg we validate.)
        if (urn !== undefined && /^(hrn|urn|memory|agent|app|node|org):|::/.test(urn)) {
          throw new GraphQLError(
            `Invalid memory slug "${urn}": expected a bare slug (e.g. "experiments"), not a full or prefixed URN.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
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
          // Free-form metadata bag. undefined leaves the stored value
          // untouched; explicit null CLEARS it (same contract as Node.data /
          // Edge.data — #263).
          ...(data !== undefined ? { data: data as InputJsonValue } : {}),
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

    cloneMemory: async (
      _: unknown,
      { id, name }: { id: string; name: string },
      ctx: Context,
    ) => {
      // 007-entity-id-or-urn: id may be ID, bare URN, or prefixed URN.
      const { id: sourceId } = await resolveMemoryRef(ctx.db, id);
      const source = await ctx.db.memory.findUniqueOrThrow({ where: { id: sourceId } });

      // Class-aware authz mirrors deleteMemory: personal/private are
      // owner-only; org-shared classes gate on org ADMIN. Authz runs first
      // so unauthorized callers can't probe class/encryption state.
      if (source.class === 'personal' || source.class === 'private') {
        if (!ctx.userId || source.userId !== ctx.userId) {
          throw new GraphQLError(
            `Forbidden: only the owner can clone a ${source.class} memory`,
            { extensions: { code: 'FORBIDDEN' } },
          );
        }
      } else {
        await requireOrgRole(ctx, source.organizationId, 'ADMIN');
      }
      // system/app-class memories auto-provision via the agent/install
      // paths (same rationale as createMemory rejecting these classes) —
      // a free-standing clone would violate their pivot invariants
      // (chk_memory_class_app_id) or duplicate an agent's brain.
      if (source.class === 'system' || source.class === 'app') {
        throw new GraphQLError(
          `cloneMemory does not accept a class='${source.class}' source. ` +
            `Only 'knowledge', 'group', 'personal', and 'private' memories can be cloned.`,
          { extensions: { code: 'UNSUPPORTED_MEMORY_CLASS' } },
        );
      }
      // v1: encrypted sources are rejected — the URN rewrite needs
      // plaintext, and a clone would need its own encryption envelope +
      // session-key flow. Follow-up if/when needed.
      if (source.isEncrypted) {
        throw new GraphQLError(
          'cloneMemory does not support encrypted memories yet.',
          { extensions: { code: 'ENCRYPTED_MEMORY_CLONE_UNSUPPORTED' } },
        );
      }
      // Group-class clones bootstrap the caller as first owner, which
      // needs an authenticated user (matches createMemory).
      if (source.class === 'group' && !ctx.userId) {
        throw new GraphQLError(
          'Cloning a group-class memory requires an authenticated user (the caller becomes the first owner).',
          { extensions: { code: 'UNAUTHENTICATED' } },
        );
      }

      const org = await ctx.db.organization.findUniqueOrThrow({
        where: { id: source.organizationId },
        select: { urn: true },
      });
      const newUrn = `${org.urn}:${name}`;
      // URN collision handling matches createMemory: a soft-deleted holder
      // is hard-deleted, a live one is an error.
      const existing = await ctx.db.memory.findUnique({ where: { urn: newUrn } });
      if (existing) {
        if (existing.deletedAt) {
          await ctx.db.memory.delete({ where: { id: existing.id } });
        } else {
          throw new Error(`A memory with URN "${newUrn}" already exists`);
        }
      }

      const isUserOwned = source.class === 'personal' || source.class === 'private';
      const { memoryId } = await cloneMemoryGraph(ctx.db, {
        sourceMemoryId: source.id,
        name,
        newUrn,
        // chk_personal_visibility_user: owner set iff personal/private.
        ownerUserId: isUserOwned ? ctx.userId! : null,
        groupOwnerUserId: source.class === 'group' ? (ctx.userId ?? null) : null,
        actorId: ctx.userId ?? ctx.clientId ?? null,
      });

      // 033 — the clone carries the source's vector-index config but no
      // vectors; stamp every node pending so the sweep (or prompt-drain on
      // future writes) re-embeds the rewritten content.
      if (source.vectorIndexEnabled) {
        await backfillMemoryEmbeddings(ctx.db, memoryId);
      }

      return ctx.db.memory.findUniqueOrThrow({
        where: { id: memoryId },
        include: MEMORY_INCLUDE,
      });
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
      // NOT NULL guard in hadron_get_node).
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
        loc: e.loc,
        name: e.name,
        description: e.description,
        isRunnable: e.isRunnable,
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

      // Restore edges from snapshot. Spec 037: derive loc when an older
      // snapshot predates the edge `loc`/`name` fields (it would carry the
      // legacy `label`); memoryId is the system memory being restored into.
      for (const e of snapshot.edges) {
        const sourceId = locToId.get(e.sourceLoc as string);
        const targetId = locToId.get(e.targetLoc as string);
        if (sourceId && targetId) {
          const edgeName = ((e.name ?? e.label) as string | null) ?? null;
          const edgeLoc = (e.loc as string | undefined)
            ?? deriveEdgeLoc(e.sourceLoc as string, edgeName, e.targetLoc as string);
          await ctx.db.edge.create({
            data: {
              id: generateId(),
              memoryId: sysMemId,
              sourceId,
              targetId,
              loc: edgeLoc,
              name: edgeName,
              description: (e.description as string | null) ?? null,
              isRunnable: (e.isRunnable as boolean | null) ?? null,
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

      // 036-ai-service-config: the legacy aiProvider/aiModel/aiApiKey args
      // become the App's 'default' registry config (deploy-time override
      // that wins over the Agent's default in the resolution walk).
      if (aiProvider && aiModel) {
        try {
          validateProviderAndParams(aiProvider, null);
        } catch (e) {
          rethrowAiConfigTyped(e);
        }
        await ctx.db.aiServiceConfig.create({
          data: {
            appId: createdApp.id,
            name: DEFAULT_AI_CONFIG_NAME,
            provider: aiProvider,
            model: aiModel,
            ...(aiApiKey
              ? { apiKeyEncrypted: encryptToken(aiApiKey), apiKeyPreview: apiKeyPreviewOf(aiApiKey) }
              : {}),
            createdBy: ctx.userId ?? null,
          },
        });
      }

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
        // GraphQL nullable args: explicit null is meaningful here
        // (aiProvider: null clears the App's 'default' AI config).
        aiProvider?: string | null;
        aiModel?: string | null;
        aiApiKey?: string | null;
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
      // 036-ai-service-config: the legacy aiProvider/aiModel/aiApiKey args
      // maintain the App's 'default' registry config. Explicit null
      // aiProvider clears the whole config (legacy column-null semantics);
      // aiApiKey '' clears just the key.
      if (aiProvider !== undefined || aiModel !== undefined || aiApiKey !== undefined) {
        const existing = await ctx.db.aiServiceConfig.findFirst({
          where: { appId: resolvedId, name: DEFAULT_AI_CONFIG_NAME },
        });
        if (aiProvider === null) {
          if (existing) await ctx.db.aiServiceConfig.delete({ where: { id: existing.id } });
        } else {
          const provider = aiProvider ?? existing?.provider;
          const model = aiModel ?? existing?.model;
          if (!provider || !model) {
            // Clearing/keeping a key on an App with no saved config stays a
            // no-op (legacy column semantics tolerated key-only clears), but
            // any attempt to SET a partial config errors cleanly instead of
            // silently dropping the args (PR #262 review).
            if (aiProvider || aiModel || aiApiKey) {
              throw new GraphQLError(
                'aiProvider and aiModel are both required when configuring AI for an App that has no saved config',
                { extensions: { code: 'AiConfigValidationError' } },
              );
            }
          } else {
            try {
              validateProviderAndParams(provider, null);
            } catch (e) {
              rethrowAiConfigTyped(e);
            }
            const keyFields = apiKeyWriteFields(aiApiKey);
            if (existing) {
              await ctx.db.aiServiceConfig.update({
                where: { id: existing.id },
                data: { provider, model, ...keyFields, updatedBy: ctx.userId ?? null },
              });
            } else {
              await ctx.db.aiServiceConfig.create({
                data: {
                  appId: resolvedId,
                  name: DEFAULT_AI_CONFIG_NAME,
                  provider,
                  model,
                  ...keyFields,
                  createdBy: ctx.userId ?? null,
                },
              });
            }
          }
        }
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

    // Spec cor:api:060 — run a task by loose name (mirrors hadron_run_task MCP tool).
    // Accepts task/memory hints (case-insensitive substring match) or a fully-qualified
    // URN. Reuses the action runner: {{arg}} substitution, inlined dependencies, usage event.
    runTask: async (
      _: unknown,
      {
        task: taskHint,
        memory: memoryHint,
        urn: directUrn,
        args: argsInput,
      }: {
        task?: string | null;
        memory?: string | null;
        urn?: string | null;
        args?: unknown;
      },
      ctx: Context,
    ) => {
      // Normalize inputs defensively.
      const t = typeof taskHint === 'string' ? taskHint.trim() : '';
      const m = typeof memoryHint === 'string' ? memoryHint.trim() : '';
      const u = typeof directUrn === 'string' ? directUrn.trim() : '';
      const args =
        argsInput && typeof argsInput === 'object' && !Array.isArray(argsInput)
          ? (argsInput as Record<string, unknown>)
          : undefined;

      // Normalize args to string values ({{key}} substitution requires strings).
      const stringArgs = args
        ? Object.fromEntries(
            Object.entries(args).map(([k, v]) => [k, String(v ?? '')]),
          )
        : undefined;

      // Helper to load a node by URN and render it.
      const auth = {
        clientId: ctx.clientId,
        userId: ctx.userId,
        appId: ctx.appId,
        sessionId: ctx.sessionId,
        roles: ctx.roles,
        organizationId: ctx.organizationId,
      };

      const loadAndRender = async (targetNodeUrn: string) => {
        try {
          assertFullyQualifiedUrn(targetNodeUrn, 'node');
        } catch (e) {
          if (e instanceof UrnNotQualifiedError) {
            throw new GraphQLError(e.message, {
              extensions: { code: e.name },
            });
          }
          throw e;
        }

        const { memoryUrn: resolvedMemoryUrn, loc } = splitNodeUrn(targetNodeUrn);

        // Find the memory by URN using case-insensitive matching (legacy `:` and canonical `::` forms).
        const parsedMemUrn = parseUrnInput(resolvedMemoryUrn.trim());
        const normalizedMemUrn = normalizeUrnForLookup(parsedMemUrn.value);
        // Build the canonical form from the normalized (legacy) form.
        const partsMemUrn = normalizedMemUrn.split(':');
        let roleMarkerIdxMem = -1;
        for (let i = partsMemUrn.length - 1; i >= 0; i--) {
          if (['system', 'app-mem', 'app-user', 'group-mem', 'priv'].includes(partsMemUrn[i])) {
            roleMarkerIdxMem = i;
            break;
          }
        }
        const canonicalMemUrn = roleMarkerIdxMem >= 0
          ? partsMemUrn.slice(0, roleMarkerIdxMem).join('::') + '::' + partsMemUrn[roleMarkerIdxMem] + (partsMemUrn.slice(roleMarkerIdxMem + 1).length ? ':' + partsMemUrn.slice(roleMarkerIdxMem + 1).join(':') : '')
          : partsMemUrn.join('::');

        const memory = await ctx.db.memory.findFirst({
          where: {
            OR: [
              { urn: normalizedMemUrn },
              { urn: canonicalMemUrn },
            ],
            deletedAt: null,
          },
          select: { id: true, urn: true },
        });

        if (!memory || !(await canReadMemory(ctx.db, auth, memory.id))) {
          throw new GraphQLError(`Memory not found: "${resolvedMemoryUrn}".`, {
            extensions: { code: 'NOT_FOUND' },
          });
        }

        const node = await ctx.db.node.findUnique({
          where: { loc_memoryId: { loc, memoryId: memory.id } },
          include: { outgoingEdges: { include: { target: true } } },
        });
        if (!node) {
          throw new GraphQLError(`Node "${targetNodeUrn}" not found.`, {
            extensions: { code: 'NOT_FOUND' },
          });
        }

        // Decrypt the node and its outgoing edge targets if the memory is encrypted.
        const nodesToDecrypt = [node, ...node.outgoingEdges.map(e => e.target)];
        await decryptNodesBatch(ctx.db, nodesToDecrypt);

        // Render the node with Mustache template compilation and inlined edges.
        let actionContent = node.content || '';
        if (actionContent.includes('{{')) {
          // Use compileTemplate for proper Mustache template handling.
          // Pass stringArgs as the node data for variable substitution.
          actionContent = await compileTemplate(actionContent, stringArgs ?? null, memory.id, ctx.db, {});
        }

        const topicSections: string[] = [];
        for (const edge of node.outgoingEdges) {
          const target = edge.target;
          if (target.content) {
            // Compose the target node URN directly.
            const targetMemory = await ctx.db.memory.findUniqueOrThrow({
              where: { id: target.memoryId },
              select: { urn: true },
            });
            const targetUrn = composeNodeUrn(targetMemory.urn, target.loc);
            topicSections.push(
              `## Node: ${target.name} (${targetUrn})\n\n${target.content}`,
            );
          }
        }

        // Record usage event (fire-and-forget).
        ctx.db.usageEvent
          .create({
            data: {
              id: generateId(),
              type: 'action-run',
              nodeLoc: loc,
              nodeId: node.id,
              appId: ctx.appId ?? null,
              createdBy: ctx.userId ?? null,
              sessionId: ctx.sessionId ?? null,
              actionArgs: stringArgs,
            },
          })
          .catch(() => {});

        const parts = [`# Node: ${node.name}\n\n${actionContent}`];
        if (topicSections.length > 0) {
          parts.push(
            '---\n\n# Referenced Nodes\n\n' +
              topicSections.join('\n\n---\n\n'),
          );
        }
        return parts.join('\n\n');
      };

      // URN bypass — run directly, no resolution.
      if (u) {
        return loadAndRender(u);
      }

      // Resolve memory (required for non-URN path).
      const accessibleMemoryIdsList = await getAccessibleMemoryIds(ctx);
      const accessibleMemoryIds = accessibleMemoryIdsList ?? [];
      if (accessibleMemoryIds.length === 0) {
        throw new GraphQLError('No memories you can read.', {
          extensions: { code: 'FORBIDDEN' },
        });
      }

      let resolvedMemory: { id: string; urn: string; name: string } | null =
        null;

      if (m) {
        // Memory hint supplied — resolve by name/urn.
        const normalizedM = normalizeUrnForLookup(m);
        const partsM = normalizedM.split(':');
        let roleMarkerIdxM = -1;
        for (let i = partsM.length - 1; i >= 0; i--) {
          if (['system', 'app-mem', 'app-user', 'group-mem', 'priv'].includes(partsM[i])) {
            roleMarkerIdxM = i;
            break;
          }
        }
        const canonicalM = roleMarkerIdxM >= 0
          ? partsM.slice(0, roleMarkerIdxM).join('::') + '::' + partsM[roleMarkerIdxM] + (partsM.slice(roleMarkerIdxM + 1).length ? ':' + partsM.slice(roleMarkerIdxM + 1).join(':') : '')
          : partsM.join('::');

        const candidates = await ctx.db.memory.findMany({
          where: {
            id: { in: accessibleMemoryIds },
            deletedAt: null,
            OR: [
              { name: { contains: m, mode: 'insensitive' } },
              { urn: normalizedM },
              { urn: canonicalM },
            ],
          },
          select: { id: true, urn: true, name: true },
        });

        if (candidates.length === 0) {
          throw new GraphQLError(`No memory matching "${m}".`, {
            extensions: { code: 'NOT_FOUND' },
          });
        }

        if (candidates.length > 1) {
          throw new GraphQLError(
            `Multiple memories match "${m}": ${candidates.map((c) => c.name).join(', ')}. Narrow the hint.`,
            { extensions: { code: 'AMBIGUOUS' } },
          );
        }

        resolvedMemory = candidates[0];
      } else {
        // No memory hint — use the first accessible memory (the resolver does not have
        // access to "active memory" from the MCP session, so we use a default).
        // For better UX, the caller should provide a memory hint or use the MCP tool.
        const mem = await ctx.db.memory.findFirst({
          where: { id: { in: accessibleMemoryIds }, deletedAt: null },
          select: { id: true, urn: true, name: true },
        });

        if (!mem) {
          throw new GraphQLError('No accessible memory found.', {
            extensions: { code: 'NOT_FOUND' },
          });
        }

        resolvedMemory = mem;
      }

      // Load runnable nodes in the resolved memory.
      const runnableNodes = await ctx.db.node.findMany({
        where: { memoryId: resolvedMemory.id, isRunnable: true, deletedAt: null },
        select: {
          id: true,
          loc: true,
          name: true,
          alias: true,
          description: true,
        },
      });

      if (runnableNodes.length === 0) {
        throw new GraphQLError(`No runnable tasks in ${resolvedMemory.name}.`, {
          extensions: { code: 'NOT_FOUND' },
        });
      }

      if (t) {
        // Task hint supplied — rank and resolve.
        const matches = rankByHint(runnableNodes, t);

        if (matches.length === 0) {
          throw new GraphQLError(
            `No runnable task matching "${t}" in ${resolvedMemory.name}.`,
            { extensions: { code: 'NOT_FOUND' } },
          );
        }

        if (matches.length > 1) {
          throw new GraphQLError(
            `Multiple tasks match "${t}" in ${resolvedMemory.name}: ${matches.map((n) => n.name).join(', ')}. Narrow the hint.`,
            { extensions: { code: 'AMBIGUOUS' } },
          );
        }

        // Unique match — run it.
        const nodeUrn = composeNodeUrn(resolvedMemory.urn, matches[0].loc);
        return loadAndRender(nodeUrn);
      } else {
        // No task hint — require explicit choice (GraphQL cannot offer a picker,
        // so we error and list the options).
        if (runnableNodes.length === 1) {
          // Exactly one option — run it.
          const nodeUrn = composeNodeUrn(resolvedMemory.urn, runnableNodes[0].loc);
          return loadAndRender(nodeUrn);
        }

        // Multiple options — error with candidates.
        const candidates = runnableNodes
          .slice(0, 25)
          .map((n) => `- ${n.name}${n.description ? ` (${n.description})` : ''}`)
          .join('\n');
        throw new GraphQLError(
          `Multiple runnable tasks in ${resolvedMemory.name}. Specify a task hint or use MCP tool for interactive selection:\n${candidates}`,
          { extensions: { code: 'AMBIGUOUS' } },
        );
      }
    },
  },
};

interface NodeEdgeInput {
  targetId: string;
  name?: string | null;
  loc?: string | null;
  description?: string | null;
  isRunnable?: boolean | null;
}

interface NodeInput {
  id?: string;
  memoryId: string;
  nodeType?: string;
  isRunnable?: boolean | null;
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

type NodeTextField = 'content' | 'name' | 'alias' | 'description' | 'abstract' | 'tags';

interface SearchReplaceInNodesInput {
  oldText: string;
  newText: string;
  nodeIds?: string[];
  memoryIds?: string[];
  prefix?: string;
  fields: NodeTextField[];
  caseInsensitive?: boolean;
  regex?: boolean;
  dryRun?: boolean;
}

interface EdgeInput {
  sourceLoc: string;
  targetLoc: string;
  name?: string | null;
  loc?: string | null;
  description?: string | null;
  isRunnable?: boolean | null;
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
