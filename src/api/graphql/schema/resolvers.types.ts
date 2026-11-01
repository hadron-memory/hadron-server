import { liveTxContext, liveReadSnapshotContext } from './authorizedTx.js';
import { batchReadEdges, batchInheritedEndpoint } from './resolvers.nodeBatchEdges.js';
import { authorizedTriggerLabel } from './resolvers.appRun.js';
import { plainRunFailure } from '../../../lib/automation/plainReason.js';
import { loadOfferedMemberRoles } from '../../../lib/memberRoles.js';
import { withReconciledNodeRead } from '../../../lib/includes/reconciledNodeRead.js';
import { resolveNodeContent } from '../../../lib/includes/resolveNodeContent.js';
import { lintWarningPage, lintWarningPageForNodeId } from '../../../lib/bootPromptLint.js';
import { sharedOrganizations } from './sharedOrganizations.js';
import { projectGovernedKind } from '../../../lib/edgeGovernedKind.js';
import { revisionApprovalOf } from '../../../lib/nodeApproval.js';
import { requireAppKeyManager } from './appKeyManagement.js';
import { servedPromptOwnerFields, servedPromptTypeResolvers } from './resolvers.servedPrompt.js';
import { isRunPrincipal } from '../../../lib/auth/runPrincipal.js';
import { loadViewerManages } from './resolvers.appViewerManages.js';
import { currentActor, currentActorAmbiguity } from '../../../lib/requestActor.js';
import { authorizationDenied } from '../../../lib/auth/authorizationDenied.js';
import { sessionEndReason } from '../../../lib/sessionEndReason.js';
// typeResolvers — GraphQL type-level field resolvers extracted from resolvers.ts
// (split step 3). No behavior change.
import { isStrictOwner } from '../../../lib/auth/strictOwner.js';
import { isLifecycleActive } from '@hadron-memory/access-control';
import { GraphQLError } from 'graphql';
import {
  getPrimaryAgent,
  isAgentInstalledAndLicensed,
  isGrantedAgentMemoryRole,
} from '../../../lib/appAgent.js';
import {
  emitNodeUrnV2,
  emitEdgeUrnV2,
  emitAssetUrnV2,
  emitActionUrnV2,
  registerEntryCode,
  emitInstalledAgentUrnV2,
  bestEffortFlatNodeUrn,
} from '../../../lib/urnEmit.js';
import { portalUrlForUrn } from '../../../lib/portalUrl.js';
import { emitEntityUrnV2 } from '../../../lib/urnEmit.js';
import { servedEndpointInEffect, type InheritedFrom } from '../../../lib/effectiveSystemMemory.js';
import { nodeContentValidationState } from '../../../lib/nodeContentValidation.js';
// Spec 049 Phase 3b — AppRun.scope: the mint snapshot as the caller may read it.
import { parseRunScopeSnapshot, resolveRunScope, scopeInfoOf } from '../../../lib/scopes.js';
import { parseRunRegisterSnapshot, resolveRegister, snapshotRowsAsEntries, toGqlRegisterRows } from '../../../lib/resolveRegister.js';
import { userUrn } from '../../../lib/userHandle.js';
import { composeNodeRevUrn } from '../../../lib/entityRef/nodeRevRef.js';
import {
  RECONCILE_EDITOR_INFO,
  revisionStateMatches,
  type SnapshotSourceNode,
} from '../../../lib/nodeRevisionSnapshot.js';
import { clearNodeAuthorship } from '../../../lib/nodeAuthorship.js';
import { decryptNodeFieldsWithKey } from '../../../lib/nodeCrypto.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { composeAppRunUrn } from '../../../lib/entityRef/appRunRef.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { canReadMemory } from '../../../mcp/access-control.js';
import { publicAssetUrl, isPublicHotlinkEnabled } from '../../assetPublic.js';
import { canManageAssetPublicLink, PUBLIC_LINK_MEMORY_SELECT } from '../../../lib/asset/publicLink.js';
import {
  canSeeUserPersonalFields,
  canSeeOrgMemberRole,
} from '../../../lib/auth/userVisibility.js';
import { Prisma, type AgentVisibility, type NodeContentValidationOutcome } from '../../../generated/prisma/index.js';
import {
  deserializeTags,
  deserializeJson,
} from '../../../integrations/db/provider.js';
import {
  type Context,
  loadEdgeEndpointNode,
  isMemoryReadableCached,
  canReadMemoryRecord,
  loadReadableMemoryRecord,
  filterReadableMemoryRecords,
  loadMemoryUrn,
  loadAppUrn,
  loadApp,
  requireOrgRole,
  isPlatformAdmin,
  requireAgentAccess,
  requireOwnerOrOrgRole,
  defaultAiConfigOf,
  isOrgMemberOrAdmin,
  safeCanonicalUrn,
  AGENT_INCLUDE,
  APP_INCLUDE,
  ORG_INCLUDE,
  listOrgExchangeConnections,
  readPrimaryAgentRecordFromEager,
  readAllAgentRecordsFromEager,
  assetUrn,
  resolveAppTeamSpaceMemoryIds,
  getAccessibleMemoryIds,
  sessionScopeFilter,
  CONTENT_RAW_DEFAULT,
} from './resolvers.helpers.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';
import { publicReadableMemoryWhere } from '../../../lib/orgDiscoverability.js';
import { memoryRowToRef, agentRowToRef } from './publicRefs.js';
import { WORKLOG_LOC } from './resolvers.teamWork.js';
import { corpusMintStateOf } from '../../../lib/specCorpus.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import { isSessionLive, loadLastEventBySession, sessionLapsesAt, sessionState, DEFAULT_SESSION_DORMANCY_DAYS } from '../../../lib/sessionActivity.js';
import type { SessionType } from '../../../generated/prisma/index.js';
import { hasBoundAppSession, strictSessionMemoryFilter } from '../../../lib/auth/sessionPrivacy.js';

// Request-local only: a session list computes the event memory set once.
type SessionEventMemorySet = { ids: string[]; delegatedMemoryId: string | null };
const sessionEventMemoryReads = new WeakMap<Context, Promise<SessionEventMemorySet>>();
function sessionEventMemoryIds(ctx: Context, parentSessionId: string): Promise<string[]> {
  let read = sessionEventMemoryReads.get(ctx);
  if (!read) {
    read = (async () => {
      const accessible = await getAccessibleMemoryIds(ctx);
      const bound = hasBoundAppSession(ctx)
        ? await ctx.db.session.findFirst({
          where: { id: ctx.sessionId!, appId: ctx.appId! },
          select: { memoryId: true, memory: { select: { class: true } } },
        })
        : null;
      const memories = await ctx.db.memory.findMany({
        where: { AND: [
          { OR: [strictSessionMemoryFilter(ctx), ...(bound?.memoryId ? [{ id: bound.memoryId }] : [])] },
          ...(accessible === null ? [] : [{ id: { in: accessible } }]),
        ] },
        select: { id: true },
      });
      return {
        ids: memories.map((m) => m.id),
        delegatedMemoryId: bound?.memory?.class === 'personal' || bound?.memory?.class === 'private'
          ? bound.memoryId : null,
      };
    })();
    sessionEventMemoryReads.set(ctx, read);
  }
  // The delegated strict-memory exception belongs only to this conversation.
  // Other readable parents in the same request retain their ordinary set.
  return read.then(({ ids, delegatedMemoryId }) => parentSessionId === ctx.sessionId || !delegatedMemoryId
    ? ids : ids.filter((id) => id !== delegatedMemoryId));
}

/**
 * #757 — a Prisma `where` fragment selecting the Agents this caller may read,
 * mirroring the `agent(ref:)` gate: PUBLIC resolves for anyone (#551), a
 * non-public agent needs membership in its owning org, a user-owned agent
 * (spec 047) is readable by its owner, and an App-key principal may read the
 * agents installed in that App.
 *
 * ALWAYS returns a filter — never `undefined` — because `deletedAt: null` is
 * unconditional. `AgentImport.parentAgent` hydrates by bare `findUnique` with
 * no soft-delete check, so an unfiltered admin branch would let a platform
 * admin resolve a DELETED parent through `importedBy` even though every other
 * Agent read surface treats soft-deleted as unreadable (`Query.agent` returns
 * null). PR #843 review, Copilot.
 *
 * Use this to scope any field that returns OTHER tenants' Agent objects, where
 * the outer gate authorized a different agent than the one being hydrated.
 */
/**
 * #481 — the fully-qualified node URN, composed server-side so every
 * Node-returning surface carries it (the extension's URN chip + run-via-URN
 * light up without a client release). Uses the preloaded relation's urn when a
 * resolver already included it (guarding against partial selects that omit
 * urn), else the request-memoized memory-urn loader.
 *
 * Shared by `Node.urn` and `Node.portalUrl` (#881) so a node's URN and the link
 * that opens it are always the same string.
 */
export async function resolveNodeUrnField(
  n: { loc: string; memoryId: string; memory?: { urn?: string } | null },
  ctx: Context,
): Promise<string> {
  const memUrn =
    (typeof n.memory?.urn === 'string' ? n.memory.urn : null) ??
    (await loadMemoryUrn(ctx, n.memoryId));
  // The field is String! — never null it. A missing memory row is corrupt
  // data; a canonicalization failure falls back to a raw compose (same
  // serve-and-log posture as safeCanonicalUrn).
  if (!memUrn) return `hrn:node:unknown:${n.loc}`;
  try {
    return emitNodeUrnV2(memUrn, n.loc);
  } catch (err) {
    console.warn(`[Node.urn] failed to emit v2 node urn for memory "${memUrn}":`, err);
    // Best-effort flat-v2 fallback (single colon, never throws). Do NOT run
    // the stored urn back through a canonicalizer here — it can itself throw
    // on the same malformed value, defeating the serve-and-log posture of
    // this non-null field.
    return bestEffortFlatNodeUrn('node', memUrn, n.loc);
  }
}

/**
 * #2610 — `Node.actionUrn`: the register entry's action address
 * (`hrn:action:<root>:<agent-slug>:<code>`), computed on read. Non-null only
 * for a `register:<code>` node in a LIVE Agent's system memory — the memory the
 * action URN keys on is the holding Agent's own (`Node.memoryId` here), so a
 * `register:` loc anywhere else names no entry. Null, never a throw, on an
 * unemittable stored code atom (charset/length): one bad row must not fail the
 * query, and a wrong action URN is worse than none.
 *
 * #2972 — entry-hood is `registerEntryCode`'s call: a NESTED `register:a:b`
 * loc is a writable namespace loc, not an entry, and nulls QUIETLY (no repair
 * warn); the null-and-log below is reachable only for a single-atom code the
 * emitter refuses — a real entry that needs repair.
 */
export async function resolveNodeActionUrnField(
  n: { loc: string; memoryId: string },
  ctx: Context,
): Promise<string | null> {
  const code = registerEntryCode(n.loc);
  if (code === null) return null;
  const agent = await ctx.db.agent.findFirst({
    where: { systemMemoryId: n.memoryId, deletedAt: null },
    select: { urn: true },
  });
  // No live Agent keys this memory (a plain memory, or a deleted Agent whose
  // URN can no longer resolve): no action address exists for this node.
  if (!agent) return null;
  try {
    return emitActionUrnV2(agent.urn, code);
  } catch (err) {
    console.warn(
      `[Node.actionUrn] register code ${JSON.stringify(code)} in memory ${n.memoryId} is not ` +
        'emittable as an action URN; serving null. The STORED loc needs repair — this is not a ' +
        'malformed caller request:',
      err,
    );
    return null;
  }
}

async function callerReadableAgentFilter(ctx: Context): Promise<Record<string, unknown>> {
  const live = { deletedAt: null };
  // This is the importedBy ROW-list audience, which includes the App's own
  // installed parents so App-key callers can see their adoption links. The
  // AgentImport.parentAgent object is separately checked against Query.agent.
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) return live;
  const or: Record<string, unknown>[] = [{ visibility: 'PUBLIC' }];
  if (ctx.userId) {
    const orgIds = await getMemberOrgIds(ctx.db, ctx.userId, ctx.impersonation?.orgId);
    if (orgIds.length > 0) or.push({ organizationId: { in: orgIds } });
    // spec 047: the caller's own org-less agents. Identity-scoped, so dropped
    // under impersonation (the shared-org session never sees user-owned rows).
    if (!ctx.impersonation) or.push({ ownerUserId: ctx.userId });
  }
  if (ctx.appId) or.push({ appAgents: { some: { appId: ctx.appId } } });
  return { ...live, OR: or };
}

export async function directReadableAgentFilter(ctx: Context): Promise<Record<string, unknown>> {
  const live = { deletedAt: null };
  // Query.agent applies strict user ownership before its org/admin branch.
  if (ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER')) {
    return {
      ...live,
      OR: [
        { visibility: 'PUBLIC' },
        { ownerUserId: null },
        ...(!ctx.impersonation && ctx.userId ? [{ ownerUserId: ctx.userId }] : []),
      ],
    };
  }
  const or: Record<string, unknown>[] = [{ visibility: 'PUBLIC' }];
  if (ctx.userId) {
    const orgIds = await getMemberOrgIds(ctx.db, ctx.userId, ctx.impersonation?.orgId);
    if (orgIds.length > 0) or.push({ organizationId: { in: orgIds } });
    if (!ctx.impersonation) or.push({ ownerUserId: ctx.userId });
  }
  return { ...live, OR: or };
}

type NestedAgentRow = {
  id: string;
  deletedAt: Date | null;
  visibility: string;
  organizationId: string | null;
  ownerUserId: string | null;
};

/** Match the Agent read gate, including the App credential's installed-Agent authority. */
export async function readableNestedAgent<T extends NestedAgentRow>(ctx: Context, agent: T | null | undefined): Promise<T | null> {
  if (!agent || agent.deletedAt) return null;
  if (agent.visibility === 'PUBLIC') return agent;
  if (ctx.appId && !ctx.userId && !ctx.impersonation) {
    // The join can outlive a revoked or expired grant. Reuse the live
    // install+license predicate that gates App-key session memory scope.
    if (await isAgentInstalledAndLicensed(ctx.db, ctx.appId, agent.id)) return agent;
  }
  try {
    await requireAgentAccess(ctx, agent, 'READER');
    return agent;
  } catch (error) {
    if (error instanceof GraphQLError && error.extensions.code === 'FORBIDDEN') return null;
    throw error;
  }
}

/**
 * #2640: the App's primary installed Agent as this caller may read it, or null (none installed, or withheld).
 * Every App field that names the primary Agent (`agentId`, `installedAgentUrn`) goes through here so none can
 * disclose what `agent` withholds.
 */
async function readablePrimaryAgent(
  ctx: Context,
  a: { id: string; appAgents?: unknown },
): Promise<(NestedAgentRow & { urn?: string }) | null> {
  const eager = readPrimaryAgentRecordFromEager(a) as (NestedAgentRow & { urn?: string }) | null | undefined;
  if (eager !== undefined) return readableNestedAgent(ctx, eager);
  const agent = await getPrimaryAgent(ctx.db, a.id);
  return readableNestedAgent(ctx, agent as (NestedAgentRow & { urn?: string }) | null);
}

/**
 * #853 — request-memoized "agent this caller may read", by id.
 *
 * `callerReadableAgentFilter` issues a membership query every call, and the
 * agent row is a second. An appRuns page allows 200 rows that commonly repeat
 * one agent, so the naive form costs up to 400 queries for a single selected
 * relation. Both halves are cached on the request Context, mirroring `loadApp`.
 */
function loadReadableAgent(ctx: Context, agentId: string): Promise<unknown | null> {
  const cache = (ctx.readableAgentCache ??= new Map<string, Promise<unknown | null>>());
  let pending = cache.get(agentId);
  if (!pending) {
    if ((ctx.appId && !ctx.userId && !ctx.impersonation) ||
        (!ctx.impersonation && isPlatformAdmin(ctx))) {
      // Pure App keys have a live installed-Agent exception to Query.agent's
      // user/org gate. The SQL audience filter cannot express grant lifecycle,
      // so use the same checked path as eager nested Agent relations.
      // #1787 (cor:dmo:050:13): a platform admin takes the same checked path —
      // the admin may MANAGE a user-owned Agent, so its nested point-read
      // routes through the gate, while the SQL filter (which also feeds the
      // LIST surfaces) keeps excluding other users' user-owned agents (#782).
      pending = ctx.db.agent.findUnique({ where: { id: agentId } })
        .then((agent) => readableNestedAgent(ctx, agent));
    } else {
      const filter = (ctx.readableAgentFilterCache ??= directReadableAgentFilter(ctx));
      pending = filter.then((readable) =>
        ctx.db.agent.findFirst({ where: { id: agentId, ...readable } }),
      );
    }
    cache.set(agentId, pending);
  }
  return pending;
}

/** A nested App object carries keys and members whose fields trust the App gate. */
async function loadReadableNestedApp(ctx: Context, appId: string) {
  const app = await loadApp(ctx, appId);
  if (!app || app.deletedAt) return null;
  try {
    await requireOwnerOrOrgRole(ctx, app, 'READER');
  } catch (error) {
    if (error instanceof GraphQLError && error.extensions.code === 'FORBIDDEN') return null;
    throw error;
  }
  return app;
}

async function filterReadableAppRows<T extends {
  id: string;
  organizationId: string | null;
  ownerUserId: string | null;
  deletedAt: Date | null;
}>(ctx: Context, apps: T[]): Promise<T[]> {
  if (apps.length === 0) return apps;
  // These callers already fetched the App rows. Use the same live-membership
  // scope as requireOrgRole once for the whole list, rather than reloading
  // each App and issuing one membership lookup per row.
  const orgIds = ctx.userId
    ? await getMemberOrgIds(ctx.db, ctx.userId, ctx.impersonation?.orgId)
    : [];
  const readableOrgIds = new Set(orgIds);
  const platformAdmin = ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER');
  return apps.filter((app) => {
    if (app.deletedAt) return false;
    if (app.ownerUserId !== null) {
      return !ctx.impersonation && !!ctx.userId && app.ownerUserId === ctx.userId;
    }
    return app.organizationId !== null && (platformAdmin || readableOrgIds.has(app.organizationId));
  });
}

async function loadReadableNestedOrganization(ctx: Context, orgId: string) {
  try {
    await requireOrgRole(ctx, orgId, 'READER');
  } catch (error) {
    if (error instanceof GraphQLError && error.extensions.code === 'FORBIDDEN') return null;
    throw error;
  }
  return ctx.db.organization.findUnique({ where: { id: orgId } });
}

/**
 * #853 — request-memoized entry-node resolution from a run's `entryNodeUrn`.
 * Resolving a URN costs a memory lookup plus a node lookup, and runs of one App
 * overwhelmingly share one entry node. Misses (deleted, moved, or an
 * unresolvable legacy URN) are cached too — all normal for a historical run.
 */
function loadEntryNode(ctx: Context, entryNodeUrn: string): Promise<{ memoryId: string } | null> {
  const cache = (ctx.entryNodeCache ??= new Map<string, Promise<{ memoryId: string } | null>>());
  let pending = cache.get(entryNodeUrn);
  if (!pending) {
    pending = (async () => {
      let id: string;
      try {
        ({ id } = await resolveNodeRef(ctx.db, entryNodeUrn));
      } catch {
        return null;
      }
      return ctx.db.node.findFirst({ where: { id, deletedAt: null } }) as Promise<{ memoryId: string } | null>;
    })();
    cache.set(entryNodeUrn, pending);
  }
  return pending;
}

/** An edge endpoint's memoryId (preloaded relation, or a memoized FK load). */
async function edgeEndpointMemoryId(
  ctx: Context,
  preloaded: unknown,
  endpointId: string,
): Promise<string | null> {
  const pre = preloaded as { memoryId?: string } | null | undefined;
  if (pre && typeof pre.memoryId === 'string') return pre.memoryId;
  const node = (await loadEdgeEndpointNode(ctx, endpointId)) as { memoryId?: string } | null;
  return node && typeof node.memoryId === 'string' ? node.memoryId : null;
}

/**
 * #781 — resolve an edge endpoint (source/target), gating a CROSS-memory
 * endpoint on the caller's read access.
 *
 * Every surface that hands the caller this Edge authorized the memory it was
 * scoped to — `edges`/`edge` and Node.outgoingEdges authorize on `Edge.memoryId`
 * (the source-side memory), Node.incomingEdges via the parent (target) node's
 * read, appNodes via the App. So the skip-the-check fast path is valid ONLY when
 * BOTH endpoints AND the edge all sit in one memory (`src == tgt == e.memoryId`):
 * that single memory is the authorized one, so both endpoints are safe (this is
 * the overwhelming majority, and it keeps appNodes system/app same-memory graphs
 * working). Crucially this also refuses the shortcut when `Edge.memoryId` is
 * STALE relative to the endpoints — a cross-memory node move can leave an A→B
 * edge's memoryId at A while both endpoints now live in B; without the
 * `== e.memoryId` clause an A-only reader would get both B nodes.
 *
 * Otherwise the requested endpoint is gated on its OWN memory via the
 * node-content gate (getAccessibleMemoryIds, see isMemoryReadableCached).
 * Denied ≡ null.
 */
async function resolveEdgeEndpoint(
  ctx: Context,
  e: { memoryId?: string; sourceId: string; targetId: string; source?: unknown; target?: unknown },
  side: 'source' | 'target',
): Promise<unknown | null> {
  const inherited = batchInheritedEndpoint(e, side);
  if (inherited) {
    const { endpoint, via } = inherited;
    // Metadata admission is not a body grant: recheck the exact effective
    // node when the endpoint object is selected, preserving the child view.
    const row = await loadEdgeEndpointNode(ctx, endpoint.id) as { id: string; memoryId: string; loc: string; role?: string | null; deletedAt: Date | null } | null;
    if (!row || row.deletedAt || row.memoryId !== endpoint.memoryId || row.loc !== endpoint.loc) return null;
    if ((endpoint.inheritedFrom || endpoint.memoryId === via) && !(await servedEndpointInEffect(ctx.db, via, endpoint.loc, { id: endpoint.id, memoryId: endpoint.memoryId, inheritedFrom: endpoint.inheritedFrom ?? null }, row))) return null;
    if (!endpoint.inheritedFrom && !(await isMemoryReadableCached(ctx, row.memoryId))) return null;
    return endpoint.inheritedFrom ? { ...row, inheritedFrom: endpoint.inheritedFrom } : row;
  }
  const wantId = side === 'source' ? e.sourceId : e.targetId;
  const wantPre = side === 'source' ? e.source : e.target;
  const otherId = side === 'source' ? e.targetId : e.sourceId;
  const otherPre = side === 'source' ? e.target : e.source;

  // The requested endpoint node — preloaded (even partially), else memoized FK.
  const pre = wantPre as { memoryId?: string; deletedAt?: Date | null } | null | undefined;
  const node =
    pre && typeof pre.memoryId === 'string' && pre.deletedAt !== undefined
      ? pre
      : ((await loadEdgeEndpointNode(ctx, wantId)) as { memoryId?: string; deletedAt?: Date | null } | null);
  if (!node || node.deletedAt || typeof node.memoryId !== 'string') return null;
  // #1893 — an endpoint stamped inherited was admitted through the child it
  // was read through (resolveInheritedEdges); its own memory is the base's,
  // which a child-only reader can't read, and must not be re-gated here.
  // The stamp is transient: no row loaded by FK ever carries it.
  if ((node as { inheritedFrom?: unknown }).inheritedFrom) return node;

  // Fast path: the edge and BOTH endpoints share one memory ⇒ that authorized
  // memory holds both endpoints, no per-endpoint check needed.
  const otherMem = await edgeEndpointMemoryId(ctx, otherPre, otherId);
  if (node.memoryId === e.memoryId && otherMem === e.memoryId) return node;

  // Cross-memory (or a stale/mismatched Edge.memoryId) → gate this endpoint on
  // its own memory's node-content access.
  return (await isMemoryReadableCached(ctx, node.memoryId)) ? node : null;
}

/**
 * Resolve one editor/approver candidate string to public identifiers:
 * 'github:<login>' matches the linked GitHub username case-insensitively;
 * 'email:<addr>' matches the account email case-insensitively; 'app:<id>'
 * is a non-user principal by construction (zero I/O); 'user:<id>' and a
 * bare ID-shaped value (isId — legacy reasons/commit messages never match)
 * look up the User PK. Returns { handle, urn } — never name/email/any PII.
 */
async function lookupRevisionEditorCandidate(
  ctx: Context,
  cand: string,
): Promise<{ handle: string; urn: string | null } | null> {
  let user: { handle: string | null } | null = null;
  if (cand.startsWith('app:')) {
    return null; // App-key principal — can never be a user.
  } else if (cand.startsWith('github:')) {
    const login = cand.slice('github:'.length);
    if (!login) return null;
    user = await ctx.db.user.findFirst({
      where: { githubUsername: { equals: login, mode: 'insensitive' }, deletedAt: null },
      select: { handle: true },
    });
  } else if (cand.startsWith('email:')) {
    const addr = cand.slice('email:'.length);
    if (!addr) return null;
    user = await ctx.db.user.findFirst({
      where: { email: { equals: addr, mode: 'insensitive' }, deletedAt: null },
      select: { handle: true },
    });
  } else {
    const id = cand.startsWith('user:') ? cand.slice('user:'.length) : cand;
    if (!isId(id)) return null; // shared ID-shape predicate (entityRef/shape)
    user = await ctx.db.user.findFirst({
      where: { id, deletedAt: null },
      select: { handle: true },
    });
  }
  if (!user?.handle) return null;
  return { handle: user.handle, urn: userUrn(user.handle) };
}

/**
 * Resolve a revision editor/approver candidate list (#617/#619/#620): first
 * candidate that resolves to a live, handle-bearing user wins. A node's
 * history overwhelmingly repeats the same few editor strings, so lookups are
 * memoized per request on the Context (same pattern as loadMemoryUrn /
 * loadEdgeEndpointNode) — a 50-row history costs one query per DISTINCT
 * candidate, negative results included.
 */
export function resolveRevisionEditor(
  ctx: Context,
  candidates: Array<string | null | undefined>,
): Promise<{ handle: string; urn: string | null } | null> {
  const cache = (ctx.revisionEditorCache ??= new Map<
    string,
    Promise<{ handle: string; urn: string | null } | null>
  >());
  const lookup = (cand: string) => {
    let pending = cache.get(cand);
    if (!pending) {
      pending = lookupRevisionEditorCandidate(ctx, cand);
      cache.set(cand, pending);
    }
    return pending;
  };
  return (async () => {
    for (const cand of candidates) {
      if (!cand) continue;
      const hit = await lookup(cand);
      if (hit) return hit;
    }
    return null;
  })();
}

type AuthoredState = {
  authorshipKind?: 'TASK' | 'HUMAN' | null;
  authoredByTask?: string | null;
  authoredByRevision?: number | null;
  authoredByHuman?: string | null;
  authoredAt?: Date | null;
};

type PendingTaskRef = { id: string; resolve: (ref: string | null) => void; reject: (error: unknown) => void };
const authorshipTaskBatches = new WeakMap<Context, { pending: Map<string, PendingTaskRef>; scheduled: boolean }>();

async function flushAuthorshipTasks(ctx: Context, batch: { pending: Map<string, PendingTaskRef>; scheduled: boolean }) {
  const pending = [...batch.pending.values()];
  batch.pending.clear();
  batch.scheduled = false;
  if (pending.length === 0) return;
  try {
    const tasks = await ctx.db.node.findMany({
      where: { id: { in: pending.map(({ id }) => id) }, deletedAt: null },
      select: { id: true, loc: true, memoryId: true },
    });
    const accessible = await getAccessibleMemoryIds(ctx);
    const readable = accessible === null ? null : new Set(accessible);
    const refs = new Map(await Promise.all(tasks.map(async (task) => [
      task.id,
      readable === null || readable.has(task.memoryId) ? await resolveNodeUrnField(task, ctx) : null,
    ] as const)));
    for (const item of pending) item.resolve(refs.get(item.id) ?? null);
  } catch (error) {
    for (const item of pending) item.reject(error);
  }
}

async function readableTaskRef(ctx: Context, taskId: string | null | undefined): Promise<string | null> {
  if (!taskId) return null;
  // Sibling authorship fields can cite many tasks. Batch their gated
  // projections and memoize each result (including concealed misses).
  const cache = ctx.readableTaskRefCache ??= new Map<string, Promise<string | null>>();
  let pending = cache.get(taskId);
  if (!pending) {
    let batch = authorshipTaskBatches.get(ctx);
    if (!batch) {
      batch = { pending: new Map(), scheduled: false };
      authorshipTaskBatches.set(ctx, batch);
    }
    pending = new Promise<string | null>((resolve, reject) => {
      batch!.pending.set(taskId, { id: taskId, resolve, reject });
    });
    cache.set(taskId, pending);
    if (!batch.scheduled) {
      batch.scheduled = true;
      setImmediate(() => { void flushAuthorshipTasks(ctx, batch!); });
    }
  }
  return pending;
}

async function resolveAuthorship(state: AuthoredState, ctx: Context) {
  if (!state.authorshipKind || !state.authoredAt) return null;
  const taskRef = state.authorshipKind === 'TASK'
    ? await readableTaskRef(ctx, state.authoredByTask)
    : null;
  return {
    kind: state.authorshipKind,
    taskRef,
    // Task identity and revision are a single claim; never reveal only half.
    taskRevision: taskRef ? state.authoredByRevision : null,
    human: state.authorshipKind === 'HUMAN'
      ? await resolveRevisionEditor(ctx, [state.authoredByHuman])
      : null,
    authoredAt: state.authoredAt,
  };
}

/**
 * #2715 — at most this many per-parent reconcile transactions in flight per request. GraphQL resolves a list's
 * `Node.revision` fields concurrently; unbounded, a 200-node `nodeBatch` asks the pool for 200 interactive
 * transactions at once, and those queued past `maxWait` (2 s) fail with Prisma P2028. Production's default pool is 5
 * (Prisma 6.19.2, physical CPUs x 2 + 1). The rest wait here, app-side, where no start deadline applies.
 *
 * #2721 — the bound is per request, not a reservation of pool capacity: two concurrent requests may request 8 of these
 * transactions against that 5-connection pool, and nothing here caps the process. What was tested is up to 20
 * concurrent 200-node batches at pool 5 with no P2028 (the #2720 QA receipt); other request concurrency, pool sizes
 * and deployments are untested. Reserving capacity for the rest of the server would need a process-wide limiter.
 */
export const NODE_RECONCILE_CONCURRENCY = 4;

/** Run `fn` once fewer than {@link NODE_RECONCILE_CONCURRENCY} of this request's reconciles are in flight (FIFO). */
function withReconcileSlot<T>(ctx: Context, fn: () => Promise<T>): Promise<T> {
  const slots = ctx.nodeReconcileSlots ??= { active: 0, waiting: [] };
  const run = () => {
    slots.active++;
    return fn().finally(() => {
      slots.active--;
      slots.waiting.shift()?.();
    });
  };
  if (slots.active < NODE_RECONCILE_CONCURRENCY) return run();
  return new Promise<T>((resolve, reject) => { slots.waiting.push(() => { run().then(resolve, reject); }); });
}

/**
 * Reconcile a raw writer's drift for a Node parent without mixing a later
 * writer's state into the GraphQL object already selected by the caller.
 * Queued behind {@link withReconcileSlot}: only WHEN the transaction starts changes, never what it reads or decides.
 */
async function reconciledNodeForParent(
  n: SnapshotSourceNode & { revSeq: number },
  ctx: Context,
): Promise<(SnapshotSourceNode & { revSeq: number }) | null> {
  // Sibling GraphQL fields resolve independently, often concurrently. Cache
  // by the selected parent OBJECT, not node id: two mutation fields in one
  // request may return different states of the same node.
  const cache = ctx.nodeReconcileCache ??= new WeakMap();
  const existing = cache.get(n);
  if (existing) return existing;
  const pending = withReconcileSlot(ctx, () => withReconciledNodeRead(ctx.db, n.id, n.memoryId, async (tx, mayReconcile) => {
    const fresh = await (mayReconcile ? liveTxContext : liveReadSnapshotContext)(ctx, tx);
    const inherited = (n as typeof n & { inheritedFrom?: InheritedFrom }).inheritedFrom;
    if (!(await isMemoryReadableCached(fresh, inherited?.via ?? n.memoryId))) return false;
    if (mayReconcile) await tx.$queryRaw`SELECT "id" FROM "nodes" WHERE "id" = ${n.id} FOR UPDATE`;
    // A newer number is safe only when every intervening revision came from
    // another reader's reconcile. An authored or edge write may have changed
    // the parent's state even when its tracked fields happen to look equal.
    const pre = await tx.node.findUnique({ where: { id: n.id }, select: { memoryId: true, revSeq: true } });
    if (!pre || pre.memoryId !== n.memoryId || pre.revSeq < n.revSeq) return false;
    if (pre.revSeq > n.revSeq) {
      const reconciles = await tx.nodeRevision.count({
        where: { nodeId: n.id, revNo: { gte: n.revSeq, lt: pre.revSeq }, editedByInfo: RECONCILE_EDITOR_INFO },
      });
      if (reconciles !== pre.revSeq - n.revSeq) return false;
    }
    return true;
  }, async (tx) => {
    const current = await tx.node.findUnique({ where: { id: n.id } });
    if (!current) return null;
    const key = sessionKeyCache.getByMemoryId(current.memoryId);
    if (key) decryptNodeFieldsWithKey(current, key);
    return revisionStateMatchesWithoutAuthorship(n, current) ? current : null;
  }, { timeoutMs: 5_000, maxWaitMs: 2_000 }));
  cache.set(n, pending);
  return pending;
}

/** The read resolver corrects a stale stamp without changing authored content. */
function revisionStateMatchesWithoutAuthorship(parent: SnapshotSourceNode, current: SnapshotSourceNode): boolean {
  return revisionStateMatches(
    { ...parent, ...clearNodeAuthorship() },
    { ...current, ...clearNodeAuthorship() },
  );
}

async function resolveContentValidation(
  state: { id?: string; nodeId?: string; memoryId?: string | null; revSeq?: number; revNo?: number | null },
  ctx: Context,
) {
  const nodeRevision = state.revSeq ?? state.revNo;
  if (nodeRevision == null) return { state: 'UNVALIDATED', latestReport: null };
  const nodeId = state.nodeId ?? state.id;
  if (!nodeId) return { state: 'UNVALIDATED', latestReport: null };
  // Legacy snapshots lacked memoryId. Their parent query already gated the
  // current memory; use that only for this legacy case.
  const memoryId = state.memoryId ?? (await ctx.db.node.findUnique({
    where: { id: nodeId }, select: { memoryId: true },
  }))?.memoryId;
  if (!memoryId) return { state: 'UNVALIDATED', latestReport: null };
  // A report captured in another memory is not exposed by moving the node.
  // GraphQL resolves list siblings concurrently, so collect their report and
  // task lookups into one request-scoped query per event-loop turn.
  const { report, taskRef } = await loadValidationReport(ctx, nodeId, memoryId, nodeRevision);
  if (!report) return { state: 'UNVALIDATED', latestReport: null };
  return {
    state: nodeContentValidationState(nodeRevision, report),
    latestReport: {
      nodeRevision: report.nodeRevSeq,
      validationTaskRef: taskRef,
      validationTaskRevision: taskRef ? report.validationTaskRevSeq : null,
      outcome: report.outcome,
      reportedAt: report.reportedAt,
    },
  };
}

type ValidationReportRow = {
  requestKey: string;
  nodeRevSeq: number;
  validationTaskId: string;
  validationTaskRevSeq: number;
  outcome: NodeContentValidationOutcome;
  reportedAt: Date;
};
type ValidationLookup = { report: ValidationReportRow | null; taskRef: string | null };
type PendingValidation = {
  key: string;
  nodeId: string;
  memoryId: string;
  revision: number;
  resolve: (value: ValidationLookup) => void;
  reject: (reason: unknown) => void;
  promise: Promise<ValidationLookup>;
};
const validationBatches = new WeakMap<Context, { pending: Map<string, PendingValidation>; scheduled: boolean }>();

/** Batch latest-report and readable-task projections across sibling Node fields. */
function loadValidationReport(ctx: Context, nodeId: string, memoryId: string, revision: number): Promise<ValidationLookup> {
  let batch = validationBatches.get(ctx);
  if (!batch) {
    batch = { pending: new Map(), scheduled: false };
    validationBatches.set(ctx, batch);
  }
  const key = JSON.stringify([nodeId, memoryId, revision]);
  const existing = batch.pending.get(key);
  if (existing) return existing.promise;
  let resolve!: PendingValidation['resolve'];
  let reject!: PendingValidation['reject'];
  const promise = new Promise<ValidationLookup>((res, rej) => { resolve = res; reject = rej; });
  batch.pending.set(key, { key, nodeId, memoryId, revision, resolve, reject, promise });
  if (!batch.scheduled) {
    batch.scheduled = true;
    setImmediate(() => { void flushValidationBatch(ctx, batch!); });
  }
  return promise;
}

async function flushValidationBatch(
  ctx: Context,
  batch: { pending: Map<string, PendingValidation>; scheduled: boolean },
): Promise<void> {
  const pending = [...batch.pending.values()];
  batch.pending.clear();
  batch.scheduled = false;
  if (pending.length === 0) return;
  try {
    const values = Prisma.join(pending.map((item) => Prisma.sql`
      (${item.key}::text, ${item.nodeId}::text, ${item.memoryId}::text, ${item.revision}::integer)
    `));
    const reports = await ctx.db.$queryRaw<ValidationReportRow[]>(Prisma.sql`
      WITH wanted(request_key, node_id, memory_id, rev_seq) AS (VALUES ${values})
      SELECT w.request_key AS "requestKey", r.node_rev_seq AS "nodeRevSeq",
             r.validation_task_id AS "validationTaskId",
             r.validation_task_rev_seq AS "validationTaskRevSeq", r.outcome,
             r.reported_at AS "reportedAt"
      FROM wanted w
      JOIN LATERAL (
        SELECT node_rev_seq, validation_task_id, validation_task_rev_seq, outcome, reported_at
        FROM node_content_validation_reports
        WHERE node_id = w.node_id AND memory_id = w.memory_id AND node_rev_seq <= w.rev_seq
        ORDER BY node_rev_seq DESC, reported_at DESC, id DESC
        LIMIT 1
      ) r ON TRUE
    `);
    const byKey = new Map(reports.map((report) => [report.requestKey, report]));
    const taskIds = [...new Set(reports.map((report) => report.validationTaskId))];
    const tasks = taskIds.length === 0 ? [] : await ctx.db.node.findMany({
      where: { id: { in: taskIds }, deletedAt: null },
      select: { id: true, loc: true, memoryId: true },
    });
    // Use the GraphQL node-content gate, including active-session isolation.
    // One access fold replaces a per-report task-memory check.
    const accessible = tasks.length === 0 ? [] : await getAccessibleMemoryIds(ctx);
    const readable = accessible === null ? null : new Set(accessible);
    const taskRefs = new Map(await Promise.all(tasks.map(async (task) => [
      task.id,
      readable === null || readable.has(task.memoryId) ? await resolveNodeUrnField(task, ctx) : null,
    ] as const)));
    for (const item of pending) {
      const report = byKey.get(item.key) ?? null;
      item.resolve({ report, taskRef: report ? taskRefs.get(report.validationTaskId) ?? null : null });
    }
  } catch (error) {
    for (const item of pending) item.reject(error);
  }
}


/** The Session parent shape the liveness fields read; partial on a narrow select. */
type SessionLivenessParent = {
  id: string;
  appId?: string | null;
  type?: SessionType;
  startedAt?: Date;
  updatedAt?: Date | null;
  autoExpiredAt?: Date | null;
  endedAt?: Date | null;
  deletedAt?: Date | null;
  expiresAt?: Date | null;
};

/**
 * #1623 review (local reviewer, two P2s): the fallback point read, memoized per
 * request and session id. Without it a narrow parent selecting both `isLive`
 * and `lapsesAt` read the row twice, and the two reads could straddle an
 * `endSession`, answering `{ isLive: true, lapsesAt: null }`. Sharing one read
 * per request makes both fields describe ONE snapshot. Every Session resolver
 * on main returns full rows today, so this path is defensive.
 */
const livenessRowReads = new WeakMap<object, Map<string, Promise<unknown>>>();
function readLivenessRowOnce(ctx: Context, id: string) {
  let perRequest = livenessRowReads.get(ctx);
  if (!perRequest) {
    perRequest = new Map();
    livenessRowReads.set(ctx, perRequest);
  }
  let read = perRequest.get(id);
  if (!read) {
    read = ctx.db.session.findUnique({
      where: { id },
      select: { id: true, appId: true, type: true, startedAt: true, updatedAt: true, autoExpiredAt: true, endedAt: true, deletedAt: true, expiresAt: true },
    });
    perRequest.set(id, read);
  }
  return read as Promise<{
    id: string; appId: string | null; type: SessionType; startedAt: Date; updatedAt: Date | null;
    autoExpiredAt: Date | null; endedAt: Date | null; deletedAt: Date | null; expiresAt: Date | null;
  } | null>;
}

/**
 * #2288: retain terminal evidence and memoize one row/activity snapshot for
 * all three fields, including sequential narrow-parent reads. Never mutate it.
 */
const sessionSnapshots = new WeakMap<object, Map<string, ReturnType<typeof loadSessionSnapshot>>>();
const fullSessionSnapshots = new WeakMap<object, WeakMap<object, ReturnType<typeof loadSessionSnapshot>>>();
const hasSessionColumns = (s: SessionLivenessParent) => !!s.type && !!s.startedAt
  && s.deletedAt !== undefined && s.expiresAt !== undefined && s.appId !== undefined;
const sessionReadTimes = new WeakMap<object, Date>();
function sessionReadTime(ctx: Context): Date {
  let now = sessionReadTimes.get(ctx);
  if (!now) { now = new Date(); sessionReadTimes.set(ctx, now); }
  return now;
}
async function loadSessionSnapshot(ctx: Context, s: SessionLivenessParent) {
  const now = sessionReadTime(ctx);
  const row = hasSessionColumns(s)
    ? s
    : await readLivenessRowOnce(ctx, s.id);
  if (!row || !row.type || !row.startedAt) return null;
  const session = {
    id: row.id, appId: row.appId ?? null, type: row.type, startedAt: row.startedAt,
    updatedAt: row.updatedAt ?? null, autoExpiredAt: row.autoExpiredAt ?? null,
    endedAt: row.endedAt ?? null, deletedAt: row.deletedAt ?? null, expiresAt: row.expiresAt ?? null,
  };
  const lastEventAt = session.endedAt || session.deletedAt ? null : await lastEventAtBatched(ctx, row.id);
  return { row: session, lastEventAt, now };
}
function sessionSnapshot(ctx: Context, s: SessionLivenessParent) {
  // A serial mutation may return a NEW full parent for the same id. Share a
  // snapshot among that parent's fields, not across distinct mutation results.
  // Preserve the historical id memo only for narrow fallback parents.
  if (hasSessionColumns(s)) {
    let parents = fullSessionSnapshots.get(ctx);
    if (!parents) { parents = new WeakMap(); fullSessionSnapshots.set(ctx, parents); }
    let snapshot = parents.get(s);
    if (!snapshot) { snapshot = loadSessionSnapshot(ctx, s); parents.set(s, snapshot); }
    return snapshot;
  }
  let rows = sessionSnapshots.get(ctx);
  if (!rows) { rows = new Map(); sessionSnapshots.set(ctx, rows); }
  let snapshot = rows.get(s.id);
  if (!snapshot) { snapshot = loadSessionSnapshot(ctx, s); rows.set(s.id, snapshot); }
  return snapshot;
}

/** Read each session's OWN App policy, batched and memoized for the request. */
const dormancyPolicies = new WeakMap<object, Map<string, Promise<number>>>();
const dormancyPolicyBatches = new WeakMap<object, { ids: Set<string>; result: Promise<Map<string, number>> }>();
function sessionDormancyDays(ctx: Context, appId: string | null): Promise<number> {
  if (!appId) return Promise.resolve(DEFAULT_SESSION_DORMANCY_DAYS);
  let cache = dormancyPolicies.get(ctx);
  if (!cache) { cache = new Map(); dormancyPolicies.set(ctx, cache); }
  let policy = cache.get(appId);
  if (!policy) {
    let batch = dormancyPolicyBatches.get(ctx);
    if (!batch) {
      const ids = new Set<string>();
      const result = Promise.resolve().then(async () => {
        dormancyPolicyBatches.delete(ctx);
        const rows = await ctx.db.app.findMany({ where: { id: { in: [...ids] } }, select: { id: true, sessionDormancyDays: true } });
        return new Map(rows.map(row => [row.id, row.sessionDormancyDays]));
      });
      batch = { ids, result };
      dormancyPolicyBatches.set(ctx, batch);
    }
    batch.ids.add(appId);
    policy = batch.result.then(rows => rows.get(appId) ?? DEFAULT_SESSION_DORMANCY_DAYS);
    cache.set(appId, policy);
  }
  return policy;
}

/**
 * hadron-cli#791 — the latest attributed usage event for a session, batched
 * per request: every `Session.isLive` resolved in the same tick shares ONE
 * grouped query. The repo has no DataLoader; GraphQL invokes a list's item
 * resolvers synchronously, so the whole page joins the batch before the
 * microtask that runs it.
 */
const lastEventBatches = new WeakMap<object, { ids: Set<string>; result: Promise<Map<string, Date | null>> }>();
function lastEventAtBatched(ctx: Context, sessionId: string): Promise<Date | null | undefined> {
  let batch = lastEventBatches.get(ctx);
  if (!batch) {
    const ids = new Set<string>();
    const result = Promise.resolve().then(() => {
      lastEventBatches.delete(ctx);
      return loadLastEventBySession(ctx.db as never, [...ids]);
    });
    batch = { ids, result };
    lastEventBatches.set(ctx, batch);
  }
  batch.ids.add(sessionId);
  return batch.result.then((byId) => byId.get(sessionId));
}

export const typeResolvers = {
  ...servedPromptTypeResolvers,
  Chat: {
    servedPrompts: servedPromptOwnerFields.chatServedPrompts,
  },
  McpServer: {
    // headersEncrypted is not in the GraphQL type at all; readers get only
    // this boolean (write-only secret posture, same as tool-held tokens).
    hasHeaders: (s: { headersEncrypted?: string | null }) => s.headersEncrypted != null,
  },
  // HomeAssistantInstance / Secret have no entry: their encrypted columns
  // (tokenEncrypted, valueEncrypted) are absent from the GraphQL type entirely
  // (write-only secret posture, #677), so there is nothing to derive — and
  // since #205 their timestamps serialize through the DateTime scalar.
  ResendSender: {
    hasApiKey: (s: { apiKeyEncrypted?: string | null }) => s.apiKeyEncrypted != null,
    from: (s: { fromAddress: string }) => s.fromAddress,
  },
  CompiledBootPrompt: {
    lintWarnings: (r: { node: { id: string }; revNo: number }, args: { first?: number | null; after?: string | null }, ctx: Context) =>
      import('../../../lib/compiledBootPromptLint.js').then(m => m.lintCompiledRevision(ctx, r.node.id, r.revNo, args)),
  },
  NodeApprovalReceipt: {
    /** #2048 — the same warnings as Node.lintWarnings, for the node just approved; approving never blocked on them. */
    lintWarnings: (r: { nodeId: string }, args: { first?: number | null; after?: string | null }, ctx: Context) =>
      lintWarningPageForNodeId(ctx, r.nodeId, args),
  },
  Node: {
    indexTruncated: async (n: { id: string; embeddingTruncatedChunks?: number | null }, _: unknown, ctx: Context) => {
      const count = n.embeddingTruncatedChunks !== undefined ? n.embeddingTruncatedChunks
        : (await ctx.db.node.findUnique({ where: { id: n.id }, select: { embeddingTruncatedChunks: true } }))?.embeddingTruncatedChunks;
      return count != null && count > 0 ? { omittedChunks: count } : null;
    },
    outgoingEdges: (n: { id: string; memoryId: string }, _: unknown, ctx: Context) => batchReadEdges(n, ctx, 'out'),
    incomingEdges: (n: { id: string; memoryId: string }, _: unknown, ctx: Context) => batchReadEdges(n, ctx, 'in'),
    /** #2048 — link lint, computed on read from the stored source and the caller's own reads; null when unavailable. */
    lintWarnings: (
      n: { id: string; memoryId: string; content: string | null; role?: string | null; nodeType?: string | null },
      args: { first?: number | null; after?: string | null },
      ctx: Context,
    ) => lintWarningPage(ctx, n, args),
    /**
     * #2041 — the one place a node's include tags resolve for a reader
     * (cor:dmo:150:03), so every path that reaches `Node.content` is covered
     * and a new surface can't forget it. The row is never rewritten.
     */
    content: async (
      n: Parameters<typeof resolveNodeContent>[1],
      args: { raw?: boolean | null },
      ctx: Context,
    ) => resolveNodeContent(ctx, n, {
      raw: args.raw ?? (n as { [CONTENT_RAW_DEFAULT]?: boolean })[CONTENT_RAW_DEFAULT] ?? false,
    }),
    authorship: async (n: SnapshotSourceNode & { revSeq: number }, _: unknown, ctx: Context) => {
      if (!n.authorshipKind || !n.authoredAt) return null;
      // Start the task lookup before per-node reconciliation so sibling list
      // fields contribute their distinct author tasks to one request batch.
      // A stale parent may lose its stamp; never return the prefetched claim
      // without checking the reconciled row below.
      const selectedTask = n.authorshipKind === 'TASK'
        ? readableTaskRef(ctx, n.authoredByTask).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        : null;
      // A raw writer can change authored content without refreshing its
      // fingerprint. Reconcile even when the client selects only authorship:
      // no other GraphQL field is guaranteed to run first. Compare the
      // parent's content after ignoring its stale stamp; a concurrent
      // supported edit must not lend its new authorship to this old parent.
      const current = await reconciledNodeForParent(n, ctx);
      // If the selected parent no longer matches a reconcilable live state,
      // its stamp cannot be verified here. An absent claim is safer than
      // attributing raw drift that a concurrent writer has since overwritten.
      if (!current) return null;
      if (selectedTask && current.authorshipKind === 'TASK' && current.authoredByTask === n.authoredByTask) {
        const selected = await selectedTask;
        if (!selected.ok) throw selected.error;
      }
      return resolveAuthorship(current, ctx);
    },
    contentValidation: async (
      n: SnapshotSourceNode & { revSeq: number; revisionContentHash: string | null },
      _: unknown,
      ctx: Context,
    ) => {
      // Start the report lookup while sibling Node revisions reconcile. On a
      // list this lets the request loader collect all selected parents in one
      // turn. If raw drift advances this node's revision, re-query using the
      // corrected cutoff before returning its validation state.
      const selectedReport = resolveContentValidation(n, ctx).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      // Match Node.revision's lazy raw-writer reconcile, so a response cannot
      // display the advanced revision beside validation for the old number.
      const revSeq = await typeResolvers.Node.revision(n, _, ctx);
      if (revSeq !== n.revSeq) return resolveContentValidation({ ...n, revSeq }, ctx);
      const selected = await selectedReport;
      if (!selected.ok) throw selected.error;
      return selected.value;
    },
    revision: async (
      n: SnapshotSourceNode & {
        revSeq: number;
        revisionContentHash: string | null;
      },
      _args: unknown,
      ctx: Context,
    ) => {
      // Raw writers are detected lazily. The canonical fingerprint is computed
      // by PostgreSQL because the revision state includes JSON/array fields
      // whose text encoding is not portable across runtimes. Reconcile + refetch under one lock,
      // then use the new number only when the selected content still matches.
      // The reconcile itself may clear a stale authorship stamp; the field
      // resolver presents that corrected stamp, so its change is allowed here.
      const current = await reconciledNodeForParent(n, ctx);
      return current?.revSeq ?? n.revSeq;
    },
    tags: (node: { tags: string | string[] }) => deserializeTags(node.tags),
    // The referenced asset for a `reference` node carrying data.asset
    // (createAssetReferenceNode / hadron_store_file). Resolves the soft
    // pointer and returns null when it dangles — there is no FK behind
    // data.asset.id (cor:dmo:060:10 reserves the schema-level link), so
    // the asset can be gone or soft-deleted while the node survives.
    //
    // Same-memory asset needs no extra gate: reaching this Node already
    // required its memory's read gate, and an Asset is bound to a
    // Memory, so an asset in that same memory is already in scope.
    //
    // A CROSS-memory pointer does need one. createAssetReferenceNode
    // permits referencing an asset from another memory (read there +
    // write here), and `data` is writable through ordinary node
    // mutations besides — so a hand-written data.asset.id could name an
    // asset in a memory the reader cannot see. Re-gate on the asset's
    // OWN memory in that case; null on failure, since a field that
    // throws would break the whole node read over a stale pointer.
    asset: async (
      n: { memoryId: string; data?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      // #876: never resolve an asset under impersonation. Every other
      // asset surface denies impersonation outright, and this field
      // would otherwise route around them — the ad-hoc auth object
      // below cannot carry ctx.impersonation, so canReadMemory would
      // evaluate the TARGET's ordinary access across all their orgs,
      // not the session's org scope.
      //
      // The stakes here are higher than a normal metadata read: asset
      // ids are the credential for the unauthenticated GET /assets/:id
      // hotlink, so disclosing an id effectively grants the bytes.
      if (ctx.impersonation) return null;

      const data = n.data as { asset?: { id?: unknown } } | null | undefined;
      const assetId = data?.asset?.id;
      if (typeof assetId !== 'string' || !assetId) return null;
      const asset = await ctx.db.asset.findUnique({ where: { id: assetId } });
      if (!asset || asset.deletedAt || !asset.memoryId) return null;
      if (asset.memoryId !== n.memoryId) {
        const readable = await canReadMemory(
          ctx.db,
          {
            userId: ctx.userId,
            appId: ctx.appId,
            roles: ctx.roles,
            organizationId: ctx.organizationId,
          },
          asset.memoryId,
        );
        if (!readable) return null;
      }
      return asset;
    },
    // #2193 (cor:acl:110, cor:api:140:03): the memory RECORD, exactly as
    // Query.memory answers it to this caller, else null. The parent that
    // handed out this node authorized the node by its own rule (a Worker's
    // team-visible handoff, an App's install scope), never the memory record,
    // so the record is gated here, once per memory per request. A client that
    // only needs the address has Node.urn / Node.memoryId.
    //
    // A preloaded `memory` is deliberately ignored, never trusted (#474):
    // appNodes preloads a truncated row (id/urn/name/organizationId) for
    // Node.urn, and a preload is no authorization decision either.
    memory: (n: { memoryId: string }, _: unknown, ctx: Context) => loadReadableMemoryRecord(ctx, n.memoryId),
    // #481 — see resolveNodeUrnField.
    urn: (
      n: { loc: string; memoryId: string; memory?: { urn?: string } | null },
      _: unknown,
      ctx: Context,
    ) => resolveNodeUrnField(n, ctx),
    // #881 — the portal link for this node, so a client (the CLI's `node get`,
    // an agent citing a source to a human) hands over a URL instead of
    // assembling one out of a URN spelling the /app/u route may not resolve.
    // Nullable: no configured portal origin ⇒ no link (see lib/portalUrl.ts).
    // Built from the SAME URN the `urn` field returns, so the two can't diverge.
    portalUrl: async (
      n: { loc: string; memoryId: string; memory?: { urn?: string } | null },
      _: unknown,
      ctx: Context,
    ) => portalUrlForUrn(await resolveNodeUrnField(n, ctx)),
    // #2610 — the action-register address for a register:<code> entry in an
    // Agent system memory; null for every other node. A second address beside
    // `urn` (which keeps resolving), computed from the holding Agent's own urn.
    actionUrn: (n: { loc: string; memoryId: string }, _: unknown, ctx: Context) =>
      resolveNodeActionUrnField(n, ctx),
    // #1885 — stamped by the effective-system-memory reads (markInherited);
    // absent everywhere else, which reads as not inherited.
    inheritedFrom: (n: { inheritedFrom?: InheritedFrom }) =>
      n.inheritedFrom ? { agentId: n.inheritedFrom.agentId, agentUrn: emitEntityUrnV2('agent', n.inheritedFrom.agentUrn) } : null,
  },
  GraphEdge: {
    // #2124 — same strict projection as Edge.governedKind.
    governedKind: (e: { governedKind?: unknown }) => projectGovernedKind(e.governedKind),
  },
  Edge: {
    // `Edge.source` / `Edge.target` are NULLABLE (`Node`) in the schema, for two
    // reasons:
    //   (1) callers preload only the relevant endpoint per direction (e.g.
    //       nodeById does `outgoingEdges: { include: { target: true } }` — source
    //       is NOT loaded — and the mirror for incomingEdges). The unloaded side
    //       is lazily loaded by FK, memoized per request (edges in a list share
    //       endpoints — e.g. every outgoing edge of one node shares its source),
    //       so each endpoint node is read at most once per request. #381.
    //   (2) #781 — cross-memory endpoint gate. A cross-memory edge (source in
    //       memory A, target in memory B) is reachable by a caller who can read
    //       only ONE side (e.g. Node.incomingEdges surfaces an edge whose source
    //       lives in a memory the caller never authorized). The endpoint
    //       resolvers previously loaded the node by FK with no re-check, leaking
    //       the far node's data across tenants. resolveEdgeEndpoint gates a
    //       CROSS-memory endpoint on the caller's read access to its OWN memory;
    //       a SAME-memory edge's endpoints sit in the already-authorized memory
    //       (every surface that surfaced this edge authorized that memory), so
    //       they need no per-endpoint check. Denied ≡ null.
    source: (e: { memoryId?: string; sourceId: string; targetId: string; source?: unknown; target?: unknown }, _: unknown, ctx: Context) =>
      resolveEdgeEndpoint(ctx, e, 'source'),
    target: (e: { memoryId?: string; sourceId: string; targetId: string; source?: unknown; target?: unknown }, _: unknown, ctx: Context) =>
      resolveEdgeEndpoint(ctx, e, 'target'),
    // #481 parity — edges are loc-addressed peers of nodes (spec 037), so
    // they carry their fully-qualified URN the same way. Edge.memoryId is the
    // denormalized SOURCE-side memory, which is exactly the URN's memory.
    // #2124 — the edge's own stored kind through the one strict projection.
    governedKind: (e: { governedKind?: unknown }) => projectGovernedKind(e.governedKind),
    urn: async (e: { loc: string; memoryId: string }, _: unknown, ctx: Context) => {
      const memUrn = await loadMemoryUrn(ctx, e.memoryId);
      if (!memUrn) return `hrn:edge:unknown:${e.loc}`;
      try {
        return emitEdgeUrnV2(memUrn, e.loc);
      } catch (err) {
        console.warn(`[Edge.urn] failed to emit v2 edge urn for memory "${memUrn}":`, err);
        // Best-effort flat-v2 fallback (single colon, never throws) — see the
        // Node.urn note on not re-canonicalizing a malformed stored value.
        return bestEffortFlatNodeUrn('edge', memUrn, e.loc);
      }
    },
  },
  NodeRevision: {
    // #1838 — the per-revision answer, from the one shared derivation.
    revisionApproval: async (nv: { nodeId: string; revNo: number | null }, _: unknown, ctx: Context) => {
      const { state, record } = nv.revNo == null
        ? { state: 'NOT_APPROVED' as const, record: null }
        : await revisionApprovalOf(ctx.db, nv.nodeId, nv.revNo);
      return {
        state,
        approved: state === 'APPROVED',
        recordedAtRevision: record?.revision ?? null,
        approvedBy: record?.approvedBy ?? null,
        approvedByInfo: record?.approvedByInfo ?? null,
        approvedAt: record?.approvedAt ?? null,
      };
    },
    authorship: (nv: AuthoredState, _: unknown, ctx: Context) => resolveAuthorship(nv, ctx),
    contentValidation: (
      nv: { nodeId: string; memoryId: string | null; revNo: number | null },
      _: unknown,
      ctx: Context,
    ) => resolveContentValidation(nv, ctx),
    // #696 — the computed end-anchored noderev URN. Null for legacy rows with
    // no revNo, and for the rare multi-segment per-user memory the flat shape
    // can't express (the compose helper throws → served as null, never crashes).
    urn: async (
      nv: { loc: string; revNo?: number | null; memoryId?: string | null; nodeId: string },
      _: unknown,
      ctx: Context,
    ) => {
      if (nv.revNo == null) return null;
      // Reuse the request-memoized memory-urn loader (the same one Node.urn /
      // Edge.urn use) so a revision-list surface doesn't N+1 (#696 review).
      let memUrn: string | null = nv.memoryId ? await loadMemoryUrn(ctx, nv.memoryId) : null;
      if (!memUrn) {
        // Legacy rows (null memoryId) — fall back to the node's current memory.
        const node = await ctx.db.node.findUnique({
          where: { id: nv.nodeId },
          select: { memoryId: true },
        });
        memUrn = node?.memoryId ? await loadMemoryUrn(ctx, node.memoryId) : null;
      }
      if (!memUrn) return null;
      try {
        return composeNodeRevUrn(memUrn, nv.loc, nv.revNo);
      } catch {
        return null;
      }
    },
    // Prisma reads a NULL scalar list as [] already; belt-and-suspenders for
    // rows that arrive from raw queries (#620 legacy rows).
    changes: (nv: { changes?: string[] | null }) => nv.changes ?? [],
    // #617/#619/#620 — resolve the revision's editor to PUBLIC identifiers
    // only: handle + urn, never name/email. Candidates in preference order:
    //   1. editedBy — post-#620 this holds ONLY a User id;
    //   2. createdBy — legacy rows captured `userId ?? clientId` here (user
    //      preferred), which resolves history the #620 migration couldn't
    //      backfill (#619);
    //   3. editedByInfo — identity-string forms: 'github:<login>' resolves
    //      via the linked GitHub username (case-insensitive), 'email:<addr>'
    //      via the account email, 'user:<id>' by PK (#619).
    // A non-resolving principal, a deleted user, or a handle-less user all
    // yield null (the portal falls back to the raw strings). handle/urn are
    // the same public identifiers the `users` search exposes, so no
    // per-caller visibility gate is needed (and no PII can leak — none is
    // returned).
    editedByUser: async (
      nv: { editedBy?: string | null; createdBy?: string | null; editedByInfo?: string | null },
      _: unknown,
      ctx: Context,
    ) => resolveRevisionEditor(ctx, [nv.editedBy, nv.createdBy, nv.editedByInfo]),
    // #620 — same public-identifier resolution for the (reserved) approver.
    approvedByUser: async (nv: { approvedBy?: string | null }, _: unknown, ctx: Context) =>
      resolveRevisionEditor(ctx, [nv.approvedBy]),
  },
  AppRun: {
    /** #2047: the run's record, self-authorized (the run read gate). */
    servedPrompt: servedPromptOwnerFields.runServedPrompt,
    // #2439: BigInt over the wire as a string, like UsageEvent.costMicroCents; NULL = unknown.
    costMicroCents: (r: { costMicroCents?: bigint | null }) => r.costMicroCents != null ? r.costMicroCents.toString() : null,
    failureReason: async (
      r: { status: string; failure: unknown; budgetTokens: number | null; budgetActions: number | null; appId?: string | null; triggerKind?: string | null; triggerId?: string | null },
      _: unknown,
      ctx: Context,
    ) => {
      const f = r.failure as { code?: unknown; reason?: unknown } | null;
      // Only a CHANGED reason can carry a name; look it up only then (#2642).
      const changed = !!f && typeof f === 'object' && f.code === 'AUTOMATION_CHANGED' && f.reason !== 'MEMORY_UNREADABLE';
      return plainRunFailure(r, changed ? { automationLabel: await authorizedTriggerLabel(ctx, r) } : undefined);
    },
    /**
     * Spec 049 Phase 3b — the run's scope as the CALLER may read it: the mint
     * snapshot ∩ the caller's current access (a lens never grants), or null
     * when the run carries no named scope (its view is then `app`).
     */
    /**
     * Spec 049 Phase 6 — snapshot rows, with the Agent-in-App attendee's
     * current access. The viewer still controls host-memory identity redaction.
     */
    register: async (r: { registerSnapshot: unknown }, _: unknown, ctx: Context) => {
      const snap = parseRunRegisterSnapshot(r.registerSnapshot);
      if (!snap) return [];
      const view = await resolveRegister(ctx.db, { attendee: snap.attendee, actor: ctx, accessActor: 'ATTENDEE', rows: snapshotRowsAsEntries(snap) });
      return view ? toGqlRegisterRows(view) : [];
    },
    scope: async (r: { appId: string; scopeSnapshot: unknown }, _: unknown, ctx: Context) => {
      if (parseRunScopeSnapshot(r.scopeSnapshot) === null) return null;
      // Request-memoized on the snapshot itself: a run page repeats one
      // trigger's snapshot across its rows, and the projection is the caller's
      // access ∩ that snapshot — the same answer for every row that carries it
      // (Copilot on PR #1163). Keyed on the serialized snapshot, not the scope
      // id, because two snapshots of one scope can differ.
      const cache = (ctx.runScopeInfoCache ??= new Map());
      const key = `${r.appId}\0${JSON.stringify(r.scopeSnapshot)}`;
      let pending = cache.get(key);
      if (!pending) {
        pending = resolveRunScope(ctx, r).then((res) => scopeInfoOf(ctx, res));
        cache.set(key, pending);
      }
      return pending;
    },
    // #696 — the computed hrn:apprun:<root>:<app>:<run-id> URN. Null for the
    // rare multi-segment App URN the flat shape can't express (compose throws →
    // served as null, never crashes the run audit surface).
    urn: async (r: { id: string; appId: string }, _: unknown, ctx: Context) => {
      // Request-memoized app-urn loader — a run-list page usually shares one App
      // across many runs, so this avoids an N+1 (#696 review).
      const appUrn = await loadAppUrn(ctx, r.appId);
      if (!appUrn) return null;
      try {
        return composeAppRunUrn(appUrn, r.id);
      } catch {
        return null;
      }
    },
    // #831 — relation fields so a CROSS-APP audit list can render names instead
    // of raw cuids. Each is gated on its OWN entity, never on the outer
    // `appRuns` org-READER gate: a nested object hands the caller that type's
    // whole field-resolver surface, including App scalars that cannot
    // re-check (findings:broadening-read-gate-leaks-nested-objects, #552).
    //
    // Every one is nullable and denial is silent. Throwing would fail the whole
    // page over one unreadable relation, and the FK scalars (appId / agentId /
    // userId / entryNodeUrn) remain the durable audit record regardless.
    app: async (r: { appId: string }, _: unknown, ctx: Context) => {
      // Request-memoized: a run-list page usually shares one App across many
      // rows (the #696 reason AppRun.urn memoizes the urn lookup).
      const app = await loadApp(ctx, r.appId);
      if (!app || app.deletedAt) return null;
      // Same bar as a direct `app(ref:)` read: `requireOwnerOrOrgRole`, i.e.
      // org member for an ORG-owned App, and STRICTLY the owner for a
      // user-owned one — there is NO platform-admin bypass on the user-owned
      // shape (PR #853 review, Copilot; the owner-only test pins it). In the
      // common case the caller already cleared org-READER on the run's org and
      // this passes; it is the cross-org and user-owned shapes that need it.
      try {
        await requireOwnerOrOrgRole(ctx, app, 'READER');
      } catch {
        return null;
      }
      return app;
    },
    agent: async (r: { agentId?: string | null }, _: unknown, ctx: Context) => {
      if (!r.agentId) return null;
      // Reuse the shared agent-read predicate (#757) rather than a bespoke
      // check, so this can't drift from `agent(ref:)`. Both the predicate (it
      // queries org memberships) and the row lookup are request-memoized: a
      // 200-row page commonly repeats one agent, and without this the field
      // costs up to 400 queries (PR #853 review, Codex P2).
      return loadReadableAgent(ctx, r.agentId);
    },
    user: async (r: { userId?: string | null }, _: unknown, ctx: Context) => {
      if (!r.userId) return null;
      // #853 review (Codex P1 / Copilot): knowing `userId` does NOT authorize
      // the User record. `Query.user(ref:)` returns null unless the caller is
      // that user, a platform admin, or shares an org with them — and only
      // name/email/googleId/appleId have field resolvers, so `policy`,
      // `identityProvider`, `externalId`, `roles` and `maxReferrals` resolve by
      // default and WOULD be exposed. A run executed on behalf of an AppMember
      // or subscriber who is not a co-member is exactly that case.
      //
      // Gate on the same shared predicate (self / platform admin / shares an
      // org), so this cannot drift from `user(ref:)`. Denied ≡ null.
      if (!(await canSeeUserPersonalFields(ctx, r.userId))) return null;
      return ctx.db.user.findFirst({ where: { id: r.userId, deletedAt: null } });
    },
    entryNode: async (r: { entryNodeUrn?: string | null; entryNodeId?: string | null }, _: unknown, ctx: Context) => {
      // #2438: prefer the stable id — entryNodeUrn is the address at mint and
      // goes stale after a rename or move; the id keeps pointing at the node.
      // Legacy rows (null id) keep the URN path.
      if (r.entryNodeId) {
        const byId = await ctx.db.node.findFirst({ where: { id: r.entryNodeId, deletedAt: null } });
        return byId && await isMemoryReadableCached(ctx, byId.memoryId) ? byId : null;
      }
      if (!r.entryNodeUrn) return null;
      // Request-memoized: resolving a URN is a memory lookup PLUS a node
      // lookup, and runs of one App overwhelmingly share an entry node
      // (PR #853 review, Copilot).
      const node = await loadEntryNode(ctx, r.entryNodeUrn);
      if (!node) return null;
      // Node CONTENT gate — the same predicate node reads and the #781 edge
      // endpoints use.
      return (await isMemoryReadableCached(ctx, node.memoryId)) ? node : null;
    },
  },
  Asset: {
    urn: async (a: { id: string; memoryId: string }, _: unknown, ctx: Context) => {
      const memory = await ctx.db.memory.findUnique({
        where: { id: a.memoryId },
        select: { urn: true },
      });
      if (!memory) return `hrn:asset:unknown:assets:${a.id}`;
      try {
        return emitAssetUrnV2(memory.urn, a.id);
      } catch (err) {
        console.warn(`[Asset.urn] failed to emit v2 asset urn for memory "${memory.urn}":`, err);
        return assetUrn(memory.urn, a.id);
      }
    },
    // The unauthenticated hotlink (see src/api/assetPublic.ts). Mirrors
    // exactly what that route will actually serve — null whenever the
    // route would 404 — so a client never shows a "copy link" action
    // for a URL that cannot work: no canonical origin configured, a
    // non-CLEAN scan, or an encrypted memory (never hotlinkable, since
    // an anonymous request holds no session key to decrypt the
    // storage key with).
    publicUrl: async (
      a: { id: string; memoryId: string | null; scanStatus: string; deletedAt: Date | null; publicLinkEnabled: boolean },
      _: unknown,
      ctx: Context,
    ) => {
      if (a.deletedAt || !a.memoryId || a.scanStatus !== 'CLEAN') return null;
      const memory = await ctx.db.memory.findUnique({
        where: { id: a.memoryId },
        select: { isEncrypted: true, deletedAt: true },
      });
      // Soft-deleted memory: the route 404s these, so offering the link
      // would be offering a dead one.
      if (!memory || memory.deletedAt || memory.isEncrypted) return null;
      // #1667: the per-asset opt-in. OFF (the default) serves nothing.
      if (!a.publicLinkEnabled) return null;
      return publicAssetUrl(a.id);
    },
    // #1667 — exactly the deployment switch; see the SDL doc.
    publicLinkAvailable: () => isPublicHotlinkEnabled(),
    // #1667 — the caller's current manager capability for this asset's memory.
    canManagePublicLink: async (
      a: { memoryId: string | null; deletedAt: Date | null },
      _: unknown,
      ctx: Context,
    ) => {
      if (a.deletedAt || !a.memoryId || !ctx.userId || ctx.impersonation) return false;
      const memory = await ctx.db.memory.findUnique({ where: { id: a.memoryId }, select: PUBLIC_LINK_MEMORY_SELECT });
      return memory ? canManageAssetPublicLink(ctx, memory) : false;
    },
  },
  Memory: {
    // A nested Memory parent is not independent authorization to expose per-file locs.
    lastSyncReport: async (m: { id: string }, _: unknown, ctx: Context) => {
      const record = await loadReadableMemoryRecord(ctx, m.id) as { lastSyncReport: string | null } | null;
      return record?.lastSyncReport ?? null;
    },
    // #1448, derived from the nodes since #1591 (corpusMintStateOf): DRAFT
    // while no live node is minted; corpusMintedAt is the latest node mint.
    corpusMintedAt: async (m: { id: string }, _: unknown, ctx: Context) =>
      (await corpusMintStateOf(ctx.db, m.id)).mintedAt,
    corpusState: async (m: { id: string }, _: unknown, ctx: Context) =>
      (await corpusMintStateOf(ctx.db, m.id)).state,
    // A Memory reader may be external to its owning org. The nested object
    // exposes org policy and relations, so apply organization(ref:)'s gate.
    organization: (g: { organizationId: string | null }, _: unknown, ctx: Context) =>
      g.organizationId ? loadReadableNestedOrganization(ctx, g.organizationId) : null,
    // A Memory read grants neither its user-owned nor its org-owned App.
    // Return null on App denial, matching the nullable relation contract.
    app: (g: { appId?: string | null }, _: unknown, ctx: Context) =>
      g.appId ? loadReadableNestedApp(ctx, g.appId) : null,
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
    // #766 — derived shareability signal. A memory can be shared with an
    // individual user via MemoryShare only when class = 'personal' (spec 023
    // FR-018); this lets the CLI/portal gate the share action up front instead
    // of surfacing InvalidMemoryClassForShareError at execution time.
    shareable: async (g: { id: string; class?: string }, _: unknown, ctx: Context) => {
      // Partial-select-safe: some query paths select Memory without `class`
      // (mirrors the `shares` resolver). Fetch it rather than defaulting to
      // false for a real personal memory.
      if (g.class !== undefined) return g.class === 'personal';
      const m = await ctx.db.memory.findUnique({
        where: { id: g.id },
        select: { class: true },
      });
      return m?.class === 'personal';
    },
    // For system-class memories, find the agent that owns this memory.
    // Returns null for regular knowledge memories. We use a findFirst because
    // there's no FK from Memory → Agent — the relationship is expressed on
    // the Agent side via Agent.systemMemoryId.
    agent: async (g: { id: string; class?: string }, _: unknown, ctx: Context) => {
      if (g.class !== 'system') return null;
      const agent = await ctx.db.agent.findFirst({
        where: { systemMemoryId: g.id, deletedAt: null },
        include: AGENT_INCLUDE,
      });
      return readableNestedAgent(ctx, agent);
    },
    // 023-app-shape US3: cross-user grants on this Memory. Empty for
    // non-personal-class memories. Visible to (a) the principal
    // (memory.userId) alone since #1647: no org-admin or platform-admin branch.
    // Grantees can read their own shares via User.memorySharesGranted
    // (out of scope here; can be added if a portal page needs it).
    shares: async (
      g: { id: string; class?: string; userId?: string | null },
      _: unknown,
      ctx: Context,
    ) => {
      // Fast path: a loaded, non-personal class has no shares and needs no
      // scoping fields — skip the fallback fetch entirely.
      if (g.class !== undefined && g.class !== 'personal') return [];
      // Partial-select-safe: some query paths select Memory with only a subset
      // of fields. Fetch the missing scoping fields rather than silently
      // returning `[]` for a real personal memory (mirrors `members` above).
      let cls = g.class;
      let uId = g.userId;
      if (cls === undefined || uId === undefined) {
        const m = await ctx.db.memory.findUnique({
          where: { id: g.id },
          select: { class: true, userId: true },
        });
        if (!m) return [];
        cls = m.class;
        uId = m.userId;
      }
      if (cls !== 'personal') return [];
      // #1647 (cor:acl:010:02, strict owner wins): the full share list names every co-grantee, so only the memory's
      // strict owner reads it. No platform-admin or org-admin branch, no impersonation; a grantee reads their OWN row
      // through `myShare` and never learns of the others.
      if (!isStrictOwner(ctx, uId)) return [];
      return ctx.db.memoryShare.findMany({
        where: { memoryId: g.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    // #778: the CALLER'S OWN share of this memory (they are the grantee),
    // or null. Grantee-readable, and safe where `shares` is not: it reads at
    // most the single row keyed on the composite PK (memoryId, ctx.userId), so
    // it can never surface a co-grantee. Row existence IS the gate — a row only
    // exists for a personal-class memory the caller was granted, so no class
    // check is needed. null for a non-grantee or an App-key caller (no userId).
    // Lets the portal render "Shared by @grantor" + the role on each
    // shared-with-me row (MemoryShare exposes grantor + role).
    myShare: async (g: { id: string }, _: unknown, ctx: Context) => {
      if (!ctx.userId) return null;
      return ctx.db.memoryShare.findUnique({
        where: { memoryId_granteeId: { memoryId: g.id, granteeId: ctx.userId } },
      });
    },
    // 023-app-shape US4: team membership rows on this memory. Empty
    // for non-group-class memories. Visible to current members (any
    // role), ADMIN/OWNER of the memory's owning org, and platform
    // ADMIN/OWNER. Non-members of a group memory get an empty list
    // even if they happen to be in the org but not on the team.
    members: async (
      g: { id: string; class?: string; organizationId?: string | null },
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
          // A user-owned memory (no organizationId) has no org-admin
          // fallback — only an existing member (checked above) can read.
          if (!orgId) return [];
          // Fall back to org admin.
          const orgMember = await ctx.db.orgMember.findFirst({
            where: { organizationId: orgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
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
    // Emit the stored urn as canonical grammar v2 (`hrn:mem:<root>:<slug>`),
    // whatever shape it is stored in. `safeCanonicalUrn` routes root entity
    // types to `emitEntityUrnV2` (#697 Stage 2), which collapses `::` and
    // strips an `@` sigil itself — so a v1 chain, a legacy single-colon row and
    // an already-v2 row all land on the same output, and no pre-normalization
    // is needed here.
    //
    // This used to promote single-colon rows to the spec-021 `::` form via
    // `legacyMemoryUrnToCanonical` first, guarded by an `includes('::')` branch.
    // Both are now redundant: the emitter re-collapses whatever the promotion
    // produced. The branch was NOT dead, though — it was load-bearing FOR the
    // promotion, because `legacyMemoryUrnToCanonical` assumes single-colon
    // input and turns `acme.com::dev` into an empty atom. Removing the
    // promotion is what makes the branch removable. Pinned by
    // `resolvers.memoryUrnEmission.test.ts`. This also matches the sibling
    // Agent/App/Org resolvers, which have always called `safeCanonicalUrn`
    // directly.
    urn: (g: { urn?: string | null }) => {
      const urn = g.urn;
      if (!urn) throw new Error('Memory URN is required but not found (partial query?)');
      return safeCanonicalUrn('memory', urn);
    },
  },
  App: {
    /** #2171 (R211): the union reader every admission decides with. */
    availableMemberRoles: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await loadOfferedMemberRoles(ctx.db, a.id)).roles,
    /** #2109 — whether the caller manages this App; the shared managesApp predicate as a read-time fact. */
    viewerManages: (a: { id: string }, _: unknown, ctx: Context) => loadViewerManages(ctx, a.id),
    /**
     * Spec 049 Phase 4 — the App's default Channel, gated on its HOST MEMORY
     * like `App.sharedMemory`: `Query.app` admits an org member who is not an
     * App participant, and a nested object hands them that type's whole field
     * surface (`Channel.memory`) — findings:broadening-read-gate-leaks-nested-
     * objects (Copilot on PR #1165). Null when unreadable, silently.
     */
    defaultChannel: async (a: { defaultChannelId: string | null }, _: unknown, ctx: Context) => {
      if (!a.defaultChannelId) return null;
      const row = await ctx.db.channel.findFirst({
        where: { id: a.defaultChannelId, deletedAt: null },
        // #1172: `Channel.chatRootUrn` reads the host memory's urn; hydrate it
        // here so a page of Apps does not pay a second query per row.
        include: { memory: { select: { urn: true } } },
      });
      if (!row) return null;
      const accessible = await getAccessibleMemoryIds(ctx);
      return accessible === null || accessible.includes(row.memoryId) ? row : null;
    },
    // 036-ai-service-config: registry-backed reads of the App's
    // 'default' config (legacy ai_* columns dropped).
    aiProvider: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'appId', ctx))?.provider ?? null,
    aiModel: async (a: { id: string }, _: unknown, ctx: Context) =>
      (await defaultAiConfigOf(a, 'appId', ctx))?.model ?? null,
    hasAiApiKey: async (a: { id: string }, _: unknown, ctx: Context) =>
      !!(await defaultAiConfigOf(a, 'appId', ctx))?.apiKeyEncrypted,
    // #2557: App participation does not authorize the owning Organization's
    // full field surface. Ignore eager rows and use the direct org read gate.
    organization: (a: { organizationId: string | null; organization?: unknown }, _: unknown, ctx: Context) =>
      a.organizationId ? loadReadableNestedOrganization(ctx, a.organizationId) : null,
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
      // #2640: the URN names the primary Agent, so it answers as that Agent's own read does.
      const agentUrn = (await readablePrimaryAgent(ctx, a))?.urn;
      if (!agentUrn) return null;
      // #697 Stage 2 / D10: an installed agent stays AUTHOR-ROOTED forever, so
      // its v2 URN is just the agent's own author-rooted URN — the v1
      // `<installing-org>::<app>::<author-org>:<slug>` R2 install chain is
      // retired. Fail soft (nullable field): a malformed stored agent urn
      // warns + returns null rather than erroring the whole app read (#520).
      try {
        return emitInstalledAgentUrnV2(agentUrn);
      } catch (err) {
        console.warn(
          `[App.installedAgentUrn] failed to emit v2 agent urn from "${agentUrn}":`,
          err,
        );
        return null;
      }
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
    // #2640: `agentId` names the PRIMARY install's Agent, so it answers as that Agent's own read does: null for an
    // Agent the caller cannot read (never the first READABLE install's id, never the raw id).
    agentId: async (
      a: { id: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ): Promise<string | null> => (await readablePrimaryAgent(ctx, a))?.id ?? null,
    agent: async (
      a: { id: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      const eager = readPrimaryAgentRecordFromEager(a) as (NestedAgentRow & Record<string, unknown>) | null | undefined;
      if (eager !== undefined) return readableNestedAgent(ctx, eager);
      const agent = await getPrimaryAgent(ctx.db, a.id, { include: AGENT_INCLUDE });
      return readableNestedAgent(ctx, agent);
    },
    agents: async (
      a: { id: string; appAgents?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      const eagerAll = readAllAgentRecordsFromEager(a);
      if (eagerAll !== undefined) {
        const visible = await Promise.all(eagerAll.map((ag) =>
          readableNestedAgent(ctx, ag as (NestedAgentRow & Record<string, unknown>) | null),
        ));
        return visible.filter((ag): ag is NonNullable<typeof ag> => ag !== null);
      }
      const rows = await ctx.db.appAgent.findMany({
        where: { appId: a.id },
        orderBy: { createdAt: 'asc' },
        include: { agent: { include: AGENT_INCLUDE } },
      });
      const visible = await Promise.all(rows.map((r) => readableNestedAgent(ctx, r.agent)));
      return visible.filter((ag): ag is NonNullable<typeof ag> => ag !== null);
    },
    members: async (a: { id: string }, _: unknown, ctx: Context) => {
      if (!(await loadReadableNestedApp(ctx, a.id))) return [];
      return ctx.db.appMember.findMany({
        where: { appId: a.id },
        orderBy: { createdAt: 'asc' },
      });
    },
    memberCount: async (a: { id: string }, _: unknown, ctx: Context) => {
      if (!(await loadReadableNestedApp(ctx, a.id))) return 0;
      return ctx.db.appMember.count({ where: { appId: a.id } });
    },
    /**
     * #965: the App's SHARED app-class memory — the App → memory hop that lets
     * clients default a team-memory argument (hadron-cli#399) instead of
     * scanning every readable memory for `Memory.appId`. Read-only: never
     * provisions (that stays with createApp/#951 and the chat/worklog
     * bootstraps).
     *
     * Resolution order, both deterministic (oldest wins):
     *   1. The memory holding the App's `worklog` root — the ledger home,
     *      located exactly like `locateWorklogRoot` (#947), so the answer
     *      matches where `recordTeamWork` will actually write. This branch
     *      also covers pre-#723 legacy shared rows the adoption sweep hasn't
     *      keyed yet.
     *   2. Else the oldest agent-keyed shared row (`sharedMemoryOfAgentId`
     *      set — the #951 install-provisioned pairing). The key filter is
     *      what excludes Worker working memories, which are ALSO app-class
     *      rows carrying this App's appId (provisionWorkerMemory) but are
     *      casting-scoped, never the team space.
     *
     * Gated by the RECORD-level memory read gate (`canReadMemoryRecord` — the
     * same predicate Query.memory runs), so a caller who may see the App but
     * not its memory gets null; denied and missing are indistinguishable.
     */
    sharedMemory: async (a: { id: string }, _: unknown, ctx: Context) => {
      const teamSpaceIds = await resolveAppTeamSpaceMemoryIds(ctx.db, a.id);
      if (teamSpaceIds.length === 0) return null;
      const worklogRoot = await ctx.db.node.findFirst({
        // loc-scope-ok: deliberately spans the App's OWN app-class memories —
        // the tenant scope is the resolved team-space id set (mirrors
        // locateWorklogRoot). #1031: resolved rather than filtered, because
        // LEGACY pre-#723 spaces have no #723 key and are column-identical to
        // name-addressable createMemoryInApp memories — telling them apart is
        // a URN match, not a column one.
        where: {
          loc: WORKLOG_LOC,
          deletedAt: null,
          memoryId: { in: teamSpaceIds },
        },
        orderBy: { createdAt: 'asc' },
        select: { memoryId: true },
      });
      const memory = worklogRoot
        ? await ctx.db.memory.findUnique({ where: { id: worklogRoot.memoryId } })
        : // Oldest team space wins when no ledger exists yet. The id set is
          // already createdAt-ordered by the resolver.
          (teamSpaceIds[0]
            ? await ctx.db.memory.findUnique({ where: { id: teamSpaceIds[0] } })
            : null);
      if (!memory || memory.deletedAt) return null;
      return (await canReadMemoryRecord(ctx, memory)) ? memory : null;
    },
    keys: async (a: { id: string; keys?: unknown[] }, _: unknown, ctx: Context) => {
      // #1744: an App read grants no credential inventory. Check even an eager list.
      const app = await ctx.db.app.findFirst({ where: { id: a.id, deletedAt: null } });
      if (!app) throw authorizationDenied();
      await requireAppKeyManager(ctx, app);
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
    app: (aa: { appId: string }, _: unknown, ctx: Context) =>
      loadReadableNestedApp(ctx, aa.appId),
    agent: async (aa: { agentId: string; agent?: unknown }, _: unknown, ctx: Context) => {
      const agent = aa.agent !== undefined
        ? aa.agent as (NestedAgentRow & Record<string, unknown>) | null
        : await ctx.db.agent.findUnique({ where: { id: aa.agentId }, include: AGENT_INCLUDE });
      return readableNestedAgent(ctx, agent);
    },
  },
  AgentSubscription: {
    isActive: (s: { activatedAt?: Date | null; revokedAt?: Date | null; expiresAt?: Date | null }) =>
      isLifecycleActive({
        activatedAt: s.activatedAt ?? null,
        revokedAt: s.revokedAt ?? null,
        expiresAt: s.expiresAt ?? null,
      }),
    user: async (s: { userId: string; user?: unknown }, _: unknown, ctx: Context) =>
      s.user ?? ctx.db.user.findUnique({ where: { id: s.userId } }),
    agent: async (s: { agentId: string; agent?: unknown }, _: unknown, ctx: Context) => {
      const agent = s.agent !== undefined
        ? s.agent as (NestedAgentRow & Record<string, unknown>) | null
        : await ctx.db.agent.findUnique({ where: { id: s.agentId } });
      return readableNestedAgent(ctx, agent);
    },
  },
  // 008-agent-installation: User↔App membership join.
  AppMember: {
    // The user's own AppMember row may be readable without org membership.
    // It does not grant the App object or its ungated keys/members fields.
    app: (s: { appId: string }, _: unknown, ctx: Context) =>
      loadReadableNestedApp(ctx, s.appId),
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
      // spec 047: a user-owned App has no owning org, so an AppMember is
      // vacuously org-external (NOT an OrgMember of a nonexistent org). Kept in
      // sync with isOrgExternalAppMember (src/lib/auth/isOrgExternalAppMember.ts).
      if (!organizationId) return true;
      const orgMember = await ctx.db.orgMember.findFirst({
        where: { userId: s.userId, organizationId, deletedAt: null },
        select: { userId: true },
      });
      return orgMember === null;
    },
  },
  // 023-app-shape US3: asymmetric cross-user grant on personal-class memory.
  MemoryShare: {
    // #2509: the record as Query.memory answers it, else null; a preloaded `memory` is never trusted (#474).
    memory: (s: { memoryId: string }, _: unknown, ctx: Context) => loadReadableMemoryRecord(ctx, s.memoryId),
    grantee: async (s: { granteeId: string; grantee?: unknown }, _: unknown, ctx: Context) =>
      s.grantee ?? ctx.db.user.findUnique({ where: { id: s.granteeId } }),
    grantor: async (s: { grantorId: string; grantor?: unknown }, _: unknown, ctx: Context) =>
      s.grantor ?? ctx.db.user.findUnique({ where: { id: s.grantorId } }),
  },
  // 023-app-shape US4: symmetric team membership on group-class memory.
  MemoryMember: {
    // #2509: the record as Query.memory answers it, else null; a preloaded `memory` is never trusted (#474).
    memory: (m: { memoryId: string }, _: unknown, ctx: Context) => loadReadableMemoryRecord(ctx, m.memoryId),
    user: async (m: { userId: string; user?: unknown }, _: unknown, ctx: Context) =>
      m.user ?? ctx.db.user.findUnique({ where: { id: m.userId } }),
  },
  // 008-agent-installation: Agent dependency edge.
  AgentImport: {
    parentAgent: async (s: { parentAgentId: string }, _: unknown, ctx: Context) =>
      readableNestedAgent(ctx, await ctx.db.agent.findUnique({ where: { id: s.parentAgentId } })),
    importedAgent: async (s: { importedAgentId: string }, _: unknown, ctx: Context) =>
      readableNestedAgent(ctx, await ctx.db.agent.findUnique({ where: { id: s.importedAgentId } })),
  },
  // 008-agent-installation: Org↔Agent license — sibling to AgentSubscription.
  AgentOrgGrant: {
    isActive: (s: { activatedAt?: Date | null; revokedAt?: Date | null; expiresAt?: Date | null }) =>
      isLifecycleActive({
        activatedAt: s.activatedAt ?? null,
        revokedAt: s.revokedAt ?? null,
        expiresAt: s.expiresAt ?? null,
      }),
    // Reading the vendor's grant does not authorize the customer org object.
    organization: (s: { orgId: string }, _: unknown, ctx: Context) =>
      loadReadableNestedOrganization(ctx, s.orgId),
    agent: async (s: { agentId: string }, _: unknown, ctx: Context) =>
      readableNestedAgent(ctx, await ctx.db.agent.findUnique({ where: { id: s.agentId } })),
  },
  MemorySubscription: {
    // A readable Memory may list subscribers outside the caller's orgs. Ignore
    // the eager relation and apply organization(ref:)'s gate to each org.
    organization: (s: { organizationId: string }, _: unknown, ctx: Context) =>
      loadReadableNestedOrganization(ctx, s.organizationId),
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
  // AppKey / UserApiKey have no entry: every field they exposed a resolver for
  // was a timestamp, and since #205 those serialize through the DateTime
  // scalar. On UserApiKey, `userId` remains intentionally NOT exposed in the
  // GraphQL type (025-oauth-for-mcp, PR-137 delta D1).
  // #562: the current request's principal. `principalType`/`appId`/`agentId`
  // resolve from the source object the Query.authContext resolver returns;
  // `user` and `apiKey` are loaded lazily from the ids it threaded so the
  // fields cost nothing when the client doesn't select them. `user` is the
  // full User type, so it inherits the same PII field-gating as `me` (the
  // viewer IS the user here, so name/email are visible to them).
  AuthContext: {
    user: (
      src: { userId: string | null },
      _: unknown,
      ctx: Context,
    ) => (src.userId ? ctx.db.user.findUnique({ where: { id: src.userId } }) : null),
    apiKey: (
      src: { apiKeyId: string | null },
      _: unknown,
      ctx: Context,
    ) => (src.apiKeyId ? ctx.db.userApiKey.findUnique({ where: { id: src.apiKeyId } }) : null),
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
    sharedOrganizations: (u: { id: string }, args: { limit?: number | null; offset?: number | null }, ctx: Context) =>
      sharedOrganizations(u.id, args, ctx),
    // Canonical hrn:user:<handle> URN (spec cor:urn:010:01) — lowercase, and
    // null for a handle-less or not-URN-legal (grandfathered) handle.
    urn: (u: { handle?: string | null }) => userUrn(u.handle),
    // #1522: a readable relation (such as AppMember.user) can carry a User
    // who is not readable through Query.user. Keep identity available, while
    // checking the target User before resolving account and policy data.
    policy: async (u: { id: string; policy?: unknown }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.policy ?? null) : null,
    identityProvider: async (u: { id: string; identityProvider?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.identityProvider ?? null) : null,
    externalId: async (u: { id: string; externalId?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.externalId ?? null) : null,
    externalAppId: async (u: { id: string; externalAppId?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.externalAppId ?? null) : null,
    linkedAt: async (u: { id: string; linkedAt?: Date | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.linkedAt ?? null) : null,
    roles: async (u: { id: string; roles?: string[] }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.roles ?? []) : [],
    maxReferrals: async (u: { id: string; maxReferrals?: number | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.maxReferrals ?? null) : null,
    // #384: field-level visibility. name/email are PII — withheld (null)
    // from any viewer who isn't the user themselves, a platform admin, or a
    // co-member of one of the user's orgs. Applied here so EVERY surface that
    // returns a User (searchUsers, me, OrgMember.user, MemoryShare.*, the
    // public invitation.sender, …) gets the same guarantee server-side.
    name: async (u: { id: string; name?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.name ?? null) : null,
    email: async (u: { id: string; email?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.email ?? null) : null,
    // #837: provider subject ids, behind the SAME #384 gate as name/email.
    // They are opaque identifiers rather than addresses, but they are still
    // account-linkage data — ungated they let any caller correlate a Hadron
    // account with a Google/Apple identity across services. The stated use
    // case (pre-merge duplicate triage) is a platform admin or the user
    // themselves, both of which this gate admits, so nothing is lost.
    //
    // Legacy `githubId`/`githubUsername` and `avatarUrl` remain ungated.
    // `externalId` and other account metadata use the #384 gate as of #1522.
    // Changing the legacy fields needs a separate consumer/contract audit.
    googleId: async (u: { id: string; googleId?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.googleId ?? null) : null,
    appleId: async (u: { id: string; appleId?: string | null }, _: unknown, ctx: Context) =>
      (await canSeeUserPersonalFields(ctx, u.id)) ? (u.appleId ?? null) : null,
    // 008-agent-installation: User↔App memberships. Resolves to a non-empty
    // list only when the queried User is the authenticated user (mirrors
    // 005's User.agentSubscriptions resolver-side gate).
    appMemberships: async (u: { id: string }, _: unknown, ctx: Context) => {
      // #876 class sweep: self-only by identity, and the rows carry no org
      // filter — under impersonation `me { appMemberships }` enumerated the
      // target's App memberships in EVERY org (cross-org disclosure).
      if (ctx.userId !== u.id || ctx.impersonation) return [];
      return ctx.db.appMember.findMany({
        where: { userId: u.id },
        orderBy: { createdAt: 'asc' },
      });
    },
  },
  Session: {
    /** #2047: a bind's record, self-authorized (worker internals). */
    servedPrompts: servedPromptOwnerFields.sessionServedPrompts,
    /** #1156 / cor:dmo:070:05: no new read gate; the parent Session is authorized. */
    endReason: sessionEndReason,
    /** #1645: nested events inherit current session and memory read boundaries. */
    events: async (s: { id: string }, _: unknown, ctx: Context) => {
      const session = await ctx.db.session.findFirst({
        where: { AND: [{ id: s.id }, await sessionScopeFilter(ctx)] },
        select: { id: true },
      });
      if (!session) return [];
      const memoryIds = await sessionEventMemoryIds(ctx, s.id);
      return ctx.db.usageEvent.findMany({
        where: { sessionId: s.id, OR: [{ memoryId: null }, { memoryId: { in: memoryIds } }] },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
    },
    outcomeMeta: (session: { outcomeMeta: unknown }) => deserializeJson(session.outcomeMeta),
    /**
     * hadron-cli#791: the exact per-session form of the shared liveness
     * predicate (`isSessionLive`, cor:agt:020:11), so a client can tell a
     * LIVE binding from a lapsed one without re-deriving the rule. No new
     * read surface: it resolves only on a Session the caller already read,
     * from columns that are readable on it. The last-event lookup is batched
     * per request, so a session list costs one grouped query, not one per row.
     */
    isLive: async (s: SessionLivenessParent, _: unknown, ctx: Context) => {
      const snapshot = await sessionSnapshot(ctx, s);
      if (!snapshot || snapshot.row.endedAt || snapshot.row.deletedAt) return false;
      return isSessionLive(snapshot.row, snapshot.lastEventAt, snapshot.now);
    },
    /** Same deadline/output as before; shared snapshot and clock with state. */
    lapsesAt: async (s: SessionLivenessParent, _: unknown, ctx: Context) => {
      const snapshot = await sessionSnapshot(ctx, s);
      if (!snapshot || snapshot.row.endedAt || snapshot.row.deletedAt) return null;
      return sessionLapsesAt(snapshot.row, snapshot.lastEventAt);
    },
    state: async (s: SessionLivenessParent, _: unknown, ctx: Context) => {
      const snapshot = await sessionSnapshot(ctx, s);
      if (!snapshot) return 'ENDED';
      return sessionState(snapshot.row, snapshot.lastEventAt, await sessionDormancyDays(ctx, snapshot.row.appId), snapshot.now);
    },
    /**
     * #980: the bound Worker, nested — prefers the eager row SESSION_INCLUDE
     * loads (the one-query list path; no DataLoader in this repo) and falls
     * back to a point read for partially-selected parents. Deliberately NO
     * retirement filter: a session's worker may since have retired, and the
     * row must still attribute (retirement ends the casting, not the
     * history). Worker.app / Worker.agent self-guard behind their own read
     * gates (#552), so nothing nested here outruns the session gate.
     */
    worker: async (
      s: { workerId?: string | null; worker?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      if (!s.workerId) return null;
      if (s.worker !== undefined) return s.worker;
      return ctx.db.worker.findUnique({ where: { id: s.workerId } });
    },
  },
  Organization: {
    /**
     * #2557: a subscription row is not itself a memory read grant. Filter its
     * memory through the shared record gate (cor:acl:010:01) before exposing
     * MemorySubscription.memory, whose non-null contract is preserved.
     */
    subscriptions: async (
      org: { id: string; subscriptions?: Prisma.MemorySubscriptionGetPayload<{ include: typeof ORG_INCLUDE.subscriptions.include }>[] },
      _: unknown,
      ctx: Context,
    ) => {
      const rows = org.subscriptions ?? await ctx.db.memorySubscription.findMany({
        where: { organizationId: org.id, ...ORG_INCLUDE.subscriptions.where },
        include: ORG_INCLUDE.subscriptions.include,
        orderBy: ORG_INCLUDE.subscriptions.orderBy,
      });
      const readable = await filterReadableMemoryRecords(ctx, rows.map(row => row.memory));
      const readableIds = new Set(readable.map(memory => memory.id));
      return rows.filter(row => readableIds.has(row.memoryId));
    },
    /**
     * The direct query's audience and rows (`listOrgExchangeConnections`). Its
     * FORBIDDEN becomes `[]` here, indistinguishable from an org with none, so an
     * admitted parent keeps its other fields; any other error propagates. Ignores
     * any eager row (hadron-internal#18).
     */
    exchangeConnections: async (org: { id: string }, _: unknown, ctx: Context) => {
      try {
        return await listOrgExchangeConnections(ctx, org.id);
      } catch (error) {
        if (error instanceof GraphQLError && error.extensions?.code === 'FORBIDDEN') return [];
        throw error;
      }
    },
    /** Every org-list record uses the point-read gate (cor:acl:010:01, #1626). */
    memories: async (
      org: { id: string; memories?: Prisma.MemoryGetPayload<{ include: typeof ORG_INCLUDE.memories.include }>[] },
      _: unknown,
      ctx: Context,
    ) => {
      const rows = org.memories ?? await ctx.db.memory.findMany({
        where: { organizationId: org.id, ...ORG_INCLUDE.memories.where },
        include: ORG_INCLUDE.memories.include,
        orderBy: ORG_INCLUDE.memories.orderBy,
      });
      return filterReadableMemoryRecords(ctx, rows);
    },
    hasGithubAppPrivateKey: (o: { githubAppPrivateKeyEncrypted?: string | null }) => !!o.githubAppPrivateKeyEncrypted,
    apps: async (org: { id: string; apps?: unknown[] }, _: unknown, ctx: Context) => {
      // An Organization may be nested under a readable Memory even when its
      // Apps are not. Scope each returned App to its own read audience.
      const apps = org.apps ?? await ctx.db.app.findMany({
        where: { organizationId: org.id, deletedAt: null },
        include: APP_INCLUDE,
        orderBy: { name: 'asc' },
      });
      return filterReadableAppRows(ctx, apps as Array<{
        id: string;
        organizationId: string | null;
        ownerUserId: string | null;
        deletedAt: Date | null;
      }>);
    },
    agents: async (org: { id: string }, _: unknown, ctx: Context) => {
      const where: Record<string, unknown> = { organizationId: org.id, deletedAt: null };
      if (ctx.userId) {
        // PERSONAL: only creator; ORGANIZATION + PUBLIC: all org members.
        // 035-visibility-enum-cleanup: agents use AgentVisibility now; the
        // creator-only draft value is PERSONAL (was PRIVATE).
        // #876 class sweep: the PERSONAL branch is creator-keyed, so under
        // impersonation the target's private DRAFT agents surfaced inside the
        // shared org. The org is right; the predicate is identity-derived.
        where.OR = ctx.impersonation
          ? [{ visibility: { not: 'PERSONAL' as AgentVisibility } }]
          : [
              { visibility: { not: 'PERSONAL' as AgentVisibility } },
              { visibility: 'PERSONAL' as AgentVisibility, createdBy: ctx.userId },
            ];
      } else {
        // No user (App Key / unauthenticated): never expose PERSONAL
        // (creator-only draft) agents.
        where.visibility = { not: 'PERSONAL' as AgentVisibility };
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
      // A headless run acts for its App, never as the admin it runs on behalf of (Xan's disposition on #2188), even with a platform role.
      if (isRunPrincipal(ctx)) return [];
      // An org-scoped client (app key / OAuth client) stays pinned to its own
      // org; a user token carries no organizationId, so the role gate decides.
      if (ctx.organizationId && ctx.organizationId !== org.id && !isPlatformAdmin(ctx)) return [];
      // A worker-bound session acts for its Worker, never as the org admin whose token it rides (as stopSignal's personEntry).
      if (currentActor().workerId || currentActorAmbiguity()) return [];
      try {
        await requireOrgRole(ctx, org.id, 'ADMIN');
      } catch (e) {
        if (e instanceof Error && e.message === 'Forbidden') return [];
        throw e;
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
  // cor:acl:080:02 — sanitized public view of a discoverable org. Only the org's
  // PUBLIC footprint is exposed; nothing here traverses to members / private
  // memories / apps / credentials. The parent object is already gated to a
  // discoverable org by Query.publicOrganization.
  PublicOrganization: {
    urn: (o: { urn?: string | null }) => {
      if (!o.urn) throw new Error('Organization URN is required but not found (partial query?)');
      return safeCanonicalUrn('org', o.urn);
    },
    publicMemories: async (o: { id: string }, _: unknown, ctx: Context) => {
      const rows = await ctx.db.memory.findMany({
        where: { organizationId: o.id, ...publicReadableMemoryWhere() },
        select: { id: true, name: true, urn: true, shortDescription: true },
        orderBy: { name: 'asc' },
      });
      return rows.map(memoryRowToRef);
    },
    publicAgents: async (o: { id: string }, _: unknown, ctx: Context) => {
      const rows = await ctx.db.agent.findMany({
        where: { organizationId: o.id, deletedAt: null, visibility: 'PUBLIC' },
        select: { id: true, name: true, urn: true, description: true },
        orderBy: { name: 'asc' },
      });
      return rows.map(agentRowToRef);
    },
  },
  // ExchangeConnection / SlackConnection have no entry: their only resolvers
  // were timestamp serializers, now handled by the DateTime scalar (#205).
  Agent: {
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
    // #759 — the #740 PUBLIC-congruence invariant deliberately EXCLUDES
    // personal/private and app-scoped memories from the covered set, so
    // `assertLinkAllowedForPublicAgent` lets a PUBLIC agent link a NON-public
    // memory of those classes. `agent(ref:)` / `publicAgents` then handed
    // `memoryItems[].memory` to anonymous callers, and the Memory type gates
    // only userId/shares/members — the scalars (name, shortDescription,
    // description, data) passed straight through. The congruence code's claim
    // that excluded memories are "never publicly readable (effectiveAccess
    // blocks public read)" holds for node CONTENT, not for these object
    // scalars.
    //
    // Filter to the memories this caller may actually read, through the shared
    // RECORD-level gate (`canReadMemoryRecord`, extracted from Query.memory)
    // rather than a bespoke predicate that would drift from it.
    //
    // Record-level, NOT `isMemoryReadableCached`: the question here is "may the
    // caller open this memory's scalars", which is exactly what Query.memory
    // answers. The node-content gate is deliberately narrower — it excludes
    // app-scoped rows (`getOrgReadableMemoryIds` sets `appId: null`) that an org
    // member CAN open directly — so using it silently dropped legitimately
    // readable app-scoped memories from `organization`/`app -> agents ->
    // memoryItems` (PR #846 review: Codex P1 / Copilot).
    //
    // Only an org-owned PUBLIC non-App memory short-circuits. A spec-047
    // user-owned memory remains strict-owner even with visibility PUBLIC; the
    // owner axis must reach canReadMemoryRecord (#1357 review).
    memoryItems: async (
      a: { id: string; memoryItems?: unknown },
      _: unknown,
      ctx: Context,
    ) => {
      type Mem = {
        id: string;
        class: string;
        visibility: string | null;
        appId: string | null;
        // #1104 — all of these are `canReadMemoryRecord`'s contract, and it
        // reads every one of them (see its header for what each `undefined`
        // does; three of the six change the answer OPEN). Both load paths below
        // use `include: { memory: true }`, so they are present at runtime and
        // this is a declaration catching up with reality rather than a fix —
        // the value is that a future narrowing `select` here now fails to
        // compile rather than quietly re-answering an authorization question.
        userId: string | null;
        ownerUserId: string | null;
        organizationId: string | null;
        userMemoryOfAgentId: string | null;
        createdBy: string | null;
      };
      type Item = { memoryId: string; role: string | null; memory?: Mem | null };
      const eager = a.memoryItems as Item[] | undefined;
      // Fall back to a query when the field wasn't eager-loaded AT ALL, and
      // also when it was loaded WITHOUT its `memory` relation — otherwise every
      // item would look unreadable and the list would silently empty out
      // (PR #846 review, Copilot).
      const needsFetch = !eager || eager.some((i) => i.memory === undefined);
      const items = needsFetch
        ? ((await ctx.db.agentMemoryItem.findMany({
            where: { agentId: a.id, deletedAt: null, memory: { deletedAt: null } },
            include: { memory: true },
          })) as Item[])
        : eager;
      const kept: Item[] = [];
      for (const item of items) {
        // A malformed persisted role grants no audience, even when the linked
        // Memory itself is PUBLIC. The public fast path must honor the same
        // link semantics as the App access fold.
        if (!isGrantedAgentMemoryRole(item.role)) continue;
        const mem = item.memory;
        if (!mem) continue;
        // Legacy per-user holding rows can carry PUBLIC visibility while
        // ownerUserId is null. Their audience is the creating user alone.
        if (mem.userMemoryOfAgentId != null) {
          if (!ctx.impersonation && ctx.userId != null && ctx.userId === mem.createdBy) kept.push(item);
          continue;
        }
        // Readable by anyone only for the genuine public audience. #653 keeps
        // App-scoped rows internal; spec-047 keeps user-owned rows strict-owner
        // even if their visibility column says PUBLIC.
        if (mem.visibility === 'PUBLIC' && mem.appId == null && mem.ownerUserId == null && mem.userMemoryOfAgentId == null) {
          kept.push(item);
          continue;
        }
        if (await canReadMemoryRecord(ctx, mem)) kept.push(item);
      }
      return kept;
    },
    imports: async (a: { id: string }, _: unknown, ctx: Context) =>
      ctx.db.agentImport.findMany({
        where: { parentAgentId: a.id },
        orderBy: { position: 'asc' },
      }),
    // #757 — `importedBy` surfaces the agents that import THIS one, i.e. OTHER
    // tenants' parent agents. On a PUBLIC agent (readable by anyone,
    // including anonymous) that handed out foreign orgs' private parent-agent
    // definitions — description, linked-memory metadata — the
    // exact #552 class. `publishAgentImport` puts no visibility constraint on
    // the parent, so this is the intended marketplace flow, not a rare shape.
    //
    // The row list retains the established App-key installed-parent audience
    // (an adoption signal, not an Agent definition grant). Its parentAgent
    // object resolver now applies Query.agent's own read gate, so a visible
    // import row cannot reveal an unreadable parent's definition.
    importedBy: async (a: { id: string }, _: unknown, ctx: Context) => {
      const parentAgent = await callerReadableAgentFilter(ctx);
      return ctx.db.agentImport.findMany({
        where: { importedAgentId: a.id, parentAgent },
        orderBy: { position: 'asc' },
      });
    },
    // #551 — the Agent's OWN definition (systemMemoryId /
    // memoryItems / imports, above) is public on a PUBLIC agent: reaching the
    // Agent object means the object-level read gate already admitted the
    // caller (PUBLIC → anyone; non-public → members), and the agent's own
    // content is what a marketplace listing publishes. (`importedBy` is NOT in
    // that set — see #757 above; it returns other tenants' agents.)
    //
    // The "who USES this agent" fields below are different: they surface OTHER
    // tenants' data, so they are NOT public. `apps` / `appAgents` return full
    // `App` objects, including scalars such as description. Returning a
    // foreign App here leaks data even though keys and members re-check.
    // Scope them to
    // Apps in orgs the CALLER belongs to, then apply each App's own read
    // gate. Platform ADMIN/OWNER can read org-owned Apps but not another
    // user's user-owned App (spec 047 strict ownership).
    apps: async (a: { id: string }, _: unknown, ctx: Context) => {
      const where: Record<string, unknown> = {
        appAgents: { some: { agentId: a.id } },
        deletedAt: null,
      };
      if (!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'))) {
        const orgIds = ctx.userId
          ? await getMemberOrgIds(ctx.db, ctx.userId, ctx.impersonation?.orgId)
          : [];
        if (orgIds.length === 0) return [];
        where.organizationId = { in: orgIds };
      }
      const apps = await ctx.db.app.findMany({ where, orderBy: { createdAt: 'asc' } });
      return filterReadableAppRows(ctx, apps);
    },
    // Adoption count — the agent's owning-TENANT view only (a bare number, but
    // still "who uses this"); everyone else gets 0. The owning tenant of an
    // org agent is its org's members; of a user-owned agent (spec 047), its
    // owner (#1693: they saw 0 for their own agent installed in their own
    // Apps). Not under impersonation, and not a platform admin for an org-less
    // agent (#1692: nothing org-derived to show).
    appCount: async (a: { id: string; organizationId: string | null; ownerUserId?: string | null }, _: unknown, ctx: Context) => {
      const owningTenant = a.organizationId === null
        ? !ctx.impersonation && !!ctx.userId && a.ownerUserId === ctx.userId
        : await isOrgMemberOrAdmin(ctx, a.organizationId);
      if (!owningTenant) return 0;
      return ctx.db.app.count({
        where: { appAgents: { some: { agentId: a.id } }, deletedAt: null },
      });
    },
    // 023-app-shape US1: the AppAgent join rows where this Agent is installed.
    // Same caller-org scope as `apps` (each join row eager-loads its `app`).
    appAgents: async (a: { id: string }, _: unknown, ctx: Context) => {
      const appWhere: Record<string, unknown> = { deletedAt: null };
      if (!(ctx.roles?.includes('ADMIN') || ctx.roles?.includes('OWNER'))) {
        const orgIds = ctx.userId
          ? await getMemberOrgIds(ctx.db, ctx.userId, ctx.impersonation?.orgId)
          : [];
        if (orgIds.length === 0) return [];
        appWhere.organizationId = { in: orgIds };
      }
      const rows = await ctx.db.appAgent.findMany({
        where: { agentId: a.id, app: appWhere, agent: { deletedAt: null } },
        orderBy: { createdAt: 'asc' },
        include: { app: true, agent: { include: AGENT_INCLUDE } },
      });
      const readableApps = await filterReadableAppRows(ctx, rows.map((row) => row.app));
      const readableIds = new Set(readableApps.map((app) => app.id));
      return rows.filter((row) => readableIds.has(row.appId));
    },
    // The agent's customer list (which orgs were granted it) — owning-org view
    // only; non-members get [].
    orgGrants: async (a: { id: string; organizationId: string | null }, _: unknown, ctx: Context) => {
      if (a.organizationId === null || !(await isOrgMemberOrAdmin(ctx, a.organizationId))) return [];
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
    // 046-usage-metering: bigint travels as a base-10 integer String
    // (graphql-js does not serialize bigint to GraphQLString by itself).
    costMicroCents: (ue: { costMicroCents: bigint | null }) =>
      ue.costMicroCents != null ? ue.costMicroCents.toString() : null,
  },

};
