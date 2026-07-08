// Helpers extracted from resolvers.ts (Step 1 of the resolver split).
// Pure mechanical move: shared auth/include/AI-config/chat/asset helpers used
// by the GraphQL resolver map. No behavior change. The `Context` interface
// lives here and is re-exported from resolvers.ts for existing importers.
import { decryptToken } from '../../../lib/tokenCrypto.js';
import type { NodeMergeField } from '../../../lib/nodeMerge.js';
import {
  AiServiceConfigNotFoundError,
  AiConfigValidationError,
  DuplicateAiServiceConfigNameError,
  NoAiConfigAvailableError,
  UnknownAiProviderError,
  DEFAULT_AI_CONFIG_NAME,
  type AiConfigOwnerType,
} from '../../../lib/aiConfig.js';
import { canWriteToMemory } from '../../../mcp/access-control.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import {
  getPrimaryAgent,
  isAgentInstalled,
} from '../../../lib/appAgent.js';
import { getOrgReadableMemoryIds } from '../../../lib/auth/orgReadableMemory.js';
import {
  formatCanonicalUrn,
  type CanonicalUrnType,
} from '../../../lib/urn.js';
import {
  validateEdgeCondition,
  validateNodeDataExtractionSpecs,
  type EvaluationError,
} from '../../../lib/edge-conditions/index.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { GraphQLError } from 'graphql';
import {
  Prisma,
  type PrismaClient,
} from '../../../generated/prisma/index.js';

export interface Context {
  db: PrismaClient;
  clientId?: string;       // "github:<username>" / "email:<addr>" — only set for OAuth/JWT users
  userId?: string;         // User.id — only set for OAuth/JWT users
  appId?: string;          // App.id — set when caller authenticated via an App Key
  sessionId?: string;      // Session.id — set when operating inside an active session
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  organizationId?: string; // set when the Client is scoped to an organization
  apiKeyId?: string;       // UserApiKey.id — set when a user authenticated via an hdr_user_ key (#562)
  // Request-scoped memo for Edge.source/target lazy loads — avoids an N+1 of
  // identical node.findUnique calls when many edges in one response share an
  // endpoint (lazily created on first use; see loadEdgeEndpointNode). #381.
  edgeEndpointNodeCache?: Map<string, Promise<unknown>>;
  // Request-scoped memo for Node.urn / Edge.urn composition (#481) — a list
  // response's nodes/edges overwhelmingly share a memory, so the memory-urn
  // lookup is memoized per request (lazily created; see loadMemoryUrn).
  memoryUrnCache?: Map<string, Promise<string | null>>;
}

/**
 * Fetch a memory's stored urn by id, memoized per request (#481). Backs the
 * Node.urn / Edge.urn field resolvers on list surfaces (findNodes, appNodes,
 * edges, nodeBatch), where every row in a page typically shares one memory —
 * without memoization each row would issue an identical findUnique.
 */
export function loadMemoryUrn(ctx: Context, memoryId: string): Promise<string | null> {
  const cache = (ctx.memoryUrnCache ??= new Map<string, Promise<string | null>>());
  let pending = cache.get(memoryId);
  if (!pending) {
    pending = ctx.db.memory
      .findUnique({ where: { id: memoryId }, select: { urn: true } })
      .then((m: { urn: string } | null) => m?.urn ?? null);
    cache.set(memoryId, pending);
  }
  return pending;
}

/**
 * Fetch an edge endpoint node by id, memoized per request (#381). Edges in a
 * single response frequently share an endpoint (e.g. every outgoing edge's
 * source is the parent node), so without memoization the Edge.source/target
 * lazy-load path would issue one identical findUnique per edge. The cache is
 * lazily attached to the (request-scoped) Context, so contexts that never hit
 * the lazy path pay nothing.
 */
export function loadEdgeEndpointNode(ctx: Context, id: string): Promise<unknown> {
  const cache = (ctx.edgeEndpointNodeCache ??= new Map<string, Promise<unknown>>());
  let pending = cache.get(id);
  if (!pending) {
    pending = ctx.db.node.findUnique({ where: { id } });
    cache.set(id, pending);
  }
  return pending;
}

export const ROLE_ORDER: Record<string, number> = { READER: 0, CONTRIBUTOR: 1, ADMIN: 2, OWNER: 3 };

export function requireRole(ctx: Context, required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER') {
  const highest = ctx.roles ? Math.max(...ctx.roles.map((r) => ROLE_ORDER[r] ?? -1)) : -1;
  if (highest < ROLE_ORDER[required]) throw new Error('Forbidden');
}

/**
 * Validate an edge-condition payload at GraphQL save-time. Throws a
 * GraphQLError with the contract's named extension codes on failure.
 * See specs/001-edge-condition-spec/contracts/graphql-edge-condition.md.
 */
export function throwOnInvalidCondition(condition: unknown): void {
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
export function throwOnReservedExtractionSpec(data: unknown): void {
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

export async function requireOrgRole(
  ctx: Context,
  orgId: string,
  required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER',
): Promise<void> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;
  if (!ctx.userId) throw new Error('Forbidden');
  // findFirst (not findUnique on the composite PK) so a REVOKED (soft-deleted)
  // membership no longer authorizes — matches getMemberOrgIds / resolveOrgScope
  // and the memory(ref) resolver's own membership check (PR-475 review, Codex
  // P1: a removed member who still knew an agent/app ref could read it).
  const member = await ctx.db.orgMember.findFirst({
    where: { organizationId: orgId, userId: ctx.userId, deletedAt: null },
  });
  if (!member || (ROLE_ORDER[member.role] ?? -1) < ROLE_ORDER[required]) {
    throw new Error('Forbidden');
  }
}

// ── 036-ai-service-config helpers ──────────────────────────────────────

export function isPlatformAdmin(ctx: Context): boolean {
  return !!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'));
}

/**
 * Boolean form of the org-membership gate (`requireOrgRole` throws; this
 * returns a boolean). True for a platform ADMIN/OWNER, or a live (non-revoked)
 * member of `orgId` at any role. Used where no-access must degrade gracefully
 * rather than throw Forbidden — the Agent "who uses this agent" fields
 * (`appCount` / `orgGrants`) that are scoped to the agent's owning org (#551).
 * `findFirst` + `deletedAt: null` so a revoked membership no longer authorizes
 * (matches `requireOrgRole`).
 */
export async function isOrgMemberOrAdmin(ctx: Context, orgId: string): Promise<boolean> {
  if (isPlatformAdmin(ctx)) return true;
  if (!ctx.userId) return false;
  const member = await ctx.db.orgMember.findFirst({
    where: { organizationId: orgId, userId: ctx.userId, deletedAt: null },
  });
  return !!member;
}

/** Row shape shared by the masked mappers below (no key material leaves). */
export interface AiServiceConfigRow {
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

export function aiConfigOwnerOf(c: AiServiceConfigRow): { ownerType: AiConfigOwnerType; ownerId: string } {
  if (c.appId) return { ownerType: 'APP', ownerId: c.appId };
  if (c.agentId) return { ownerType: 'AGENT', ownerId: c.agentId };
  if (c.organizationId) return { ownerType: 'ORGANIZATION', ownerId: c.organizationId };
  return { ownerType: 'HADRON_SERVER', ownerId: c.hadronServerId! };
}

/** Masked management view — never carries key material beyond the preview. */
export function toGqlAiServiceConfig(c: AiServiceConfigRow) {
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
export async function requireAiConfigOwnerAdmin(
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
export async function requireAiConfigPickerAccess(
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
export function rethrowAiConfigTyped(e: unknown): never {
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
export const defaultAiConfigMemo = new WeakMap<object, Promise<AiServiceConfigRow | null>>();
export function defaultAiConfigOf(
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

// ── Uniform find-many surface (#473) — Spec: cor:api:120 ───────────────

// Standard page bounds for the uniform `<entity>s(filter, orgId, limit,
// offset)` list queries — matches the globalSearch idiom (default 50, cap
// 200). `limit: 0` is preserved (an empty page with just `total` — the cheap
// count, same contract as memoryNodes). Spec: cor:api:120:02.
export const LIST_PAGE_DEFAULT = 50;
export const LIST_PAGE_MAX = 200;

export function clampListTake(limit?: number | null): number {
  if (limit == null) return LIST_PAGE_DEFAULT;
  return Math.min(LIST_PAGE_MAX, Math.max(0, limit));
}

/**
 * cor:api:100:01 — resolve the caller's organization scope for a uniform
 * find-many query.
 *
 * Returns `{ memberOrgIds, scopedOrgId }` where `memberOrgIds` is the org set
 * the query should range over (the caller's memberships, or `[orgId]` when a
 * valid scope was requested), or `null` when the `orgId` gate fails —
 * unresolvable ref OR non-member — in which case the caller must return an
 * EMPTY page (no org-existence disclosure, no platform-admin bypass).
 *
 * App-key callers' "member org" is their own App's org (their access is
 * already confined to it).
 */
export async function resolveOrgScope(
  ctx: Context,
  orgId?: string | null,
): Promise<{ memberOrgIds: string[]; scopedOrgId: string | null } | null> {
  let memberOrgIds: string[] = [];
  if (ctx.userId) {
    const memberships = await ctx.db.orgMember.findMany({
      where: { userId: ctx.userId, deletedAt: null },
      select: { organizationId: true },
    });
    memberOrgIds = memberships.map((m) => m.organizationId);
  } else if (ctx.appId) {
    const app = await ctx.db.app.findUnique({
      where: { id: ctx.appId },
      select: { organizationId: true },
    });
    memberOrgIds = app ? [app.organizationId] : [];
  }
  if (orgId == null) return { memberOrgIds, scopedOrgId: null };
  let resolvedOrgId: string;
  try {
    ({ id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId));
  } catch {
    return null;
  }
  if (!memberOrgIds.includes(resolvedOrgId)) return null;
  return { memberOrgIds: [resolvedOrgId], scopedOrgId: resolvedOrgId };
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
export async function getAccessibleMemoryIds(
  ctx: Context,
  // Single-memory authorization (e.g. Query.memory(id:)) passes the target id
  // so every branch scopes its lookup to that one row — the result is `[id]`
  // or `[]`, with no enumeration of the whole accessible set (e.g. every PUBLIC
  // memory). The canonical predicates are unchanged, just narrowed, so a
  // scoped check stays in lockstep with the full-set node gate by construction.
  onlyMemoryId?: string,
): Promise<string[] | null> {
  const scope = onlyMemoryId ? { id: onlyMemoryId } : {};
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
    return onlyMemoryId ? ids.filter((id) => id === onlyMemoryId) : ids;
  }

  // Platform ADMIN/OWNER: broad access EXCEPT another user's owner-owned
  // personal/private memory. 034-memory-class-access: we return an explicit id
  // list (not `null` = "no filter") so the owner-only carve-out flows through
  // every node read surface (memoryAccessFilter / nodeSearch) — otherwise an
  // operator could read another user's private memory's nodes.
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) {
    const all = await ctx.db.memory.findMany({
      where: {
        ...scope,
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
    const orgPublicIds = await getOrgReadableMemoryIds(ctx.db, ctx.userId, onlyMemoryId);
    // Identity-scoped clauses stay local — owner-only, not org-wide:
    //   - 034: owner-owned personal/private memories (only the owner).
    //   - the caller's own per-user "holding" memories (userMemoryOfAgentId
    //     set — e.g. the startChat no-App knowledge downgrade), gated on
    //     creator identity (mirrors the chathistory-knowledge-class-auth-gap
    //     finding).
    const ownAndHoldings = await ctx.db.memory.findMany({
      where: {
        ...scope,
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
    where: { ...scope, visibility: 'PUBLIC', deletedAt: null },
    select: { id: true },
  });
  return publicMemories.map((g) => g.id);
}

/** Prisma `where` clause that restricts sessions to the caller's scope. */
export async function sessionScopeFilter(ctx: Context): Promise<Record<string, unknown>> {
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
export async function memoryAccessFilter(ctx: Context): Promise<Record<string, unknown>> {
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
export function safeCanonicalUrn(type: CanonicalUrnType, raw: string): string {
  try {
    return formatCanonicalUrn(type, raw);
  } catch (err) {
    // Log so operators can locate + repair corrupted rows — the fallback keeps
    // the query alive, but the bad data still needs a one-off fix.
    console.warn(`[safeCanonicalUrn] failed to canonicalize ${type} URN "${raw}"; serving raw value:`, err);
    return raw;
  }
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
export async function requireMemoryWriteAccess(ctx: Context, memoryId: string): Promise<void> {
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

  // Direct org member with CONTRIBUTOR+? findFirst + deletedAt so a REVOKED
  // membership no longer grants write access (same rule as requireOrgRole).
  const member = await ctx.db.orgMember.findFirst({
    where: { organizationId: memory.organizationId, userId: ctx.userId, deletedAt: null },
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

export const MEMORY_INCLUDE = {
  subscriptions: { include: { organization: true }, orderBy: { createdAt: 'asc' as const } },
};

export const AGENT_INCLUDE = {
  memoryItems: { where: { deletedAt: null, memory: { deletedAt: null } }, include: { memory: true } },
};

export const ORG_INCLUDE = {
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

export const SESSION_INCLUDE = { events: { orderBy: { createdAt: 'desc' as const }, take: 50 } };

// 023-app-shape Phase 2b: APP_INCLUDE eager-loads the AppAgent rows
// (with each Agent's memoryItems) so the GraphQL `App.agent` /
// `App.agents` / `App.installedAgentUrn` field resolvers can compute
// their result without re-querying. The legacy `agent: { ... }` key
// is gone because the direct FK was dropped; consumers that need the
// "primary" Agent read it via the first appAgents row (orderBy
// createdAt asc) or via `getPrimaryAgent` / `getPrimaryAgentId`.
export const APP_INCLUDE = {
  keys: { where: { revokedAt: null }, orderBy: { createdAt: 'desc' as const } },
  appAgents: {
    orderBy: { createdAt: 'asc' as const },
    include: { agent: { include: AGENT_INCLUDE } },
  },
};

export const toISO = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : v;

// ─── 023-app-shape Phase 2b — App field-resolver helpers ────────────────
//
// `App.agent` / `App.agentId` / `App.installedAgentUrn` / `App.agents`
// are soft-deprecated convenience reads. They first try the eager-loaded
// `appAgents` collection (populated by APP_INCLUDE / ORG_INCLUDE) and
// fall back to `getPrimaryAgent` / `getPrimaryAgentId` re-fetches when
// the field-resolver is invoked on a parent that wasn't loaded with the
// include.

export type EagerAppAgentRow = { agent: { id: string; urn?: string } & Record<string, unknown> };

export function readPrimaryAppAgent(parent: { appAgents?: unknown }): EagerAppAgentRow | undefined {
  const rows = parent.appAgents;
  if (!Array.isArray(rows)) return undefined;
  // APP_INCLUDE / ORG_INCLUDE order by createdAt asc; [0] is the primary.
  return rows[0] as EagerAppAgentRow | undefined;
}

export function readPrimaryAgentIdFromEager(parent: { appAgents?: unknown }): string | null | undefined {
  if (parent.appAgents === undefined) return undefined;
  const first = readPrimaryAppAgent(parent);
  return first?.agent?.id ?? null;
}

export function readPrimaryAgentRecordFromEager(
  parent: { appAgents?: unknown },
): unknown | undefined {
  if (parent.appAgents === undefined) return undefined;
  const first = readPrimaryAppAgent(parent);
  return first?.agent ?? null;
}

export function readAllAgentRecordsFromEager(
  parent: { appAgents?: unknown },
): unknown[] | undefined {
  const rows = parent.appAgents;
  if (!Array.isArray(rows)) return undefined;
  return rows.map((r) => (r as EagerAppAgentRow).agent);
}

export async function readPrimaryAgentField(
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

export async function requireMemoryMemberOwner(
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

export async function requireMemoryMemberOwnerOrSelf(
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

export async function requireMemorySharePrincipal(
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

export class DuplicateAppAgentError extends GraphQLError {
  constructor(appId: string, agentId: string) {
    super(`Agent ${agentId} is already installed in App ${appId}.`, {
      extensions: { code: 'DUPLICATE_APP_AGENT', appId, agentId },
    });
  }
}

export async function installAgentIntoAppCore(
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
  // #551: installing is a member-level write on the App's org (CONTRIBUTOR+),
  // not an ADMIN-only action — any org member who can author App config can
  // install an Agent.
  await requireOrgRole(ctx, app.organizationId, 'CONTRIBUTOR');
  const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
  // #551: a foreign Agent may be installed cross-org WHEN it is PUBLIC (the
  // marketplace / AgentOrgGrant path — the grant is auto-provisioned below).
  // A non-PUBLIC agent still must belong to the App's own org (pre-023
  // behavior — you can't reach into another org's private agents).
  if (agent.organizationId !== app.organizationId && agent.visibility !== 'PUBLIC') {
    throw new GraphQLError('Agent must belong to the same organization as the App, or be PUBLIC.', {
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

export async function uninstallAgentFromAppCore(
  ctx: Context,
  args: { appId: string; agentId: string },
): Promise<{ appId: string; agentId: string }> {
  const { id: resolvedAppId } = await resolveAppRef(ctx.db, args.appId);
  const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, args.agentId);
  const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
  // #551: symmetric with install — a CONTRIBUTOR+ member of the App's org can
  // uninstall an Agent (was ADMIN-only).
  await requireOrgRole(ctx, app.organizationId, 'CONTRIBUTOR');
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
export function deriveChatTitle(
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

export async function getExchangeRefreshToken(
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

export type ExtractionSpecEntry = { field: string; description?: string; shape?: string };

/**
 * Build the respond() tool schema by merging extractionSpec from three
 * levels: agent (config node) → conversation → stage. Stage-level fields
 * win on conflict. Always includes onTrack + offTrackReason fields for
 * continuous routing.
 */
export async function buildRespondToolSchema(
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

export interface GoalStackEntry {
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

export function getGoalStack(chatData: Record<string, unknown>): GoalStackEntry[] {
  return (chatData.goalStack as GoalStackEntry[]) ?? [];
}

export function pushGoal(
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

export function popGoal(chatData: Record<string, unknown>): GoalStackEntry | null {
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

export function currentGoal(chatData: Record<string, unknown>): GoalStackEntry | null {
  const stack = getGoalStack(chatData);
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].status === 'ACTIVE') return stack[i];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Route history helpers
// ---------------------------------------------------------------------------

export interface RouteHistoryEntry {
  nodeUrn?: string;
  topicUrn?: string;
  conversationUrn?: string;
  action: 'ENTER' | 'EXIT' | 'COMPLETED' | 'FOLLOWED';
  trigger?: { type: string; content?: string };
  edgeUrn?: string;
  timestamp: string;
}

export function getRouteHistory(chatData: Record<string, unknown>): RouteHistoryEntry[] {
  return (chatData.routeHistory as RouteHistoryEntry[]) ?? [];
}

export function appendRouteEntry(
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
export function wasRecentlyVisited(
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
export async function resolveAssetTargetMemoryId(
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
export async function isOrgAdminFor(
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
  // Same soft-revocation rule as requireOrgRole: a deleted membership row
  // must not keep granting org-admin authority.
  const member = await db.orgMember.findFirst({
    where: { organizationId, userId, deletedAt: null },
  });
  return !!member && (member.role === 'ADMIN' || member.role === 'OWNER');
}

export function assetUrn(memoryUrn: string, assetId: string): string {
  return `${memoryUrn}:assets:${assetId}`;
}

// ---------------------------------------------------------------------------
// Snapshot reader: reads nodes from a published revision snapshot instead
// of the live database. Used by startChat/sendChatMessage when the agent
// has a publishedRevisionLoc set.
// ---------------------------------------------------------------------------

export interface SnapshotNode {
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
export async function loadPublishedSnapshot(
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
export function rankByHint<
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

// ── Shared GraphQL input types (moved from resolvers.ts, split step 2) ──
export interface NodeEdgeInput {
  targetId: string;
  name?: string | null;
  loc?: string | null;
  description?: string | null;
  isRunnable?: boolean | null;
}

/**
 * Bulk-import node shape — used only by replaceSubtree (git-sync) since the
 * spec-039 Phase 0 split retired upsertNode. Single-node writes use
 * CreateNodeInput / UpdateNodeInput below.
 */
export interface NodeInput {
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
  /**
   * MIME type of `content` (#476, spec cor:cnv:010:01). 'text/markdown'
   * (default) stores as-is; 'text/html' converts to Markdown via
   * hadrontool-pdf before storage (the extracted title lands in
   * properties.title when the caller didn't set one). Consumed at the write
   * seam — never persisted.
   */
  contentType?: string | null;
  data?: Record<string, unknown>;
  seq?: number;
  tags?: string[];
  properties?: Record<string, unknown>;
  llmModel?: string;
  aiAgent?: string;
  ownerRepo?: string;
  edges?: NodeEdgeInput[];
  /** Why this change was made — stored in version history (editedBy). Issue #88. */
  reason?: string | null;
}

/**
 * createNode input (spec 039 Phase 0 D1/D4): memoryId/loc/name required;
 * `id` is only ever a forced create-PK (importer/sync), never a selector.
 */
export type CreateNodeInput = NodeInput;

/**
 * updateNode input (spec 039 Phase 0 D2–D4): the target is `id` (PK or
 * fully-qualified node URN) XOR (`memoryId` + `loc`); every content field
 * (name included) is optional = preserve-on-omit. Never creates, never moves.
 */
export interface UpdateNodeInput
  extends Omit<NodeInput, 'id' | 'memoryId' | 'loc' | 'name'> {
  id?: string;
  memoryId?: string;
  loc?: string;
  name?: string;
}

export type NodeTextField = 'content' | 'name' | 'alias' | 'description' | 'abstract' | 'tags';

export interface SearchReplaceInNodesInput {
  oldText: string;
  newText: string;
  nodeIds?: string[];
  memoryIds?: string[];
  prefix?: string;
  fields: NodeTextField[];
  caseInsensitive?: boolean;
  regex?: boolean;
  dryRun?: boolean;
  /** Why this change was made — stored in version history (editedBy). Issue #88. */
  reason?: string | null;
}

export interface EdgeInput {
  sourceLoc: string;
  targetLoc: string;
  name?: string | null;
  loc?: string | null;
  description?: string | null;
  isRunnable?: boolean | null;
}

/**
 * Fields mergeNodes can fold from the source node into the target node.
 * Text fields concatenate (target first), TAGS unions, DATA/PROPERTIES
 * shallow-merge with the target winning on key collisions, and EDGES
 * re-points the source's relationships onto the target. See the
 * `mergeNodes` resolver for the per-field merge strategy.
 */
export interface MergeNodesInput {
  /** Source node — ID or fully-qualified URN. Folded into `target`. */
  source: string;
  /** Target node — ID or fully-qualified URN. The surviving node. */
  target: string;
  /** Which fields to merge. Omitted/null = every mergeable field. */
  include?: NodeMergeField[] | null;
  /** Hard-delete the source node after a successful merge. */
  deleteSource?: boolean | null;
}

export interface MergeMemoriesInput {
  /** Source memory — ID or fully-qualified URN. Emptied into `target`. */
  source: string;
  /** Target memory — ID or fully-qualified URN. The surviving memory. */
  target: string;
  /** Field strategy for source nodes that collide (same loc) in the target. Omitted/null = every mergeable field. */
  include?: NodeMergeField[] | null;
  /** Delete the (now-empty) source memory after a successful merge. */
  deleteSourceMem?: boolean | null;
}

export interface SessionInput {
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

export interface UsageEventInput {
  type: string;
  nodeLoc?: string;
  actionArgs?: Record<string, unknown>;
  sessionId?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
}
