import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { generateId } from '../../../lib/id.js';
import { APP_KEY_PREFIX, hashAppKey } from '../../../middleware/auth.js';
import { canWriteToMemory } from '../../../mcp/access-control.js';
import { ensureAgentSubscription } from '../../../controller/operations/ensureAgentSubscription.js';
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
import { parseUrnInput, validateUrnType } from '../../../lib/urn.js';
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
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { completeAssetUpload } from '../../../controller/operations/completeAssetUpload.js';
import { setAgentAssetUploadEnabled } from '../../../controller/operations/setAgentAssetUploadEnabled.js';
import { listAgentAssets } from '../../../controller/operations/listAgentAssets.js';
import { mintAssetDownloadUrl } from '../../../controller/operations/mintAssetDownloadUrl.js';
import { softDeleteAsset } from '../../../controller/operations/softDeleteAsset.js';
import { restoreAsset } from '../../../controller/operations/restoreAsset.js';
import { GraphQLError } from 'graphql';
import type { InputJsonValue } from '../../../generated/prisma/runtime/library.js';
import type {
  PrismaClient,
  Role,
  AppType,
  AppMembershipRole,
  AppAgentRole,
  SubscriptionType,
  MemoryVisibility,
  Prisma,
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
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return null;

  // App Key with an active session — hard-isolate to the session's memory
  // plus the agent's system memory. Even if an LLM asks to read a different
  // memory by ID, this filter denies it. This is THE security boundary for
  // multi-user agents.
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
          // Org memories: ORGANIZATION or PUBLIC visible to all members, PRIVATE only to creator
          ...(orgIds.length > 0
            ? [
                { organizationId: { in: orgIds }, visibility: { not: 'PRIVATE' as any } },
                { organizationId: { in: orgIds }, visibility: 'PRIVATE' as any, createdBy: ctx.userId },
                { subscriptions: { some: { organizationId: { in: orgIds } } } },
              ]
            : []),
          { visibility: 'PUBLIC' as any },
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
 * Deduplicate nodes by loc: when multiple nodes share the same loc across
 * different memories, prefer canonical (isLink=false) over link nodes.
 */
function deduplicateNodes<T extends { loc: string; isLink: boolean }>(nodes: T[]): T[] {
  const byLoc = new Map<string, T>();
  for (const node of nodes) {
    const existing = byLoc.get(node.loc);
    if (!existing || (existing.isLink && !node.isLink)) {
      byLoc.set(node.loc, node);
    }
  }
  return Array.from(byLoc.values());
}

/**
 * Verify the caller has write access to a specific memory.
 *
 * Checks (most restrictive wins):
 * 1. Global ADMIN/OWNER — always allowed (except for PERSONAL memories,
 *    where strict ownership applies per FR-016)
 * 2. App-keyed callers: write resolved by canWriteToMemory which folds
 *    AppAgent.role + AgentMemoryItem.role + AgentSubscription gates
 * 3. Users: org member with CONTRIBUTOR+, or cross-org subscription with CONTRIBUTOR role
 */
async function requireMemoryWriteAccess(ctx: Context, memoryId: string): Promise<void> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;

  if (ctx.appId) {
    if (await canWriteToMemory(ctx.db, ctx, memoryId)) return;
    throw new Error('Forbidden: no write access to this memory');
  }

  // JWT user path
  if (!ctx.userId) throw new Error('Unauthenticated');

  const memory = await ctx.db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: { organizationId: true },
  });

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
      type: { not: 'AGENT_SYSTEM' as const },
    },
    include: MEMORY_INCLUDE,
    orderBy: { name: 'asc' as const },
  },
  agents: { where: { deletedAt: null }, include: { memoryItems: { where: { deletedAt: null, memory: { deletedAt: null } }, include: { memory: true } } }, orderBy: { name: 'asc' as const } },
  apps: { where: { deletedAt: null }, include: { keys: { where: { revokedAt: null } }, appAgents: { include: { agent: true } } }, orderBy: { name: 'asc' as const } },
  subscriptions: { where: { deletedAt: null }, include: { memory: true, organization: true }, orderBy: { createdAt: 'asc' as const } },
  exchangeConnections: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' as const } },
};

const AGENT_INCLUDE = {
  memoryItems: { where: { deletedAt: null, memory: { deletedAt: null } }, include: { memory: true } },
};

const SESSION_INCLUDE = { events: { orderBy: { createdAt: 'desc' as const }, take: 50 } };

const APP_INCLUDE = {
  keys: { where: { revokedAt: null }, orderBy: { createdAt: 'desc' as const } },
  appAgents: {
    where: { deletedAt: null },
    include: { agent: { include: AGENT_INCLUDE } },
    orderBy: { createdAt: 'asc' as const },
  },
};

const toISO = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

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
    organization: (g: { organizationId: string; organization?: unknown }, _: unknown, ctx: Context) =>
      (g as Record<string, unknown>).organization ??
      ctx.db.organization.findUnique({ where: { id: g.organizationId } }),
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
    // For AGENT_SYSTEM memories, find the agent that owns this memory.
    // Returns null for regular knowledge memories. We use a findFirst because
    // there's no FK from Memory → Agent — the relationship is expressed on
    // the Agent side via Agent.systemMemoryId.
    agent: async (g: { id: string; type?: string }, _: unknown, ctx: Context) => {
      if (g.type !== 'AGENT_SYSTEM') return null;
      return ctx.db.agent.findFirst({
        where: { systemMemoryId: g.id, deletedAt: null },
        include: AGENT_INCLUDE,
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
    agents: async (a: { id: string; appAgents?: Array<{ agent: unknown }> }, _: unknown, ctx: Context) => {
      if (a.appAgents) {
        return a.appAgents.map((aa) => aa.agent).filter((g) => g && !(g as { deletedAt?: Date | null }).deletedAt);
      }
      const rows = await ctx.db.appAgent.findMany({
        where: { appId: a.id, deletedAt: null },
        include: { agent: true },
      });
      return rows.map((r) => r.agent).filter((g) => !g.deletedAt);
    },
    agentSubscriptions: async (a: { id: string; appAgents?: unknown[] }, _: unknown, ctx: Context) => {
      if (a.appAgents) return a.appAgents;
      return ctx.db.appAgent.findMany({
        where: { appId: a.id, deletedAt: null },
        include: { agent: { include: AGENT_INCLUDE } },
        orderBy: { createdAt: 'asc' },
      });
    },
    keys: async (a: { id: string; keys?: unknown[] }, _: unknown, ctx: Context) => {
      if (a.keys) return a.keys;
      return ctx.db.appKey.findMany({
        where: { appId: a.id, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    },
  },
  AppAgentSub: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    agent: async (s: { agentId: string; agent?: unknown }, _: unknown, ctx: Context) =>
      s.agent ?? ctx.db.agent.findUnique({ where: { id: s.agentId } }),
  },
  AgentSubscription: {
    createdAt: (s: { createdAt: Date | string }) => toISO(s.createdAt)!,
    activatedAt: (s: { activatedAt?: Date | string | null }) => toISO(s.activatedAt ?? null),
    expiresAt: (s: { expiresAt?: Date | string | null }) => toISO(s.expiresAt ?? null),
    revokedAt: (s: { revokedAt?: Date | string | null }) => toISO(s.revokedAt ?? null),
    isActive: (s: { activatedAt?: Date | null; revokedAt?: Date | null; expiresAt?: Date | null }) => {
      if (!s.activatedAt) return false;
      if (s.revokedAt) return false;
      if (s.expiresAt && new Date(s.expiresAt) <= new Date()) return false;
      return true;
    },
    user: async (s: { userId: string; user?: unknown }, _: unknown, ctx: Context) =>
      s.user ?? ctx.db.user.findUnique({ where: { id: s.userId } }),
    agent: async (s: { agentId: string; agent?: unknown }, _: unknown, ctx: Context) =>
      s.agent ?? ctx.db.agent.findUnique({ where: { id: s.agentId } }),
  },
  AppKey: {
    createdAt: (k: { createdAt: Date | string }) => toISO(k.createdAt)!,
    lastUsedAt: (k: { lastUsedAt?: Date | string | null }) => toISO(k.lastUsedAt ?? null),
    revokedAt: (k: { revokedAt?: Date | string | null }) => toISO(k.revokedAt ?? null),
  },
  User: {
    linkedAt: (u: { linkedAt?: Date | string | null }) => toISO(u.linkedAt ?? null),
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
        // PRIVATE: only creator; ORGANIZATION + PUBLIC: all org members
        where.OR = [
          { visibility: { not: 'PRIVATE' as MemoryVisibility } },
          { visibility: 'PRIVATE' as MemoryVisibility, createdBy: ctx.userId },
        ];
      }
      return ctx.db.agent.findMany({
        where,
        include: { memoryItems: { where: { deletedAt: null, memory: { deletedAt: null } }, include: { memory: true } } },
        orderBy: { name: 'asc' },
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
  },
  UsageEvent: {
    actionArgs: (event: { actionArgs: unknown }) => deserializeJson(event.actionArgs),
  },

  Query: {
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
      const sorted = deduplicateNodes(results).sort((a, b) =>
        (typePriority[a.nodeType] ?? 1) - (typePriority[b.nodeType] ?? 1)
      );
      return sorted.slice(offset ?? 0, (offset ?? 0) + (limit ?? 100));
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
      return deduplicateNodes(results);
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
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
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
      // Find the user memory for (agent, current user). No auto-create
      // here — the list is empty until the user starts their first chat.
      const userMemory = await ctx.db.memory.findFirst({
        where: {
          userMemoryOfAgentId: agentId,
          createdBy: ctx.userId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!userMemory) return [];
      // Top-level chat nodes live at loc "chats:<id>" (depth 2)
      const chatNodes = await ctx.db.node.findMany({
        where: {
          memoryId: userMemory.id,
          loc: { startsWith: 'chats:' },
          deletedAt: null,
        },
      });
      const tops = chatNodes.filter((n) => n.loc.split(':').length === 2);
      // Pre-fetch first user message per chat for title fallback
      const firstMessagesByChat = new Map<string, string>();
      for (const top of tops) {
        const firstMsg = await ctx.db.node.findFirst({
          where: {
            memoryId: userMemory.id,
            loc: { startsWith: `${top.loc}:messages:` },
            deletedAt: null,
          },
          orderBy: { seq: 'asc' as const },
          select: { loc: true, content: true },
        });
        if (firstMsg?.content) firstMessagesByChat.set(top.loc, firstMsg.content);
      }
      const chats = tops.map((node) => {
        const data = (node.data as Record<string, unknown>) ?? {};
        const title = deriveChatTitle(node, data, firstMessagesByChat.get(node.loc) ?? null);
        return {
          id: node.id,
          loc: node.loc,
          title,
          conversationName: (data.conversationName as string) ?? null,
          stageName: (data.stageName as string) ?? null,
          messageCount: (data.messageCount as number) ?? 0,
          createdAt: node.createdAt,
          lastMessageAt: (data.lastMessageAt as string) ?? null,
        };
      });
      chats.sort((a, b) => {
        const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : Date.parse(String(a.createdAt));
        const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : Date.parse(String(b.createdAt));
        return tb - ta;
      });
      return chats.slice(offset ?? 0, (offset ?? 0) + (limit ?? 100));
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
      // Ownership check: the user must own the memory the chat lives in.
      const mem = await ctx.db.memory.findUniqueOrThrow({
        where: { id: chatNode.memoryId },
        select: { createdBy: true },
      });
      if (mem.createdBy !== ctx.userId && !ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        throw new Error('Forbidden');
      }
      const rows = await ctx.db.node.findMany({
        where: {
          memoryId: chatNode.memoryId,
          loc: { startsWith: `${chatId}:messages:` },
          deletedAt: null,
        },
        orderBy: { seq: 'asc' as const },
        take: limit ?? 100,
        select: { loc: true, content: true, seq: true, createdAt: true },
      });
      return rows.map((m) => {
        const name = m.loc.split(':').pop() ?? '';
        const isUser = !name.includes('assistant') && !name.includes('a-summary');
        return {
          role: isUser ? 'user' : 'assistant',
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
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: id, userId: ctx.userId } },
        });
        if (!member) throw new Error('Forbidden');
      }
      return ctx.db.organization.findUnique({ where: { id }, include: ORG_INCLUDE });
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
      // Authorization: platform ADMIN or member of the org
      if (!ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        if (!ctx.userId) throw new Error('Forbidden');
        const member = await ctx.db.orgMember.findUnique({
          where: { organizationId_userId: { organizationId: orgId, userId: ctx.userId } },
        });
        if (!member) throw new Error('Forbidden');
      }
      return ctx.db.memory.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          type: 'AGENT_SYSTEM',
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
        : { type: { not: 'AGENT_SYSTEM' as const } };

      // App-keyed caller — return memories from AppAgent membership
      if (ctx.appId) {
        const appAgents = await ctx.db.appAgent.findMany({
          where: { appId: ctx.appId, deletedAt: null },
          include: { agent: { include: { memoryItems: { include: { memory: { include: MEMORY_INCLUDE } } } } } },
        });
        const memoryMap = new Map<string, any>();
        for (const sub of appAgents) {
          for (const item of sub.agent.memoryItems) {
            if (!includeAgentSystem && item.memory.type === 'AGENT_SYSTEM') continue;
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
            // Also exclude per-user memories — they belong to the chatbot
            // flow, not the user's regular memory list.
            userMemoryOfAgentId: null,
            OR: [
              { organizationId: { in: orgIds } },
              { subscriptions: { some: { organizationId: { in: orgIds } } } },
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
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.exchangeConnection.findMany({
        where: { organizationId: orgId, deletedAt: null },
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
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.app.findMany({
        where: { organizationId: orgId, deletedAt: null },
        include: APP_INCLUDE,
        orderBy: { name: 'asc' },
      });
    },

    app: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const app = await ctx.db.app.findUnique({ where: { id }, include: APP_INCLUDE });
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
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      return ctx.db.agentSubscription.findMany({
        where: { agentId },
        orderBy: { createdAt: 'desc' },
      });
    },

    appNodes: async (
      _: unknown,
      { appId, limit }: { appId: string; limit?: number },
      ctx: Context,
    ) => {
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
      // Org-scoped auth: anyone with org membership at READER+ on the App's
      // org may read its accessible nodes; platform ADMIN/OWNER bypasses.
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        await requireOrgRole(ctx, app.organizationId, 'READER');
      }
      const subs = await ctx.db.appAgent.findMany({
        where: { appId, deletedAt: null },
        include: { agent: { include: { memoryItems: true } } },
      });
      const memoryIds = [
        ...new Set(subs.flatMap((s) => s.agent.memoryItems.map((m) => m.memoryId))),
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
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
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
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) {
        await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      }
      return ctx.db.appKey.findMany({
        where: { appId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
      });
    },
  },

  Mutation: {
    upsertNode: async (_: unknown, { input }: { input: NodeInput }, ctx: Context) => {
      // Resolve memoryId from loc prefix when not provided
      if (!input.memoryId) {
        const memories = await ctx.db.memory.findMany({
          where: { deletedAt: null },
          select: { id: true, urn: true },
        });
        const match = memories
          .filter((m) => m.urn && input.loc.startsWith(m.urn))
          .sort((a, b) => b.urn.length - a.urn.length)[0];
        if (match) {
          input.memoryId = match.id;
          // Strip memory URN prefix from loc — loc should be memory-relative
          const prefix = match.urn + ':';
          if (input.loc.startsWith(prefix)) {
            input.loc = input.loc.slice(prefix.length);
          }
        } else {
          throw new Error(`Cannot resolve memory for loc "${input.loc}". Provide a memoryId or set an active memory.`);
        }
      }
      await requireMemoryWriteAccess(ctx, input.memoryId);

      // Reject saves whose extraction-spec arrays would write into the
      // reserved exception namespace (spec 001-edge-condition-spec FR-013).
      throwOnReservedExtractionSpec(input.data);

      // Snapshot current state before update (for version history)
      const existing = await ctx.db.node.findUnique({
        where: { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
      });
      if (existing) {
        await ctx.db.nodeVersion.create({
          data: {
            nodeId: existing.id,
            loc: existing.loc,
            name: existing.name,
            alias: existing.alias,
            description: existing.description,
            content: existing.content,
            tags: existing.tags as string[],
            editedBy: ctx.clientId ?? ctx.userId ?? null,
            createdBy: ctx.userId ?? ctx.clientId ?? null,
          },
        });
      }

      const tags = serializeTags(input.tags ?? []) as string[];
      const id = input.id ?? generateId();
      const { edges, ...nodeFields } = input;
      const createdBy = ctx.userId ?? ctx.clientId ?? null;

      // If the target memory is encrypted, encrypt content and data before
      // writing. Throws SESSION_EXPIRED if no session key is cached.
      const memEncInfo = await getMemoryEncryptionInfo(ctx.db, input.memoryId);
      if (memEncInfo.isEncrypted) {
        const key = sessionKeyCache.getByMemoryId(memEncInfo.id);
        if (!key) {
          throw new Error('SESSION_EXPIRED: memory is encrypted but no active session key is available');
        }
        const enc = encryptNodeFieldsWithKey(
          { content: nodeFields.content ?? null, data: nodeFields.data ?? null },
          key,
        );
        (nodeFields as Record<string, unknown>).content = enc.content ?? undefined;
        (nodeFields as Record<string, unknown>).data = enc.data ?? undefined;
      }

      const node = await ctx.db.node.upsert({
        where: { loc_memoryId: { loc: input.loc, memoryId: input.memoryId } },
        create: { ...nodeFields, id, tags, createdBy } as Prisma.NodeUncheckedCreateInput,
        update: { ...nodeFields, tags } as Prisma.NodeUncheckedUpdateInput,
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });

      // For the return value, decrypt the result back so callers see plaintext.
      if (memEncInfo.isEncrypted) {
        decryptNodeFields(node, memEncInfo);
      }

      let finalNode = node;
      if (edges !== undefined) {
        await ctx.db.edge.deleteMany({ where: { sourceId: node.id } });
        await ctx.db.pendingEdge.deleteMany({ where: { sourceId: node.id } });
        for (const e of edges) {
          const target = await ctx.db.node.findUnique({ where: { id: e.targetId } });
          if (target) {
            await ctx.db.edge.upsert({
              where: { sourceId_targetId_label: { sourceId: node.id, targetId: target.id, label: e.label ?? '' } },
              create: { sourceId: node.id, targetId: target.id, label: e.label ?? '', createdBy },
              update: {},
            });
          } else {
            await ctx.db.pendingEdge.upsert({
              where: { sourceId_targetId: { sourceId: node.id, targetId: e.targetId } },
              create: { sourceId: node.id, targetId: e.targetId, label: e.label ?? null, createdBy },
              update: { label: e.label ?? null },
            });
          }
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
        content: finalNode.content,
        tags: deserializeTags(finalNode.tags) as string[],
        outgoingEdges: finalNode.outgoingEdges ?? [],
      }, input.ownerRepo ?? '', ctx.clientId, input.memoryId).catch((err) => {
        console.error('[upsertNode] git write error:', err);
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
      return ctx.db.node.update({
        where: { loc_memoryId: { loc: from, memoryId: resolvedMemoryId } },
        data: { loc: to, memoryId: destMemoryId },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
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
      const existing = await ctx.db.app.findUniqueOrThrow({ where: { id } });
      const isPlatformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
      if (!isPlatformAdmin) await requireOrgRole(ctx, existing.organizationId, 'ADMIN');

      // Revoke all active keys, then create a fresh one.
      await ctx.db.appKey.updateMany({
        where: { appId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      const rawKey = `${APP_KEY_PREFIX}${randomBytes(32).toString('hex')}`;
      const keyHash = createHash('sha256').update(rawKey).digest('hex');
      await ctx.db.appKey.create({
        data: {
          id: generateId(),
          appId: id,
          keyHash,
          keyPreview: rawKey.slice(-4),
          label: 'Regenerated key',
          createdBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null,
        },
      });
      const fresh = await ctx.db.app.findUniqueOrThrow({
        where: { id },
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
      await requireOrgRole(ctx, id, 'ADMIN');
      return ctx.db.organization.update({
        where: { id },
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
      await ctx.db.organization.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },

    linkGithubApp: async (
      _: unknown,
      { orgId, installationId }: { orgId: string; installationId: number },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.organization.update({
        where: { id: orgId },
        data: { githubInstallationId: installationId },
        include: ORG_INCLUDE,
      });
    },

    updateOrgGithubApp: async (
      _: unknown,
      { orgId, appId, privateKey }: { orgId: string; appId: string; privateKey: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      const encrypted = encryptToken(privateKey);
      return ctx.db.organization.update({
        where: { id: orgId },
        data: { githubAppId: appId, githubAppPrivateKeyEncrypted: encrypted },
        include: ORG_INCLUDE,
      });
    },

    unlinkGithubApp: async (
      _: unknown,
      { orgId }: { orgId: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.organization.update({
        where: { id: orgId },
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
      await requireOrgRole(ctx, orgId, 'ADMIN');
      const slug = generateId().slice(0, 16);
      const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : null;
      const invite = await ctx.db.userInvitation.create({
        data: {
          id: generateId(),
          slug,
          senderUserId: ctx.userId ?? null,
          organizationId: orgId,
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
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.orgMember.create({
        data: { id: generateId(), organizationId: orgId, userId, role: role as Role, createdBy: ctx.userId ?? ctx.clientId ?? null },
        include: { user: true },
      });
    },

    updateOrgMember: async (
      _: unknown,
      { orgId, userId, role }: { orgId: string; userId: string; role: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      return ctx.db.orgMember.update({
        where: { organizationId_userId: { organizationId: orgId, userId } },
        data: { role: role as Role },
        include: { user: true },
      });
    },

    removeOrgMember: async (
      _: unknown,
      { orgId, userId }: { orgId: string; userId: string },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      // Cannot remove the last OWNER
      const owners = await ctx.db.orgMember.findMany({
        where: { organizationId: orgId, role: 'OWNER', deletedAt: null },
      });
      const member = await ctx.db.orgMember.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: orgId, userId } },
      });
      if (member.role === 'OWNER' && owners.length <= 1) {
        throw new Error('Cannot remove the last owner of an organization');
      }
      await ctx.db.orgMember.delete({
        where: { organizationId_userId: { organizationId: orgId, userId } },
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
        type,
      }: {
        orgId: string; name: string;
        shortDescription?: string; description?: string; tags?: string[];
        license?: string; category0?: string; category1?: string; category2?: string;
        iconUrl?: string; heroUrl?: string; homeUrl?: string;
        source?: string | null; readBranch?: string; writeBranch?: string; visibility?: string;
        type?: 'KNOWLEDGE' | 'AGENT_SYSTEM';
      },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      const memOrg = await ctx.db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { urn: true } });
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
      const memory = await ctx.db.memory.create({
        data: {
          id: generateId(),
          organizationId: orgId,
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
          visibility: (visibility as MemoryVisibility) ?? 'PRIVATE',
          type: type ?? 'KNOWLEDGE',
          // 005-agent-subscription: explicit user-driven createMemory
          // creates a knowledge-class memory by default. Personal-class
          // memories are auto-provisioned via the AgentSubscription
          // path; system-class via Agent.systemMemoryId.
          class: 'knowledge',
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
        include: MEMORY_INCLUDE,
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
      }: {
        id: string; name?: string; urn?: string; organizationId?: string;
        shortDescription?: string; description?: string; tags?: string[];
        license?: string; category0?: string; category1?: string; category2?: string;
        iconUrl?: string; heroUrl?: string; homeUrl?: string;
        source?: string; readBranch?: string; writeBranch?: string; visibility?: string;
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
      return ctx.db.memory.update({
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
        },
        include: MEMORY_INCLUDE,
      });
    },

    deleteMemory: async (_: unknown, { id }: { id: string }, ctx: Context) => {
      const memory = await ctx.db.memory.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      // AGENT_SYSTEM memories are owned by their agent and can only be
      // removed by deleting the agent. This prevents the agent from ending
      // up with no brain via a stray deleteMemory call.
      if (memory.type === 'AGENT_SYSTEM') {
        throw new Error('Cannot delete an agent system memory directly. Delete the owning agent instead.');
      }
      await ctx.db.memory.update({ where: { id }, data: { deletedAt: new Date() } });
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
      await requireOrgRole(ctx, orgId, 'ADMIN');
      const org = await ctx.db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { urn: true } });
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
      const agentVisibility = (visibility as MemoryVisibility) ?? 'PRIVATE';

      // If a systemMemoryId is provided at create time, validate the target
      // and mark it as AGENT_SYSTEM with the synced name and visibility.
      // This is the wizard's primary entry point.
      if (systemMemoryId) {
        const target = await ctx.db.memory.findUniqueOrThrow({ where: { id: systemMemoryId } });
        if (target.organizationId !== orgId) {
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
            type: 'AGENT_SYSTEM',
            name: `${name} System`,
            visibility: agentVisibility,
          },
        });
      }

      return ctx.db.agent.create({
        data: {
          organizationId: orgId, urn: agentUrn, name, description, systemPrompt, systemMemoryId: systemMemoryId ?? null,
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
          // org, isn't already another agent's system memory, and mark it
          // as AGENT_SYSTEM.
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
              type: 'AGENT_SYSTEM',
              // Sync name + visibility immediately to the target memory.
              name: `${name ?? agent.name} System`,
              visibility: (visibility as MemoryVisibility) ?? agent.visibility,
            },
          });
        }
      }

      // ── Name / visibility sync for existing system memory.
      // If the agent already has a system memory and the caller is updating
      // name or visibility on the agent, propagate to the memory so they
      // stay in lockstep.
      if (agent.systemMemoryId && (name !== undefined || visibility !== undefined)) {
        await ctx.db.memory.update({
          where: { id: agent.systemMemoryId },
          data: {
            ...(name !== undefined ? { name: `${name} System` } : {}),
            ...(visibility !== undefined ? { visibility: visibility as MemoryVisibility } : {}),
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
          ...(visibility !== undefined ? { visibility: visibility as MemoryVisibility } : {}),
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
      // AGENT_SYSTEM memories can only be linked via Agent.systemMemoryId.
      // Attaching them as regular memory items would allow access patterns
      // we don't want (e.g. another agent reading Juno's prompts).
      const memory = await ctx.db.memory.findUniqueOrThrow({
        where: { id: resolvedMemoryId },
        select: { type: true },
      });
      if (memory.type === 'AGENT_SYSTEM') {
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

      if (memory.visibility === 'ORGANIZATION' || memory.visibility === 'PRIVATE') {
        throw new Error('Only public memories can be subscribed to by other organizations');
      }

      if (memory.visibility === 'PUBLIC') {
        await requireOrgRole(ctx, resolvedOrgId, 'ADMIN');
      } else {
        await requireOrgRole(ctx, memory.organizationId, 'ADMIN');
      }

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

      // Snapshot current state before restoring
      await ctx.db.nodeVersion.create({
        data: {
          id: generateId(),
          nodeId: node.id,
          loc: node.loc,
          name: node.name,
          alias: node.alias,
          description: node.description,
          content: node.content,
          tags: node.tags as string[],
          editedBy: ctx.clientId ?? ctx.userId ?? null,
          createdBy: ctx.userId ?? ctx.clientId ?? null,
        },
      });

      // Restore the node to the version's state
      return ctx.db.node.update({
        where: { id: node.id },
        data: {
          name: version.name,
          alias: version.alias,
          description: version.description,
          content: version.content,
          tags: version.tags as string[],
        },
        include: { outgoingEdges: { include: { target: true } }, incomingEdges: { include: { source: true } } },
      });
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
      { agentId, userId, conversationName }: { agentId: string; userId?: string; conversationName?: string },
      ctx: Context,
    ) => {
      requireRole(ctx, 'READER');

      // Resolve effective user id. The portal calls with userId omitted and
      // we use ctx.userId. The App Key path can pass an externalUserId.
      // Legacy callers with no user get "anonymous".
      const effectiveUserId = userId ?? ctx.userId ?? 'anonymous';

      // 005-agent-subscription FR-002: auto-provision an AgentSubscription
      // on the first user-attributed contact for (user, agent). Idempotent.
      // Skip for the "anonymous" sentinel — there is no User row.
      if (effectiveUserId !== 'anonymous') {
        await ensureAgentSubscription(ctx.db, effectiveUserId, agentId);
      }

      // Load agent with system memory
      const agent = await ctx.db.agent.findUniqueOrThrow({
        where: { id: agentId },
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
      // in a user-scoped memory. Three auth paths:
      //   1. App Key session with an active sessionId → use session.memoryId
      //   2. JWT user → find-or-create a per-user memory for (agent, ctx.userId)
      //   3. Legacy fallback → first writable memory attached to the agent
      let targetMemoryId: string | null = null;
      if (ctx.appId && ctx.sessionId) {
        const session = await ctx.db.session.findUnique({
          where: { id: ctx.sessionId },
          select: { memoryId: true },
        });
        targetMemoryId = session?.memoryId ?? null;
      } else if (ctx.userId) {
        const existing = await ctx.db.memory.findFirst({
          where: {
            userMemoryOfAgentId: agentId,
            createdBy: ctx.userId,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (existing) {
          targetMemoryId = existing.id;
        } else {
          // Lazily provision a per-user memory for this (agent, user).
          const org = await ctx.db.organization.findUniqueOrThrow({
            where: { id: agent.organizationId }, select: { urn: true },
          });
          const opaqueId = generateId();
          const agentSlug = agent.urn.split(':').slice(1).join(':');
          const memoryUrn = `${org.urn}:${agentSlug}:user:${opaqueId}`;
          const created = await ctx.db.memory.create({
            data: {
              organizationId: agent.organizationId,
              urn: memoryUrn,
              name: `${agent.name} — ${ctx.userId}`,
              // 005-agent-subscription: personal-class memory; userId
              // owner-pivot is required by the bidirectional CHECK
              // constraint (PERSONAL ⇔ userId IS NOT NULL). Note:
              // organizationId stays at agent.organizationId here for
              // the legacy JWT-user path; the spec's FR-015 (use
              // user's personal org) applies to the new App-keyed
              // AgentSubscription auto-provisioning path.
              userId: ctx.userId,
              class: 'personal',
              visibility: 'PERSONAL',
              userMemoryOfAgentId: agentId,
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

      // Compile the prompt with Mustache against the target memory's data
      let systemMessage = promptContent;
      if (promptContent.includes('{{')) {
        const access = await memoryAccessFilter(ctx);
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
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
      const shortId = generateId().slice(-8);
      const chatName = `${ts}-${shortId}-${convName}`;
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

      // Create the chat node with initial goal stack and route history
      const initialChatData: Record<string, unknown> = {
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
      const messageCount = ((chatData.messageCount as number) ?? 0) + 1;
      const convName = chatData.conversationName as string;
      const stageName = chatData.stageName as string;

      // Save user message. When the memory is encrypted we need to encrypt
      // the message content AND the chat node's updated `data`.
      const msgNum = String(messageCount).padStart(3, '0');
      const userId = chatData.userId as string ?? 'user';
      const newMsgFields = encryptNodeFields(
        { content: userMessage, data: null },
        memEncInfo,
      );
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${msgNum}-${userId}`, name: `${msgNum}-${userId}`,
          nodeType: 'record', content: newMsgFields.content ?? null, seq: messageCount,
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

        // Compile with data
        const access = await memoryAccessFilter(ctx);
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

      const messageHistory = messages.map((m) => {
        const name = m.loc.split(':').pop() ?? '';
        const isUser = !name.includes('assistant') && !name.includes('juno') && !name.includes('ai');
        return { role: isUser ? 'user' : 'assistant', content: m.content ?? '' };
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
      const messageCount = ((chatData.messageCount as number) ?? 0) + 1;

      const message = (toolResponse.message as string) ?? '';
      const data = toolResponse.data as Record<string, unknown> | undefined;
      const nextStage = toolResponse.next_stage as string | undefined;
      const onTrack = toolResponse.onTrack as boolean | undefined;
      const offTrackReason = toolResponse.offTrackReason as string | undefined;

      // Save assistant message (encrypted when memory is encrypted)
      const msgNum = String(messageCount).padStart(3, '0');
      const encMsg = encryptNodeFields({ content: message, data: null }, memEncInfo);
      await ctx.db.node.create({
        data: {
          id: generateId(), memoryId: chatNode.memoryId,
          loc: `${chatId}:messages:${msgNum}-assistant`, name: `${msgNum}-assistant`,
          nodeType: 'record', content: encMsg.content ?? null, seq: messageCount,
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
                      sourceNodeUrn: `urn:memory:${sysMemId}:${currentStageLoc}`,
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
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
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
        where: { id: agentId },
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
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');
      return ctx.db.agent.update({
        where: { id: agentId },
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
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
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
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
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
        where: { id: agentId },
        data: { publishedRevisionLoc: revisionLoc },
      });

      return { revisionLoc, label, published: true, createdAt: new Date().toISOString() };
    },

    restoreRevision: async (
      _: unknown,
      { agentId, revisionLoc }: { agentId: string; revisionLoc: string },
      ctx: Context,
    ) => {
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
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
      await resolvers.Mutation.createRevision({}, { agentId, description: `Auto-save before restoring ${revisionLoc}` }, ctx);

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
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
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
        where: { id: agentId },
        data: { editorLockUserId: ctx.userId, editorLockExpiresAt: expiresAt },
      });

      return { locked: true, lockedBy: ctx.userId, expiresAt: expiresAt.toISOString() };
    },

    releaseEditorLock: async (
      _: unknown,
      { agentId }: { agentId: string },
      ctx: Context,
    ) => {
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
      await requireOrgRole(ctx, agent.organizationId, 'ADMIN');

      await ctx.db.agent.update({
        where: { id: agentId },
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
      const mem = await ctx.db.memory.findUniqueOrThrow({
        where: { id: chatNode.memoryId },
        select: { createdBy: true },
      });
      if (mem.createdBy !== ctx.userId && !ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        throw new Error('Forbidden');
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
      const mem = await ctx.db.memory.findUniqueOrThrow({
        where: { id: chatNode.memoryId },
        select: { createdBy: true },
      });
      if (mem.createdBy !== ctx.userId && !ctx.roles?.includes('ADMIN') && !ctx.roles?.includes('OWNER')) {
        throw new Error('Forbidden');
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
        // App-original fields
        createUserPermission,
        identifyUserMethod,
        sessionTimeoutSeconds,
        anonymousTtlDays,
      }: {
        orgId: string; name: string;
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
        createUserPermission?: 'DENY' | 'EXPLICIT' | 'IMPLICIT';
        identifyUserMethod?: 'USER_ID' | 'SECRET';
        sessionTimeoutSeconds?: number;
        anonymousTtlDays?: number;
      },
      ctx: Context,
    ) => {
      await requireOrgRole(ctx, orgId, 'ADMIN');
      // URN format matches memories and agents: "{org.urn}:{slug}".
      // If the caller provides an explicit slug use it; otherwise derive from
      // the name (lowercase, non-alphanum → hyphens, trimmed).
      const org = await ctx.db.organization.findUniqueOrThrow({
        where: { id: orgId }, select: { urn: true },
      });
      const slug = (urn ?? name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
      if (!slug) throw new Error('App URN slug cannot be empty');
      const appUrn = `${org.urn}:${slug}`;
      // Hard-delete a soft-deleted collision so the URN can be reused
      // (same pattern as createAgent/createMemory)
      const existing = await ctx.db.app.findUnique({ where: { urn: appUrn } });
      if (existing) {
        if (existing.deletedAt) {
          await ctx.db.app.delete({ where: { id: existing.id } });
        } else {
          throw new Error(`An app with URN "${appUrn}" already exists`);
        }
      }
      return ctx.db.app.create({
        data: {
          organizationId: orgId,
          name,
          urn: appUrn,
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
        },
        include: APP_INCLUDE,
      });
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
        createUserPermission?: 'DENY' | 'EXPLICIT' | 'IMPLICIT';
        identifyUserMethod?: 'USER_ID' | 'SECRET';
        sessionTimeoutSeconds?: number;
        anonymousTtlDays?: number;
      },
      ctx: Context,
    ) => {
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id } });
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
        where: { id },
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
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      await ctx.db.app.update({ where: { id }, data: { deletedAt: new Date() } });
      return true;
    },

    addAgentToApp: async (
      _: unknown,
      {
        appId,
        agentId,
        role,
        trainingMode,
      }: {
        appId: string;
        agentId: string;
        role?: AppAgentRole;
        trainingMode?: boolean;
      },
      ctx: Context,
    ) => {
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      // Agent must belong to the same org
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: agentId } });
      if (agent.organizationId !== app.organizationId) {
        throw new Error('Agent must belong to the same organization as the App');
      }
      // 005-agent-subscription: subscription_type was dropped; the cap
      // it used to enforce is governed by AgentMemoryItem.role per-attached
      // memory.
      await ctx.db.appAgent.upsert({
        where: { appId_agentId: { appId, agentId } },
        create: {
          appId,
          agentId,
          role: role ?? 'OPERATE',
          trainingMode: trainingMode ?? false,
          createdBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null,
        },
        update: {
          ...(role !== undefined ? { role } : {}),
          ...(trainingMode !== undefined ? { trainingMode } : {}),
          updatedBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null,
        },
      });
      return ctx.db.app.findUniqueOrThrow({ where: { id: appId }, include: APP_INCLUDE });
    },

    removeAgentFromApp: async (
      _: unknown,
      { appId, agentId }: { appId: string; agentId: string },
      ctx: Context,
    ) => {
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      await ctx.db.appAgent
        .delete({ where: { appId_agentId: { appId, agentId } } })
        .catch(() => {}); // idempotent
      return ctx.db.app.findUniqueOrThrow({ where: { id: appId }, include: APP_INCLUDE });
    },

    createAppKey: async (
      _: unknown,
      { appId, label }: { appId: string; label?: string },
      ctx: Context,
    ) => {
      const app = await ctx.db.app.findUniqueOrThrow({ where: { id: appId } });
      await requireOrgRole(ctx, app.organizationId, 'ADMIN');
      // Raw key format: hdr_app_<64 hex chars> (256 bits of entropy)
      const rawKey = APP_KEY_PREFIX + randomBytes(32).toString('hex');
      const keyHash = hashAppKey(rawKey);
      const keyPreview = rawKey.slice(0, 12) + '...' + rawKey.slice(-4);
      const appKey = await ctx.db.appKey.create({
        data: {
          appId,
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

      // App must be allowed to operate this agent
      const allowed = await ctx.db.appAgent.findUnique({
        where: { appId_agentId: { appId: ctx.appId, agentId } },
      });
      if (!allowed) throw new Error('Forbidden: App is not allowed to operate this agent');

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
              // Bidirectional CHECK constraint requires PERSONAL ⇔ userId
              // IS NOT NULL.
              userId,
              class: 'personal',
              visibility: 'PERSONAL',
              userMemoryOfAgentId: agentId,
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
            visibility: 'PRIVATE',
            userMemoryOfAgentId: agentId,
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
  content?: string;
  data?: Record<string, unknown>;
  seq?: number;
  tags?: string[];
  properties?: Record<string, unknown>;
  llmModel?: string;
  aiAgent?: string;
  ownerRepo?: string;
  edges?: NodeEdgeInput[];
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
