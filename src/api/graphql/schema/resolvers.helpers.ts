// Helpers extracted from resolvers.ts (Step 1 of the resolver split).
// Pure mechanical move: shared auth/include/AI-config/chat/asset helpers used
// by the GraphQL resolver map. No behavior change. The `Context` interface
// lives here and is re-exported from resolvers.ts for existing importers.
import type { NodeMergeField } from '../../../lib/nodeMerge.js';
import { runEmailOperation, type ToolCalendarEvent, type ToolDriveFile } from '../../../lib/emailClient.js';
import { scopeForOperation } from '../../../lib/emailOperationScopes.js';
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
import { ensureAgentSubscription } from '../../../controller/operations/ensureAgentSubscription.js';
import {
  getPrimaryAgent,
  isAgentInstalled,
} from '../../../lib/appAgent.js';
import { getOrgReadableMemoryIds } from '../../../lib/auth/orgReadableMemory.js';
import { sessionScopedMemoryIds } from '../../../lib/auth/sessionScopedMemoryIds.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';
import {
  formatCanonicalUrn,
  type CanonicalUrnType,
} from '../../../lib/urn.js';
import { emitEntityUrnV2 } from '../../../lib/urnEmit.js';
import {
  validateEdgeCondition,
  validateNodeDataExtractionSpecs,
  type EvaluationError,
} from '../../../lib/edge-conditions/index.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRefOrEmail } from '../../../lib/entityRef/userRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import {
  UserNotFoundError,
  AmbiguousUserRefError,
  OrganizationNotFoundError,
  AppNotFoundError,
  AgentNotFoundError,
} from '../../../lib/entityRef/errors.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import type { ImpersonationContext } from '../../../lib/auth/impersonation.js';
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
  // Admin impersonation: set when the request authenticated with an
  // impersonation JWT — userId is the TARGET, roles is [], and reads must be
  // scoped to impersonation.orgId with all personal-class access dropped (the
  // org-scope chokepoints in this file + src/lib/auth consult it). Mutations
  // are blocked wholesale by the read-only Apollo plugin.
  impersonation?: ImpersonationContext;
  // Request-scoped memo for Edge.source/target lazy loads — avoids an N+1 of
  // identical node.findUnique calls when many edges in one response share an
  // endpoint (lazily created on first use; see loadEdgeEndpointNode). #381.
  edgeEndpointNodeCache?: Map<string, Promise<unknown>>;
  // Request-scoped memo for per-memory READ-access checks (#781) — gates
  // Edge.source/target endpoint resolution on a cross-memory read. A graph
  // response's edges overwhelmingly share a few endpoint memories, so each
  // distinct memory is checked once per request (see canReadMemoryCached).
  memoryReadCache?: Map<string, Promise<boolean>>;
  // Request-scoped memo for Node.urn / Edge.urn composition (#481) — a list
  // response's nodes/edges overwhelmingly share a memory, so the memory-urn
  // lookup is memoized per request (lazily created; see loadMemoryUrn).
  memoryUrnCache?: Map<string, Promise<string | null>>;
  // Request-scoped memo for AppRun.urn composition (#696) — a run-list response
  // often shares one App across many runs, so the app-urn lookup is memoized per
  // request (lazily created; see loadAppUrn).
  appUrnCache?: Map<string, Promise<string | null>>;
  // Request-scoped memo for AppRun.app (#831) — same rationale as appUrnCache,
  // for the full row rather than just the urn (lazily created; see loadApp).
  appRowCache?: Map<string, Promise<AppRow | null>>;
  // #853 — AppRun.agent / AppRun.entryNode memos. A run page repeats the same
  // agent and entry node across rows; without these the two relations cost a
  // membership query + a row lookup EACH (see loadReadableAgent/loadEntryNode).
  readableAgentFilterCache?: Promise<Record<string, unknown>>;
  readableAgentCache?: Map<string, Promise<unknown | null>>;
  entryNodeCache?: Map<string, Promise<{ memoryId: string } | null>>;
  // Request-scoped memo for NodeRevision.editedByUser / approvedByUser
  // candidate lookups (#620) — a node's history repeats the same few editor
  // strings, so each distinct candidate (including misses) is resolved once
  // per request (lazily created; see resolveRevisionEditor).
  revisionEditorCache?: Map<string, Promise<{ handle: string; urn: string | null } | null>>;
}

/** entityRef resolvers each throw a distinct `*NotFoundError` on a genuine miss. */
function isEntityNotFound(e: unknown): boolean {
  return (
    e instanceof UserNotFoundError ||
    e instanceof OrganizationNotFoundError ||
    e instanceof AppNotFoundError ||
    e instanceof AgentNotFoundError ||
    e instanceof MemoryNotFoundError
  );
}

/**
 * Resolve a GraphQL mutation's `<label>Ref` / deprecated `<label>Id` argument
 * pair to a definite entity id (#764, spec cor:api:180). Generalizes
 * `resolveGranteeId` (PR #774) over any `resolveXRef` helper so every access
 * mutation accepts a URN / handle / email / id uniformly:
 *
 *  - BOTH ref and id supplied → `BAD_USER_INPUT` (silently preferring one would
 *    contradict the schema).
 *  - a ref that resolves to nothing → `NOT_FOUND` (the shape that missed is not
 *    leaked, matching `resolveGranteeId`).
 *  - `AmbiguousUserRefError` (two accounts differing only by email case) →
 *    `BAD_USER_INPUT`.
 *  - neither supplied → `BAD_USER_INPUT` naming the ref arg.
 *
 * BOTH the new `xRef` and the deprecated `xId` are resolved through the same
 * `resolveXRef` helper (every one accepts a raw id, a URN, and — for users —
 * a handle/email). Routing `xId` through the resolver too preserves the
 * pre-#764 behavior of the id-named args that already accepted URNs
 * (subscription memoryId/orgId, orgMember orgId, appMember appId), rather than
 * silently narrowing them to raw-PK-only.
 */
export async function resolveRefArg(
  db: Context['db'],
  resolve: (db: Context['db'], ref: string) => Promise<{ id: string }>,
  args: { ref?: string | null; id?: string | null; label: string },
): Promise<string> {
  const ref = args.ref?.trim();
  const id = args.id?.trim();
  if (ref && id) {
    throw new GraphQLError(`Pass either ${args.label}Ref or ${args.label}Id, not both.`, {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  const chosen = ref || id;
  if (!chosen) {
    throw new GraphQLError(
      `A ${args.label} is required: pass ${args.label}Ref (or the deprecated ${args.label}Id).`,
      { extensions: { code: 'BAD_USER_INPUT' } },
    );
  }
  try {
    const { id: resolvedId } = await resolve(db, chosen);
    return resolvedId;
  } catch (e) {
    if (isEntityNotFound(e)) {
      throw new GraphQLError(`No match for ${args.label}Ref "${chosen}".`, {
        extensions: { code: 'NOT_FOUND' },
      });
    }
    if (e instanceof AmbiguousUserRefError) {
      throw new GraphQLError(
        `${args.label}Ref "${chosen}" matches more than one account (differing only by email case). Use the exact-case email, the handle, or the id.`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    throw e;
  }
}

/** #764 — per-entity `resolveRefArg` wrappers (label = the ref arg's name). */
export const resolveUserRefArg = (
  db: Context['db'],
  a: { ref?: string | null; id?: string | null },
): Promise<string> =>
  resolveRefArg(db, (d, ref) => resolveUserRefOrEmail(d, ref), { ...a, label: 'user' });
export const resolveOrgRefArg = (
  db: Context['db'],
  a: { ref?: string | null; id?: string | null },
): Promise<string> =>
  resolveRefArg(db, (d, ref) => resolveOrgRef(d, ref), { ...a, label: 'org' });
export const resolveMemoryRefArg = (
  db: Context['db'],
  a: { ref?: string | null; id?: string | null },
): Promise<string> =>
  resolveRefArg(db, (d, ref) => resolveMemoryRef(d, ref), { ...a, label: 'memory' });
export const resolveAppRefArg = (
  db: Context['db'],
  a: { ref?: string | null; id?: string | null },
): Promise<string> =>
  resolveRefArg(db, (d, ref) => resolveAppRef(d, ref), { ...a, label: 'app' });
export const resolveAgentRefArg = (
  db: Context['db'],
  a: { ref?: string | null; id?: string | null },
): Promise<string> =>
  resolveRefArg(db, (d, ref) => resolveAgentRef(d, ref), { ...a, label: 'agent' });

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
 * Fetch an App's stored urn by id, memoized per request (#696). Backs the
 * AppRun.urn field resolver on the run-audit list surfaces (appRuns), where many
 * runs in a page typically share one App — without memoization each row would
 * issue an identical findUnique.
 */
export function loadAppUrn(ctx: Context, appId: string): Promise<string | null> {
  const cache = (ctx.appUrnCache ??= new Map<string, Promise<string | null>>());
  let pending = cache.get(appId);
  if (!pending) {
    pending = ctx.db.app
      .findUnique({ where: { id: appId }, select: { urn: true } })
      .then((a: { urn: string } | null) => a?.urn ?? null);
    cache.set(appId, pending);
  }
  return pending;
}

/**
 * Fetch a full App row by id, memoized per request (#831). Sibling of
 * `loadAppUrn` with the same rationale — a run-audit page shares one App across
 * many rows, so `AppRun.app` must not become one findUnique per row.
 *
 * Returns the raw row INCLUDING soft-deleted (the caller decides): an audit
 * list legitimately shows runs of an App that was deleted afterwards, and the
 * run's `appId` is the durable record either way.
 */
export function loadApp(ctx: Context, appId: string): Promise<AppRow | null> {
  const cache = (ctx.appRowCache ??= new Map<string, Promise<AppRow | null>>());
  let pending = cache.get(appId);
  if (!pending) {
    pending = ctx.db.app.findUnique({ where: { id: appId } }) as Promise<AppRow | null>;
    cache.set(appId, pending);
  }
  return pending;
}

/** The App fields the AppRun relation gate needs. */
export type AppRow = {
  id: string;
  organizationId: string | null;
  ownerUserId: string | null;
  deletedAt: Date | null;
} & Record<string, unknown>;

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

/**
 * Per-request memoized NODE-CONTENT read check for a single memory (#781). Backs
 * the Edge.source/target CROSS-memory endpoint gate: a cross-memory edge (source
 * in memory A, target in memory B) must NOT let a caller who can read only A
 * resolve the B-side node — `edge`/`edges` authorize on the denormalized
 * `Edge.memoryId` and Node.incomingEdges reaches edges whose memoryId the caller
 * never authorized, while the endpoint resolvers historically loaded the node by
 * FK with no re-check.
 *
 * Uses the NODE-CONTENT gate `getAccessibleMemoryIds` — the same predicate
 * nodeById / memoryAccessFilter use — deliberately NOT Query.memory's
 * record-level org-member fast-path (which admits app/system memory RECORDS to
 * org members but must not expose their node CONTENT — getOrgReadableMemoryIds
 * excludes app-scoped rows via `appId: null`). Consequence (security-first,
 * fail-safe): a cross-memory endpoint reachable ONLY via appNodes' App-install
 * grant is nulled rather than leaked; folding the App-install scope into a
 * complete node-read gate is the tracked follow-up (#781). Memoized per distinct
 * memory since a graph response's edges share a few endpoint memories.
 */
export function isMemoryReadableCached(ctx: Context, memoryId: string): Promise<boolean> {
  const cache = (ctx.memoryReadCache ??= new Map<string, Promise<boolean>>());
  let pending = cache.get(memoryId);
  if (!pending) {
    pending = getAccessibleMemoryIds(ctx, memoryId).then(
      (ids) => ids === null || ids.includes(memoryId),
    );
    cache.set(memoryId, pending);
  }
  return pending;
}

/**
 * Resolve a memory ref (ID or URN) to its id IFF the caller may read it; returns
 * null when the ref does not resolve OR the caller lacks read access — so a
 * ref-scoped surface answers with an empty page and discloses neither the
 * memory's nor its org's existence (the `conventions:multi-ref-scope-args`
 * drop-unreadable posture). Uses the SCOPED `getAccessibleMemoryIds` point-read,
 * so it stays an indexed check and stays in lockstep with the shared predicate
 * by construction rather than by a hand-rolled copy of it.
 *
 * A MALFORMED ref still throws. Silence is for EXISTENCE, not for shape: a bad
 * URN is caller error and a DB failure is operational, and swallowing either
 * hands back a partial page that looks complete.
 *
 * **When NOT to use this.** It costs a full authorization round PER REF — the
 * ref resolution is itself a DB round trip (two on a miss, via the legacy-alias
 * fallback) and the scoped `getAccessibleMemoryIds` issues one or more of its
 * own depending on the caller's principal shape. That is the right trade only
 * for a surface that does not already hold the caller's accessible set. A
 * surface that computes the full set anyway for its default
 * scope — `listAssets` is the live example — should intersect in memory against
 * that set instead. `listAssets` additionally narrows by `orgId` before checking
 * refs, so swapping this helper in there would also drop that narrowing and
 * WIDEN the result. Unify the two only if you keep both checks.
 */
export async function resolveReadableMemoryId(
  ctx: Context,
  memoryRef: string,
): Promise<string | null> {
  let resolvedId: string;
  try {
    ({ id: resolvedId } = await resolveMemoryRef(ctx.db, memoryRef));
  } catch (e) {
    // Only a genuine miss collapses to an empty page (no existence disclosure).
    // A malformed URN or an unexpected DB/runtime error must propagate rather
    // than masquerade as "empty graph" — mirrors the Query.memory(id:) resolver.
    if (e instanceof MemoryNotFoundError) return null;
    throw e;
  }
  const accessible = await getAccessibleMemoryIds(ctx, resolvedId);
  if (accessible !== null && !accessible.includes(resolvedId)) return null;
  return resolvedId;
}

/**
 * The RECORD-level memory read gate — "may this caller open this memory's
 * record (its scalars: name, description, data)?", as distinct from
 * `isMemoryReadableCached` above, which answers "may they read its NODES?".
 *
 * The two are deliberately different (see that function's note): the record
 * gate keeps an org-member fast-path that admits app/system-class memory
 * RECORDS which `getOrgReadableMemoryIds` excludes from the node-content set.
 * Using the node gate for a record-level question silently drops memories the
 * caller can open directly via `Query.memory` — the #759 review finding
 * (Codex P1 / Copilot on PR #846).
 *
 * Extracted from `Query.memory` so the two callers cannot drift (AGENTS.md:
 * "reuse the shared access gate; a bespoke per-resolver gate drifts"). Order is
 * load-bearing and preserved exactly:
 *   1. personal/private → strict owner, or a MemoryShare grantee (#778).
 *   2. spec 047 user-owned → strict owner, BEFORE the platform-admin path so an
 *      ADMIN never reads another user's user-owned record (#676).
 *   3. otherwise → platform ADMIN/OWNER, a live org membership, or whatever the
 *      shared node gate already admits (PUBLIC, subscription, App session) —
 *      the #362 fallback that keeps record reads in step with node reads.
 */
export async function canReadMemoryRecord(
  ctx: Context,
  memory: {
    id: string;
    class: string;
    userId?: string | null;
    ownerUserId?: string | null;
    organizationId?: string | null;
  },
): Promise<boolean> {
  if (memory.class === 'personal' || memory.class === 'private') {
    // Impersonation: personal-class records are invisible even though the
    // TARGET owns them — the shared-org scope excludes all identity-scoped
    // resources (the target-as-owner check below would otherwise admit them).
    if (ctx.impersonation) return false;
    if (ctx.userId && memory.userId === ctx.userId) return true;
    if (ctx.userId && (await granteeShareAccess(ctx.db, ctx.userId, memory as never))) return true;
    return false;
  }
  if (memory.ownerUserId != null) {
    // Impersonation: user-owned (spec 047) records are identity-scoped —
    // invisible for the same reason as personal/private above.
    if (ctx.impersonation) return false;
    return !!ctx.userId && memory.ownerUserId === ctx.userId;
  }
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return true;
  // findFirst (not findUnique) so a REVOKED (soft-deleted) membership no longer
  // grants access. A user-owned memory (org NULL) has no membership fast-path
  // and was already returned above. Under impersonation the fast-path only
  // applies inside the session's shared org.
  const member =
    ctx.userId &&
    memory.organizationId &&
    (!ctx.impersonation || ctx.impersonation.orgId === memory.organizationId)
      ? await ctx.db.orgMember.findFirst({
          where: { organizationId: memory.organizationId, userId: ctx.userId, deletedAt: null },
        })
      : null;
  if (member) return true;
  // Scope the shared gate to THIS memory so it stays an indexed point-read.
  const accessibleIds = await getAccessibleMemoryIds(ctx, memory.id);
  return accessibleIds === null || accessibleIds.includes(memory.id);
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
  // Impersonation: the session may only see into its ONE shared org. Without
  // this, a read resolver gating on a NAMED org (dashboard, usage, org detail)
  // would honor the target's memberships in their OTHER orgs. Checked before
  // the platform short-circuit (inert under impersonation anyway — roles: []).
  if (ctx.impersonation && orgId !== ctx.impersonation.orgId) {
    throw new Error('Forbidden');
  }
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
 * Owner-or-org access gate for an entity that may be **user-owned** or
 * **org-owned** (spec 047: App / Agent / Memory carry
 * `organizationId`-XOR-`ownerUserId`). The keystone gate that replaces bare
 * `requireOrgRole(ctx, entity.organizationId, role)` on those entities so a
 * user-owned row is authorized by its owner, not by an org role.
 *
 *   - Platform ADMIN/OWNER: bypass (same as `requireOrgRole`; a user-owned
 *     App/Agent/Memory-tenant is NOT the strict-personal case — the
 *     personal/private strict-owner gate on `Memory.userId` is separate and
 *     lives in `canReadMemory`/`canWriteToMemory`, and DOES deny admins).
 *   - `ownerUserId` set (user-owned): owner-only — `ctx.userId === ownerUserId`;
 *     no org-role path, and the `required` role is moot (the owner has full
 *     authority over their own entity).
 *   - else `organizationId` set (org-owned): delegate to `requireOrgRole`.
 *
 * The XOR CHECK guarantees exactly one is set; a row with neither is denied
 * defensively. Throws `Forbidden` on denial (mirrors `requireOrgRole`).
 */
export async function requireOwnerOrOrgRole(
  ctx: Context,
  entity: { organizationId: string | null; ownerUserId: string | null },
  required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER',
): Promise<void> {
  // spec 047 (Holger 2026-07-14): a user-owned entity is STRICTLY owner-only —
  // NO platform-admin bypass, consistent with personal/private strict ownership
  // (cor:acl:010:02). The owner check runs BEFORE the admin/org path.
  if (entity.ownerUserId !== null) {
    // Impersonation: user-owned entities are identity-scoped — the target
    // owning it does NOT admit the impersonated (shared-org-only) session.
    if (ctx.impersonation) throw new Error('Forbidden');
    if (ctx.userId && ctx.userId === entity.ownerUserId) return;
    throw new Error('Forbidden');
  }
  if (isPlatformAdmin(ctx)) return;
  if (entity.organizationId !== null) {
    await requireOrgRole(ctx, entity.organizationId, required);
    return;
  }
  throw new Error('Forbidden');
}

/**
 * Boolean form of {@link requireOwnerOrOrgRole} (graceful, no throw) — true for
 * a platform admin, the entity's user owner, or a live member of its owning org.
 * Mirrors `isOrgMemberOrAdmin` for user-or-org-owned entities. A user-owned
 * entity is strictly owner-only (no platform-admin bypass — see the throwing
 * form), so the owner check precedes the admin path.
 */
export async function isOwnerOrOrgMember(
  ctx: Context,
  entity: { organizationId: string | null; ownerUserId: string | null },
): Promise<boolean> {
  // Impersonation: user-owned entities are identity-scoped and invisible.
  if (entity.ownerUserId !== null) {
    return !ctx.impersonation && !!ctx.userId && ctx.userId === entity.ownerUserId;
  }
  if (isPlatformAdmin(ctx)) return true;
  if (entity.organizationId !== null) return isOrgMemberOrAdmin(ctx, entity.organizationId);
  return false;
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
  // Impersonation: only the session's shared org can admit (see requireOrgRole).
  if (ctx.impersonation && orgId !== ctx.impersonation.orgId) return false;
  if (isPlatformAdmin(ctx)) return true;
  if (!ctx.userId) return false;
  const member = await ctx.db.orgMember.findFirst({
    where: { organizationId: orgId, userId: ctx.userId, deletedAt: null },
  });
  return !!member;
}

/**
 * App-participation predicate — "may this USER act as a member of this App?"
 * (#939's team-chat gate, generalized in #943 so `startSession`'s `appRef`
 * gate is the SAME predicate rather than a second copy of it).
 *
 * Admits: an AppMember at ANY role (participation follows the host memory's
 * audience — `cor:acl:030:01`, so a 'reader' member counts), an org member
 * with CONTRIBUTOR+ on the App's owning org (parity with the persona-mint
 * gate's org branch, and platform ADMIN/OWNER via `requireOrgRole`), or the
 * owner of a user-owned App.
 *
 * This is the USER branch only. Callers own their principal-shape policy
 * around it (findings:auth-appid-credential-vs-selection): a caller with no
 * `userId` is a pure App-key (or anonymous) principal and is false here —
 * whether an App KEY may act for its own App is the caller's call, not this
 * predicate's. A hybrid principal (userId + an active-App SELECTION from
 * MCP's `requireAppScope`) is judged solely on the user, which is exactly
 * what this returns.
 */
export async function isAppParticipant(
  ctx: Context,
  app: { id: string; organizationId: string | null; ownerUserId: string | null },
): Promise<boolean> {
  if (!ctx.userId) return false;
  if (app.ownerUserId !== null) {
    // spec 047: a user-owned App admits its owner and nobody else
    // (findings:org-xor-owner-null-comparison-bypass — branch on the
    // ownership CLASS first; for two different users' entities BOTH
    // `organizationId`s are NULL, so an org comparison would read
    // `null !== null` and admit exactly the cross-tenant case).
    // Identity-scoped, so never via impersonation (isOwnerOrOrgMember's rule;
    // the team-chat caller already denies org-less Apps under impersonation —
    // this keeps the predicate safe for any future caller that doesn't).
    if (ctx.impersonation) return false;
    return ctx.userId === app.ownerUserId;
  }
  const member = await ctx.db.appMember.findUnique({
    where: { appId_userId: { appId: app.id, userId: ctx.userId } },
    select: { userId: true },
  });
  if (member) return true;
  if (app.organizationId !== null) {
    try {
      await requireOrgRole(ctx, app.organizationId, 'CONTRIBUTOR');
      return true;
    } catch (e) {
      // requireOrgRole signals denial with a plain Error('Forbidden'); anything
      // else (a DB failure inside the membership lookup) must propagate rather
      // than read as "not a member" (review:narrow-catch-blocks — the
      // team-chat original swallowed everything here).
      if (e instanceof Error && e.message === 'Forbidden') return false;
      throw e;
    }
  }
  return false;
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
      await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
      return { ownerWhere: { appId: id }, resolvedOwnerId: id };
    }
    case 'AGENT': {
      const { id } = await resolveAgentRef(ctx.db, ownerId);
      const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id } });
      await requireOwnerOrOrgRole(ctx, agent, 'ADMIN');
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
      where: {
        userId: ctx.userId,
        deletedAt: null,
        // Impersonation: only the session's shared org counts as "member".
        ...(ctx.impersonation ? { organizationId: ctx.impersonation.orgId } : {}),
      },
      select: { organizationId: true },
    });
    memberOrgIds = memberships.map((m) => m.organizationId);
  } else if (ctx.appId) {
    const app = await ctx.db.app.findUnique({
      where: { id: ctx.appId },
      select: { organizationId: true },
    });
    // spec 047: a user-owned App has no org → contributes no org membership.
    memberOrgIds = app?.organizationId ? [app.organizationId] : [];
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
 * Does `userId` reach a PERSONAL memory through a MemoryShare grant (#778)?
 *
 * The single-memory counterpart of the grantee clause in
 * `getAccessibleMemoryIds` — used by `Query.memory` (read) and
 * `requireMemoryWriteAccess` (writer shares). Mirrors the share rule in
 * `createMemoryShare`: an org-owned personal memory is shareable only within its
 * org, so a grantee must ALSO be a current member of that org. This keeps the
 * read/write gate in lockstep with the create rule and means a legacy or
 * revoked-membership cross-org share can't admit a non-member (which would also
 * expose the org's nested app/key/member objects via `Memory.organization`).
 *
 * Only `personal` is shareable (`private` never is), and agent-scoped personal
 * "holding" memories (`userMemoryOfAgentId` set) are deliberately excluded here
 * — their share additionally requires an active AgentSubscription
 * (resolveMemoryAuthorization step 3c), which this portal surface doesn't model;
 * excluding them is the safe, no-regression direction.
 *
 * @param opts.requireWrite when true, only a `writer` share qualifies.
 */
export async function granteeShareAccess(
  db: Context['db'],
  userId: string,
  memory: {
    id: string;
    class: string;
    organizationId: string | null;
    userMemoryOfAgentId: string | null;
  },
  opts?: { requireWrite?: boolean },
): Promise<boolean> {
  if (memory.class !== 'personal' || memory.userMemoryOfAgentId !== null) return false;
  const share = await db.memoryShare.findUnique({
    where: { memoryId_granteeId: { memoryId: memory.id, granteeId: userId } },
    select: { role: true },
  });
  if (!share) return false;
  if (opts?.requireWrite && share.role !== 'writer') return false;
  // Free-standing (org-less) personal memory — the share alone admits.
  if (memory.organizationId === null) return true;
  // Org-owned — the grantee must still be a current member of the org.
  const member = await db.orgMember.findFirst({
    where: { organizationId: memory.organizationId, userId, deletedAt: null },
    select: { userId: true },
  });
  return !!member;
}

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
  //
  // #945: the admissibility rule (which memory the session may actually reach)
  // lives in `sessionScopedMemoryIds` — ONE predicate shared with the MCP
  // node-search scope, which used to carry its own copy of this branch.
  if (ctx.appId && ctx.sessionId) {
    const ids = await sessionScopedMemoryIds(ctx.db, ctx.appId, ctx.sessionId);
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
          OR: [
            // Another user's owner-owned personal/private memory (unchanged).
            { class: { in: ['personal', 'private'] as any }, userId: { not: ctx.userId ?? '__none__' } },
            // spec 047: a user-owned memory is STRICTLY private — a platform
            // admin does NOT see another user's user-owned rows either.
            { AND: [{ ownerUserId: { not: null } }, { ownerUserId: { not: ctx.userId ?? '__none__' } }] },
          ],
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
    const orgPublicIds = await getOrgReadableMemoryIds(
      ctx.db,
      ctx.userId,
      onlyMemoryId,
      ctx.impersonation?.orgId,
    );
    // Impersonation: the identity-scoped clauses below (personal/private,
    // per-user holdings, user-owned, shares) are all dropped — the shared-org
    // scope admits ONLY the org/public/subscription set computed above.
    if (ctx.impersonation) return orgPublicIds;
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
          // spec 047: a user-owned memory is readable ONLY by its owner.
          { ownerUserId: ctx.userId },
        ],
      },
      select: { id: true },
    });
    // #778 — personal memories shared WITH the caller (they are a grantee).
    // Only `personal` is shareable; agent-scoped holdings are excluded (see
    // granteeShareAccess). Org-owned shares are additionally membership-gated so
    // a legacy/revoked cross-org share can't admit a non-member — mirrors the
    // create rule and keeps this node-read gate in lockstep with Query.memory.
    const memberOrgIds = await getMemberOrgIds(ctx.db, ctx.userId);
    const sharedWithMe = await ctx.db.memory.findMany({
      where: {
        ...scope,
        deletedAt: null,
        class: 'personal',
        userMemoryOfAgentId: null,
        shares: { some: { granteeId: ctx.userId } },
        OR: [{ organizationId: null }, { organizationId: { in: memberOrgIds } }],
      },
      select: { id: true },
    });
    const accessibleIds = new Set(orgPublicIds);
    for (const g of ownAndHoldings as { id: string }[]) accessibleIds.add(g.id);
    for (const g of sharedWithMe as { id: string }[]) accessibleIds.add(g.id);
    return [...accessibleIds];
  }

  // Unauthenticated — public memories only. #653: exclude app-scoped rows — an
  // app-scoped knowledge/group memory is App-internal even if its visibility was
  // changed to PUBLIC (mirrors getOrgReadableMemoryIds' PUBLIC clause).
  // #758: `ownerUserId: null` for the same reason as that clause — spec 047
  // makes a USER-owned memory owner-only regardless of visibility, and an
  // anonymous caller is never its owner. This branch is a SECOND copy of the
  // PUBLIC predicate, so it needs the guard independently of orgReadableMemory.
  const publicMemories = await ctx.db.memory.findMany({
    where: { ...scope, visibility: 'PUBLIC', appId: null, ownerUserId: null, deletedAt: null },
    select: { id: true },
  });
  return publicMemories.map((g) => g.id);
}

/**
 * #931: write gate for session mutations (`updateSession` / `endSession`).
 * A session may be written by: a platform ADMIN/OWNER; the App it belongs to
 * (App-key caller); or the user it is attributed to (identity-scoped — not
 * via impersonation, #876 class). Deliberately NARROWER than the session read
 * gates: org membership grants read, never write. Before #931 `endSession`
 * was ungated — any authenticated principal holding a session id could end
 * it and overwrite its summary (and, post-#928, free another driver's
 * persona, since "taken" derives from active sessions).
 */
export function requireSessionWriteAccess(
  ctx: Context,
  session: { appId: string | null; userId: string | null },
): void {
  if (isPlatformAdmin(ctx)) return;
  // App branch: PURE App-key principals only (#932 Codex P1). A hybrid
  // principal — a user with an active-App selection, the MCP auth shape —
  // must NOT inherit App authority, or any co-member of an App could end
  // another member's session (and free their persona). GraphQL App-key
  // contexts carry no userId, so this is a no-op for them; it exists so a
  // Context built from MCP auth (userId + selected appId) can't widen.
  if (!ctx.userId && ctx.appId && session.appId === ctx.appId) return;
  if (ctx.userId && session.userId === ctx.userId && !ctx.impersonation) return;
  throw new Error('Forbidden');
}

/** Prisma `where` clause that restricts sessions to the caller's scope. */
export async function sessionScopeFilter(ctx: Context): Promise<Record<string, unknown>> {
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return {};
  // App Key path — sessions belonging to the authenticated App.
  if (ctx.appId) return { appId: ctx.appId };
  // JWT user — sessions for Apps in any org the user is a member of, PLUS
  // sessions attributed to the user themself (#929 review P1: a session
  // started outside any App context — the CLI coding case — has appId null,
  // so without the userId branch its own creator could not list it).
  // Identity-scoped, so the self branch does not apply via impersonation
  // (#876 class: impersonation stays bounded to the shared org's Apps).
  if (ctx.userId) {
    const memberships = await ctx.db.orgMember.findMany({
      where: {
        userId: ctx.userId,
        deletedAt: null,
        // Impersonation: sessions of the shared org's Apps only.
        ...(ctx.impersonation ? { organizationId: ctx.impersonation.orgId } : {}),
      },
      select: { organizationId: true },
    });
    const orgIds = memberships.map((m: { organizationId: string }) => m.organizationId);
    const clauses: Record<string, unknown>[] = [];
    if (orgIds.length > 0) {
      const apps = await ctx.db.app.findMany({
        where: { organizationId: { in: orgIds }, deletedAt: null },
        select: { id: true },
      });
      if (apps.length > 0) clauses.push({ appId: { in: apps.map((a) => a.id) } });
    }
    if (!ctx.impersonation) clauses.push({ userId: ctx.userId });
    if (clauses.length === 0) return { id: '__none__' };
    return clauses.length === 1 ? clauses[0] : { OR: clauses };
  }
  return { id: '__none__' }; // unauthenticated — no sessions
}

/** Prisma `where` clause that restricts nodes to accessible memories. */
export async function memoryAccessFilter(ctx: Context): Promise<Record<string, unknown>> {
  const ids = await getAccessibleMemoryIds(ctx);
  return ids === null ? {} : { memoryId: { in: ids } };
}

/**
 * Resolve a BARE LOC to a node the caller may read — the safe replacement for
 * `db.node.findFirst({ where: { loc } })` (#825).
 *
 * `Node.loc` is unique per MEMORY, not globally (`@@unique([loc, memoryId])`),
 * so an unscoped lookup silently returns an arbitrary tenant's node. Short
 * conventional locs collide heavily — `preflight` exists in five memories at
 * once — which is how usage rows came to be attributed to strangers' memories.
 *
 * Contract:
 *   - The candidate set is scoped by the SHARED read gate (`memoryAccessFilter`),
 *     so nothing outside the caller's readable set can ever be returned.
 *   - A loc that names nothing readable resolves to `null`. Denied and missing
 *     are indistinguishable, so a caller can't probe for existence.
 *   - An AMBIGUOUS loc — readable in more than one memory — also resolves to
 *     `null` rather than guessing. Silently picking one is the bug this exists
 *     to prevent; a caller that needs a specific node should name it by PK or
 *     fully-qualified URN (`resolveNodeRef`), which is self-scoping.
 *   - A real node beats a link at the same loc, preserving the previous
 *     preference order.
 *
 * Prefer a PK or URN over a bare loc wherever the surface allows it. This
 * helper exists for the surfaces whose input shape is a loc and cannot change
 * without breaking their published contract.
 */
export async function resolveReadableNodeByLoc(
  ctx: Context,
  loc: string,
): Promise<{ id: string; memoryId: string } | null> {
  const access = await memoryAccessFilter(ctx);
  const candidates = await ctx.db.node.findMany({
    // loc-scope-ok: scoped by the shared read gate (memoryAccessFilter) on the
    // line below; ambiguity across readable memories resolves to null.
    where: { loc, deletedAt: null, ...access },
    select: { id: true, memoryId: true, isLink: true },
  });
  if (candidates.length === 0) return null;
  const real = candidates.filter((c) => !c.isLink);
  const pool = real.length > 0 ? real : candidates;
  // More than one readable match ⇒ genuinely ambiguous. Refuse to choose.
  if (pool.length > 1) return null;
  return { id: pool[0].id, memoryId: pool[0].memoryId };
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
    // #697 Stage 2: EMIT flat grammar-v2 for the root entity types (`memory`
    // renames to `mem`; single colon; no `@` sigil). Any other type word falls
    // back to the v1 canonical form (unchanged surface until it too flips).
    if (type === 'memory' || type === 'org' || type === 'agent' || type === 'app') {
      return emitEntityUrnV2(type, raw);
    }
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
  // App-keyed callers: delegate to the class-aware MCP gate. The ADMIN/OWNER
  // short-circuit stands (the documented app+admin short-circuit — App Keys
  // carry no roles, so this only fires for a platform-admin JWT with an active
  // App), EXCEPT for a spec-047 user-owned memory: strict ownership means even
  // a platform admin gets no write, so we skip the bypass and let
  // canWriteToMemory enforce owner-only (gemini review, #676). (The pre-existing
  // personal/private app+admin bypass is deliberately left as-is here — it's
  // load-bearing for agent session writes and out of scope for 2c-2a.)
  if (ctx.appId) {
    if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) {
      const m = await ctx.db.memory.findUnique({
        where: { id: memoryId },
        select: { ownerUserId: true },
      });
      if (m?.ownerUserId == null) return;
    }
    if (await canWriteToMemory(ctx.db, ctx, memoryId)) return;
    throw new Error('Forbidden: no write access to this memory');
  }

  // JWT user path
  if (!ctx.userId) throw new Error('Unauthenticated');

  const memory = await ctx.db.memory.findUniqueOrThrow({
    where: { id: memoryId },
    select: {
      id: true,
      organizationId: true,
      ownerUserId: true,
      userId: true,
      class: true,
      appId: true,
      userMemoryOfAgentId: true,
    },
  });

  // 034-memory-class-access: owner-owned personal/private memories are
  // owner-only to write — no ADMIN/OWNER bypass, no org-role path — EXCEPT a
  // #778 `writer` MemoryShare grantee on a personal memory (private is never
  // shareable, so this only widens personal).
  if (memory.class === 'personal' || memory.class === 'private') {
    if (memory.userId === ctx.userId) return;
    if (await granteeShareAccess(ctx.db, ctx.userId, memory, { requireWrite: true })) return;
    throw new Error('Forbidden: no write access to this memory');
  }

  // spec 047: a USER-owned memory is writable ONLY by its owner — STRICT
  // ownership, so this runs BEFORE the ADMIN/OWNER bypass below (a platform
  // admin does NOT get write to another user's user-owned memory, consistent
  // with the personal/private carve-out above). Covers a user-owned
  // non-personal memory, e.g. a user-owned agent's system/knowledge memory.
  if (memory.ownerUserId !== null) {
    if (ctx.userId === memory.ownerUserId) return;
    throw new Error('Forbidden: no write access to this memory');
  }

  // Non-personal/private, org-owned: global ADMIN/OWNER bypass.
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;

  // #653: an APP-SCOPED knowledge/group memory is App-internal — it must NOT be
  // writable via the org-member CONTRIBUTOR / cross-org-subscription grants
  // below (which key on organizationId, ignoring app_id). App-scoped write goes
  // through the App-key/agent path (canWriteToMemory via getAppMemoryAccess); a
  // JWT org contributor who isn't ADMIN gets no write here (codex review, #660).
  if (memory.appId !== null && (memory.class === 'knowledge' || memory.class === 'group')) {
    throw new Error('Forbidden: no write access to this memory');
  }

  if (memory.organizationId === null) {
    throw new Error('Forbidden: no write access to this memory');
  }

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
      // #653: an app-scoped knowledge/group memory is App-internal, not an "org
      // memory" — keep it out of the org's main list (surfaced via the App).
      appId: null,
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
// createMemoryShare / updateMemoryShareRole share the v1 rule: caller
// MUST be the Memory's principal (`memory.userId`). deleteMemoryShare
// widens that to principal-OR-self (#785) — a grantee may delete their
// OWN row, mirroring requireMemoryMemberOwnerOrSelf — so it consumes
// the boolean `isMemorySharePrincipal` instead of the throwing guard.
// The Agent-mediated path (App backend acting on behalf via MCP) is
// supported by the access-control predicate but not by this GraphQL
// surface — see joinApp.ts header for the broader policy discussion.

// ─── 023-app-shape US4 — MemoryMember caller-authority guards ──────────
//
// addMemoryMember / updateMemoryMemberRole require an existing OWNER on
// the memory. removeMemoryMember accepts either an owner OR the member
// being removed (self-removal).

/**
 * The single uniform FORBIDDEN for the member-management surface. Missing,
 * soft-deleted, wrong-class, and not-owner all collapse to this one shape
 * (don't-leak-metadata) — and #764 routes a memory-ref resolution miss here
 * too, so an unknown ref is indistinguishable from an unauthorized real memory.
 */
export function memoryMemberForbidden(): GraphQLError {
  return new GraphQLError('You are not authorized to manage members on this memory.', {
    extensions: { code: 'FORBIDDEN' },
  });
}

/**
 * Boolean form of {@link requireMemoryMemberOwner}: is the caller an OWNER of a
 * live group-class memory? A missing/soft-deleted/wrong-class memory is never
 * "owner". Lets the owner-OR-self surface decide how to fail BEFORE it resolves
 * the target user (so a non-owner can't turn user resolution into an oracle).
 */
export async function isMemoryMemberOwner(ctx: Context, memoryId: string): Promise<boolean> {
  if (!ctx.userId) return false;
  const memory = await ctx.db.memory.findUnique({
    where: { id: memoryId },
    select: { class: true, deletedAt: true },
  });
  if (!memory || memory.deletedAt || memory.class !== 'group') return false;
  const member = await ctx.db.memoryMember.findUnique({
    where: { memoryId_userId: { memoryId, userId: ctx.userId } },
    select: { role: true },
  });
  return member?.role === 'owner';
}

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
  // unauthorized path (missing/soft-deleted/wrong-class/not-owner all look
  // the same). Membership rows persist past Memory soft-delete, so the class +
  // deletedAt checks live in isMemoryMemberOwner too.
  if (!(await isMemoryMemberOwner(ctx, memoryId))) {
    throw memoryMemberForbidden();
  }
}

/**
 * #764 review — resolve a memory ref for a member-management surface WITHOUT a
 * memory-existence oracle. A resolution miss (unknown/soft-deleted memory) maps
 * to the same uniform FORBIDDEN {@link requireMemoryMemberOwner} throws, so an
 * authenticated non-owner can't distinguish "no such memory" (NOT_FOUND) from
 * "real memory you don't own" (FORBIDDEN). Malformed-input errors
 * (BAD_USER_INPUT) still surface — they reveal nothing about existence.
 */
export async function resolveMemoryRefForMemberGate(
  ctx: Context,
  args: { ref?: string | null; id?: string | null },
): Promise<string> {
  try {
    return await resolveMemoryRefArg(ctx.db, args);
  } catch (e) {
    if (e instanceof GraphQLError && e.extensions?.code === 'NOT_FOUND') {
      throw memoryMemberForbidden();
    }
    throw e;
  }
}

/**
 * #764 review — resolve the TARGET user for a member surface that only permits
 * self-action to a non-owner caller. Any resolution miss maps to the uniform
 * member FORBIDDEN, and the caller must verify `resolved === ctx.userId`
 * afterwards, so an unknown handle/email is indistinguishable from a known one
 * the caller may not act on (no user-enumeration oracle).
 */
export async function resolveSelfUserRefForMemberGate(
  ctx: Context,
  args: { ref?: string | null; id?: string | null },
): Promise<string> {
  try {
    return await resolveUserRefArg(ctx.db, args);
  } catch (e) {
    if (e instanceof GraphQLError && e.extensions?.code === 'NOT_FOUND') {
      throw memoryMemberForbidden();
    }
    throw e;
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

/**
 * Is the caller the Memory's principal (`memory.userId`)? Boolean form of
 * `requireMemorySharePrincipal`, for the one surface that must know the
 * answer BEFORE it decides how to fail (deleteMemoryShare, #785).
 * A soft-deleted or missing memory is never "principal".
 */
export async function isMemorySharePrincipal(
  ctx: Context,
  memoryId: string,
): Promise<boolean> {
  if (!ctx.userId) return false;
  const memory = await ctx.db.memory.findUnique({
    where: { id: memoryId },
    select: { userId: true, deletedAt: true },
  });
  return !!memory && !memory.deletedAt && memory.userId === ctx.userId;
}

export function memoryShareForbidden(): GraphQLError {
  // Uniform message + code for every unauthorized share path — the
  // don't-leak-metadata rule: "memory doesn't exist", "memory is
  // soft-deleted", "not personal-class", and "you're not the principal"
  // are indistinguishable to the caller.
  return new GraphQLError('You are not authorized to manage shares on this memory.', {
    extensions: { code: 'FORBIDDEN' },
  });
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
  if (!(await isMemorySharePrincipal(ctx, memoryId))) {
    throw memoryShareForbidden();
  }
}

// ─── 023-app-shape US1 — install/uninstall Agent core logic ────────────
//
// Shared by both the canonical mutations (`installAgentIntoApp` /
// `uninstallAgentFromApp`, returning Payload types) and the deprecated
// pre-023 mutations (`addAgentToApp` / `removeAgentFromApp`, returning
// `App`). Keeping the logic in one place prevents drift between the two
// surfaces.

/**
 * "Is the caller a non-`reader` member of this App?" — the AppMember half of
 * `createTeamPersona`'s mint gate, extracted here (#952) so the one
 * conventional read-only role spelling lives in a single place rather than
 * being restated by each surface that admits App members.
 *
 * `installAgentIntoAppCore` deliberately does NOT use it — see the note on its
 * gate: installing an EXISTING Agent is itself a read grant on that Agent's
 * design, which minting a fresh one is not.
 *
 * AppMember roles are free-form strings drawn from the Agent's
 * `installationPolicy.memberRoles`, so `reader` is the one conventional
 * read-only spelling this predicate knows (case-insensitive, trimmed).
 *
 * Never admits on a USER-owned App: spec 047 keeps those strictly owner-only,
 * and the owner is already admitted by the org/owner gate this backs up.
 * Never admits under impersonation — support sessions are read-only (#875).
 */
export async function isNonReaderAppMember(
  ctx: Context,
  app: { id: string; ownerUserId: string | null },
): Promise<boolean> {
  if (ctx.impersonation || !ctx.userId || app.ownerUserId !== null) return false;
  const member = await ctx.db.appMember.findUnique({
    where: { appId_userId: { appId: app.id, userId: ctx.userId } },
    select: { role: true },
  });
  return !!member && member.role.trim().toLowerCase() !== 'reader';
}

export class DuplicateAppAgentError extends GraphQLError {
  constructor(appId: string, agentId: string) {
    super(`Agent ${agentId} is already installed in App ${appId}.`, {
      extensions: { code: 'DUPLICATE_APP_AGENT', appId, agentId },
    });
  }
}

export async function installAgentIntoAppCore(
  ctx: Context,
  // #789 / cor:api:140 — these are REFS (PK or URN), resolved below. Named
  // `*Ref` so the param name stops advertising a PK it never required.
  args: { appRef: string; agentRef: string; trainingMode?: boolean },
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
  const { id: resolvedAppId } = await resolveAppRef(ctx.db, args.appRef);
  const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, args.agentRef);
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
  //
  //
  // #952 asked for a non-`reader` AppMember fallback here, "matching
  // createTeamPersona's gate", so a team's own members can compose the roster.
  // NOT done, deliberately — the two operations are not symmetric:
  // createTeamPersona installs an Agent it MINTS in the same call (empty, so
  // nothing pre-existing is revealed), whereas this one installs an EXISTING
  // Agent, and installing is itself a read grant. An installed Agent's system
  // memory becomes READ_ONLY in every App-context access map
  // (`foldAgentIntoAccessMap`), and the mutation payload returns the Agent
  // object, whose own definition fields (systemPrompt / systemMemoryId /
  // memoryItems) are NOT field-gated — they rely on this object-level gate
  // (#551). An AppMember who is not an org member cannot read a non-PUBLIC org
  // Agent today (`Query.agent` requires org READER), so admitting them here
  // would hand them exactly that — the
  // findings:broadening-read-gate-leaks-nested-objects class. Widening this
  // needs a deliberate call on that exposure, not an inference from the
  // roster-composition use case.
  await requireOwnerOrOrgRole(ctx, app, 'CONTRIBUTOR');
  const agent = await ctx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
  // #756: an org-owned App and a user-owned App have DIFFERENT accessibility
  // rules, and the org comparison alone cannot express the second one. Both
  // `organizationId` columns are null for a user-owned App + a user-owned
  // Agent, so a bare `agent.organizationId !== app.organizationId` reads
  // `null !== null` ⇒ false and waves through another USER's non-PUBLIC agent
  // (leaking its systemPrompt via the returned AGENT_INCLUDE). Branch on the
  // App's ownership class instead, mirroring createApp's personal path.
  if (app.organizationId === null) {
    // spec 047 personal install: no org ⇒ no AgentOrgGrant. A user-owned App
    // may install ONLY a PUBLIC (marketplace) agent or its OWNER's own agent —
    // never another user's or another org's private agent.
    const isOwnAgent = agent.ownerUserId !== null && agent.ownerUserId === app.ownerUserId;
    if (agent.visibility !== 'PUBLIC' && !isOwnAgent) {
      throw new GraphQLError('A personal App may only install a PUBLIC agent or your own personal agent.', {
        extensions: { code: 'ORGANIZATION_MISMATCH', appId: resolvedAppId, agentId: resolvedAgentId },
      });
    }
  } else if (agent.organizationId !== app.organizationId && agent.visibility !== 'PUBLIC') {
    // #551: a foreign Agent may be installed cross-org WHEN it is PUBLIC (the
    // marketplace / AgentOrgGrant path — the grant is auto-provisioned below).
    // A non-PUBLIC agent still must belong to the App's own org (pre-023
    // behavior — you can't reach into another org's private agents).
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
  // Auto-provision AgentOrgGrant (cross-org gate symmetry). spec 047: an
  // AgentOrgGrant is org-scoped — a user-owned App has no org, so a personal
  // install rides the owner's AgentSubscription instead (no grant needed).
  if (app.organizationId) {
    await ensureAgentOrgGrant(ctx.db, app.organizationId, resolvedAgentId);
  } else if (app.ownerUserId && agent.ownerUserId !== app.ownerUserId) {
    // #756: license the personal install the same way createApp does, so a
    // marketplace agent added through THIS path is subscribed rather than run
    // unlicensed. Skipped for the owner's own agent — ownership licenses it.
    await ensureAgentSubscription(ctx.db, app.ownerUserId, resolvedAgentId);
  }
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
  // #789 / cor:api:140 — refs, not PKs (resolved below).
  args: { appRef: string; agentRef: string },
): Promise<{ appId: string; agentId: string }> {
  const { id: resolvedAppId } = await resolveAppRef(ctx.db, args.appRef);
  const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, args.agentRef);
  const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
  // #551: symmetric with install — a CONTRIBUTOR+ member of the App's org can
  // uninstall an Agent (was ADMIN-only).
  await requireOwnerOrOrgRole(ctx, app, 'CONTRIBUTOR');
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

/**
 * Load an email connection and enforce the shared access gate for a MAIL/
 * CALENDAR OPERATION. The ONE place connection-operation authorization lives —
 * never hand-roll a per-resolver connection gate. Connection MANAGEMENT (list,
 * delete) keeps its org-ADMIN gates; those are administration, not operations.
 *
 * Two principal contexts (#396 owner-only + spec-042 Track B / #593 delegation):
 *
 * - **Interactive owner** (`ctx.appId` absent, `ctx.userId === owner`) → allowed
 *   for every operation. This is the only allow-all path.
 * - **App / headless-run context** (`ctx.appId` set) → FAIL-CLOSED: requires a
 *   live `ConnectionGrant` to this App (`ctx.appId`) whose scopes cover the
 *   operation, **even when the run is on-behalf-of the owner**. The scope table
 *   is authoritative in every autonomous context, so the mailbox stays
 *   scope-bounded regardless of `run.userId` provenance (Option B, Holger
 *   2026-07-09). An operation with no scope mapping is owner-only (a grantee can
 *   never satisfy it).
 * - Everyone else (non-owner user, App with no covering grant) → Forbidden.
 *
 * Grantee is the App install (`granteeAppId`), never the Agent — one Agent in
 * two Apps/orgs is two trust contexts. Cross-org delegation is intended: the
 * grant row is the sole authority, so NO same-org check is added here.
 */
export async function requireEmailConnection(
  ctx: Context,
  connectionRef: string,
  operation: string,
): Promise<{
  id: string;
  provider: string;
  toolConnectionId: string;
  organizationId: string;
  userId: string;
  mailboxEmail: string;
}> {
  // #876 (HIGH): an ExchangeConnection is ALWAYS identity-scoped — a mailbox,
  // calendar, or Drive belonging to one person. The interactive-owner branch
  // below authorizes on `ctx.userId === connection.userId`, and its own
  // comment records the intended boundary: "org admins included → denied".
  // Under impersonation ctx.userId IS the owner, which would inverted that
  // denial into permission across nine read surfaces (exchangeMessages,
  // exchangeFolders, calendars, calendarEvents, calendarEvent,
  // calendarSchedule, driveFiles, driveFile, driveFileExport) — an org admin
  // reading an employee's private mail, calendar, and Drive exports. A
  // blanket deny is correct: no impersonated operation on this surface is
  // in-scope, so there is no per-operation carve-out to make.
  if (ctx.impersonation) throw new Error('Forbidden');
  // findFirst (not findUnique) so deletedAt filters in the query — the
  // revoked-membership pattern (PR #475). The `select` is load-bearing: it
  // keeps the legacy encrypted-token column out of the returned object, so
  // the declared type IS the runtime shape and no caller can accidentally
  // serialize a secret (CLAUDE.md authorization invariants: sanitized
  // projection, never the raw row).
  const connection = await ctx.db.exchangeConnection.findFirst({
    where: { id: connectionRef, deletedAt: null },
    select: {
      id: true,
      provider: true,
      toolConnectionId: true,
      organizationId: true,
      userId: true,
      mailboxEmail: true,
    },
  });
  // Soft-deleted / non-existent connections fail first (before any auth
  // branch) so absence and denial stay indistinguishable.
  if (!connection) throw new Error('Connection not found');

  if (ctx.appId) {
    // App / headless-run context — a covering grant is mandatory (fail-closed),
    // even for an on-behalf-of-owner run. Unmapped operation ⇒ owner-only ⇒ deny.
    const scope = scopeForOperation(operation);
    if (!scope) throw new Error('Forbidden');
    const grant = await ctx.db.connectionGrant.findFirst({
      where: {
        connectionId: connection.id,
        granteeAppId: ctx.appId,
        deletedAt: null,
        // The grantee App must still be a live install. App-key auth rejects a
        // DELETED App but NOT an uninstalled one, so an old key for a
        // soft-uninstalled App would otherwise keep authorizing via a live grant
        // — uninstalling must drop delegated authority (PR-599 review, Codex).
        granteeApp: { deletedAt: null, uninstalledAt: null },
        scopes: { has: scope },
        // Enforce expiry in the query (TOCTOU-safe). The OR is mandatory — a
        // bare `gt` would silently drop perpetual (null-expiry) grants.
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
    });
    if (!grant) throw new Error('Forbidden');
  } else if (!ctx.userId || ctx.userId !== connection.userId) {
    // Pure user principal that isn't the owner (org admins included) → denied.
    throw new Error('Forbidden');
  }
  // else: interactive owner (no appId, userId === owner) — allowed for all ops.

  if (!connection.toolConnectionId) {
    throw new GraphQLError(
      'This mailbox connection has not been migrated to the email tool yet — reconnect the mailbox or run the token transfer.',
      { extensions: { code: 'EMAIL_CONNECTION_NOT_MIGRATED' } },
    );
  }
  return { ...connection, toolConnectionId: connection.toolConnectionId };
}

/**
 * The one way a resolver runs a mail operation: owner-only gate, then the
 * spec-002 operation on the provider tool with the TOOL's connection id (a
 * copy-paste that passed core's row id instead would 404 only in prod —
 * tests mock the client). Extra input fields (messageId, bodyHtml,
 * idempotencyKey, …) merge over the routed connectionId.
 */
export async function runOwnedEmailOperation<T = Record<string, unknown>>(
  ctx: Context,
  connectionRef: string,
  operation: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const connection = await requireEmailConnection(ctx, connectionRef, operation);
  // connectionId is set AFTER the spread so no input field can override the
  // routed tool connection id (PR-573 Copilot review).
  return runEmailOperation<T>(connection.provider, operation, {
    ...input,
    connectionId: connection.toolConnectionId,
  });
}

/**
 * Map a tool CalendarEvent (lowercase response vocabulary on the wire) to
 * the GraphQL shape (CalendarEventResponse enum values are uppercase). The
 * ONE mapper both the query and mutation resolvers use, so the wire→schema
 * translation cannot drift between the two surfaces.
 */
export function mapToolCalendarEvent(e: ToolCalendarEvent) {
  return {
    ...e,
    attendees: e.attendees.map((a) => ({ ...a, response: a.response.toUpperCase() })),
    myResponse: e.myResponse ? e.myResponse.toUpperCase() : null,
  };
}

/**
 * Map a tool DriveFile (lowercase kind vocabulary on the wire) to the
 * GraphQL shape (DriveFileKind enum values are uppercase). The ONE mapper
 * every drive surface uses — the calendar-event mapper's sibling (#749).
 */
export function mapToolDriveFile(f: ToolDriveFile) {
  return { ...f, kind: f.kind.toUpperCase() };
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
  /** #725 — collection discriminator (e.g. "competitor"). Omit preserves; null clears. */
  objectType?: string | null;
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
  /** Why this change was made — stored in revision history (NodeRevision.revLabel, #620). Issue #88. */
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
  /** Why this change was made — stored in revision history (NodeRevision.revLabel, #620). Issue #88. */
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
  // #928 coding-session provenance.
  transcriptPath?: string;
  host?: string;
  tool?: string;
  // #928 / cor:api:140: the Agent (persona) driving this session (PK or URN).
  agentRef?: string;
  // #943 / cor:api:140: the App this session is a unit of work for (PK or URN),
  // gated on the caller's membership of that App.
  appRef?: string;
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
