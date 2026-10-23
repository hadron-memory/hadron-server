import { LINK_CAP_MEMORY_SELECT, linkWriteTargetAdmits } from '../../../lib/auth/agentMemoryLinkCap.js';
import { systemMemoryReadGrants } from '../../../lib/auth/systemMemoryRead.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
// Helpers extracted from resolvers.ts (Step 1 of the resolver split).
// Pure mechanical move: shared auth/include/AI-config/chat/asset helpers used
// by the GraphQL resolver map. No behavior change. The `Context` interface
// lives here and is re-exported from resolvers.ts for existing importers.
import type { NodeMergeField } from '../../../lib/nodeMerge.js';
import type { SnapshotSourceNode } from '../../../lib/nodeRevisionSnapshot.js';
import { sharedUrnAgentSlug } from '../../../lib/sharedMemoryLegacyKey.js';
// Spec 049 Phase 5 — the install-created register row (D2) and its removal on uninstall.
import { ensureInstallRegisterRows, removeRegisterRowsForUninstall } from '../../../lib/registerInstall.js';
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
import { effectiveApiStyle, effectiveEndpoint } from '../../../lib/aiEndpoint.js';
import {
  canReadMemory,
  canWriteToMemory,
  EXPLICIT_REF,
  filterReadableMemoryIds,
  getPrincipalAppMemoryAccess,
  getWorkerMemoryAccess,
} from '../../../mcp/access-control.js';
import { ensureAgentOrgGrant } from '../../../controller/operations/ensureAgentOrgGrant.js';
import { planOrgAgentInstallGrant } from '../../../lib/auth/orgAgentInstallLicense.js';
import { withAuthorizedTx } from './authorizedTx.js';
import { ensureAgentSubscription } from '../../../controller/operations/ensureAgentSubscription.js';
import {
  getPrimaryAgent,
  isAgentInstalled,
} from '../../../lib/appAgent.js';
import { getOrgReadableMemoryIds } from '../../../lib/auth/orgReadableMemory.js';
import { getOrgWritableMemoryIds } from '../../../lib/auth/orgWritableMemory.js';
import { ROLE_ORDER } from '../../../lib/auth/orgRole.js';
import { sessionScopedMemoryIds } from '../../../lib/auth/sessionScopedMemoryIds.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';
import { foreignIdentityScopedMemoryFilter } from '../../../lib/auth/memoryOwnership.js';
import { isStrictOwner } from '../../../lib/auth/strictOwner.js';
import { boundSessionPrivacyFilter } from '../../../lib/auth/sessionPrivacy.js';
import {
  formatCanonicalUrn,
  UrnNotQualifiedError,
  type CanonicalUrnType,
} from '../../../lib/urn.js';
import { safeEntityUrnV2 } from '../../../lib/urnEmit.js';
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
  AmbiguousLegacyUrnError,
} from '../../../lib/entityRef/errors.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { assertLinkAllowedForPublicAgent, isExcludedFromCoveredSet } from '../../../lib/agentPublicCongruence.js';
import type { ImpersonationContext } from '../../../lib/auth/impersonation.js';
import { GraphQLError } from 'graphql';
import { isLifecycleActive, type LifecycleLike } from '@hadron-memory/access-control';
import {
  Prisma,
  type Agent,
  type PrismaClient,
} from '../../../generated/prisma/index.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import { isUserOwnedAgentDefinition } from '../../../lib/auth/userOwnedAgentDefinition.js';
import { canManageAgentSystemMemory } from '../../../lib/auth/managedSystemMemory.js';
import { isInstallMemoryRow, readableInstallMemoryIds } from '../../../lib/auth/installMemory.js';
import { installWriteAllowed } from './installMemory.js';
import { appPrincipalSessionWriteAllowed } from '../../../lib/sessionOwnership.js';

/**
 * Marks a Node row whose `content` field answers with the STORED text unless a
 * query asks otherwise: `node(raw: true)` / `nextNode(raw: true)` set it for
 * the node they return, and `nodeBatch` sets it on every node (R21 A: a bulk
 * read resolves only for `content(raw: false)`). `Node.content` reads it as its
 * default; an explicit `content(raw:)` wins. The row itself is never rewritten,
 * so field resolvers that verify the parent against the database see stored
 * text. A Symbol key is never serialized by GraphQL (#2041).
 */
export const CONTENT_RAW_DEFAULT: unique symbol = Symbol('contentRawDefault');

export interface Context {
  login?: import('../../../auth/jwt.js').HadronJwtPayload['login'];
  db: PrismaClient;
  /**
   * #2044: set ONLY by a door that re-runs its write gate on a transaction client holding the
   * install memory's authority fence (writeNodeCore). On the pooled client an install memory's
   * write gate otherwise answers NO: a writer that never rechecks in its own transaction
   * (restoreNodeRevision, moveNode, deleteNode, ...) cannot hold the fence, so it fails closed.
   */
  installWritePreflight?: boolean;
  /**
   * #1301 — set by an MCP handler that DELEGATES to a GraphQL resolver (e.g.
   * `hadron_update_node_data` → `updateNodeData`), so a refusal addresses the
   * caller on the surface they are actually on (@codex, PR #1305). Unset means
   * a GraphQL caller.
   */
  transport?: 'mcp';
  /**
   * #1301 — with `transport: 'mcp'`: whether the delegating MCP call could be
   * replayed through `kind`'s MCP door. Only the MCP handler knows which fields
   * its caller sent, so it answers; a refusal that cannot be replayed on MCP
   * names no MCP door (@codex, PR #1305).
   */
  governedCanReplay?: (kind: 'task' | 'review' | 'spec' | 'decision') => boolean;
  clientId?: string;       // "github:<username>" / "email:<addr>" — only set for OAuth/JWT users
  userId?: string;         // User.id — only set for OAuth/JWT users
  appId?: string;          // App.id — set when caller authenticated via an App Key
  appKeyId?: string;       // AppKey.id — set only when authenticated with an hdr_app_ key (#1749)
  sessionId?: string;      // Session.id — set when operating inside an active session
  /** #1705 — a named X-Hadron-Session failed validation (see AuthContext.sessionBindingRefused). */
  sessionBindingRefused?: boolean;
  roles?: ('OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER')[];
  organizationId?: string; // set when the Client is scoped to an organization
  apiKeyId?: string;       // UserApiKey.id — set when a user authenticated via an hdr_user_ key (#562)
  signInId?: string;       // #1897: the factor-protected sign-in this credential descends from (JWT sid or key root)
  oauthScopes?: string[];  // immutable OAuth grant on the presented hdr_user_ key (#1261)
  // Admin impersonation: set when the request authenticated with an
  // impersonation JWT — userId is the TARGET, roles is [], and reads must be
  // scoped to impersonation.orgId with all personal-class access dropped (the
  // org-scope chokepoints in this file + src/lib/auth consult it). Mutations
  // are blocked wholesale by the read-only Apollo plugin.
  impersonation?: ImpersonationContext;
  /** #2198 — task warnings collected during this request (see resolvers.taskWarnings.ts); lazily created. */
  taskWarnings?: { path: string; warning: import('./resolvers.taskWarnings.js').TaskWarning }[];
  /** #2198 — request-local gate/register answers and the read time spent on them (resolvers.taskWarnings.ts). */
  taskWarningState?: import('./resolvers.taskWarnings.js').TaskWarningState;
  // Request-scoped memo for Edge.source/target lazy loads — avoids an N+1 of
  // identical node.findUnique calls when many edges in one response share an
  // endpoint (lazily created on first use; see loadEdgeEndpointNode). #381.
  edgeEndpointNodeCache?: Map<string, Promise<unknown>>;
  // Request-scoped memo for per-memory READ-access checks (#781) — gates
  // Edge.source/target endpoint resolution on a cross-memory read. A graph
  // response's edges overwhelmingly share a few endpoint memories, so each
  // distinct memory is checked once per request (see canReadMemoryCached).
  memoryReadCache?: Map<string, Promise<boolean>>;
  // Request-scoped memo for the caller's APP-DERIVED memory ids (#1092). The
  // fold costs several queries per App and the node gate runs on nearly every
  // read surface, so it is computed at most once per request. Independent of
  // any `onlyMemoryId` narrowing — the fold is the same set either way, and the
  // scoping is applied to the result (see appDerivedMemoryIds).
  appDerivedMemoryIdCache?: Promise<string[]>;
  // Request-scoped memo for Node.urn / Edge.urn composition (#481) — a list
  // response's nodes/edges overwhelmingly share a memory, so the memory-urn
  // lookup is memoized per request (lazily created; see loadMemoryUrn).
  memoryUrnCache?: Map<string, Promise<string | null>>;
  // #2193 — Node.memory's record read, memoized per memory: a node list loads
  // and gates each distinct memory once (see loadReadableMemoryRecord).
  memoryRecordCache?: Map<string, Promise<unknown | null>>;
  // Request-scoped per-parent reconciliation. Node.revision,
  // Node.contentValidation and Node.authorship can all resolve on one GraphQL
  // Node object; share its locked read without mixing distinct parent states.
  nodeReconcileCache?: WeakMap<object, Promise<(SnapshotSourceNode & { revSeq: number }) | null>>;
  // Request-scoped gated task URN lookup for repeated Node.authorship fields.
  readableTaskRefCache?: Map<string, Promise<string | null>>;
  // Request-scoped memo for AppRun.urn composition (#696) — a run-list response
  // often shares one App across many runs, so the app-urn lookup is memoized per
  // request (lazily created; see loadAppUrn).
  appUrnCache?: Map<string, Promise<string | null>>;
  // Request-scoped memo for AppRun.app (#831) — same rationale as appUrnCache,
  // for the full row rather than just the urn (lazily created; see loadApp).
  appRowCache?: Map<string, Promise<AppRow | null>>;
  // #1715 — the caller's merge-aware identities (their id plus every account
  // merged into them; src/lib/userMerges.ts), memoized per request.
  mergedIdentityCache?: Promise<Set<string>>;
  // Spec 049 Phase 3b — AppRun.scope memo, keyed on the serialized snapshot
  // (lazily created in the field resolver): a run page repeats one trigger's
  // snapshot across its rows.
  runScopeInfoCache?: Map<string, Promise<unknown>>;
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
  const chosen = chosenRefArg(args);
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
    if (isEntityNotFound(e)) throw refArgNotFoundError(args.label, chosen);
    if (e instanceof AmbiguousUserRefError) {
      throw new GraphQLError(
        `${args.label}Ref "${chosen}" matches more than one account (differing only by email case). Use the exact-case email, the handle, or the id.`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      );
    }
    throw e;
  }
}

/** The ref `resolveRefArg` resolves: the trimmed `<label>Ref`, else the deprecated `<label>Id`. */
export function chosenRefArg(args: { ref?: string | null; id?: string | null }): string | undefined {
  return args.ref?.trim() || args.id?.trim();
}

/**
 * `resolveRefArg`'s answer for a ref that resolves to nothing. Exported so a
 * surface that CONCEALS an unreadable target (#1381, `cor:api:140:03`) throws
 * the identical error rather than a copy that could drift.
 */
export function refArgNotFoundError(label: string, chosen: string): GraphQLError {
  return new GraphQLError(`No match for ${label}Ref "${chosen}".`, { extensions: { code: 'NOT_FOUND' } });
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
 * A copy of the context with EVERY request memo removed (each `*Cache` key), so
 * a gate asked on it reflects the database as it is now rather than replaying
 * an answer memoized earlier in the request. Stripping by suffix keeps a memo
 * added later from quietly re-staling the callers (#1360 review, round 4).
 *
 * Pass `db` — the interactive transaction's client — when the gate runs INSIDE
 * a transaction. Asked on `ctx.db` it needs a second pool connection while the
 * transaction holds one, so N concurrent writers queued on one row lock can
 * hold every connection and starve the lock holder until the transaction
 * timeout (#1360 review: 8 concurrent rule updates did exactly that).
 */
export function withoutRequestCaches(ctx: Context, db?: Prisma.TransactionClient): Context {
  const fresh = Object.fromEntries(Object.entries(ctx).filter(([k]) => !k.endsWith('Cache'))) as Context;
  return db ? { ...fresh, db: db as PrismaClient } : fresh;
}

/**
 * {@link isMemoryReadableCached}, but ALWAYS re-asked, and the fresh answer
 * replaces the request's memoized one. For a check that must reflect the state
 * at a later point in the same request — a re-check inside a write's
 * transaction — where the memoized answer from the pre-check would make it a
 * no-op, and where later reads in the request must not reuse the stale
 * decision either (#1360 review).
 *
 * The gate runs on a copy of the context with EVERY request memo removed (each
 * `*Cache` key), not just `memoryReadCache`: `getAccessibleMemoryIds` consults
 * nested ones too (`appDerivedMemoryIdCache` for App-derived access, App rows),
 * and bypassing only the outer one re-used the inner answer (#1360 review,
 * round 4). Stripping by suffix keeps a memo added later from quietly
 * re-staling this path. Inside a transaction, pass its client as `tx` (see
 * {@link withoutRequestCaches}).
 */
export function isMemoryReadableFresh(ctx: Context, memoryId: string, tx?: Prisma.TransactionClient): Promise<boolean> {
  const uncached = withoutRequestCaches(ctx, tx);
  const cache = (ctx.memoryReadCache ??= new Map<string, Promise<boolean>>());
  const pending = getAccessibleMemoryIds(uncached, memoryId).then((ids) => ids === null || ids.includes(memoryId));
  cache.set(memoryId, pending);
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
 * Resolve a memory ref for a surface that reads the memory's NODE data, and
 * answer an unreadable memory exactly as `resolveMemoryRef` answers a missing
 * one: `MemoryNotFoundError(ref)`, carrying the caller's own ref (#1316).
 *
 * The throwing twin of {@link resolveReadableMemoryId}, for surfaces whose
 * missing-memory contract is the typed `MEMORY_NOT_FOUND` error rather than an
 * empty page. Before this, each such surface resolved first (only a MISSING
 * memory throws there) and then applied its own gate with its own denial —
 * `[]`, `NOT_FOUND`, `null`, `FORBIDDEN` — so "exists but unreadable" differed
 * from "no such memory". Memory URNs are guessable, which made each one a
 * cross-tenant name oracle.
 *
 * The gate is the node-content gate (`isMemoryReadableCached`, i.e.
 * `getAccessibleMemoryIds`) — the one these surfaces already used, so this
 * moves only the response, not the access decision. It is deliberately NOT the
 * record gate: an org member may open an app/system memory RECORD whose nodes
 * that gate excludes, and these surfaces return node data.
 *
 * Malformed refs and DB faults propagate from `resolveMemoryRef` unchanged.
 */
export async function resolveNodeReadableMemoryRef(
  ctx: Context,
  ref: string,
): Promise<{ id: string }> {
  const { id } = await resolveMemoryRef(ctx.db, ref);
  if (!(await isMemoryReadableCached(ctx, id))) throw new MemoryNotFoundError(ref);
  return { id };
}

/**
 * True for an ORDINARY authorization denial — the only error an existence
 * classification may replace. The platform's gates deny in three spellings:
 * a `FORBIDDEN`-coded GraphQLError (every shared gate since #1493:
 * requireOrgRole, requireOrgAction, requireOwnerOrOrgRole and the rest), a
 * plain `Error('Forbidden')` / `Error('Forbidden: …')` (gates outside the shared
 * set that are not yet typed), and `Error('Unauthenticated')`. Anything else — a DB
 * fault, a typed domain refusal, a malformed ref — is not a denial and must
 * propagate as itself (#1316: no blanket catch-all).
 */
export function isAuthorizationDenial(error: unknown): boolean {
  if (error instanceof GraphQLError) return error.extensions.code === 'FORBIDDEN';
  if (!(error instanceof Error)) return false;
  return (
    error.message === 'Forbidden' ||
    error.message.startsWith('Forbidden:') ||
    error.message === 'Unauthenticated'
  );
}

/**
 * Run a memory-targeted mutation's EXISTING authorization, and when it denies
 * a caller who cannot even open the memory's record, answer as the missing
 * branch does: `MemoryNotFoundError(ref)` (#1316).
 *
 * A caller who CAN open the record (via `Query.memory`) already knows the
 * memory exists, so their denial stays exactly what the surface threw —
 * readable-but-not-permitted remains FORBIDDEN, which is the actionable
 * answer. Only an ordinary denial ({@link isAuthorizationDenial}) is
 * classified; every other error, and every success, passes through untouched,
 * so no permitted caller is ever narrowed. The record read here selects every
 * field `canReadMemoryRecord` requires (omitting one can fail it open —
 * #1104).
 *
 * `authorize` must perform authorization ONLY — no writes — since it runs
 * before classification and its side effects would not be concealed.
 */
export async function concealUnreadableDenial(
  ctx: Context,
  memoryId: string,
  ref: string,
  authorize: () => Promise<void>,
  // #1381 — the surface's own missing-memory error, for the surfaces whose
  // miss is not `MemoryNotFoundError` (the `<label>Ref` arguments answer
  // `refArgNotFoundError`). Only an identical answer conceals anything.
  missing: () => Error = () => new MemoryNotFoundError(ref),
): Promise<void> {
  try {
    await authorize();
  } catch (error) {
    if (!isAuthorizationDenial(error)) throw error;
    if (await canOpenMemoryRecordById(ctx, memoryId)) throw error;
    throw missing();
  }
}

/**
 * The capability an `AgentMemoryItem` row confers (`cor:dmo:050:09`). `read`
 * admits the memory's node CONTENT to the agent's audience; `read-write` is
 * additionally the sole write cap for a knowledge memory.
 *
 * Validated rather than free-form (#1349): the column is a plain `String`, so
 * an unrecognised value used to be stored silently. Read surfaces now skip
 * those legacy rows through isGrantedAgentMemoryRole rather than treating
 * an unknown value as read-only.
 */
export const AGENT_MEMORY_ROLES = ['read', 'read-write'] as const;
export type AgentMemoryRole = (typeof AGENT_MEMORY_ROLES)[number];

/** Parse an `AgentMemoryItem.role` argument, defaulting to the narrower cap. */
export function parseAgentMemoryRole(role?: string | null): AgentMemoryRole {
  const value = role ?? 'read';
  if (!(AGENT_MEMORY_ROLES as readonly string[]).includes(value)) {
    throw new GraphQLError(
      `Unknown role "${value}" — expected one of: ${AGENT_MEMORY_ROLES.join(', ')}.`,
      { extensions: { code: 'BAD_USER_INPUT', role: value } },
    );
  }
  return value as AgentMemoryRole;
}

/**
 * The caller's OWN user principal, with every App-derived reach stripped
 * (#1349).
 *
 * An attach is a grant TO an App audience, so the capability it hands over has
 * to be one the human calling holds themselves. Evaluated on the request
 * context as-is, an App-keyed or session-bound caller would have
 * `getAccessibleMemoryIds` union in whatever THAT App already reaches — which
 * is exactly how one App's grant would launder into another App's audience.
 * Dropping `appId`/`sessionId` (and the caches primed under the wider
 * principal) asks the narrower question the grant needs: what may this *user*
 * reach?
 */
function userPrincipalOnly(ctx: Context): Context {
  return {
    db: ctx.db,
    userId: ctx.userId,
    clientId: ctx.clientId,
    roles: ctx.roles,
    organizationId: ctx.organizationId,
    apiKeyId: ctx.apiKeyId,
    signInId: ctx.signInId,
    oauthScopes: ctx.oauthScopes,
    impersonation: ctx.impersonation,
  };
}

/**
 * Does this caller hold CONTENT-READ on the memory **in their own right** —
 * excluding anything they can only reach through an App (#1349)?
 *
 * Dropping `ctx.appId` is NOT enough, and the first version of this gate was
 * wrong to claim it was (@codex, PR #1357). `getAccessibleMemoryIds`' user
 * branch folds in `appDerivedMemoryIds`, which for a user principal enumerates
 * EVERY App that user can reach — so a memory readable only through App B still
 * passed, and attaching it to an agent in App A laundered B's grant into A's
 * audience, which is precisely what this gate exists to stop. Stripping the
 * active App made the reach broader, not narrower.
 */
function holdsContentReadIndependently(ctx: Context, memoryId: string): Promise<boolean> {
  const self = userPrincipalOnly(ctx);
  return getAccessibleMemoryIds(self, memoryId, { excludeAppDerived: true }).then(
    (ids) => ids === null || ids.includes(memoryId),
  );
}

/**
 * The same-App attach (#1357; Holger's ruling, 2026-09-26): an appropriately
 * authorized caller may attach an App's own memory, READ-ONLY, to another
 * agent installed in that same App.
 *
 * Why it needs its own branch: the capability check excludes App-derived reach
 * on purpose — counting it let a memory reachable only through App B be
 * laundered into App A. That also made an App-scoped memory (#653: App-internal,
 * excluded from every org-wide gate) unattachable by anyone, including the
 * App's own admins, so provisioning a SECOND agent in the App could not give it
 * the App's knowledge. This admits exactly that and nothing wider:
 *
 *  - **the memory's OWN App** — `memory.appId`, never whichever App the caller
 *    happens to reach it through. That is the "no cross-App shortcut";
 *  - **the target agent is installed in that App**, which is live (not deleted,
 *    not uninstalled, its org not soft-deleted);
 *  - **the caller is authorized for that App** by the gate `createMemoryInApp`
 *    uses to provision App knowledge (`requireOwnerOrOrgRole(app, 'ADMIN')`), so
 *    "appropriately authorized" means what it already means;
 *  - **knowledge / group only**, and never a user-owned row — never a
 *    strict-owner shape;
 *  - **`read` only**, mirroring provisioning, which links App knowledge `read`
 *    and leaves writes with the org admin. This also holds for a platform
 *    admin, whose independent read capability must not bypass App scope.
 *
 * The row this admits confers no ambient authority of its own: the access fold
 * (`admissibleFoldRows`) confines an App-scoped row to its own App, so the new
 * agent reaches the memory only inside the App that owns it (#1376).
 */
async function sameAppAttachAdmitted(
  ctx: Context,
  agent: { id: string; organizationId: string | null; ownerUserId: string | null },
  memory: { appId: string | null; class: string; organizationId: string | null; ownerUserId: string | null; userMemoryOfAgentId: string | null },
): Promise<boolean> {
  if (memory.appId == null) return false;
  if (memory.class !== 'knowledge' && memory.class !== 'group') return false;
  // Legacy knowledge/group holdings with this pointer are creator-scoped,
  // even when the App owns their namespace and ownerUserId is null.
  if (memory.userMemoryOfAgentId != null) return false;
  // A spec-047 USER-owned row is strictly owner-only (@copilot, PR #1357). Its
  // owner already holds content read in their own right and never needs this
  // branch; anyone else must not get it through an App admin role.
  if (memory.ownerUserId != null) return false;
  const app = await ctx.db.app.findUnique({
    where: { id: memory.appId },
    select: { id: true, organizationId: true, ownerUserId: true },
  });
  if (!app) return false;
  // A stale appId on a transferred memory does not grant the destination
  // tenant's content to the App's installed Agents.
  if (app.organizationId !== memory.organizationId || app.ownerUserId !== memory.ownerUserId) return false;
  // deleteApp and App uninstall update the App row without removing the
  // AppAgent join. Lock and recheck lifecycle inside the attach transaction:
  // the earlier lookup identifies the row, not its authoritative live state.
  const liveApp = await ctx.db.$queryRaw<{ id: string }[]>`
    SELECT id FROM apps WHERE id = ${app.id} AND deleted_at IS NULL AND uninstalled_at IS NULL FOR SHARE
  `;
  if (liveApp.length === 0) return false;
  if (app.organizationId != null) {
    const liveOrg = await ctx.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM organizations WHERE id = ${app.organizationId} AND deleted_at IS NULL FOR SHARE
    `;
    if (liveOrg.length === 0) return false;
  }
  // A foreign Agent's owning org can be deleted while its AppAgent and grant
  // survive. Hold that lifecycle row through the attach decision too.
  if (agent.organizationId != null && agent.organizationId !== app.organizationId) {
    const liveAgentOrg = await ctx.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM organizations WHERE id = ${agent.organizationId} AND deleted_at IS NULL FOR SHARE
    `;
    if (liveAgentOrg.length === 0) return false;
  }
  // FOR KEY SHARE, not a plain read (@copilot, PR #1357): uninstalling DELETES
  // this join row without locking the agent or the memory, so a snapshot could
  // pass here and the uninstall commit before the grant — leaving a latent row
  // that re-activates if the agent is reinstalled. The lock makes that delete
  // wait for this transaction instead. No deadlock: uninstall takes no memory
  // or agent lock.
  const installed = await ctx.db.$queryRaw<{ app_id: string }[]>`
    SELECT app_id FROM app_agents WHERE app_id = ${app.id} AND agent_id = ${agent.id} FOR KEY SHARE
  `;
  if (installed.length === 0) return false;
  // The join can outlive a revoked/expired install license. Lock that row and
  // evaluate the same lifecycle predicate as the App access fold, so a revoke
  // cannot commit between this decision and the attached grant.
  if (app.organizationId == null) {
    if (app.ownerUserId == null) return false;
    if (app.ownerUserId !== agent.ownerUserId) {
      const license = await ctx.db.$queryRaw<LifecycleLike[]>`
        SELECT activated_at AS "activatedAt", revoked_at AS "revokedAt", expires_at AS "expiresAt"
        FROM agent_subscriptions WHERE user_id = ${app.ownerUserId} AND agent_id = ${agent.id} FOR SHARE
      `;
      if (!license[0] || !isLifecycleActive(license[0])) return false;
    }
  } else if (app.organizationId !== agent.organizationId) {
    const license = await ctx.db.$queryRaw<LifecycleLike[]>`
      SELECT activated_at AS "activatedAt", revoked_at AS "revokedAt", expires_at AS "expiresAt"
      FROM agent_org_grants WHERE org_id = ${app.organizationId} AND agent_id = ${agent.id} FOR SHARE
    `;
    if (!license[0] || !isLifecycleActive(license[0])) return false;
  }
  // A licensed foreign Agent is permitted below for this App's read audience,
  // so the caller must explicitly administer this App as well as the Agent.
  try {
    await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
  } catch (error) {
    if (!isAuthorizationDenial(error)) throw error;
    return false;
  }
  return true;
}

/**
 * Gate an agent-memory ATTACHMENT on the capability it grants (#1349).
 *
 * `addMemoryToAgent` / `updateAgentMemoryRole` authorize the AGENT (its owner
 * or an org ADMIN). That is necessary and not sufficient: the row they write is
 * the sole knowledge-memory write cap (`cor:dmo:050:09`) and folds into every
 * App access map, so administering an agent used to be enough to hand that
 * agent's audience read — and with `read-write`, WRITE — over a memory the
 * caller could not touch themselves. `findings:installing-an-agent-is-a-read-grant`
 * states the rule this restores: **an attach operation's gate is a read gate on
 * the attached entity.**
 *
 * Two conditions, both required:
 *
 * 1. **Tenancy.** The memory must belong to the agent's own tenant (same org,
 *    or the same owning user for a spec-047 user-owned agent), be genuinely
 *    PUBLIC, or be the knowledge of an App where the Agent is live-installed
 *    and licensed. The latter two exceptions grant only `read`.
 *    Holger's ruling (2026-09-25) refuses a cross-tenant non-public attach even
 *    when the caller can read the memory, matching `attachMemoryToApp`'s
 *    `ORGANIZATION_MISMATCH` and the PUBLIC-only cross-org subscription rule.
 * 2. **Capability.** The caller must hold, on their own user principal, the
 *    capability being granted: the node-CONTENT read gate for `read`, and the
 *    memory write gate for `read-write`. The content gate (not the record gate)
 *    is the right one because an attach grants node content: an org member may
 *    open an app-scoped memory's RECORD while `getAccessibleMemoryIds`
 *    deliberately excludes its nodes (#653), and that gap is a same-tenant
 *    amplification a tenancy check alone cannot see.
 *
 * A caller who cannot read the memory at all is answered as if it did not exist
 * (#1316) — the refusal itself must not disclose that a guessable URN names a
 * real memory. A caller who CAN read it but may not grant what they asked for
 * gets an actionable `FORBIDDEN`, since existence is not a secret from them.
 */
export async function requireAgentMemoryGrant(
  ctx: Context,
  agent: { id: string; organizationId: string | null; ownerUserId: string | null; visibility: string | null },
  memory: {
    id: string;
    class: string;
    visibility: string | null;
    userId: string | null;
    ownerUserId: string | null;
    organizationId: string | null;
    appId: string | null;
    userMemoryOfAgentId: string | null;
  },
  // The RAW role argument (@copilot, PR #1357): it is parsed only AFTER the
  // concealment decision below, so a real-but-unreadable memory cannot be told
  // from a missing one by sending an invalid role (BAD_USER_INPUT vs
  // MEMORY_NOT_FOUND). Returns the parsed role for the caller to store.
  rawRole: string | null | undefined,
  ref: string,
): Promise<AgentMemoryRole> {
  // The role the caller asked for, defaulted as parseAgentMemoryRole does; it
  // only selects the same-App branch here and is validated after concealment.
  const asked = rawRole ?? 'read';
  // Also a KNOWN mutation survivor (harness #8), for #7's reason: `self` feeds
  // only the write check below, which no reachable caller depends on today.
  const self = userPrincipalOnly(ctx);
  const independentlyReadable = await holdsContentReadIndependently(ctx, memory.id);
  // The ONE route by which App reach may admit an attach (#1357).
  const sameAppRead = asked === 'read' && (await sameAppAttachAdmitted(ctx, agent, memory));
  const canRead = independentlyReadable || sameAppRead;
  // Existence-hiding first: every refusal below this line is addressed to
  // someone who already knows the memory exists.
  if (!canRead) throw new MemoryNotFoundError(ref);
  // Both attachment mutations use this gate, including re-role on a legacy
  // AgentMemoryItem. Check class AFTER concealment: an unreadable memory must
  // still answer like a miss, without revealing its class (#1349, #1101).
  if (memory.class === 'system') {
    throw new Error('Agent system memories can only be attached via systemMemoryId, not as a memory item');
  }
  // #1101: these classes have no App audience to grant. A personal share is
  // per-user, and a private memory is not shareable.
  if (memory.class === 'personal' || memory.class === 'private') {
    throw new GraphQLError(
      memory.class === 'private'
        ? 'A private-class memory cannot be attached to an agent — an attach grants the agent’s whole audience, and this class has no audience to grant. Private memories are never shareable either, not even by their owner. If this content needs to reach an agent, it has to live in a memory whose class has readers.'
        : 'A personal-class memory cannot be attached to an agent — an attach grants the agent’s whole audience, and this class has no audience to grant. Giving another person access is the owner’s to do, not an administrator’s: createMemoryShare is the mechanism and only the owner may call it, so if you are not the owner, ask them.',
      { extensions: { code: 'UNSUPPORTED_MEMORY_CLASS', memoryId: memory.id, memoryClass: memory.class } },
    );
  }
  // An APP-class memory is App-internal and never an agent's to hold, for any
  // caller (@copilot, PR #1357): its fold would break session isolation.
  if (memory.class === 'app') {
    throw new GraphQLError('An App-class memory belongs to its App and cannot be attached to an agent.', {
      extensions: { code: 'UNSUPPORTED_MEMORY_CLASS', memoryClass: memory.class },
    });
  }
  const role = parseAgentMemoryRole(rawRole);
  // Platform ADMIN can independently read App-scoped knowledge through its
  // global branch, but the row is still App-internal. Its grant must satisfy
  // the same live-install, App-admin and read-only rule as every other caller.
  if (memory.appId != null && memory.ownerUserId == null &&
      (memory.class === 'knowledge' || memory.class === 'group') && !sameAppRead) {
    throw new GraphQLError('App-scoped knowledge can only be attached read-only to an agent installed in its App.', {
      extensions: { code: 'FORBIDDEN', reason: 'APP_SCOPED_ATTACH' },
    });
  }

  const sameTenant =
    (agent.organizationId != null && agent.organizationId === memory.organizationId) ||
    (agent.ownerUserId != null && agent.ownerUserId === memory.ownerUserId);
  // The live same-App READ branch is an App-local audience even for a licensed
  // cross-tenant Agent. createMemoryInApp provisions that same link, so the
  // generic attach path must be able to restore it for an authorized caller.
  // A PUBLIC *column* is not a public AUDIENCE (@codex, PR #1357). An
  // app-scoped row is App-internal even when marked PUBLIC (#653), and a
  // personal/private or spec-047 user-owned row is owner-only regardless — so
  // the cross-tenant exception uses the SAME covered-set predicate
  // `cor:acl:080:03` uses, not the raw column. Otherwise a platform admin, or
  // the strict owner, could attach one to an agent in another organization and
  // expose it through that agent's App map.
  const genuinelyPublic =
    memory.visibility === 'PUBLIC' &&
    !isExcludedFromCoveredSet(memory) &&
    memory.ownerUserId == null;
  const publicRead = role === 'read' && genuinelyPublic;
  if (!sameTenant && !publicRead && !(role === 'read' && sameAppRead)) {
    throw new GraphQLError(
      genuinelyPublic
        ? 'A PUBLIC memory from another tenant can only be attached read-only — its audience is a read audience.'
        : "This memory belongs to another tenant; attach it to an agent in its own tenant, or share it with the agent's tenant first.",
      { extensions: { code: 'FORBIDDEN', reason: 'CROSS_TENANT_ATTACH' } },
    );
  }

  if (role === 'read-write') {
    // A PUBLIC agent's audience is EVERY org that installs it (@codex, PR
    // #1357). `cor:acl:080:03` already keeps such an agent's knowledge public;
    // the missing half is that PUBLIC is a READ audience, so a read-write item
    // on a public agent hands every installer the write cap. Measured before
    // this guard: a foreign App key, holding only an AgentOrgGrant on the
    // published agent, overwrote the publisher's node. Same-tenant ownership
    // does not make that safe — the audience, not the tenancy, is what widens.
    // The App-scoped grant rule above admits read only, including for platform
    // admins. Legacy writable App-scoped links remain outside the PUBLIC
    // covered set, but this mutation cannot create or escalate one.
    // Only for a COVERED memory, exactly as publication judges it (@codex,
    // PR #1357): an App-scoped or strict-owner memory is not part of any
    // public surface — the fold confines it to its own App — so
    // assertAgentPublicAllowed ignores such links. Without the same exemption
    // here, attach-then-publish succeeded (reachable by a platform admin, who
    // can read and write an App-scoped memory) while publish-then-attach was
    // refused: one invariant, two answers depending on order.
    if (agent.visibility === 'PUBLIC' && !isExcludedFromCoveredSet(memory)) {
      throw new GraphQLError(
        'A PUBLIC agent may hold read-only knowledge only — publishing it would grant write access to every organization that installs it.',
        { extensions: { code: 'FORBIDDEN', reason: 'PUBLIC_AGENT_READ_WRITE' } },
      );
    }
    // Defense in depth, and a KNOWN mutation survivor (harness #7): no caller
    // constructible today reaches this check without already holding write.
    // Same tenant, everyone past the agent gate (an org ADMIN, or a user-owned
    // agent's owner) can write what they can read — and App-scoped knowledge,
    // which no user writes, is refused by the read gate above (the same-App
    // branch admits `read` only). Cross tenant, the tenancy rule and the
    // PUBLIC-is-read-only rule refuse first. It stays because those facts live
    // in other files, and this is the check that states the actual invariant.
    try {
      await requireMemoryWriteAccess(self, memory.id);
    } catch (error) {
      if (!isAuthorizationDenial(error)) throw error;
      throw new GraphQLError(
        'Attaching a memory read-write grants the agent write access you do not hold on it yourself.',
        { extensions: { code: 'FORBIDDEN', reason: 'INSUFFICIENT_MEMORY_CAPABILITY' } },
      );
    }
  }
  // cor:acl:080:03 — both fresh attach and legacy-row re-role can leave an
  // active item on a PUBLIC agent. Judge the locked agent and memory together
  // here so neither door can retain non-PUBLIC covered knowledge (#1357).
  await assertLinkAllowedForPublicAgent(agent.visibility, memory);
  return role;
}

/**
 * The record gate by id: may this caller open the memory's record? A
 * soft-deleted or absent memory is never openable. Reads EVERY field
 * `canReadMemoryRecord` requires — omitting one can fail it open (#1104).
 */
export async function canOpenMemoryRecordById(ctx: Context, memoryId: string): Promise<boolean> {
  const record = await ctx.db.memory.findUnique({
    where: { id: memoryId },
    select: {
      id: true,
      class: true,
      userId: true,
      ownerUserId: true,
      organizationId: true,
      appId: true,
      userMemoryOfAgentId: true,
      deletedAt: true,
    },
  });
  return !!record && !record.deletedAt && (await canReadMemoryRecord(ctx, record));
}

/**
 * Resolve a memory ref that a mutation will WRITE, concealing it at the moment
 * it resolves (#1381): a memory this caller can neither write nor open answers
 * `MemoryNotFoundError(ref)`, exactly as `resolveMemoryRef` answers a miss.
 *
 * For surfaces that resolve SEVERAL refs before authorizing any of them
 * (`moveNode`, `mergeMemories`, …). Wrapping only the later write gate is not
 * enough there: a missing ref refuses at resolution, so the ORDER in which the
 * refs refuse becomes the oracle — an unreadable source paired with a missing
 * destination answered differently from a missing source.
 *
 * A caller who may open the record gets the memory back and meets the
 * surface's own write denial later, in the same order as before; a writer is
 * never narrowed. Malformed refs and faults propagate.
 */
export async function resolveMemoryRefForWrite(ctx: Context, ref: string): Promise<{ id: string }> {
  const { id } = await resolveMemoryRef(ctx.db, ref);
  if (await isMemoryHiddenForWrite(ctx, id, 'record')) throw new MemoryNotFoundError(ref);
  return { id };
}

/**
 * True when this caller can neither write the memory nor read it — the only
 * case an existence-concealing surface may answer as "missing" (#1381).
 * `gate` picks the read half: `'record'` for a memory-addressed surface,
 * `'node'` (the node-content gate `Query.node` uses) for a node-addressed one.
 * Only an ordinary denial counts as "cannot write"; any other error propagates.
 */
export async function isMemoryHiddenForWrite(
  ctx: Context,
  memoryId: string,
  gate: 'record' | 'node',
): Promise<boolean> {
  try {
    await requireMemoryWriteAccess(ctx, memoryId);
    return false;
  } catch (error) {
    if (!isAuthorizationDenial(error)) throw error;
  }
  return gate === 'node'
    ? !(await isMemoryReadableCached(ctx, memoryId))
    : !(await canOpenMemoryRecordById(ctx, memoryId));
}

/**
 * The NODE-addressed twin of {@link concealUnreadableDenial} (#1316): run a
 * node-targeted mutation's existing authorization, and when it denies a caller
 * who cannot read the node's memory, throw `missing()` — the surface's own
 * missing-node error, since each spells that miss its own way (a
 * `NODE_NOT_FOUND` GraphQLError, a bare `NodeNotFoundError`, …) and only an
 * identical answer conceals anything.
 *
 * These surfaces resolve the node BEFORE authorizing, so without this a caller
 * who cannot read the memory learned three things by probing: the memory
 * exists, the node exists, and (by a missing loc answering differently) that
 * the loc is free.
 *
 * The classifier is the node-content gate (`isMemoryReadableCached`), NOT the
 * record gate: a caller who may open an app/system memory's RECORD but not its
 * nodes must not learn which nodes exist in it — the same line `Query.node`
 * draws. Ordinary denials only ({@link isAuthorizationDenial}); every other
 * error and every success passes through, so no permitted caller is narrowed.
 *
 * `authorize` must perform authorization ONLY — no writes.
 */
export async function concealUnreadableNodeDenial(
  ctx: Context,
  memoryId: string,
  missing: () => Error,
  authorize: () => Promise<void>,
): Promise<void> {
  try {
    await authorize();
  } catch (error) {
    if (!isAuthorizationDenial(error)) throw error;
    if (await isMemoryReadableCached(ctx, memoryId)) throw error;
    throw missing();
  }
}

/**
 * The typed `NODE_NOT_FOUND` answer the node-addressed mutations give for a
 * ref that resolves to nothing — shared so a concealed denial is byte-identical
 * to it (#1316).
 */
export function nodeNotFoundError(ref: string): GraphQLError {
  return new GraphQLError(`Node not found: "${ref}"`, {
    extensions: { code: 'NODE_NOT_FOUND', ref },
  });
}

/** Per-list read snapshots; never shared with mutations or another request. */
type MemoryRecordReadBatch = {
  memberOrgIds?: Promise<string[]>;
  accessibleIds?: Promise<string[] | null>;
};

/** Gate a record list without repeating membership and access-set queries per row. */
export async function filterReadableMemoryRecords<T extends Parameters<typeof canReadMemoryRecord>[1]>(
  ctx: Context,
  rows: T[],
): Promise<T[]> {
  const batch: MemoryRecordReadBatch = {};
  const readable = await Promise.all(rows.map(row => canReadMemoryRecord(ctx, row, batch)));
  return rows.filter((_, index) => readable[index]);
}

/**
 * The RECORD-level memory read gate — "may this caller open this memory's
 * record (its scalars: name, description, data)?", as distinct from
 * `isMemoryReadableCached` above, which answers "may they read its NODES?".
 *
 * The two are deliberately different (see that function's note): the record
 * gate keeps an org-member fast-path for ordinary knowledge memory RECORDS which
 * `getOrgReadableMemoryIds` excludes from the node-content set. App-class
 * records use their shape-aware content audience; system records use the
 * installed/licensed Agent or manager audience (#1807).
 * Using the node gate for a record-level question silently drops memories the
 * caller can open directly via `Query.memory` — the #759 review finding
 * (Codex P1 / Copilot on PR #846).
 *
 * Extracted from `Query.memory` so the two callers cannot drift (AGENTS.md:
 * "reuse the shared access gate; a bespoke per-resolver gate drifts"). Order is
 * load-bearing:
 *   1. personal/private → strict owner, or a MemoryShare grantee (#778).
 *   2. system → shared Agent/App read grants, or the scoped content gate.
 *   3. spec 047 user-owned → owner, or a Worker row's current holder under
 *      cor:acl:010:01, BEFORE the platform-admin path (#676).
 *   4. app class → the shared node gate (team, Worker, session audiences).
 *   5. other non-strict classes → platform ADMIN/OWNER, a live org membership,
 *      or whatever the shared node gate already admits (PUBLIC, subscription).
 */
export async function canReadMemoryRecord(
  ctx: Context,
  // EVERY field is required, and none of it is style (#1104, PR #1105 review —
  // @copilot). This gate reads all of them, and an `undefined` from a narrowly
  // `select`ed row does not fail loudly in any of the six cases — it changes the
  // ANSWER, and in three of them it changes it OPEN:
  //
  //   - `ownerUserId` — `memory.ownerUserId != null` is LOOSE, so `undefined`
  //     skips the spec-047 strict-owner branch entirely. The next line is the
  //     platform ADMIN/OWNER short-circuit, so a platform admin reads another
  //     user's user-owned memory — the exact bypass #676 put that branch ABOVE
  //     the admin path to prevent. Fails OPEN, for the admin alone: an ordinary
  //     org member is unaffected, because `chk_memory_owner_xor` makes a
  //     user-owned row's `organizationId` NULL, so the membership branch below
  //     is skipped and the `getAccessibleMemoryIds` fallback re-applies
  //     ownership from the stored row. (Scope corrected by @codex on PR #1105 —
  //     the first version of this comment named every org member.)
  //   - `organizationId` — `granteeShareAccess` compares it to `null` (so
  //     `undefined` misses the free-standing short-circuit) and then hands it to
  //     Prisma, which **silently drops an `undefined` where-filter**. The
  //     org-membership check becomes "is this caller a member of ANY org", so a
  //     grantee who is a member of some OTHER org is admitted to an org-owned
  //     personal memory. Fails OPEN, and this is the same Prisma behaviour
  //     `getOrgReadableMemoryIds` carries an explicit guard against. (On a
  //     free-standing row it fails CLOSED instead — a grantee in no org at all
  //     is refused a memory the share alone should admit.)
  //   - `class` — decides which branch runs at all.
  //   - `userMemoryOfAgentId` — `granteeShareAccess` reads it; `undefined !==
  //     null` is true, so EVERY share grantee is silently refused. Fails closed.
  //   - `userId` / `appId` — the owner and AppMember branches; both fail closed.
  //
  // Requiring them is what makes a wrong call a COMPILE error instead of a
  // quiet re-answer, which is why `granteeShareAccess` below is now called
  // without the `as never` that was hiding exactly this.
  memory: {
    id: string;
    class: string;
    userId: string | null;
    ownerUserId: string | null;
    organizationId: string | null;
    appId: string | null;
    userMemoryOfAgentId: string | null;
  },
  batch?: MemoryRecordReadBatch,
): Promise<boolean> {
  // A full set and an indexed point read use the same shared predicate. Only
  // list filtering opts into a shared snapshot; point reads stay fresh.
  const accessible = () => batch
    ? (batch.accessibleIds ??= getAccessibleMemoryIds(ctx))
    : getAccessibleMemoryIds(ctx, memory.id);
  if (memory.class === 'personal' || memory.class === 'private') {
    // Impersonation: personal-class records are invisible even though the
    // TARGET owns them — the shared-org scope excludes all identity-scoped
    // resources (the target-as-owner check below would otherwise admit them).
    if (ctx.impersonation) return false;
    if (memory.class === 'private' && isRunPrincipal(ctx) && !await canReadMemory(ctx.db, ctx, memory.id)) return false;
    if (isStrictOwner(ctx, memory.userId)) return true;
    // No `as never`: the cast is what let a caller omit the fields this reads.
    if (ctx.userId && (await granteeShareAccess(ctx.db, ctx.userId, memory))) return true;
    return false;
  }
  // System records follow the installed/licensed Agent or manager audience,
  // never the record-only org-member shortcut (#1807).
  if (memory.class === 'system') {
    // #2064 §10: a user's own session is NOT a different principal for an App's INSTALL
    // memory. Its record rights (a manager's, R45) are the user's, and binding a session
    // of some other App must not drop them. A pure App key (no user), a run principal and
    // an impersonation keep the hard-isolated content set below.
    if (ctx.sessionId && ctx.userId && !ctx.impersonation && !isRunPrincipal(ctx)
      && await ctx.db.memory.count({ where: { id: memory.id, isInstallMemory: true } }) > 0) {
      return (await systemMemoryReadGrants(ctx.db, ctx, memory.id)).length > 0;
    }
    if (ctx.sessionId || ctx.impersonation || isRunPrincipal(ctx) || !ctx.userId) {
      const ids = await accessible();
      return ids === null || ids.includes(memory.id);
    }
    return (await systemMemoryReadGrants(ctx.db, ctx, memory.id)).length > 0;
  }
  if (memory.ownerUserId != null) {
    // Impersonation: user-owned (spec 047) records are identity-scoped —
    // invisible for the same reason as personal/private above.
    if (ctx.impersonation) return false;
    if (ctx.userId && memory.ownerUserId === ctx.userId) return true;
    // #1787 (cor:dmo:050:13): a platform admin may read a user-owned Agent's
    // system memory — its definition — as part of managing the Agent. This is
    // the ONLY user-owned memory a platform admin reads: every other
    // user-owned class stays owner-only here (the wider #1734 bypass is a
    // separate, unbuilt change), personal/private were handled above, and the
    // definition is read-only (its editor is the agent-ownership surface).
    if (
      memory.class === 'system' && isPlatformAdmin(ctx) &&
      await isUserOwnedAgentDefinition(ctx.db, memory.id)
    ) return true;
    // A user-owned App's Worker row is also visible to its current holder.
    // The shared content gate checks the casting and excludes team/session rows.
    if (memory.class !== 'app') return false;
    const ids = await accessible();
    return ids !== null && ids.includes(memory.id);
  }
  if (ctx.appId && ctx.sessionId && !ctx.userId) {
    const ids = await accessible();
    return ids === null || ids.includes(memory.id);
  }
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return true;
  // All app-class shapes use their node-content audience. The historical
  // record fast paths below are wider: an org READER or AppMember could open
  // a Worker/session memory record even when their nodes were concealed.
  if (memory.class === 'app') {
    const ids = await accessible();
    return ids === null || ids.includes(memory.id);
  }
  // findFirst (not findUnique) so a REVOKED (soft-deleted) membership no longer
  // grants access. A user-owned memory (org NULL) has no membership fast-path
  // and was already returned above. Under impersonation the fast-path only
  // applies inside the session's shared org.
  // #1208 / cor:acl:010:01: a GROUP record never takes the org-member fast
  // path — an org member without a MemoryMember row must fall through to the
  // shared gate below, which admits group only through memberships. (A
  // MemoryMember with no org role was already served by that same fallback.)
  const member =
    ctx.userId &&
    memory.organizationId &&
    memory.class !== 'group' && memory.class !== 'system' &&
    (!ctx.impersonation || ctx.impersonation.orgId === memory.organizationId)
      ? batch
        ? (await (batch.memberOrgIds ??= getMemberOrgIds(ctx.db, ctx.userId, ctx.impersonation?.orgId))).includes(memory.organizationId)
        : await ctx.db.orgMember.findFirst({
          where: { organizationId: memory.organizationId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
        })
      : null;
  if (member) return true;
  // #982 review (Codex P1): an App-scoped memory's record is readable by the
  // App's OWN members — the explicitly supported external/B2C shape where an
  // AppMember is NOT an org member. Such a member participates in the App's
  // shared memory (the team-chat and worklog gates both admit them, and the
  // MCP getMemoryAccess unions their App-derived reach), so refusing them the
  // RECORD here left App.sharedMemory null for exactly the CLI users it
  // exists for, and Query.memory out of step with effectiveAccess. AppMember
  // rows hard-delete on removal (no deletedAt column), so existence is
  // liveness. Identity-scoped — never via impersonation (#876 class).
  if (ctx.userId && memory.appId && !ctx.impersonation) {
    const appMember = await ctx.db.appMember.findUnique({
      where: { appId_userId: { appId: memory.appId, userId: ctx.userId } },
      select: { userId: true },
    });
    if (appMember) return true;
  }
  // Scope the shared gate to THIS memory so it stays an indexed point-read.
  const accessibleIds = await accessible();
  return accessibleIds === null || accessibleIds.includes(memory.id);
}

/**
 * #2193 — a memory's RECORD as `Query.memory` would answer it to this caller:
 * the same full-row load, the same deleted check and the same
 * {@link canReadMemoryRecord}, so impersonation, App-key, run and session
 * scope match it by construction. Unreadable, deleted and missing are all
 * null (cor:api:140:03).
 *
 * For a nested entity field such as `Node.memory` (cor:acl:110): the parent
 * that admitted the node authorized the NODE, by its own rule, and never the
 * memory record. Memoized per memory under a `*Cache` key, so a node list
 * loads and gates each distinct memory once and `withoutRequestCaches` strips
 * the memo like the others.
 */
export function loadReadableMemoryRecord(ctx: Context, memoryId: string): Promise<unknown | null> {
  const cache = (ctx.memoryRecordCache ??= new Map<string, Promise<unknown | null>>());
  let pending = cache.get(memoryId);
  if (!pending) {
    pending = (async () => {
      const memory = await ctx.db.memory.findUnique({ where: { id: memoryId }, include: MEMORY_INCLUDE });
      if (!memory || memory.deletedAt) return null;
      return (await canReadMemoryRecord(ctx, memory)) ? memory : null;
    })();
    cache.set(memoryId, pending);
  }
  return pending;
}

// The ordering moved to src/lib/auth/orgRole.ts (#1196): this module imports
// from src/mcp/access-control.ts, so the MCP layer could not import the
// threshold back without a cycle and had to restate it. Re-exported so existing
// importers are unchanged (the `mentionTokenOf` precedent).
export { ROLE_ORDER };

export function requireRole(ctx: Context, required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER') {
  const highest = ctx.roles ? Math.max(...ctx.roles.map((r) => ROLE_ORDER[r] ?? -1)) : -1;
  if (highest < ROLE_ORDER[required]) throw authorizationDenied();
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
    throw authorizationDenied();
  }
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;
  if (!ctx.userId) throw authorizationDenied();
  // findFirst (not findUnique on the composite PK) so a REVOKED (soft-deleted)
  // membership no longer authorizes — matches getMemberOrgIds / resolveOrgScope
  // and the memory(ref) resolver's own membership check (PR-475 review, Codex
  // P1: a removed member who still knew an agent/app ref could read it).
  const member = await ctx.db.orgMember.findFirst({
    where: { organizationId: orgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
  });
  if (!member || (ROLE_ORDER[member.role] ?? -1) < ROLE_ORDER[required]) {
    throw authorizationDenied();
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
 *   - Platform ADMIN/OWNER: bypass only for org-owned entities. Memory
 *     personal/private strict ownership is handled by
 *     `requireMemoryManageAccess`, not by this tenant-only helper.
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
    if (ctx.impersonation) throw authorizationDenied();
    if (ctx.userId && ctx.userId === entity.ownerUserId) return;
    throw authorizationDenied();
  }
  if (isPlatformAdmin(ctx)) return;
  if (entity.organizationId !== null) {
    await requireOrgRole(ctx, entity.organizationId, required);
    return;
  }
  throw authorizationDenied();
}

/**
 * The Agent-management gate (#1787, cor:dmo:050:13 — Holger, team chat #8895:
 * "we have to be able to shut down a rogue agent"). Whatever an org's
 * ADMIN/OWNER may do to an org-owned Agent, a platform ADMIN/OWNER may do to
 * a USER-owned one: read it (definition and prompt), update it, delete it.
 * One shared predicate every Agent caller of {@link requireOwnerOrOrgRole}
 * goes through — the arm is not re-derived per resolver. Everything else
 * keeps the tenant gate's shape: the owner and org arms unchanged,
 * org-owned behavior unchanged (platform admins already pass
 * requireOrgRole's bypass), and impersonation gains nothing (identity-scoped
 * like the owner arm it extends).
 *
 * NOT routed through here: the decrypted AI-config reads (`agentAIConfig`,
 * `resolveAIConfig`'s user-owned arm) — a user's own provider key on their
 * own Agent is a user-owned credential and stays owner-only (Holger #8075,
 * the same split Ada ruled for Apps on #1734 at #9051: manage yes, read the
 * key no). Set/clear of the config IS management and uses this gate.
 */
export async function requireAgentAccess(
  ctx: Context,
  agent: { organizationId: string | null; ownerUserId: string | null },
  required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER',
): Promise<void> {
  if (agent.ownerUserId !== null && !ctx.impersonation && isPlatformAdmin(ctx)) return;
  return requireOwnerOrOrgRole(ctx, agent, required);
}

/**
 * #1944 — resolve an Agent ref AND gate the Agent for reading, with a denial
 * answered exactly like an absent Agent: the same `AgentNotFoundError(ref)`,
 * so the same code, message and extensions on the wire. The Agent-side
 * sibling of #1939's `resolveReadableWorkerRef`.
 *
 * Resolving first and gating second is safe only if the two refusals are
 * indistinguishable. Before this, each Agent surface gated the resolved row
 * on its own and refused FORBIDDEN, so an outsider could guess
 * `hrn:agent:<org>:<slug>` and read existence off the code (Cameron's repro).
 *
 * The read gate is `Query.agent`'s: a PUBLIC Agent is readable by anyone
 * (#551, its existence is marketplace-public), otherwise READER on the Agent.
 * What a caller gets past it, a surface may refuse however it likes: a reader
 * already knows the Agent exists, so a management FORBIDDEN tells them
 * nothing new. `Query.agent` keeps answering an absent Agent with null, and
 * so answers a denied one with null too.
 *
 * NARROW catch, the #1019 convention: only the gate's expected FORBIDDEN
 * collapses. A database failure inside the membership lookup propagates,
 * because reporting an outage as a missing Agent misleads exactly the caller
 * who needs the truth. An under-qualified ref still throws URN_NOT_QUALIFIED
 * from the resolve: that is the caller's input, not a fact about the Agent.
 */
export async function resolveReadableAgentRef(ctx: Context, ref: string): Promise<Agent> {
  const { id } = await resolveAgentRef(ctx.db, ref);
  const agent = await ctx.db.agent.findUnique({ where: { id } });
  await requireReadableAgent(ctx, agent, ref);
  return agent!;
}

/**
 * The gate half of {@link resolveReadableAgentRef}, on a row the caller has
 * already read: a missing or retired row, or one the caller can't read (not
 * PUBLIC and no READER), throws `AgentNotFoundError(ref)`, by the same narrow
 * catch. For a surface that must serve a row read with its own shape (e.g.
 * `Query.agent`'s includes): gate THAT row, the one actually returned, never
 * an earlier read of it (Atilla's P2 on #1950: a visibility flip between two
 * reads would otherwise serve a row nobody authorized).
 */
export async function requireReadableAgent(
  ctx: Context,
  agent: Pick<Agent, 'visibility' | 'deletedAt' | 'organizationId' | 'ownerUserId'> | null,
  ref: string,
): Promise<void> {
  if (!agent || agent.deletedAt) throw new AgentNotFoundError(ref);
  if (agent.visibility === 'PUBLIC') return;
  try {
    await requireAgentAccess(ctx, agent, 'READER');
  } catch (e) {
    if (!(e instanceof GraphQLError && e.extensions?.code === 'FORBIDDEN')) throw e;
    throw new AgentNotFoundError(ref);
  }
}

/**
 * #1946 — for the agentUrn-addressed asset operations (beginAssetUpload,
 * agentAssets, setAgentAssetUploadEnabled): run the shared Agent read gate
 * BEFORE the operation, which otherwise refuses on things derived from the
 * Agent (its App, its tool gate, its org's admins) and so tells an existing
 * Agent from an absent one. An Agent the caller can't read throws
 * `notFound()`, the operation's OWN absent-Agent error, so both read the
 * same. A ref that doesn't resolve is left to the operation, which already
 * answers it (or surfaces a malformed one) its own way.
 */
export async function requireReadableAgentForAssetOp(ctx: Context, agentRef: string, notFound: () => Error): Promise<void> {
  let id: string;
  try {
    ({ id } = await resolveAgentRef(ctx.db, agentRef));
  } catch (e) {
    // NARROW (Atilla's P2 on #1955, the #1019 convention): only a ref that
    // names nothing, or a malformed one, is left to the op, which answers it
    // its own way. Anything else (an outage) propagates, so the op never runs
    // with this gate skipped.
    if (e instanceof AgentNotFoundError || e instanceof UrnNotQualifiedError || e instanceof AmbiguousLegacyUrnError) return;
    throw e;
  }
  try {
    await requireReadableAgent(ctx, await ctx.db.agent.findUnique({ where: { id } }), agentRef);
  } catch (e) {
    if (e instanceof AgentNotFoundError) throw notFound();
    throw e;
  }
}

/**
 * #1944 — {@link resolveReadableAgentRef} for the `agentRef`/`agentId` arg
 * pair `resolveRefArg` takes: an Agent the caller can't read answers with
 * that helper's own not-found envelope (`refArgNotFoundError`), exactly as an
 * absent one does there.
 */
export async function resolveReadableAgentRefArg(
  ctx: Context,
  a: { ref?: string | null; id?: string | null },
): Promise<Agent> {
  const id = await resolveAgentRefArg(ctx.db, a);
  try {
    return await resolveReadableAgentRef(ctx, id);
  } catch (e) {
    if (!(e instanceof AgentNotFoundError)) throw e;
    throw refArgNotFoundError('agent', chosenRefArg(a)!);
  }
}

/**
 * Manage a Memory's settings and operational controls. Personal/private
 * memories have a strict owner in `userId` (cor:acl:010:02), independent of
 * the tenant owner in `ownerUserId`; every other class uses the tenant gate.
 */
export async function requireMemoryManageAccess(
  ctx: Context,
  memory: {
    class: string;
    userId: string | null;
    organizationId: string | null;
    ownerUserId: string | null;
  },
  required: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER' = 'ADMIN',
): Promise<void> {
  if (memory.class === 'personal' || memory.class === 'private') {
    if (!ctx.impersonation && ctx.userId && memory.userId === ctx.userId) return;
    throw authorizationDenied();
  }
  await requireOwnerOrOrgRole(ctx, memory, required);
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
 * The `AppMember.role` that MANAGES a user-owned App: "every member with the
 * owner role" has the App owner's rights on it (cor:dmo:050:12, Holger
 * #7790/#8130), except the AI configuration, which only the owning user holds.
 */
export const APP_OWNER_MEMBER_ROLE = 'owner';

/**
 * `where` over Apps: user-owned Apps on which `userId` holds a CURRENT
 * owner-role membership (#2089). One predicate for the list, the batch filter
 * and the point reads, so they cannot drift. AppMember has no `deletedAt`:
 * removal deletes the row and demotion rewrites `role`, so row existence plus
 * the exact role IS the current membership.
 */
export function userOwnedAppOwnerMemberWhere(userId: string): Prisma.AppWhereInput {
  return {
    ownerUserId: { not: null },
    members: { some: { userId, role: APP_OWNER_MEMBER_ROLE } },
  };
}

/**
 * Is the caller a real, non-impersonated user holding a current owner-role
 * AppMember row on this live USER-owned App? (#2089.) A point query on the
 * deciding read, never a cached or token-carried role: a demotion or removal
 * committed before this statement refuses; a read whose deciding statement ran
 * earlier may complete as an already authorized read. Grants READ reach of the
 * App record only, no write or credential authority and no child fields (see
 * {@link appChildrenWithheld}).
 */
export async function isUserOwnedAppOwnerMember(
  ctx: Context,
  app: { id: string; ownerUserId: string | null; deletedAt?: Date | null },
): Promise<boolean> {
  // Cheap short-circuits only; neither of them decides admission. The row the
  // caller holds may have been loaded before a deleteApp committed.
  if (app.ownerUserId === null || app.deletedAt) return false;
  if (ctx.impersonation || !ctx.userId) return false;
  // ONE statement decides live-App AND current-membership together (the join
  // reads the App row and the AppMember row in the same snapshot), so an App
  // deleted after it was loaded is refused here rather than trusted from the
  // caller's earlier read.
  const member = await ctx.db.appMember.findFirst({
    where: {
      appId: app.id,
      userId: ctx.userId,
      role: APP_OWNER_MEMBER_ROLE,
      app: { deletedAt: null, ownerUserId: { not: null } },
    },
    select: { appId: true },
  });
  return member !== null;
}

/**
 * The App READ gate (#2089): {@link requireOwnerOrOrgRole} plus exactly one new
 * arm, an owner-role member of a user-owned App. App-specific on purpose: the
 * generic helper also guards Agents, memories and the App's AI credentials,
 * which must stay owner-only.
 */
export async function requireAppRead(
  ctx: Context,
  app: { id: string; organizationId: string | null; ownerUserId: string | null; deletedAt?: Date | null },
): Promise<void> {
  if (app.ownerUserId !== null && ctx.userId !== app.ownerUserId && (await isUserOwnedAppOwnerMember(ctx, app))) return;
  return requireOwnerOrOrgRole(ctx, app, 'READER');
}

/** Boolean form of {@link requireAppRead}. Mirrors {@link isOwnerOrOrgMember} plus the new arm. */
export async function canReadApp(
  ctx: Context,
  app: { id: string; organizationId: string | null; ownerUserId: string | null; deletedAt?: Date | null },
): Promise<boolean> {
  return (await isOwnerOrOrgMember(ctx, app)) || (await isUserOwnedAppOwnerMember(ctx, app));
}

/**
 * Is the App's roster / install / AI-config projection WITHHELD from this
 * caller? (#2089.) Reaching a user-owned App's parent record is not a grant of
 * these children: only the owning user (non-impersonated) and the App's own
 * pure App key keep them, as before. Anyone else who reaches the record gets
 * `null` = "withheld", never `[]`, `0` or `false`. Org-owned Apps are
 * unchanged. Every affected field calls this BEFORE using a prefetched
 * relation or the fallback load.
 */
export function appChildrenWithheld(
  ctx: Context,
  app: { id: string; ownerUserId: string | null },
): boolean {
  if (app.ownerUserId === null) return false;
  if (!ctx.impersonation && ctx.userId && ctx.userId === app.ownerUserId) return false;
  if (!ctx.userId && ctx.appId === app.id) return false;
  return true;
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
    where: { organizationId: orgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
  });
  return !!member;
}

/**
 * App-participation predicate — "may this USER act as a member of this App?"
 * (#939's team-chat gate, generalized in #943 so `startSession`'s `appRef`
 * gate is the SAME predicate rather than a second copy of it).
 *
 * Admits: an AppMember at ANY role (of a user-owned App too, #1764) (participation follows the host memory's
 * audience — `cor:acl:030:01`, so a 'reader' member counts), an org member
 * with CONTRIBUTOR+ on the App's owning org (parity with the persona-mint
 * gate's org branch, and platform ADMIN/OWNER via `requireOrgRole`), or the
 * owner of a user-owned App (whose AppMembers are covered by the first arm).
 *
 * Under IMPERSONATION this narrows to the session's ONE shared org (#1094):
 * every arm answers about the TARGET, so an unbounded one would admit an App in
 * an org the support session was never scoped to. Same bound `requireOrgRole`
 * and `isOrgMemberOrAdmin` apply; the owner arm's outright denial is that rule's
 * degenerate case, since a user-owned App has no org to match.
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
    // spec 047 + cor:acl:010:01 (Holger "A", #8151/#8155, #1764): a user-owned App admits its owner and every
    // AppMember at any role, and nobody else. The App has no org, so no org arm exists and no platform-admin arm either
    // (findings:org-xor-owner-null-comparison-bypass — branch on the ownership CLASS first; for two different users'
    // entities BOTH `organizationId`s are NULL, so an org comparison would read `null !== null` and admit exactly the
    // cross-tenant case). Identity-scoped, so never via impersonation (isOwnerOrOrgMember's rule; the team-chat caller
    // already denies org-less Apps under impersonation — this keeps the predicate safe for any future caller that
    // doesn't). User-owned MEMORIES and AGENTS stay strictly owner-only; this is the App's participation alone.
    if (ctx.impersonation) return false;
    if (ctx.userId === app.ownerUserId) return true;
    const member = await ctx.db.appMember.findUnique({
      where: { appId_userId: { appId: app.id, userId: ctx.userId } },
      select: { userId: true },
    });
    return member !== null;
  }
  // #1094 — impersonation NARROWS this predicate to the session's ONE shared
  // org, stated once here rather than per arm. `ctx.userId` is the TARGET under
  // impersonation, so the AppMember lookup below would otherwise answer a
  // question about the target's memberships ANYWHERE — admitting an App in an
  // org the support session was never scoped to. Fifth instance of the #876
  // class (`ctx.userId = target` fails open against identity-keyed predicates),
  // and the first one inside a shared predicate rather than a resolver, which
  // is why `impersonationSweep.test.ts` — a case per resolver MODULE — could
  // not see it.
  //
  // Bounded, not denied, and that is the neighbours' rule rather than a choice
  // made here: `requireOrgRole` and `isOrgMemberOrAdmin` both already read
  // "under impersonation only the shared org may admit". A blanket
  // `if (ctx.impersonation) return false` would have made this arm the only one
  // of the three saying something different, and would have cost an impersonated
  // admin the in-scope team chat and worklog they can legitimately support.
  //
  // The owner arm above denies outright for the SAME rule, not a different one:
  // a user-owned App has no org, so it can never satisfy this bound.
  if (ctx.impersonation && app.organizationId !== ctx.impersonation.orgId) return false;
  if (app.organizationId !== null) {
    const liveOrg = await ctx.db.organization.findFirst({
      where: { id: app.organizationId, deletedAt: null }, select: { id: true },
    });
    if (!liveOrg) return false;
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
      // requireOrgRole signals denial with a FORBIDDEN GraphQLError whose message
      // is 'Forbidden' (#1493), which this match still catches; anything
      // else (a DB failure inside the membership lookup) must propagate rather
      // than read as "not a member" (review:narrow-catch-blocks — the
      // team-chat original swallowed everything here).
      if (e instanceof Error && e.message === 'Forbidden') return false;
      throw e;
    }
  }
  return false;
}

/**
 * Column narrowing for the App's TEAM SPACE — the app-class memory hosting
 * `chats:team` and the worklog. NOT sufficient on its own: see
 * {@link resolveAppTeamSpaceMemoryIds}, which is the surface callers want.
 *
 * `class='app'` is a tenancy bucket shared by several row shapes, not one
 * ([[findings:app-class-is-four-row-shapes]], #1003), so a bare
 * `appId + class:'app'` predicate is always wrong:
 *
 * - `workerOf: { none: {} }` excludes a Worker's casting-scoped working memory
 *   (#974), whose App-wide readability is an open policy question owned by
 *   `maySeeWorkerInternals` and must not be settled by accident.
 * - `userMemoryOfAgentId: null` excludes SESSION memories, reachable only
 *   through a session binding. Admitting them on a read gate hands every App
 *   member every anonymous end-user session — the #934/#967 isolation breach.
 *
 * What these columns CANNOT do is separate a LEGACY (pre-#723) team space from
 * a name-addressable `createMemoryInApp` memory: both have every key null. That
 * is the URN matcher's job, and the reason this is not exported alone.
 */
function appTeamSpaceColumnFilter(appId: string) {
  return {
    appId,
    class: 'app' as const,
    deletedAt: null,
    workerOf: { none: {} },
    userMemoryOfAgentId: null,
  };
}

/**
 * The memory ids that ARE this App's team space — the identity question.
 *
 * Two kinds qualify, and both must, which is why this is a resolver rather than
 * a `where` object:
 *
 * 1. **Adopted** rows, carrying the #723 key `sharedMemoryOfAgentId`.
 * 2. **Legacy** (pre-#723) rows, whose key is null because identity then lived
 *    in the urn string `<app-urn>:<agent-slug>:shared`.
 *
 * Legacy rows are column-INDISTINGUISHABLE from name-addressable
 * `createMemoryInApp(memoryClass: 'app')` memories, which also carry every key
 * null. Getting this wrong fails in both directions and neither is loud:
 *
 * - Requiring the key drops legacy spaces — `App.sharedMemory` reports none and
 *   the worklog locator finds an empty ledger for an App the adoption sweep has
 *   not reached (PR #1066 review, Copilot: a regression, since both admitted
 *   legacy before).
 * - Dropping the key admits named memories, so an older one wins an
 *   oldest-first pick and is presented as the team space (same PR, Codex).
 *
 * So legacy rows are matched by URN through {@link memoryCarriesLegacyKeyFor} —
 * by PARSED-ATOM EQUALITY, never a SQL pattern. A slug may legally contain `_`,
 * a single-character `LIKE` wildcard, and Prisma's `endsWith`/`contains`
 * compile to `LIKE`, so a pattern would let `sales_bot` adopt `salesXbot`'s
 * space. That module is the one definition the three adoption paths share; this
 * is the fourth reader and deliberately not a fifth copy.
 *
 * Candidates are narrowed by indexed columns first and compared in memory — an
 * App holds a handful of app-class rows, so the scan is trivial.
 *
 * NOTE this is TENANCY, not authorization: it answers "which memory is the team
 * space", never "may the caller read it". Pair with {@link isAppParticipant}.
 * The MCP access map deliberately does NOT use this — see the comment at
 * `getAppTeamSpaceAccess`, which answers the broader ACCESS question.
 */
export async function resolveAppTeamSpaceMemoryIds(
  db: Context['db'],
  appId: string,
): Promise<string[]> {
  const rows = await db.memory.findMany({
    where: appTeamSpaceColumnFilter(appId),
    select: { id: true, urn: true, legacyUrn: true, sharedMemoryOfAgentId: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) return [];

  const adopted = rows.filter((r) => r.sharedMemoryOfAgentId !== null);
  const unkeyed = rows.filter((r) => r.sharedMemoryOfAgentId === null);
  if (unkeyed.length === 0) return adopted.map((r) => r.id);

  // A LEGACY row is recognised from its OWN urn, not from the install roster.
  //
  // Deriving the slug set from currently-installed agents looked tighter and
  // silently lost history (PR #1066 review, Codex): uninstall HARD-DELETES the
  // AppAgent row while deliberately RETAINING the pairing's memories (FR-005),
  // so a legacy space whose agent was later uninstalled would stop being
  // recognised — App.sharedMemory null, teamWorkItems an empty ledger — while
  // the adopted branch, keyed on a column, kept working. A predicate that
  // forgets more than its sibling as installs change is the wrong shape.
  //
  // The roster cross-check bought nothing here anyway. `chat-scope` matches
  // slugs because it resolves ONE (app, agent) pairing; this asks the broader
  // "is this row a team space of THIS App", and `appId` has already answered
  // the tenancy half. What remains is the urn's own shape, and
  // `sharedUrnAgentSlug` already rejects the one collision that matters — a
  // name-addressable `…:<agent>:app-mem:<name>` row, including one literally
  // named "shared".
  const legacy = unkeyed.filter(
    (r) => sharedUrnAgentSlug(r.urn) !== null || sharedUrnAgentSlug(r.legacyUrn) !== null,
  );

  // Preserve the createdAt ordering the caller's oldest-first picks rely on.
  const keep = new Set([...adopted, ...legacy].map((r) => r.id));
  return rows.filter((r) => keep.has(r.id)).map((r) => r.id);
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
  /** #1373 — optional so a row read before the columns existed still maps. */
  endpoint?: string | null;
  apiStyle?: string | null;
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
/**
 * #1380 review (Codex P2): the MEMBER-visible picker (resolveAiServiceConfigs)
 * — any App member, not just the owner's admins — must not learn an explicit
 * endpoint, which under the self-hosted private-network opt-in can be an
 * internal hostname or address. The endpoint is withheld, and
 * effectiveEndpoint is shown only when it is the public provider default.
 */
export function toGqlAiServiceConfigForPicker(c: AiServiceConfigRow) {
  const full = toGqlAiServiceConfig(c);
  // A legacy row may still carry params.baseUrl (D2: no migration): it is no
  // longer read, but it names a host all the same, so members don't see it.
  const params =
    full.params && typeof full.params === 'object' && !Array.isArray(full.params) && 'baseUrl' in full.params
      ? Object.fromEntries(Object.entries(full.params as Record<string, unknown>).filter(([k]) => k !== 'baseUrl'))
      : full.params;
  return { ...full, params, endpoint: null, effectiveEndpoint: c.endpoint ? null : full.effectiveEndpoint };
}

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
    endpoint: c.endpoint ?? null,
    effectiveEndpoint: effectiveEndpoint(c),
    apiStyle: c.apiStyle ?? null,
    effectiveApiStyle: effectiveApiStyle(c),
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
      if (!isPlatformAdmin(ctx)) throw authorizationDenied();
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
      // #1944: through the read gate first, so an Agent the caller can't read
      // answers as absent; the tenant gate below still decides the rest.
      const agent = await resolveReadableAgentRef(ctx, ownerId);
      const { id } = agent;
      // #1787 review (Rook P2-1): the config registry stays on the TENANT gate —
      // update/test can send the stored key to a caller-chosen endpoint, so for a
      // user-owned Agent these are owner-only (manage yes, move the key no);
      // requireAgentAccess is not used here on purpose.
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
  if (!ctx.userId) throw authorizationDenied();
  if (!appId) throw authorizationDenied();
  const member = await ctx.db.appMember.findUnique({
    where: { appId_userId: { appId, userId: ctx.userId } },
  });
  if (!member) throw authorizationDenied();
  // The named Agent must be installed in this App, or the walk could be
  // pointed at an unrelated Agent's (masked) configs.
  if (agentId && !(await isAgentInstalled(ctx.db, appId, agentId))) {
    throw authorizationDenied();
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
 * #2213 — size arguments of the `<field>Page` siblings (cor:api:120:04). An
 * omitted or null limit pages at 20; 0 is count-only (an empty page with the
 * real total); a negative limit is 0; a limit over 200 is served as 200, never a
 * refusal. A negative or omitted offset is 0. Distinct from `clampListTake`, whose
 * default of 50 the older `<entity>s` lists keep.
 */
export const PAGE_ARGS_DEFAULT = 20;
export const PAGE_ARGS_MAX = 200;

export function pageArgs(args: { limit?: number | null; offset?: number | null }): { take: number; skip: number } {
  const limit = args.limit ?? PAGE_ARGS_DEFAULT;
  return {
    take: Math.min(PAGE_ARGS_MAX, Math.max(0, limit)),
    skip: Math.max(0, args.offset ?? 0),
  };
}

/** `{ items, total, hasMore }`: hasMore is whether rows remain past this page. */
export function pageEnvelope<T>(items: T[], total: number, skip: number) {
  return { items, total, hasMore: skip + items.length < total };
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
        ...LIVE_ORG_MEMBERSHIP,
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
    where: { organizationId: memory.organizationId, userId, ...LIVE_ORG_MEMBERSHIP },
    select: { userId: true },
  });
  return !!member;
}

/**
 * The caller's APP-DERIVED memory ids for the node-content gate (#1092), memoized
 * per request.
 *
 * Delegates the reach question to `getPrincipalAppMemoryAccess` — the one
 * predicate this and the MCP gate share, which enforces App scope, spec-047
 * strict ownership, and exclusion of personal/private folds for both. The
 * class filter below remains as defense in depth at this direct-enumeration
 * boundary.
 *
 * That filter is not defensive decoration. The MCP map is documented
 * personal-free, and when #1092 shipped NOTHING enforced the claim:
 * `addMemoryToAgent` rejected only class `system`, so an org ADMIN could attach
 * a `personal` memory as an agent memory item and it folded in. MCP survived
 * that because `canReadMemory` strict-gates personal/private ABOVE the map;
 * this gate has no such per-row check — its output becomes `memoryId IN (…)`
 * directly. Inheriting an invariant that the upstream does not enforce is how a
 * latent hole reaches a wider audience, and #1092 widened the audience.
 *
 * **#1101 has since closed that front door** — the attach gate now refuses
 * strict-owner classes outright. This filter STAYS anyway, and deliberately:
 *   - rows attached BEFORE that refusal existed are unaffected by it;
 *   - a read gate that depends on a write gate having done its job is one
 *     refactor away from being wrong, and this one guards a cross-tenant leak
 *     with five instances in three months behind it (#362 class);
 *   - it is one indexed predicate on a query this function already makes.
 * So do not delete it as now-redundant: "the writer prevents it" is an argument
 * about today's writers, and `AgentMemoryItem` gains one every few months.
 *
 * The filter is also what keeps this gate's own contract: `getAccessibleMemoryIds`
 * admits personal/private ONLY through its identity-scoped clauses (owner,
 * holdings, share grantee). Nothing App-derived may add to that set.
 *
 * Both strict-owner axes live upstream as well (PR #1102 and #1260 reviews):
 * a map carrying rows the canonical point gate hard-denies is wrong for every
 * direct consumer, not just this one.
 */
async function appDerivedMemoryIds(ctx: Context, onlyMemoryId?: string): Promise<string[]> {
  const all = await (ctx.appDerivedMemoryIdCache ??= (async () => {
    const folded = [...(await getPrincipalAppMemoryAccess(ctx.db, ctx)).keys()];
    if (ctx.userId) folded.push(...await getWorkerMemoryAccess(ctx.db, ctx));
    if (folded.length === 0) return [];
    const rows = await ctx.db.memory.findMany({
      where: {
        id: { in: folded },
        deletedAt: null,
        class: { notIn: ['personal', 'private'] as never },
      },
      select: { id: true },
    });
    return rows.map((m: { id: string }) => m.id);
  })());
  return onlyMemoryId ? all.filter((id) => id === onlyMemoryId) : all;
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
  // #1349 — `excludeAppDerived` drops the App-participation fold from the USER
  // branch, leaving only the paths a user holds in their own right: ownership,
  // org membership, a share, a subscription, PUBLIC. Exactly one caller wants
  // this — the agent-attachment gate, which must not let a grant held through
  // one App be re-granted to another App's audience. Everywhere else the fold
  // is correct and the default keeps it.
  options?: { excludeAppDerived?: boolean },
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
  //
  // #934: PURE App-key shape only (`!ctx.userId`) — user principals can now
  // carry a session binding too (the heartbeat attribution), and a hybrid
  // user+selection principal entering this branch would swap their user reach
  // for `sessionScopedMemoryIds`, which never consults the USER's rights: a
  // narrowing at best, a grant (a bound agent's system memory the user cannot
  // read) at worst. Same shape as `requireSessionWriteAccess`'s App branch
  // (#932) and the #967 narrow-never-grant rule.
  if (ctx.appId && ctx.sessionId && !ctx.userId) {
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
        // #1217 — one predicate shared with MCP browse/task discovery and both
        // global-search slices. The strict owner of personal/private is userId;
        // ownerUserId is only authoritative for the other classes.
        NOT: foreignIdentityScopedMemoryFilter(ctx.userId),
      },
      select: { id: true },
    });
    const workerIds = (await getWorkerMemoryAccess(ctx.db, ctx))
      .filter((id) => !onlyMemoryId || id === onlyMemoryId);
    const candidates = [...new Set([...all.map((memory) => memory.id), ...workerIds])];
    const readable = await filterReadableMemoryIds(ctx.db, ctx, candidates);
    return candidates.filter((id) => readable.has(id));
  }

  // App Key without an active session — the App's installed-agent reach:
  // its agent's system memory + linked memories, via the SAME predicate the
  // MCP read gates use (`getAppMemoryAccess`). This branch returned [] from
  // its pre-App-rename origin ("management-only context, no memory access") —
  // written when App keys had no GraphQL node reads at all. Once the MCP
  // search tools started delegating to Query.findNodes (#403), that stance
  // made this the one gate that disagreed with the MCP layer: the same key
  // could read every node via hadron_get_node / hadron_list_nodes but every
  // findNodes-backed search intersected to empty (hadron_find_nodes returned
  // "No nodes found" for all queries, survey mode included). One predicate,
  // shared — the sessionScopedMemoryIds lesson (#945) again.
  // #1092: this is a RETURN only for a principal whose entire reach IS the App
  // — a pure App key, or an impersonated context (whose identity-scoped reach is
  // deliberately dropped, #876 class, and whose behaviour this change leaves
  // exactly as it was). A HYBRID user+selection caller — the shape every MCP
  // tool builds once its user has an active App — falls THROUGH to the user
  // branch, which unions this fold with the user's own reach.
  //
  // Returning here for a hybrid caller was a silent narrowing: an org member who
  // selected an App lost their ORG memories from `findNodes`, while
  // `hadron_get_node` on a node in one still succeeded (MCP's `getMemoryAccess`
  // unions the App fold with `getOrgReadableMemoryIds`). A selection FOCUSES a
  // request; it never narrows what its driver may read (`cor:acl:020:01`).
  if (ctx.appId && (!ctx.userId || ctx.impersonation)) {
    // #1003: `callerUserId` gates only the App team-space fold — a user-owned
    // App's team space is owner-only, so a co-member must not receive it. A pure
    // App key passes null and acts for the App itself.
    //
    // Routed through `appDerivedMemoryIds` (#1092) for its STRICT-OWNER filter,
    // which this branch never had. Measured on the unmodified branch: an org
    // ADMIN may attach a `personal` memory as an agent memory item
    // (`addMemoryToAgent` rejects only class `system`), and this gate then
    // returned it to a pure App key — while MCP's `canReadMemory` refused the
    // same principal the same row. A pre-existing leak rather than one #1092
    // introduced, closed here because it is the same fold three lines away and
    // is now proven constructible. #1101 is the real fix — the ATTACH gate
    // should refuse a strict-owner class; this is the read gate that must not
    // depend on it having done so.
    // A principal whose ONLY reach is App-derived holds nothing in its own
    // right, so an attachment gate asking "what does this caller hold?" gets
    // the empty set rather than that App's fold (#1349).
    if (options?.excludeAppDerived) return [];
    return appDerivedMemoryIds(ctx, onlyMemoryId);
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
          //
          // NON-personal classes, for the reason MCP's `getMemoryAccess` states
          // as "the map is personal-free by design" — and this copy did not have
          // it (found reviewing PR #1215, @codex on the sibling clause in
          // `Query.memories`). The two owner columns are independent and no
          // constraint ties them, so `ownerUserId = A, userId = B` is a legal
          // personal row; `canReadMemory` and `canReadMemoryRecord` both branch
          // on personal/private FIRST and admit only `userId`, so an
          // unrestricted clause here put B's personal memory into A's
          // node-enumeration set — the NODE CONTENTS, which is strictly worse
          // than the record metadata the list exposed.
          //
          // Narrowing a shared read gate is normally a decision to escalate
          // (#1208 is exactly that). This one is not, and the difference is
          // measured rather than argued: the clause only ever mattered for rows
          // where the two columns DISAGREE, and production has none (0 of 15
          // personal user-owned rows). Nobody loses reach; an aligned row still
          // arrives through the strict-owner clause above.
          // #2044: not an install memory — that kind has its own audience below, so
          // a user-owned App's owner keeps no blanket read once the App is deleted.
          { class: { notIn: ['personal', 'private'] as any }, ownerUserId: ctx.userId, isInstallMemory: false },
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
    // #1092 — the APP-derived half, through the SAME predicate the MCP gate
    // uses, for the same reason getOrgReadableMemoryIds is shared: the two
    // surfaces answer one question and a second copy is how they drifted. This
    // branch had no App arm at all, so an external AppMember (an AppMember with
    // no org role — the supported B2C shape) was admitted to the App's memories
    // by `Query.memory` (#982), by `appNodes` (#1070) and by MCP's point read,
    // and got NOTHING from `findNodes` scoped to those same memories. Its
    // user-visible face was `Edge.source`/`Edge.target` resolving to null for
    // endpoints the same response had just authorized (PR #1093, Codex P2) —
    // a rule that quietly nulls authorized data is not a narrower scope, it is
    // a wrong answer.
    //
    // No new AUDIENCE is created here. `cor:acl:010:01` already states the
    // team space's audience as App PARTICIPATION and names no narrower
    // enumeration audience, so the absent branch was an incomplete
    // implementation of a stated rule, not a decision to enumerate less. What
    // changes is that material already readable BY URN becomes FINDABLE.
    //
    // Skipped when a SCOPED check has already admitted the target: the fold
    // cannot change an answer that is already `true`, and skipping it keeps the
    // common point-read (an org member reading their own org memory) at exactly
    // its previous query cost. The fold is several queries per App and this gate
    // runs on nearly every read surface, so the shortcut is worth stating.
    if (!options?.excludeAppDerived && !(onlyMemoryId && accessibleIds.has(onlyMemoryId))) {
      for (const id of await appDerivedMemoryIds(ctx, onlyMemoryId)) accessibleIds.add(id);
    }
    // #2044: install memories — content for the live App's participants only.
    if (!options?.excludeAppDerived) {
      for (const id of await readableInstallMemoryIds(ctx.db, ctx)) {
        if (!onlyMemoryId || id === onlyMemoryId) accessibleIds.add(id);
      }
    }
    if (isRunPrincipal(ctx)) {
      const privateCandidates = await ctx.db.memory.findMany({ where: { id: { in: [...accessibleIds] }, class: 'private' }, select: { id: true } });
      const readable = await filterReadableMemoryIds(ctx.db, ctx, privateCandidates.map(m => m.id));
      for (const m of privateCandidates) if (!readable.has(m.id)) accessibleIds.delete(m.id);
    }
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
export async function requireSessionWriteAccess(
  ctx: Context,
  session: { appId: string | null; userId: string | null; launchOperationId: string | null; memoryId: string | null },
): Promise<void> {
  // #1647 (cor:acl:010:02, strict owner wins; Holger's A, #13061): a platform admin's authority stops at a session bound
  // to ANOTHER user's personal/private memory, and stops TERMINALLY. The admin role confers nothing there, and neither
  // does an attribution that role could otherwise fall back on (the admin's own session bound to someone else's memory
  // is refused too). `memoryId` is REQUIRED so a caller that forgot to select it fails to compile.
  if (isPlatformAdmin(ctx)) {
    if (await boundToForeignStrictMemory(ctx, session.memoryId)) throw authorizationDenied();
    return;
  }
  // App branch: PURE App-key principals only (#932 Codex P1). A hybrid
  // principal — a user with an active-App selection, the MCP auth shape —
  // must NOT inherit App authority, or any co-member of an App could end
  // another member's session (and free their persona). GraphQL App-key
  // contexts carry no userId, so this is a no-op for them; it exists so a
  // Context built from MCP auth (userId + selected appId) can't widen.
  // #1934 (cor:agt:070:04): an App key writes only user-less sessions
  // (Holger's ruling A, #11860), never a host-launched one, and a key that
  // ever held host:operate writes none — the shared predicate MCP's
  // hadron_end_session uses too.
  if (!ctx.userId) {
    // #1969: a host key's refusal here is recorded (cor:agt:070:07), apart, after the decision.
    if (await appPrincipalSessionWriteAllowed(ctx.db, ctx, session)) return;
    throw authorizationDenied();
  }
  if (session.userId === ctx.userId && !ctx.impersonation) return;
  throw authorizationDenied();
}

/** Is the memory another user's personal/private one, which no admin role or impersonation reaches? */
async function boundToForeignStrictMemory(ctx: Context, memoryId: string | null): Promise<boolean> {
  if (!memoryId) return false;
  const memory = await ctx.db.memory.findUnique({ where: { id: memoryId }, select: { class: true, userId: true } });
  if (!memory || (memory.class !== 'personal' && memory.class !== 'private')) return false;
  return !isStrictOwner(ctx, memory.userId);
}

/** Prisma `where` clause that restricts sessions to the caller's scope. */
export async function sessionScopeFilter(ctx: Context): Promise<Record<string, unknown>> {
  return { AND: [await sessionAudienceFilter(ctx), boundSessionPrivacyFilter(ctx)] };
}

/** Existing session audience, intersected with bound-memory privacy by sessionScopeFilter. */
async function sessionAudienceFilter(ctx: Context): Promise<Record<string, unknown>> {
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
        ...LIVE_ORG_MEMBERSHIP,
        // Impersonation: sessions of the shared org's Apps only.
        ...(ctx.impersonation ? { organizationId: ctx.impersonation.orgId } : {}),
      },
      select: { organizationId: true },
    });
    const orgIds = memberships.map((m: { organizationId: string }) => m.organizationId);
    const clauses: Record<string, unknown>[] = [];
    if (orgIds.length > 0 || !ctx.impersonation) {
      const apps = await ctx.db.app.findMany({
        where: {
          deletedAt: null,
          OR: [
            ...(orgIds.length ? [{ organizationId: { in: orgIds } }] : []),
            ...(!ctx.impersonation ? [{ ownerUserId: ctx.userId }] : []),
          ],
        },
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
  // #697 Stage 2: EMIT flat grammar-v2 for the root entity types (`memory`
  // renames to `mem`; single colon; no `@` sigil). Delegated to the shared
  // safeEntityUrnV2 so this wrapper and every non-GraphQL emitter (e.g.
  // effectiveAccess, #966) share ONE strict-then-raw fallback. Any other type
  // word falls back to the v1 canonical form (unchanged surface until it too
  // flips).
  if (type === 'memory' || type === 'org' || type === 'agent' || type === 'app') {
    return safeEntityUrnV2(type, raw);
  }
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
 * 3. Users: app-class rows through the MCP shape/participation gate; other
 *    shared classes through their own membership, org, or subscription rules
 */
export async function requireMemoryWriteAccess(ctx: Context, memoryId: string): Promise<void> {
  // App-keyed callers: delegate to the class-aware MCP gate. The ADMIN/OWNER
  // shortcut applies only to non-strict org memories. A platform-admin USER
  // with an active App still cannot write another user's personal/private
  // memory (#1492); ownerUserId is null on those org-anchored rows.
  if (ctx.appId) {
    const memory = await ctx.db.memory.findUnique({
      where: { id: memoryId },
      select: { id: true, ownerUserId: true, userId: true, class: true, appId: true, organizationId: true, installOfAgentId: true, isInstallMemory: true },
    });
    if (!memory) throw memoryWriteForbidden();
    // #2044: an install memory has its own write audience; no platform-role
    // shortcut below may reach it (a deleted App's memory takes no write at all).
    if (isInstallMemoryRow(memory)) {
      if (await installWriteAllowed(ctx, memory)) return;
      throw memoryWriteForbidden();
    }
    const strictOwner = memory.class === 'personal' || memory.class === 'private';
    // A strict owner's rights under App selection are decided by the shared
    // gate below, the same rule MCP applies (#1503, ruling (c)): an explicit
    // reference to the owner's memory in another App is evaluated as that App,
    // with isolation and the subscription check. An inline identity shortcut
    // here (#1500) let GraphQL drift from MCP, so there is no second copy.
    if (!strictOwner && memory.ownerUserId === null &&
        !(ctx.appId && ctx.sessionId && !ctx.userId) &&
        (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'))) return;
    // A write always names its target: an explicit reference (#1503).
    if (await canWriteToMemory(ctx.db, ctx, memoryId, EXPLICIT_REF)) return;
    throw memoryWriteForbidden();
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
      createdBy: true,
      installOfAgentId: true,
      isInstallMemory: true,
    },
  });

  // #2044: see the App-keyed branch above.
  if (isInstallMemoryRow(memory)) {
    if (await installWriteAllowed(ctx, memory)) return;
    throw memoryWriteForbidden();
  }

  // 034-memory-class-access: owner-owned personal/private memories are
  // owner-only to write — no ADMIN/OWNER bypass, no org-role path — EXCEPT a
  // #778 `writer` MemoryShare grantee on a personal memory (private is never
  // shareable, so this only widens personal).
  if (memory.class === 'personal' || memory.class === 'private') {
    if (memory.class === 'private' && isRunPrincipal(ctx) && !await canWriteToMemory(ctx.db, ctx, memory.id)) throw memoryWriteForbidden();
    if (isStrictOwner(ctx, memory.userId)) return;
    if (await granteeShareAccess(ctx.db, ctx.userId, memory, { requireWrite: true })) return;
    throw memoryWriteForbidden();
  }

  // spec 047: user-owned non-strict memories are owner-only, with the narrow
  // cor:acl:010:01 exception for a Worker's current holder. This runs BEFORE
  // the ADMIN/OWNER bypass: a platform admin does not gain another user's
  // user-owned memory merely from that role.
  if (memory.ownerUserId !== null) {
    if (ctx.userId === memory.ownerUserId) return;
    if (memory.class === 'app' && await canWriteToMemory(ctx.db, ctx, memoryId)) return;
    // #2206 case 2: a user-owned Agent's system memory, by whoever manages the Agent (the shared predicate).
    if (memory.class === 'system' && await canManageAgentSystemMemory(ctx.db, ctx, memoryId)) return;
    throw memoryWriteForbidden();
  }

  // Non-personal/private, org-owned: global ADMIN/OWNER bypass.
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return;

  // The app class contains team, Worker, and session rows with distinct
  // audiences. Use the same shape-aware gate as MCP rather than allowing a
  // blanket org-CONTRIBUTOR write below.
  if (memory.class === 'app') {
    if (await canWriteToMemory(ctx.db, ctx, memoryId)) return;
    throw memoryWriteForbidden();
  }

  // #653: an APP-SCOPED knowledge/group memory is App-internal — it must NOT be
  // writable via the org-member CONTRIBUTOR / cross-org-subscription grants
  // below (which key on organizationId, ignoring app_id). App-scoped write goes
  // through the App-key/agent path (canWriteToMemory via getAppMemoryAccess); a
  // JWT org contributor who isn't ADMIN gets no write here (codex review, #660).
  if (memory.appId !== null && (memory.class === 'knowledge' || memory.class === 'group')) {
    throw memoryWriteForbidden();
  }

  if (memory.organizationId === null) {
    throw memoryWriteForbidden();
  }

  // Identity-scoped records do not inherit shared org grants. Match the
  // existing creator-scoped read audience, with impersonation excluded.
  if (memory.class === 'knowledge' && memory.userMemoryOfAgentId !== null) {
    if (!ctx.impersonation && memory.createdBy === ctx.userId) return;
    throw memoryWriteForbidden();
  }

  // Definition authoring follows whoever manages the Agent (#2206, cor:dmo:050:13), through the one predicate MCP
  // shares: a live Agent's own system memory with matching tenant, never a class-only org-ADMIN shortcut (a system
  // row no live Agent points at is nobody's definition). User-owned and platform-admin cases were decided above.
  if (memory.class === 'system') {
    if (await canManageAgentSystemMemory(ctx.db, ctx, memoryId)) return;
    throw memoryWriteForbidden();
  }

  // One shared predicate for GraphQL and MCP: free-standing knowledge via
  // live org CONTRIBUTOR+, group via its MemoryMember writer/owner grant.
  if ((await getOrgWritableMemoryIds(ctx.db, ctx.userId, memoryId)).includes(memoryId)) return;

  // A subscription grants writes only to ordinary shared knowledge. Group
  // membership stays the exclusive group-write arm (cor:acl:010:01).
  if (memory.class === 'knowledge' && memory.userMemoryOfAgentId === null) {
    const userOrgs = await ctx.db.orgMember.findMany({
      where: {
        userId: ctx.userId,
        ...LIVE_ORG_MEMBERSHIP,
        role: { in: ['CONTRIBUTOR', 'ADMIN', 'OWNER'] as any },
      },
      select: { organizationId: true },
    });
    for (const uo of userOrgs) {
      const memorySub = await ctx.db.memorySubscription.findUnique({
        where: { memoryId_organizationId: { memoryId, organizationId: uo.organizationId } },
      });
      if (memorySub && memorySub.deletedAt === null && (ROLE_ORDER[memorySub.role] ?? -1) >= ROLE_ORDER['CONTRIBUTOR']) return;
    }
  }

  throw memoryWriteForbidden();
}

/**
 * The shared memory-write denial. Keep the established prose and GraphQL
 * partial-response transport, but make the authorization classification
 * explicit so Apollo does not report an ordinary denial as a server fault.
 */
export function memoryWriteForbidden(): GraphQLError {
  return new GraphQLError('Forbidden: no write access to this memory', {
    extensions: { code: 'FORBIDDEN' },
  });
}

export const MEMORY_INCLUDE = {
  // #2238: live rows only, matching ORG_INCLUDE.subscriptions.
  subscriptions: { where: { deletedAt: null }, include: { organization: true }, orderBy: { createdAt: 'asc' as const } },
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
  // No exchangeConnections here: Organization.exchangeConnections resolves
  // through listOrgExchangeConnections, never from an eager row (hadron-internal#18).
};

// #980: `worker: true` eager-loads the bound Worker so `Session.worker`
// resolves list pages in one query — the repo has no DataLoader and
// Query.sessions serves 200-row pages, so a per-row field resolver would be a
// straight N+1. Full row (not a select): the Worker type's scalar fields all
// come from it, and its OWN field resolvers (app/agent — which self-guard,
// #552) fetch on demand.
export const SESSION_INCLUDE = {
  events: { orderBy: { createdAt: 'desc' as const }, take: 50 },
  worker: true,
};

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
 * the worker-staffing gate (castWorker, formerly createTeamPersona's mint
 * gate), extracted here (#952) so the one
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
  // the staffing gate", so a team's own members can compose the roster.
  // NOT done, deliberately — the two operations are not symmetric:
  // castWorker only CASTS an agent that is already installed (nothing
  // pre-existing is revealed), whereas this one installs an EXISTING
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
  // #1946: the Agent is resolved only AFTER the App gate, so an outsider is
  // refused on the App whatever the ref names; resolving first answered a
  // real Agent and a guessed one differently.
  const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, args.agentRef);
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
      // #1946: ORGANIZATION_MISMATCH (and its agentId) only for an Agent the
      // caller can read; one they can't answers exactly as an absent one.
      await requireReadableAgent(ctx, agent, args.agentRef);
      throw new GraphQLError('A personal App may only install a PUBLIC agent or your own personal agent.', {
        extensions: { code: 'ORGANIZATION_MISMATCH', appId: resolvedAppId, agentId: resolvedAgentId },
      });
    }
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
  // The license, install and default Channel register row all mint authority.
  // Keep them in one transaction under the App owner's anchor, so a revoker
  // cannot return while a post-check grant is still waiting to commit.
  let currentAgentOwnerUserId: string | null = agent.ownerUserId;
  let autoProvisionOrgGrant = false;
  const created = await withAuthorizedTx(
    ctx,
    [
      { kind: 'app', id: resolvedAppId },
      { kind: 'agent', id: resolvedAgentId },
      ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
      ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    ],
    async (txCtx) => {
      const currentApp = await txCtx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      const currentAgent = await txCtx.db.agent.findUniqueOrThrow({ where: { id: resolvedAgentId } });
      currentAgentOwnerUserId = currentAgent.ownerUserId;
      if (currentApp.organizationId !== app.organizationId || currentApp.ownerUserId !== app.ownerUserId) {
        throw new Error('App ownership changed; retry the installation');
      }
      if (currentAgent.deletedAt) throw new Error('Agent not found');
      if (currentApp.uninstalledAt) {
        throw new GraphQLError('Cannot install Agent into an uninstalled App.', {
          extensions: { code: 'APP_UNINSTALLED', appId: resolvedAppId },
        });
      }
      await requireOwnerOrOrgRole(txCtx, currentApp, 'CONTRIBUTOR');
      const ownAgent = currentAgent.ownerUserId !== null && currentAgent.ownerUserId === currentApp.ownerUserId;
      if (currentApp.organizationId === null) {
        if (currentAgent.visibility !== 'PUBLIC' && !ownAgent) {
          await requireReadableAgent(txCtx, currentAgent, args.agentRef); // #1946, as above
          throw new GraphQLError('A personal App may only install a PUBLIC agent or your own personal agent.', {
            extensions: { code: 'ORGANIZATION_MISMATCH', appId: resolvedAppId, agentId: resolvedAgentId },
          });
        }
      } else {
        // Check the grant while the org/Agent anchors are held. A concurrent
        // revoke must not race a cross-org installation past this decision.
        autoProvisionOrgGrant = await planOrgAgentInstallGrant(
          txCtx.db, currentApp.organizationId, resolvedAgentId, args.agentRef,
        );
      }
    },
    async (tx) => {
      if (app.organizationId && autoProvisionOrgGrant) {
        await ensureAgentOrgGrant(tx, app.organizationId, resolvedAgentId);
      } else if (app.ownerUserId && currentAgentOwnerUserId !== app.ownerUserId) {
        await ensureAgentSubscription(tx, app.ownerUserId, resolvedAgentId);
      }
      if (args.trainingMode !== undefined) {
        await tx.app.update({
          where: { id: resolvedAppId },
          data: { trainingMode: args.trainingMode, updatedBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null },
        });
      }
      let installed;
      try {
        installed = await tx.appAgent.create({
          data: { appId: resolvedAppId, agentId: resolvedAgentId, createdBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null },
          include: { app: true, agent: { include: AGENT_INCLUDE } },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new DuplicateAppAgentError(resolvedAppId, resolvedAgentId);
        }
        throw e;
      }
      await ensureInstallRegisterRows(tx, resolvedAppId, {
        agentId: resolvedAgentId,
        createdBy: ctx.userId ?? ctx.appId ?? ctx.clientId ?? null,
      });
      return installed;
    },
    { afterLock: async (tx) => {
      await tx.$queryRaw`SELECT id FROM apps WHERE id = ${resolvedAppId} FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM agents WHERE id = ${resolvedAgentId} FOR SHARE`;
    } },
  );
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
  const app = await ctx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
  // #551: symmetric with install — a CONTRIBUTOR+ member of the App's org can
  // uninstall an Agent (was ADMIN-only).
  await requireOwnerOrOrgRole(ctx, app, 'CONTRIBUTOR');
  // #1946: the Agent only after the App gate. The delete stays idempotent for
  // an Agent the caller can read; one they can't that isn't installed here
  // answers exactly as an absent one (an installed one is on the roster the
  // caller already sees).
  const { id: resolvedAgentId } = await resolveAgentRef(ctx.db, args.agentRef);
  const installedHere = await ctx.db.appAgent.findUnique({
    where: { appId_agentId: { appId: resolvedAppId, agentId: resolvedAgentId } },
    select: { agentId: true },
  });
  if (!installedHere) {
    await requireReadableAgent(ctx, await ctx.db.agent.findUnique({ where: { id: resolvedAgentId } }), args.agentRef);
  }
  // Idempotent delete — `deleteMany` returns a count, never throws on
  // absent rows. The (App, Agent, *) memories persist as orphans per
  // spec 023 FR-005.
  await withAuthorizedTx(
    ctx,
    [
      { kind: 'app', id: resolvedAppId },
      { kind: 'agent', id: resolvedAgentId },
      ...(app.organizationId ? [{ kind: 'org' as const, id: app.organizationId }] : []),
      ...(app.ownerUserId ? [{ kind: 'user' as const, id: app.ownerUserId }] : []),
    ],
    async (txCtx) => {
      const current = await txCtx.db.app.findUniqueOrThrow({ where: { id: resolvedAppId } });
      if (current.organizationId !== app.organizationId || current.ownerUserId !== app.ownerUserId) {
        throw new Error('App ownership changed; retry the uninstall');
      }
      await requireOwnerOrOrgRole(txCtx, current, 'CONTRIBUTOR');
    },
    async (tx) => {
      await tx.appAgent.deleteMany({ where: { appId: resolvedAppId, agentId: resolvedAgentId } });
      await removeRegisterRowsForUninstall(tx, resolvedAppId, resolvedAgentId, ctx.userId ?? null);
    },
    { lockMode: 'exclusive', afterLock: async (tx) => {
      await tx.$queryRaw`SELECT id FROM apps WHERE id = ${resolvedAppId} FOR SHARE`;
    } },
  );
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
 * An org's live exchange connections, for whoever may manage them: org ADMIN or
 * OWNER, or a platform admin, under `requireOrgRole` (impersonation included).
 * The ONE list predicate: `Query.exchangeConnections` refuses with its
 * FORBIDDEN, and `Organization.exchangeConnections` masks that refusal to `[]`
 * (hadron-internal#18), so the two surfaces always admit the same callers and
 * return the same rows in the same order.
 */
export async function listOrgExchangeConnections(ctx: Context, orgId: string) {
  const scope = await orgExchangeConnectionScope(ctx, orgId);
  return ctx.db.exchangeConnection.findMany(scope);
}

/**
 * The admission and the row scope of `listOrgExchangeConnections`, built once so
 * the list and `Query.exchangeConnectionsPage` (#2213) can never disagree about
 * who sees which rows. Refuses before returning a scope, so a count or a page
 * built from it is never read for a denied caller.
 */
export async function orgExchangeConnectionScope(ctx: Context, orgId: string) {
  await requireOrgRole(ctx, orgId, 'ADMIN');
  return {
    where: { organizationId: orgId, deletedAt: null },
    // The id tiebreak makes rows created in the same millisecond come back in
    // one order on every read, so the two surfaces agree row for row.
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  };
}

/**
 * `requireEmailConnection`'s answer for a missing or deleted connection. The
 * message is unchanged for the operation surfaces; a caller that must answer
 * absence like denial (hadron-internal#18) can tell it apart by type.
 */
export class ConnectionNotFoundError extends Error {
  constructor() {
    super('Connection not found');
    this.name = 'ConnectionNotFoundError';
  }
}

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
  if (ctx.impersonation) throw authorizationDenied();
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
  if (!connection) throw new ConnectionNotFoundError();

  if (ctx.appId) {
    // App / headless-run context — a covering grant is mandatory (fail-closed),
    // even for an on-behalf-of-owner run. Unmapped operation ⇒ owner-only ⇒ deny.
    const scope = scopeForOperation(operation);
    if (!scope) throw authorizationDenied();
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
    if (!grant) throw authorizationDenied();
  } else if (!ctx.userId || ctx.userId !== connection.userId) {
    // Pure user principal that isn't the owner (org admins included) → denied.
    throw authorizationDenied();
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
 * Merge extractionSpec from three levels: agent (config node) →
 * conversation → stage. Stage-level fields win on conflict.
 *
 * Exported (#910) because the WRITE path needs the same list the tool schema
 * was built from: a spec's `field` carries the destination prefix that says
 * where each extracted value is filed, and the model answers with the bare
 * last segment. Deriving the two from one function is what keeps the routing
 * key and the schema property name in agreement.
 */
export async function resolveExtractionSpec(
  db: PrismaClient,
  systemMemoryId: string,
  convName: string | null,
  stageData: Record<string, unknown>,
): Promise<ExtractionSpecEntry[]> {
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
  return deduped;
}

/**
 * Build the respond() tool schema from the merged spec. Always includes
 * onTrack + offTrackReason fields for continuous routing.
 *
 * The property name is the field's LAST dotted segment — the leading
 * segment is the destination (#910) and is not something the model should
 * see or answer with.
 */
export async function buildRespondToolSchema(
  db: PrismaClient,
  systemMemoryId: string,
  convName: string | null,
  stageData: Record<string, unknown>,
): Promise<Array<{ name: string; description: string; parameters: unknown }> | null> {
  const deduped = await resolveExtractionSpec(db, systemMemoryId, convName, stageData);

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
  // #1349: only a link the agent's own tenant can WRITE on its own
  // (cor:dmo:050:09 — a link is a limit, never a grant), so a legacy
  // read-write link to another tenant's memory is never an upload target.
  const agent = await db.agent.findUnique({ where: { id: agentId }, select: { organizationId: true, ownerUserId: true } });
  const tenant = { organizationId: agent?.organizationId ?? null, ownerUserId: agent?.ownerUserId ?? null, userId };
  const writableLinks = await db.agentMemoryItem.findMany({
    where: { agentId, deletedAt: null, role: 'read-write', memory: { deletedAt: null } },
    orderBy: { createdAt: 'asc' },
    select: { memoryId: true, role: true, memory: { select: LINK_CAP_MEMORY_SELECT } },
  });
  const agentMemory = writableLinks.find((item) => linkWriteTargetAdmits(tenant, item.memory, item.role));
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
    where: { organizationId, userId, ...LIVE_ORG_MEMBERSHIP },
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
 * Legacy bulk-import node shape retained by the refused replaceSubtree field.
 * Single-node writes use CreateNodeInput / UpdateNodeInput below.
 */
export interface NodeInput {
  id?: string;
  memoryId: string;
  nodeType?: string;
  /** Internal copy paths may preserve this legacy Node field. */
  isLink?: boolean;
  /** #725 — collection discriminator (e.g. "competitor"). Omit preserves; null clears. */
  objectType?: string | null;
  isRunnable?: boolean | null;
  /**
   * #1201 — what this node is FOR (open string). Distinct from `nodeType` (the
   * platform-kind axis) and `objectType` (the collection discriminator). A
   * GOVERNED value routes the write to that kind's door; anything else is
   * inert. Omit preserves on update; null clears.
   */
  role?: string | null;
  loc: string;
  name: string;
  alias?: string | null;
  /** Nullable on the wire (CreateNodeInput/UpdateNodeInput `description: String`); `null` clears. */
  description?: string | null;
  /** Paragraph-length summary. Spec 031. Optional; `null` clears, omitted preserves. */
  abstract?: string | null;
  /** Nullable on the wire (`content: String`); `null` clears. */
  content?: string | null;
  /**
   * MIME type of `content` (#476, spec cor:cnv:010:01). 'text/markdown'
   * (default) stores as-is; 'text/html' converts to Markdown via
   * hadrontool-pdf before storage (the extracted title lands in
   * properties.title when the caller didn't set one). Consumed at the write
   * seam — never persisted.
   */
  contentType?: string | null;
  data?: Record<string, unknown> | null;
  seq?: number;
  tags?: string[];
  properties?: Record<string, unknown> | null;
  llmModel?: string | null;
  aiAgent?: string | null;
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
  /** Optional positive Node.revision compare-and-swap precondition (#937). */
  expectedRevision?: number | null;
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
  // #1707 / cor:agt:060:04: the model family this session runs as. Omitted:
  // derived from llmModel, then tool (src/lib/agentTasks/family.ts).
  family?: string | null;
  // #928 / cor:api:140: the role-Agent driving this session (PK or URN).
  agentRef?: string;
  // #943 / cor:api:140: the App this session is a unit of work for (PK or URN),
  // gated on the caller's membership of that App.
  appRef?: string;
  // #974 / cor:agt:020:03: the Worker (named casting) this session works as.
  // THREE forms, told apart by shape (never a fallback chain): an id, a
  // `hrn:worker:…` URN (#991), or the worker's NAME (#990).
  //
  // The NAME form is App-SCOPED — names are unique only within an App — so it
  // requires App context (appRef, an App-key credential, or an MCP active-App
  // selection) and refuses SESSION_WORKER_NAME_NEEDS_APP without one. It is
  // gated on the staff read gate before the lookup, since resolving a name
  // discloses roster membership that the id and URN forms never do.
  //
  // Gated for all three: the worker must belong to the session's App; a retired
  // worker refuses; a taken worker refuses WORKER_TAKEN unless force (#940).
  workerRef?: string;
  // #1726: the worker this bind's worker reports to (id, URN or name in the
  // session's App). Sets it only when unset; omitted leaves it unchanged.
  reportsTo?: string | null;
  // #940: explicit informed-takeover override for a WORKER_TAKEN refusal.
  force?: boolean;
  // #1709: a host-launched agent's single-use launch grant (cor:agt:070:08).
  launchGrant?: string | null;
  // The session's stated intent (Session.plan) — MCP's hadron_start_session
  // description lands here since it delegates to startSession (#940 parity).
  plan?: string;
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
