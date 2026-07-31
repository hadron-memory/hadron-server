import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateId } from '../lib/id.js';
import {
  buildNodeRevisionSnapshot,
  createNodeRevision,
  editorFromAuth,
  diffNodeChanges,
} from '../lib/nodeRevisionSnapshot.js';
import {
  parseUrnInput,
  assertFullyQualifiedUrn,
  splitNodeUrn,
  validateUrnType,
  normalizeUrnForLookup,
  UrnNotQualifiedError,
} from '../lib/urn.js';
import { emitEntityUrnV2, emitNodeUrnV2, emitEdgeUrnV2 } from '../lib/urnEmit.js';
import { validateParentRel, InvalidParentRelError } from '../lib/parentRel.js';
import type { NodeWhere } from '../lib/retrieval/nodeWhere.js';
import { validateNodeAgainstSchema, NodeSchemaViolation } from '../lib/validateNodeAgainstSchema.js';
import { normalizeObjectType } from '../lib/enforceNodeSchema.js';
import type { MemorySchema } from '../lib/memorySchema.js';
import { validateLoc, InvalidLocError } from '../lib/validateLoc.js';
import { deriveEdgeLoc } from '../lib/edgeLoc.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
import { ancestorLocs, lockAncestorsForCreate, lockNodeForDelete } from '../lib/nodeSubtreeLock.js';
import {
  moveNodeSubtree,
  SubtreeMoveCollisionError,
  SubtreeMoveIntoSelfError,
  SubtreeMoveSourceChangedError,
  CrossMemoryMoveUnsupportedError,
  SubtreeMoveSchemaViolationError,
} from '../lib/nodeSubtreeMove.js';
import { resolveAuthContext, type AuthContext } from '../middleware/auth.js';
import {
  resolveAppForRequest,
  resolveAppIdentifier,
  resolveUserAppsWithMeta,
  type AppResolution,
} from '../auth/user-app-resolution.js';
import { getServerOrigin } from '../auth/oauth.js';
import {
  APP_SELECTION_ERROR_CODES,
  appSelectionError,
  type AppSelectionErrorEnvelope,
} from './app-selection-errors.js';
import { mcpLog } from './mcp-log.js';
import { tagsInputSchema } from './tagsInput.js';

// Spec 025-oauth-for-mcp / research §R-6: error_description in the
// 409 multi-App response links to a docs page that explains the
// situation + (eventually) lists the App-identification regimes
// added by the sibling spec 02X-app-identification-regimes. The
// page doesn't exist yet (T056 in Polish phase); the URL is
// env-overrideable so docs reorganization doesn't require a code
// change.
const MULTIPLE_APPS_DOCS_URL =
  process.env.HADRON_MULTIPLE_APPS_DOCS_URL ??
  'https://hadronmemory.com/docs/auth/multiple-apps-resolved';
import {
  canReadMemory,
  canWriteToMemory,
  getAccessibleMemoryIds,
  getMemoryAccess,
} from './access-control.js';
import { globalSearch } from '../lib/global-search/index.js';
import {
  normalizeEntityTypes,
  normalizeFields,
  type SearchPrincipal,
} from '../lib/global-search/index.js';
import { getMemberOrgIds } from '../lib/auth/memberOrgIds.js';
import { publishNodeWritten } from '../lib/events/nodeWritten.js';
import { computeContentHash } from '../lib/contentHash.js';
import { nextSiblingSeq } from '../lib/nodeSeq.js';
import { BATCH_READ_MAX_NODES, BATCH_READ_MAX_BYTES } from '../lib/batchRead.js';
import { isCiphertext } from '../lib/crypto.js';
import { enqueueNodeEmbedding } from '../services/embedding/enqueue.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { decryptNodeFieldsWithKey, encryptNodeFieldsWithKey } from '../lib/nodeCrypto.js';
import { resolveSuppliedKey, MemoryUnlockError } from '../lib/memoryUnlock.js';
import { resolveNodeRef } from '../lib/entityRef/nodeRef.js';
import {
  NodeNotFoundError,
  NodeAbstractTooLongError,
  InvalidContentScopeError,
} from '../lib/entityRef/errors.js';
import { isId } from '../lib/entityRef/shape.js';
import { HADRON_SERVER_VERSION, getDeploymentInfo } from './deploymentInfo.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import type { PrismaClient, SessionType, Prisma } from '../generated/prisma/index.js';
import type { InputJsonValue } from '../generated/prisma/runtime/library.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

// Server-identity / deployment-info surface lives in ./deploymentInfo.js so
// the GraphQL resolvers (which this module imports, line ~77) can read it
// without a circular import. Imported above for the internal MCP uses below;
// other modules import the symbols straight from ./deploymentInfo.js.

/**
 * Test-only harness — invoke a registered MCP tool by name without
 * spinning up an HTTP transport. Behavioral tests use this to exercise
 * the full closure inside `createMcpServerInstance` (including `auth`
 * binding) while skipping the transport, JSON-RPC framing, and zod
 * validation that the SDK does in production.
 *
 * The SDK's `_registeredTools` is `private` at the type level but is a
 * plain object at runtime. Coupling is deliberately narrow — if the SDK
 * renames the field, this single helper breaks loudly, rather than
 * every behavioral test in the suite.
 */
export interface TestableMcpServer {
  callTool(
    name: string,
    args?: unknown,
  ): Promise<{ content: Array<{ type: string; text: string }> }>;
  callToolText(name: string, args?: unknown): Promise<string>;
}

export function createTestableMcpServer(
  auth: AuthContext,
  opts?: { sessionId?: string; cachedAppResolution?: AppResolution | null },
): TestableMcpServer {
  const server = createMcpServerInstance(
    auth,
    () => opts?.sessionId,
    opts?.cachedAppResolution ?? null,
  );
  const tools = (server as unknown as {
    _registeredTools: Record<
      string,
      {
        handler: (
          args: unknown,
          extra: unknown,
        ) => Promise<{ content: Array<{ type: string; text: string }> }>;
        enabled: boolean;
      }
    >;
  })._registeredTools;

  return {
    async callTool(name: string, args: unknown = {}) {
      const tool = tools[name];
      if (!tool) throw new Error(`Tool not registered: ${name}`);
      if (!tool.enabled) throw new Error(`Tool disabled: ${name}`);
      return tool.handler(args, {});
    },
    async callToolText(name: string, args: unknown = {}) {
      const result = await this.callTool(name, args);
      return result.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
    },
  };
}

/** A single resolved edge ready to be written to the database (spec 037). */
export type ResolvedEdge = {
  targetNodeId: string;
  /** Target node's loc — used to derive the edge loc when none is authored. */
  targetLoc: string;
  name: string | null;
  /** Author-supplied loc, or null to derive from endpoints + name at write. */
  loc: string | null;
  description: string | null;
  isRunnable: boolean | null;
};

/**
 * Resolve every edge `targetId` through `resolveNodeRef` (spec 007)
 * so all four supported reference shapes — bare ID, full `urn:node:`
 * URN, memory-prefixed loc, and short loc within `sourceMemoryId` —
 * work uniformly.
 *
 * Pure read; writes nothing. Returns the resolved edges on success,
 * or `{ error: <user-facing string> }` when any ref doesn't resolve.
 * Callers run this BEFORE mutating the source node, so an unresolvable
 * target aborts the mutation cleanly without committing the source
 * upsert/update.
 *
 * Issue #107: prior inline logic in hadron_create_node / hadron_update_node used a
 * `targetId.includes(':')` heuristic plus `findFirst({loc})` (no
 * memory scope), which silently no-op'd memory-prefixed/URN forms and
 * FK-errored on single-segment short locs.
 *
 * Security (#755): target-memory read access is checked with `canReadMemory`,
 * exactly as the single-edge `addEdge` path does. `resolveNodeRef` is a pure
 * DB lookup with no auth context, so without this gate `hadron_create_node` /
 * `hadron_update_node` could point an edge at a node in a memory the caller
 * cannot read — both a foreign-memory existence oracle and, once the edge is
 * hydrated through `Edge.target`, a cross-tenant content read. The
 * unauthorized-target branch reuses the genuine-miss wording to keep that
 * channel closed.
 */
export async function resolveEdgeRefs(
  edges: Array<{
    targetId: string;
    name?: string | null;
    loc?: string | null;
    description?: string | null;
    isRunnable?: boolean | null;
  }>,
  sourceMemoryId: string,
  auth: AuthContext,
): Promise<{ resolved: ResolvedEdge[] } | { error: string }> {
  const resolved: ResolvedEdge[] = [];
  for (const edge of edges) {
    try {
      const { id: targetNodeId } = await resolveNodeRef(db, edge.targetId, sourceMemoryId);
      // Fetch the target's loc so the edge loc can be derived at write time.
      const tgt = await db.node.findUnique({
        where: { id: targetNodeId },
        select: { loc: true, memoryId: true },
      });
      if (!tgt || !(await canReadMemory(db, auth, tgt.memoryId))) {
        return { error: `Edge target not found: "${edge.targetId}"` };
      }
      resolved.push({
        targetNodeId,
        targetLoc: tgt.loc,
        name: edge.name ?? null,
        loc: edge.loc ?? null,
        description: edge.description ?? null,
        isRunnable: edge.isRunnable ?? null,
      });
    } catch (err) {
      if (err instanceof NodeNotFoundError) {
        return { error: `Edge target not found: "${err.ref}"` };
      }
      throw err;
    }
  }
  return { resolved };
}

/**
 * Add a single outgoing edge from `sourceUrn` to `targetUrn`, non-
 * destructively (other edges on the source are left alone) and
 * idempotently (re-running with the same loc is a no-op against
 * the `@@unique([loc, memoryId])` identity). Backs the
 * `hadron_create_edge` MCP tool — extracted so the auth-gated flow (resolve
 * source → check write → resolve target → check read → upsert) is
 * directly testable without wiring a full MCP transport handshake.
 *
 * Returns either a `{ urn }`-shaped success carrying the canonical
 * URNs of both endpoints (useful for cross-memory edges where the
 * target's memory differs from the source's), or a `{ error }`-shaped
 * miss with a caller-facing message. Errors use the same wording the
 * tool surface emits, so the helper IS the contract for the MCP
 * response text.
 *
 * Security: target-memory read access is checked explicitly with
 * `canReadMemory` — `resolveNodeRef` is a pure DB lookup with no
 * auth context, so without this gate a caller could probe foreign-
 * memory node existence via the `Edge target not found` vs success
 * distinction. The unauthorized-target branch returns the same
 * `Edge target not found` wording as the genuine miss to keep the
 * channel closed.
 */
export type AddEdgeResult =
  | { error: string }
  | { sourceUrn: string; targetUrn: string; edgeUrn: string; name: string | null; loc: string };

export async function addEdge(args: {
  sourceUrn: string;
  targetUrn: string;
  name?: string | null;
  loc?: string | null;
  description?: string | null;
  isRunnable?: boolean | null;
  auth: AuthContext;
}): Promise<AddEdgeResult> {
  const {
    sourceUrn: rawSource,
    targetUrn: rawTarget,
    name = null,
    loc: authoredLoc = null,
    description = null,
    isRunnable = null,
    auth,
  } = args;

  // #322: the source may be an ID-shape PK *or* a fully-qualified URN.
  // PKs are immutable across move/rename, so referencing the source by id
  // survives a URN change (the incident in #322); a URN is the fallback.
  // A URN must be fully qualified (we recover the memory from it for the
  // write check); a bare PK is unambiguous, needs no qualification, and
  // can't reintroduce the spec-022 silent-routing hazard (that only
  // applies to context-relative locs, never to a PK lookup). The target
  // likewise accepts a PK or a fully-qualified URN — the gate below
  // enforces qualification for any non-ID target (no short-loc dispatch).
  try {
    if (!isId(rawTarget)) {
      assertFullyQualifiedUrn(rawTarget, 'node');
    }
  } catch (e) {
    if (e instanceof UrnNotQualifiedError) return { error: `Target: ${e.message}` };
    throw e;
  }

  // Resolve source strictly — hadron_create_edge never auto-creates the
  // source (use hadron_create_node for that). Both branches yield the
  // node's id + loc + memoryId; downstream is identifier-agnostic.
  let sourceNode: { id: string; loc: string; memoryId: string };
  if (isId(rawSource)) {
    const found = await db.node.findUnique({
      where: { id: rawSource },
      select: { id: true, loc: true, memoryId: true, deletedAt: true },
    });
    if (!found || found.deletedAt) {
      return { error: `Source node not found: "${rawSource}".` };
    }
    sourceNode = { id: found.id, loc: found.loc, memoryId: found.memoryId };
  } else {
    try {
      assertFullyQualifiedUrn(rawSource, 'node');
    } catch (e) {
      if (e instanceof UrnNotQualifiedError) return { error: `Source: ${e.message}` };
      throw e;
    }
    const { memoryUrn: sourceMemoryUrn, loc: sourceLoc } = splitNodeUrn(rawSource);
    const sourceMem = await resolveMemoryByUrn(sourceMemoryUrn);
    if (!sourceMem) {
      return { error: `Source memory not found: "${sourceMemoryUrn}".` };
    }
    const found = await db.node.findUnique({
      where: { loc_memoryId: { loc: sourceLoc, memoryId: sourceMem.id } },
      select: { id: true, loc: true, memoryId: true, deletedAt: true },
    });
    if (!found || found.deletedAt) {
      return { error: `Source node not found: "${rawSource}".` };
    }
    sourceNode = { id: found.id, loc: found.loc, memoryId: found.memoryId };
  }

  if (!(await canWriteToMemory(db, auth, sourceNode.memoryId))) {
    return { error: 'Write access denied for source memory.' };
  }

  let targetNodeId: string;
  try {
    ({ id: targetNodeId } = await resolveNodeRef(db, rawTarget, sourceNode.memoryId));
  } catch (e) {
    if (e instanceof NodeNotFoundError) {
      return { error: `Edge target not found: "${e.ref}"` };
    }
    throw e;
  }

  // Fetch the target's memory + loc once; reused for the
  // canReadMemory gate AND the success-message URN rendering.
  const target = await db.node.findUnique({
    where: { id: targetNodeId },
    select: { loc: true, memoryId: true },
  });
  if (!target || !(await canReadMemory(db, auth, target.memoryId))) {
    return { error: `Edge target not found: "${rawTarget}"` };
  }

  // Spec 037: the edge's identity is its loc within the source memory.
  // Author-supplied loc is validated; otherwise derive it deterministically
  // so re-running with the same endpoints + name stays idempotent.
  const edgeLoc =
    authoredLoc != null && authoredLoc !== '' ? authoredLoc : deriveEdgeLoc(sourceNode.loc, name, target.loc);
  try {
    validateLoc(edgeLoc);
  } catch (e) {
    if (e instanceof InvalidLocError) return { error: `Invalid edge loc: ${e.message}` };
    throw e;
  }

  await db.edge.upsert({
    where: { loc_memoryId: { loc: edgeLoc, memoryId: sourceNode.memoryId } },
    create: {
      id: generateId(),
      memoryId: sourceNode.memoryId,
      sourceId: sourceNode.id,
      targetId: targetNodeId,
      loc: edgeLoc,
      name,
      description,
      isRunnable,
      createdBy: auth.clientId ?? null,
    },
    update: {},
  });

  const savedSourceUrn = await nodeUrn(sourceNode.loc, sourceNode.memoryId);
  const savedTargetUrn = await nodeUrn(target.loc, target.memoryId);
  const savedEdgeUrn = await edgeUrn(edgeLoc, sourceNode.memoryId);
  return { sourceUrn: savedSourceUrn, targetUrn: savedTargetUrn, edgeUrn: savedEdgeUrn, name, loc: edgeLoc };
}

/**
 * Replace the outgoing edges of `sourceNodeId` with `resolved`, in a
 * single `$transaction` so we never observe a state where the
 * existing edges are gone but the new ones are missing.
 *
 * Caller must have already validated targets via `resolveEdgeRefs` —
 * this function performs only writes. Each row gets an explicit
 * UUIDv7 from `generateId()` because the Prisma client extension at
 * `src/integrations/db/client.ts` only auto-injects IDs on `create`
 * and `upsert`, not on `createMany`.
 */
export async function replaceOutgoingEdges(args: {
  sourceNodeId: string;
  sourceLoc: string;
  sourceMemoryId: string;
  resolved: ResolvedEdge[];
  createdBy: string | null;
}): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.edge.deleteMany({ where: { sourceId: args.sourceNodeId } });
    await tx.pendingEdge.deleteMany({ where: { sourceId: args.sourceNodeId } });
    if (args.resolved.length > 0) {
      await tx.edge.createMany({
        data: args.resolved.map((e) => ({
          id: generateId(),
          memoryId: args.sourceMemoryId,
          sourceId: args.sourceNodeId,
          targetId: e.targetNodeId,
          loc: e.loc ?? deriveEdgeLoc(args.sourceLoc, e.name, e.targetLoc),
          name: e.name,
          description: e.description,
          isRunnable: e.isRunnable,
          createdBy: args.createdBy,
        })),
        skipDuplicates: true,
      });
    }
  });
}

/**
 * v2 entity URN for user-facing MCP tool text (#697 emission flip). Falls back
 * to the raw stored bare urn if a row can't compose to v2 — display strings must
 * never crash a tool (serve-and-fall-back).
 */
function safeEmitEntityUrnV2(type: 'memory' | 'app', bareUrn: string): string {
  try {
    return emitEntityUrnV2(type, bareUrn);
  } catch {
    return bareUrn;
  }
}

/** Build a full urn:node: URN from a loc and memoryId. Caches memory URNs. */
const memoryUrnCache = new Map<string, string>();
async function nodeUrn(loc: string, memoryId: string): Promise<string> {
  let memUrn = memoryUrnCache.get(memoryId);
  if (!memUrn) {
    const mem = await db.memory.findUnique({ where: { id: memoryId }, select: { urn: true } });
    memUrn = mem?.urn ?? memoryId;
    memoryUrnCache.set(memoryId, memUrn);
  }
  // Grammar-v2 node URN (#697 emission flip). Shared with the global-search
  // node adapter via emitNodeUrnV2 (src/lib/urnEmit.ts) so the two surfaces
  // can't drift on node-URN shape.
  return emitNodeUrnV2(memUrn, loc);
}

/** Build a full hrn:edge: URN from an edge loc and its memoryId (spec 037). */
async function edgeUrn(loc: string, memoryId: string): Promise<string> {
  let memUrn = memoryUrnCache.get(memoryId);
  if (!memUrn) {
    const mem = await db.memory.findUnique({ where: { id: memoryId }, select: { urn: true } });
    memUrn = mem?.urn ?? memoryId;
    memoryUrnCache.set(memoryId, memUrn);
  }
  return emitEdgeUrnV2(memUrn, loc);
}

// The `hadron_find_nodes` tool delegates retrieval to resolvers.Query.findNodes
// (PR2 #403), so the keyword/expand search helpers are no longer imported here;
// they live in src/lib/search.ts, consumed by the findNodes resolver.

// Loc validation moved to src/lib/validateLoc.ts so the GraphQL
// upsertNode resolver and the MCP tool surface share the same rule
// and produce the same typed InvalidLocError.

/**
 * If the user passes a full URN (e.g. "hadronmemory.com:dev:architecture"),
 * try to strip the memory URN prefix and return just the loc.
 * Also returns the matched memoryId for scoping.
 */
async function resolveLocFromUrn(
  rawInput: string,
  accessibleMemoryIds: string[] | null,
): Promise<{ loc: string; memoryId?: string }> {
  // For an explicit `urn:node:<org>::<memory>::<loc>` input (canonical
  // OR legacy hierarchy), route through splitNodeUrn so the memory/loc
  // boundary is recovered correctly. The fallback prefix-strip below
  // uses `mem.urn + ':'` to detect the boundary, which mis-parses
  // canonical inputs in two ways:
  //   - If Memory.urn is legacy (`acme.com:dev`), the input
  //     `acme.com::dev::loc` doesn't start with `acme.com:dev:` and
  //     never matches.
  //   - If Memory.urn is canonical (`acme.com::dev`), the input
  //     starts with `acme.com::dev:` (one trailing colon, not two),
  //     so the strip leaves a leading `:` in the returned loc.
  // Either way, callers (hadron_list_nodes / hadron_find_nodes) end up with a
  // bogus prefix that breaks depth math and `startsWith(prefix + ':')`
  // scoping. splitNodeUrn handles both grammars uniformly.
  const parsed = parseUrnInput(rawInput);
  if (parsed.type === 'node') {
    try {
      const { memoryUrn, loc } = splitNodeUrn(rawInput);
      const mem = await resolveMemoryByUrn(memoryUrn);
      if (mem && (!accessibleMemoryIds || accessibleMemoryIds.includes(mem.id))) {
        return { loc, memoryId: mem.id };
      }
      // Memory unknown / inaccessible — fall through to the legacy
      // best-effort path below so behavior degrades gracefully for the
      // (rare) caller passing a stale or out-of-scope URN.
    } catch {
      // splitNodeUrn rejects malformed inputs — fall through.
    }
  }

  const input = parsed.value;

  // First, try as-is — it might already be a valid loc
  const directWhere: Record<string, unknown> = { loc: input };
  if (accessibleMemoryIds) directWhere.memoryId = { in: accessibleMemoryIds };
  const direct = await db.node.findFirst({ where: directWhere, select: { id: true } });
  if (direct) return { loc: input };

  // Try stripping known memory URN prefixes
  // Load accessible memories and check if input starts with any URN
  const memoryFilter = accessibleMemoryIds ? { id: { in: accessibleMemoryIds } } : {};
  const memories = await db.memory.findMany({ where: memoryFilter, select: { id: true, urn: true } });
  for (const mem of memories) {
    const prefix = mem.urn + ':';
    if (input.startsWith(prefix)) {
      const loc = input.slice(prefix.length);
      return { loc, memoryId: mem.id };
    }
  }

  // No match — return as-is
  return { loc: input };
}

/**
 * Look up a Memory by a user-supplied URN that may be canonical
 * (`urn:memory:foo:bar`) or bare (`foo:bar`). Memory.urn is stored bare,
 * so a prefixed input must be stripped before the DB lookup. A wrong-type
 * URN prefix (`urn:agent:`, `urn:org:`, etc.) returns null so the caller
 * can surface a clean error rather than silently coerce — see #100 #3
 * (the memory-scoped read-after-write asymmetry traced to this exact
 * normalization gap).
 *
 * Soft-deleted memories are treated as not found, matching the convention
 * in `resolveMemoryRef` and the entity-ref helpers under `src/lib/entityRef/`.
 */
async function resolveMemoryByUrn(
  rawUrn: string,
): Promise<{ id: string; urn: string } | null> {
  const parsed = parseUrnInput(rawUrn.trim());
  if (parsed.type !== 'memory' && parsed.type !== 'unknown') return null;
  if (!parsed.value) return null;
  // Spec 021 migration window: Memory.urn rows may be stored in either
  // legacy (`acme.com:dev`) or canonical (`acme.com::dev`) form. Match
  // BOTH so a canonical-form input doesn't miss a legacy-stored row and
  // vice versa. Previously this normalized to legacy only and used an
  // equality lookup — that broke for the canonical-stored case, which
  // the resolveNodeRef tests in this PR already exercise (and the
  // hadron_create_edge source path inherits the same hazard via splitNodeUrn).
  const legacyForm = normalizeUrnForLookup(parsed.value);
  const canonicalForm = legacyForm.includes(':')
    ? legacyForm.split(':').join('::')
    : legacyForm;
  return await db.memory.findFirst({
    where: {
      deletedAt: null,
      OR: [{ urn: legacyForm }, { urn: canonicalForm }],
    },
    select: { id: true, urn: true },
  });
}

// Access control lives in ./access-control.ts.

/**
 * Shared single-node read projection — the meta block + contentScope-driven
 * body that `hadron_get_node` returns. Extracted so `hadron_get_nodes` (batch) emits
 * the *identical* per-node projection (spec cor:api:040:01 — "the per-node
 * projection is identical to the single-node read"); the two surfaces share
 * one renderer and cannot drift. Pure formatting — the caller fetches the
 * node (with outgoing/incoming edges + `memory.isEncrypted`), validates
 * `contentScope`, and fires any usage event; this only renders. Response
 * matrix: specs/031-node-abstract-field/contracts/hadron_get_node.md (spec 031 + 032).
 */
type ReadProjectionNode = {
  id: string;
  name: string;
  loc: string;
  memoryId: string;
  description: string | null;
  nodeType: string;
  tags: string[];
  seq: number | null;
  properties: unknown;
  data: unknown;
  content: string | null;
  abstract: string | null;
  abstractOriginHash: string | null;
  memory: { isEncrypted: boolean };
  outgoingEdges: Array<{ name: string | null; loc: string; target: { id: string; loc: string; memoryId: string; name: string } }>;
  incomingEdges: Array<{ name: string | null; loc: string; source: { id: string; loc: string; memoryId: string; name: string } }>;
};

/**
 * Spec 041 (PR-2, #206): decrypt a fetched node in place when this process
 * holds the memory's key (MCP session unlock / any live session), or mark
 * it locked. On 'unlocked' the projection is plaintext and downstream logic
 * (staleness hash, fallbacks) behaves exactly like a plaintext memory — the
 * helper flips the projection's isEncrypted flag to say so. On 'locked' the
 * encrypted fields are BLANKED (a `Locked:` meta line replaces enc:v1 noise).
 */
function mcpDecryptOrMark(
  node: Pick<ReadProjectionNode, 'memoryId' | 'content' | 'abstract' | 'data' | 'memory'>,
): 'plaintext' | 'unlocked' | 'locked' {
  if (!node.memory.isEncrypted) return 'plaintext';
  const key = sessionKeyCache.getByMemoryId(node.memoryId);
  if (key) {
    decryptNodeFieldsWithKey(node, key);
    node.memory = { isEncrypted: false }; // projection-local: it IS plaintext now
    return 'unlocked';
  }
  node.content = null;
  node.abstract = null;
  node.data = null;
  return 'locked';
}

async function renderNodeReadProjection(
  node: ReadProjectionNode,
  scope: 'content' | 'abstract' | 'all',
  opts: { locked?: boolean } = {},
): Promise<string> {
  const urn = await nodeUrn(node.loc, node.memoryId);
  const outgoingLines = await Promise.all(
    node.outgoingEdges.map(async (e) => {
      const targetUrn = await nodeUrn(e.target.loc, e.target.memoryId);
      // #322: surface the target's stable PK alongside the URN so callers can
      // reference it by id (immutable across move/rename) instead of the URN.
      return `  - ${targetUrn} (id: ${e.target.id}) (${e.target.name}) — ${e.name ?? e.loc}`;
    }),
  );
  const incomingLines = await Promise.all(
    node.incomingEdges.map(async (e) => {
      const sourceUrn = await nodeUrn(e.source.loc, e.source.memoryId);
      return `  - ${sourceUrn} (id: ${e.source.id}) (${e.source.name}) — ${e.name ?? e.loc}`;
    }),
  );

  const hasContent = !!(node.content && node.content.length > 0);
  const hasAbstract = !!(node.abstract && node.abstract.length > 0);
  const isFallback = scope === 'content' && !hasContent && hasAbstract;

  // Spec 032 FR-010 — `Source: abstract-stale` marker. Encryption gate:
  // since spec 041 PR-2 the MCP read path decrypts when the session holds
  // the key — mcpDecryptOrMark flips the projection's isEncrypted to false
  // on success, so the predicate below runs on PLAINTEXT for unlocked
  // memories and is (correctly) skipped only while locked. Scope gate:
  // the marker only fires under scopes that surface the abstract (`abstract` /
  // `all`); the default `content` scope omits it (the abstract isn't in the
  // response). The explicit `abstractOriginHash != null` guard is load-bearing
  // for legacy rows (without it `null !== "abc"` is true and the marker
  // false-fires on every pre-spec-032 node).
  const shouldCheckStale = scope === 'abstract' || scope === 'all';
  let includeStaleMarker = false;
  if (
    shouldCheckStale &&
    !node.memory.isEncrypted &&
    hasAbstract &&
    hasContent &&
    node.abstractOriginHash != null
  ) {
    includeStaleMarker =
      node.abstractOriginHash !== computeContentHash(node.content);
  }

  // #186: surface nodeType so callers can tell `parent` from `info`.
  const meta = [
    `**${node.name}**`,
    urn,
    // #322: the node's stable PK. URNs are mutable (move/rename changes the
    // loc), so edges/replies created against a URN break when it changes;
    // the id never does. Surfaced so callers can prefer it as the reference.
    `ID: ${node.id}`,
    node.description ? `> ${node.description}` : '',
    `Type: ${node.nodeType}`,
    opts.locked
      ? 'Locked: encrypted memory — call hadron_unlock_memory to read/write its content (spec 041)'
      : '',
    isFallback ? 'Source: abstract-fallback' : '',
    includeStaleMarker ? 'Source: abstract-stale' : '',
    node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
    node.seq !== null ? `Seq: ${node.seq}` : '',
    node.properties ? `Properties: ${JSON.stringify(node.properties)}` : '',
    node.data ? `Data: ${JSON.stringify(node.data)}` : '',
    outgoingLines.length ? `Related:\n${outgoingLines.join('\n')}` : '',
    incomingLines.length ? `Referenced by:\n${incomingLines.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  // Response matrix (specs/031-node-abstract-field/contracts/hadron_get_node.md).
  if (scope === 'abstract') {
    // meta + abstract (no `---`, no body). Meta alone when abstract null.
    return hasAbstract ? `${meta}\n\n${node.abstract}` : meta;
  }
  if (scope === 'all') {
    //   both present  → meta + abstract + --- + content
    //   only abstract → meta + abstract  (no `---`)
    //   only content  → meta + --- + content
    //   both null     → meta alone
    const parts: string[] = [meta];
    if (hasAbstract) parts.push(node.abstract!);
    if (hasContent) parts.push(`---\n\n${node.content}`);
    return parts.join('\n\n');
  }
  // scope === 'content' (default) — body is content, else abstract (fallback),
  // else empty (byte-identical pre-spec when content AND abstract are null).
  const body = hasContent ? node.content! : isFallback ? node.abstract! : '';
  return meta + '\n\n---\n\n' + body;
}

// ---------------------------------------------------------------------------
// MCP Server factory — one McpServer per transport session
// ---------------------------------------------------------------------------

export function createMcpServerInstance(
  auth: AuthContext,
  getSessionId: () => string | undefined,
  cachedAppResolution: AppResolution | null,
): McpServer {
  const server = new McpServer(
    { name: 'hadron', version: HADRON_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Per-session state — this server instance is built once per MCP session
  // (see the createMcpServerInstance call sites), so this closure variable is
  // genuinely per-session. Set via `hadron_set_active_memory`. Spec 022 D4a kept it
  // advisory; spec cor:api:060 (hadron_run_task) is its first server-side reader,
  // consuming it as the default memory scope when a by-name run gives no
  // `memory` hint. Spec-022 URN-input tools still MUST NOT fall back to it —
  // they require a fully-qualified URN.
  let activeMemoryUrn: string | undefined;

  // Spec 026 — has the session called `hadron_list_apps` or `hadron_set_active_app`,
  // or had a regime-(b) `initialize` envelope attempted? Toggles which
  // error fires when a multi-App user calls an App-scoped tool without
  // selection: typed `no_active_app` (new) vs. legacy
  // `multiple_apps_resolved` text (FR-016 fall-through for un-migrated
  // clients). The legacy text is preserved verbatim in the helper so
  // SC-003 can track adoption — operators watching for the legacy phrase
  // in logs / client traces see the migration trend.
  let engagedWithNewSurface = false;

  /**
   * Spec 026 — resolve the active App for an App-scoped tool call.
   * Returns `null` when the caller can proceed (auth.appId set, possibly
   * via a freshly applied session-scoped selection). Returns an MCP
   * tool-error envelope when the caller has no App scope.
   *
   * Mutates `auth.appId` / `auth.organizationId` when a session-scoped
   * selection becomes active — so the existing tools' `if (!auth.appId)`
   * checks downstream pass without per-tool plumbing.
   */
  function requireAppScope(): AppSelectionErrorEnvelope | null {
    if (auth.appId) return null;
    if (!auth.userId) return null; // truly unauth — let existing checks handle it

    const sid = getSessionId();
    if (sid) {
      const sel = activeAppByMcpSession.get(sid);
      if (sel) {
        auth.appId = sel.appId;
        auth.organizationId = sel.organizationId ?? undefined;
        return null;
      }
    }

    if (cachedAppResolution?.kind === 'multi-app') {
      // TODO(US3 — revocation cascade): cachedAppResolution is captured at
      // session-init and may go stale within a long-lived session. A user
      // whose multi-App status changes mid-session (one revocation reduces
      // them to single-App; new install widens them to multi-App) won't
      // see the cache invalidate. US3's revocation work is the natural
      // place to add a per-call re-resolve OR an invalidation hook on
      // AppMember mutations.
      if (engagedWithNewSurface) {
        const message = `No active Hadron App. Call hadron_list_apps to see options, then hadron_set_active_app with the one you want. If you're calling from a project directory, set 'app' in '.hadron/config.json'.`;
        mcpLog('warn', 'no_active_app_typed_error', { userId: auth.userId, mcpSessionId: sid });
        return appSelectionError(APP_SELECTION_ERROR_CODES.NO_ACTIVE_APP, message);
      }
      // FR-016 fall-through for un-engaged callers. The MULTIPLE_APPS_RESOLVED
      // code carries the literal `multiple_apps_resolved` token in the
      // envelope's `[<code>]` prefix so SC-003's production-log grep
      // continues to work even when the legacy spec-025 HTTP 409 path is
      // gone.
      const message = `User has more than one Hadron App; this MCP client does not support App selection. See ${MULTIPLE_APPS_DOCS_URL} for guidance. Or call hadron_list_apps to see your accessible Apps and hadron_set_active_app to pick one.`;
      mcpLog('warn', 'multiple_apps_resolved_fallthrough', { userId: auth.userId, mcpSessionId: sid });
      return appSelectionError(APP_SELECTION_ERROR_CODES.MULTIPLE_APPS_RESOLVED, message);
    }

    return null; // zero-App or other path — fall through
  }

  // ── hadron_search ─────────────────────────────────────────────────────────────

  server.tool(
    'hadron_search',
    "Global cross-entity search across organizations, memories, nodes, agents, apps, AI service configs, and users — returns one ranked, flat list. By default the query shape is smart-sniffed: a PK-shaped input does an exact id lookup, a URN-shaped input matches URNs, free text matches name + URN. Pass `fields` to force which fields to match (overrides the sniff) and `entityTypes` to restrict the kinds. `pk` is exact-match; the rest are case-insensitive substring — including `content` (node bodies), which is a LITERAL substring match (NOT stemmed): 'report abuse' won't match 'reports abusive behavior'. `content` is opt-in and skips encrypted memories. For a stemmed, ranked, concept/multi-word search over node text — and the cross-memory 'does anyone know about X?' probe — use hadron_find_nodes (keyword mode, allMemories: true) instead; this tool is best for locating a known entity by name/URN/id across kinds.",
    {
      query: z
        .string()
        .describe('Search text: a PK/id, a URN (hrn:/urn: or bare org::slug), or free-text name.'),
      entityTypes: z
        .array(
          z.enum(['organization', 'memory', 'node', 'agent', 'app', 'aiServiceConfig', 'user']),
        )
        .optional()
        .describe('Restrict to these entity types. Omit to search all.'),
      fields: z
        .array(z.enum(['urn', 'name', 'description', 'pk', 'content']))
        .optional()
        .describe('Force these fields (overrides the smart-sniff). Omit to auto-detect.'),
      limit: z.number().optional().describe('Max results (default 50, max 200).'),
    },
    async ({ query, entityTypes, fields, limit }) => {
      if (!auth.clientId && !auth.appId && !auth.userId) return textResult('Not authenticated.');

      // createTestableMcpServer bypasses zod — normalize args defensively.
      const q = typeof query === 'string' ? query : '';
      const types = normalizeEntityTypes(entityTypes);
      const flds = normalizeFields(fields);
      const lim = typeof limit === 'number' ? limit : undefined;

      // Same access gates as the GraphQL globalSearch resolver — see the
      // rationale there. App-Key callers (no userId) get no org-read → [].
      const isPlatformAdmin = !!auth.roles?.includes('ADMIN') || !!auth.roles?.includes('OWNER');
      const accessibleMemoryIds = await getAccessibleMemoryIds(db, auth);
      // The caller's own member orgs (admin or not) — the org allow-list for
      // non-admins, and the #609 hidden-org carve-out for admins.
      const memberOrgIds = auth.userId ? await getMemberOrgIds(db, auth.userId) : [];
      const orgIds = isPlatformAdmin ? null : memberOrgIds;
      const principal: SearchPrincipal = {
        viewerUserId: auth.userId ?? null,
        isPlatformAdmin,
        accessibleMemoryIds,
        orgIds,
        viewerOrgIds: memberOrgIds,
      };

      const { hits, degraded } = await globalSearch(
        db,
        { query: q, entityTypes: types, fields: flds, limit: lim },
        principal,
      );

      const note = degraded.length
        ? `\n\n${degraded.map((d) => `[degraded] ${d}`).join('\n')}`
        : '';
      if (hits.length === 0) {
        return textResult(`No results for "${q}".${note}`);
      }
      const lines = hits.map((h) => {
        const label = h.urn ?? h.id;
        const name = h.name ? ` — ${h.name}` : '';
        return `- [${h.entityType}] **${label}**${name} (matched ${h.matchedField}, score ${h.score.toFixed(2)})`;
      });
      return textResult(
        `${hits.length} result${hits.length === 1 ? '' : 's'} for "${q}":\n\n${lines.join('\n')}${note}`,
      );
    },
  );

  // ── hadron_list_memories ──────────────────────────────────────────────────────

  server.tool(
    'hadron_list_memories',
    'List all memories this caller has access to, with URN and access level (read-only or read-write).',
    {},
    async () => {
      // Spec 026 / D-2026-05-21-003: hadron_list_memories is advisory — it
      // works without an active App. When auth.appId is unset but
      // auth.userId is set (multi-App OAuth caller without selection),
      // getMemoryAccess unions memory access across the user's
      // accessible Apps. No requireAppScope() gate on purpose.
      if (!auth.clientId && !auth.appId && !auth.userId) return textResult('Not authenticated.');

      // Effective access level per memory. The App/org access map is
      // personal-free by design (it also backs getAccessibleMemoryIds, which
      // other tools rely on staying personal-free), so we start from it and
      // then fold in the caller's own personal/private memories below.
      const levels = new Map<string, string>(await getMemoryAccess(db, auth));

      // #282: a user's own personal/private memories are reachable per-node via
      // canReadMemory but absent from the access map — so without this they
      // can't be *discovered* over MCP, the CLI-vs-MCP asymmetry #282 reported.
      // Fold them in here, gated on auth.userId: App-Key callers (no userId)
      // get none, preserving per-App isolation. canReadMemory / canWriteToMemory
      // are the canonical gates, so the listing can never disagree with what
      // hadron_get_node allows — including per-App isolation for app-scoped personal
      // rows and the spec-034 free-standing owner-only case.
      if (auth.userId) {
        const owned = await db.memory.findMany({
          where: {
            userId: auth.userId,
            class: { in: ['personal', 'private'] },
            deletedAt: null,
          },
          select: { id: true },
        });
        // Each memory is independent and keyed by a unique id, so run the gate
        // checks concurrently rather than as a serial 2N+1 round-trip when a
        // user owns many personal memories. The synchronous `levels.set`
        // between awaits is race-free: the ids are distinct, so no two
        // callbacks ever touch the same key.
        await Promise.all(
          owned.map(async ({ id }) => {
            if (levels.has(id)) return;
            if (!(await canReadMemory(db, auth, id))) return;
            levels.set(id, (await canWriteToMemory(db, auth, id)) ? 'READ_WRITE' : 'READ_ONLY');
          }),
        );
      }

      // Surface the active scope so a narrow list isn't silently mistaken for
      // "no access" (#282; also the #187/#190 dual-namespace confusion) — an
      // App-Key session is intentionally narrower than a user session.
      let scope: string;
      if (auth.appId) {
        const app = await db.app.findUnique({ where: { id: auth.appId }, select: { urn: true } });
        const who = app ? safeEmitEntityUrnV2('app', app.urn) : auth.appId;
        scope = auth.userId
          ? `Scope: user · active App ${who} — this App's agent memories + org-readable memories + your personal memories scoped to this App.`
          : `Scope: App key · ${who} (App-scoped) — this App's agent memories only; personal and org-readable memories require user authentication and are not shown to an App key.`;
      } else if (auth.userId) {
        scope = `Scope: user · no active App — the union across your Apps + org-readable memories + all your personal memories. Select one with hadron_set_active_app to narrow the view.`;
      } else {
        scope = `Scope: ${auth.clientId ?? 'authenticated caller'}.`;
      }

      if (levels.size === 0) {
        return textResult(`${scope}\n\nNo memories accessible. Subscribe to an agent with memories first.`);
      }

      const memoryIds = [...levels.keys()];
      const memories = await db.memory.findMany({
        where: { id: { in: memoryIds } },
        select: { id: true, urn: true, name: true, data: true, schema: true, class: true },
      });

      // #339: the displayed level MUST equal what mutating ops enforce.
      // canWriteToMemory grants global ADMIN/OWNER an unconditional write
      // bypass on every NON-personal memory (access-control.ts), but
      // getMemoryAccess — which `levels` is built from — never encodes that
      // bypass (it tops out at READ_ONLY for org-readable knowledge/group/
      // public rows). Without folding the bypass in here, an admin sees their
      // org's memories labeled read-only while hadron_create_node into them
      // succeeds — the exact list-vs-enforce divergence #339 reported. The
      // bypass is non-personal only; personal/private rows keep the strict-
      // ownership level the owned fold above already computed via
      // canWriteToMemory, so this can't wrongly upgrade another user's
      // (unreachable) personal memory.
      const isSuperWriter = !!auth.roles?.includes('ADMIN') || !!auth.roles?.includes('OWNER');

      const lines = memories.map((m) => {
        const isPersonal = m.class === 'personal' || m.class === 'private';
        const writable =
          levels.get(m.id) === 'READ_WRITE' || (isSuperWriter && !isPersonal);
        const level = writable ? 'read-write' : 'read-only';
        // Tag personal/private rows so it's clear *why* an otherwise-private
        // memory shows up (it's the caller's own); knowledge/app/group rows
        // keep the bare `(level)` form they've always had.
        const cls = isPersonal ? `${m.class}, ` : '';
        const head = `- **${safeEmitEntityUrnV2('memory', m.urn)}** — ${m.name} (${cls}${level})`;
        // Free-form metadata bag (no server-side semantics). Surfaced
        // read-only on its own indented line, only when non-null so the
        // listing stays scannable — mirrors hadron_get_node's `Data: <json>`
        // idiom. Writing `data` is a GraphQL-only path: the MCP surface has
        // no memory-mutation tool (memories are created/edited via
        // createMemory / updateMemory). MCP also bypasses encryption (#206),
        // but `data` is plaintext-by-design metadata, so there's no
        // decrypt-parity gap to bridge here.
        // #725 — surface the property schema read-only for discovery (which
        // collections + typed fields this memory declares), so an agent knows
        // what objectType/where to query. Authoring stays GraphQL-only.
        const dataLine = m.data != null ? `\n  data: ${JSON.stringify(m.data)}` : '';
        const schemaLine = m.schema != null ? `\n  schema: ${JSON.stringify(m.schema)}` : '';
        return `${head}${dataLine}${schemaLine}`;
      });

      return textResult(`${scope}\n\n${memories.length} accessible memories:\n\n${lines.join('\n')}`);
    },
  );

  // ── hadron_set_active_memory ──────────────────────────────────────────────────

  server.tool(
    'hadron_set_active_memory',
    'Set the active memory for this session. Subsequent tree tools will use this as the default scope.',
    {
      memoryUrn: z.string().describe('Memory URN, e.g. hadronmemory.com::dev or hrn:memory:hadronmemory.com::dev'),
    },
    async ({ memoryUrn }) => {
      // #100 #3: Memory.urn is stored bare ('hadronmemory.com::dev'). Storing
      // the caller-supplied string verbatim makes every downstream
      // findFirst({urn:activeMemoryUrn}) silently miss when the caller passed
      // the canonical 'urn:memory:' form. Writes have fallback paths
      // (single-writable-memory, parent-node lookup) and so still land on
      // the right memory; reads do not. Result: writes succeed, reads see
      // an inconsistent / empty scope, which is the read-after-write
      // asymmetry reported in issue #100.
      const parsed = parseUrnInput(memoryUrn.trim());
      if (parsed.type !== 'memory' && parsed.type !== 'unknown') {
        const prefix = parsed.type === 'loc' ? 'loc:' : `hrn:${parsed.type}:`;
        return textResult(
          `Expected a memory URN, got '${prefix}'. Pass 'hadronmemory.com::dev' or 'hrn:memory:hadronmemory.com::dev'.`,
        );
      }

      // Resolve via the shared helper — soft-delete filtering, trimming, and
      // bare-URN normalization all live in one place so every read-side
      // scoping point behaves consistently.
      const mem = await resolveMemoryByUrn(memoryUrn);
      if (!mem) {
        return textResult(`Memory not found: '${memoryUrn}'. Use hadron_list_memories to see what's available.`);
      }
      if (!(await canReadMemory(db, auth, mem.id))) {
        return textResult(`Access denied: '${memoryUrn}'.`);
      }

      // Store the bare URN from the DB row (the canonical form for downstream
      // findFirst({urn:activeMemoryUrn}) lookups).
      activeMemoryUrn = mem.urn;

      // #187 / #190 — include the bound deployment URL + server version
      // in the success message so an agent (or a transcript reader) can
      // notice they've reached the wrong hadron-server when two
      // namespaces (`mcp__hadron__*` vs `mcp__claude_ai_Hadron__*`) are
      // bound to different deployments. Cheap to surface, hard to
      // ignore in transcripts. Full diagnostic dump lives on
      // hadron_server_info; this is the inline hint.
      const dep = getDeploymentInfo();
      return textResult(
        `Active memory set to: ${safeEmitEntityUrnV2('memory', mem.urn)} ` +
          `(server: ${dep.baseUrl}, version: ${dep.version}).`,
      );
    },
  );

  // ── hadron_server_info ────────────────────────────────────────────────────────
  //
  // #187 / #190 — exposes the bound deployment URL + hadron-server
  // version so an agent can answer "which server am I talking to?"
  // without needing to issue any other tool calls. Doesn't require an
  // active App, doesn't require an active memory, doesn't even require
  // read access on any memory — it returns server identity only, never
  // any per-tenant data.
  //
  // Auth layering — the tool itself does NOT add gating because the MCP
  // transport already requires a valid AuthContext (App Key, User API Key,
  // or JWT bearer) to reach any tool invocation. handleMcpRequest at the
  // /mcp boundary rejects requests with no auth principal via a 401 +
  // RFC 9728 protected-resource metadata. So "no tool-level auth gate" is
  // a deliberate layering choice (gate at the transport, not per-tool),
  // not an exposure. The unit test pinning the "works for unauthenticated-
  // shape caller" case bypasses the transport on purpose — it pins that a
  // future "require active App" decoration on this tool can't silently
  // break the transcript-reader use case after auth succeeds upstream.
  //
  // Intentionally does NOT include DATABASE_URL (may carry credentials).
  // If a future need arises to disambiguate two deployments that share
  // a BASE_URL but point at different DBs, the helper's docstring
  // explains how to add a path-only `dbName` field.

  server.tool(
    'hadron_server_info',
    'Returns the identity of the hadron-server this MCP session is bound to: the deployment URL and server version. Useful when a caller has two MCP namespaces wired up and needs to know which one a tool call landed on (see #190 for context). No arguments. Returns plain key:value pairs. Does NOT require an active App or any memory access.',
    {},
    async () => {
      const dep = getDeploymentInfo();
      const lines = [
        `server: ${dep.baseUrl}`,
        `version: ${dep.version}`,
      ];
      return textResult(lines.join('\n'));
    },
  );

  // ── hadron_list_apps (spec 026 regime c) ──────────────────────────────────────

  server.tool(
    'hadron_list_apps',
    'List the Hadron Apps you have access to. Use this to find an App to pass to hadron_set_active_app, or to check what an `app` field in `.hadron/config.json` resolves to.',
    {},
    async () => {
      // Auth gate first; only then mark the session "engaged" so an
      // unauthenticated call can't flip the flag and influence a later
      // re-authed request.
      if (!auth.userId && !auth.clientId && !auth.appId) {
        return textResult('Not authenticated.');
      }
      engagedWithNewSurface = true;
      // AppKey callers (appId set, no userId) — list returns the single App
      // they're scoped to, for parity with the user-credential path.
      if (auth.appId && !auth.userId) {
        const app = await db.app.findUnique({
          where: { id: auth.appId },
          select: { id: true, urn: true, name: true },
        });
        if (!app) return textResult('No accessible apps.');
        return textResult(
          `1 accessible app:\n\n- **${safeEmitEntityUrnV2('app', app.urn)}** — ${app.name} (via App Key)`,
        );
      }

      // Reaching here means we passed the auth gate AND are not AppKey-
      // scoped. In all current auth paths, that implies auth.userId is
      // set (OAuth bearer + portal-issued user-API-key both populate
      // userId). The clientId-only-no-userId case is unreachable in
      // production today; guard defensively so a future auth path that
      // populates clientId without userId can't crash here.
      if (!auth.userId) return textResult('No accessible apps.');
      const apps = await resolveUserAppsWithMeta(auth.userId, db);
      if (apps.length === 0) {
        return textResult(
          'No accessible apps. Ask an App owner to add you, or visit the Hadron portal to create one.',
        );
      }
      const lines = apps.map(
        (a) => `- **${safeEmitEntityUrnV2('app', a.urn)}** — ${a.name} (role: ${a.role})`,
      );
      const header =
        apps.length === 1
          ? `1 accessible app:`
          : `${apps.length} accessible apps:`;
      const trailer =
        apps.length === 1
          ? `\n\n(You only have one App, so hadron_set_active_app isn't required — it's already the active one by default.)`
          : '';
      return textResult(`${header}\n\n${lines.join('\n')}${trailer}`);
    },
  );

  // ── hadron_set_active_app (spec 026 regime c) ─────────────────────────────────

  server.tool(
    'hadron_set_active_app',
    "Set the active Hadron App for this session. Subsequent tools (hadron_find_nodes, hadron_create_node, etc.) will use this as the App scope. Pass the App URN (e.g. 'hrn:app:acme-corp::notes') or an App name that matches exactly one App you have access to. Use hadron_list_apps to see options.",
    {
      app: z
        .string()
        .describe(
          "App URN or unambiguous App name. Pass the URN form for guaranteed match; pass the display name when it is unique across your Apps.",
        ),
    },
    async ({ app }) => {
      // Auth gate first; mark engaged only on real authenticated calls.
      if (auth.appId && !auth.userId) {
        // AppKey caller — App identity is in the credential. Return an
        // error envelope (not a plain text result) so disciplined clients
        // can programmatically distinguish misuse from a successful no-op.
        return appSelectionError(
          APP_SELECTION_ERROR_CODES.APP_NOT_FOUND,
          'AppKey callers already carry App identity in the credential; hadron_set_active_app is not applicable.',
        );
      }
      if (!auth.userId) {
        return textResult('Not authenticated.');
      }
      engagedWithNewSurface = true;

      const r = await resolveAppIdentifier(app, auth.userId, db);
      const sid = getSessionId();

      switch (r.kind) {
        case 'resolved': {
          if (sid) {
            activeAppByMcpSession.set(sid, {
              appId: r.app.id,
              organizationId: r.app.organizationId,
            });
          }
          auth.appId = r.app.id;
          auth.organizationId = r.app.organizationId ?? undefined;
          mcpLog('info', 'regime_c_selection_set', {
            userId: auth.userId,
            mcpSessionId: sid,
            appId: r.app.id,
            appUrn: r.app.urn,
          });
          return textResult(
            `Active App set to: **${safeEmitEntityUrnV2('app', r.app.urn)}** (${r.app.name}). Subsequent App-scoped tools will operate against this App. Call hadron_set_active_app again with a different identifier to switch, or hadron_list_apps to see other options.`,
          );
        }
        case 'ambiguous': {
          const candidatesText = r.candidates
            .map((c) => `  - ${safeEmitEntityUrnV2('app', c.urn)}`)
            .join('\n');
          mcpLog('warn', 'app_identifier_ambiguous', {
            userId: auth.userId,
            mcpSessionId: sid,
            submittedIdentifier: app,
            candidateCount: r.candidates.length,
          });
          return appSelectionError(
            APP_SELECTION_ERROR_CODES.APP_IDENTIFIER_AMBIGUOUS,
            `Multiple Apps match '${app}'. Try the URN form to disambiguate:\n${candidatesText}`,
          );
        }
        case 'unavailable': {
          return appSelectionError(
            APP_SELECTION_ERROR_CODES.APP_UNAVAILABLE,
            `App '${app}' is no longer available (${r.reason}). Ask the App owner to reinstall, or pick another with hadron_list_apps.`,
          );
        }
        case 'not-member': {
          return appSelectionError(
            APP_SELECTION_ERROR_CODES.APP_NOT_FOUND,
            `No accessible App matches '${app}'. Use hadron_list_apps to see what's available.`,
          );
        }
        case 'not-found': {
          return appSelectionError(
            APP_SELECTION_ERROR_CODES.APP_NOT_FOUND,
            `No accessible App matches '${app}'. Use hadron_list_apps to see what's available.`,
          );
        }
      }
    },
  );

  // ── hadron_create_parent_node ───────────────────────────────────────────────────

  server.tool(
    'hadron_create_parent_node',
    'Create a parent (section/category) node in the memory graph. Lightweight container for organizing nodes. The URN MUST be fully qualified (org::memory::loc).',
    {
      urn: z.string().describe('Fully-qualified node URN for the new section, e.g. "acme.com::mmdata::services" or "acme.com::mmdata::services:db-helpers"'),
      name: z.string().optional().describe('Display name (defaults to the last loc atom)'),
      description: z.string().optional().describe('What this section contains'),
      tags: tagsInputSchema.optional(),
    },
    async ({ urn: rawUrn, name: rawName, description, tags }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const { memoryUrn, loc } = splitNodeUrn(rawUrn);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      const memoryId = memory.id;
      // Default name to the last loc atom (e.g. `services:db-helpers` → `db-helpers`).
      const name = rawName ?? loc.split(':').pop()!;
      const content = description ?? `Section: ${name}`;

      try {
        validateLoc(loc);
      } catch (e) {
        return textResult((e as Error).message);
      }

      if (!(await canWriteToMemory(db, auth, memoryId))) {
        return textResult('Write access denied for this memory.');
      }

      const upsertArgs = {
        where: { loc_memoryId: { loc, memoryId } },
        create: {
          id: generateId(),
          memoryId,
          loc,
          name,
          nodeType: 'info',
          description: description ?? null,
          content,
          tags: tags ?? [],
          createdBy: auth.clientId ?? null,
        },
        update: {
          name,
          nodeType: 'info',
          description: description ?? null,
          content,
          tags: tags ?? [],
        },
      };
      // #664 (Model A — see nodeSubtreeLock.ts): a section node is a hierarchy
      // parent, so creating it under a concurrently-deleted grandparent is
      // exactly the orphan race. Serialize against an ancestor-delete by holding
      // advisory locks on the ancestor path across the upsert, matching the
      // hadron_create_node / createNode paths. Root-level locs skip the tx.
      if (ancestorLocs(loc).length === 0) {
        await db.node.upsert(upsertArgs);
      } else {
        await db.$transaction(async (tx) => {
          await lockAncestorsForCreate(tx, memoryId, loc);
          await tx.node.upsert(upsertArgs);
        });
      }

      const urn = await nodeUrn(loc, memoryId);
      return textResult(`Node saved: ${urn}`);
    },
  );

  // ── hadron_find_nodes ─────────────────────────────────────────────────────────

  server.tool(
    'hadron_find_nodes',
    'Relevance-ranked full-text search across nodes. Keyword mode (default) runs Postgres full-text search: terms are STEMMED (so "running" matches "run"), results are RANKED by field-weighted relevance (name/alias > loc/tags > description/abstract > body/data), and BODY + abstract ARE indexed. Boolean operators are supported — `(banana OR apple) AND shake`, quoted phrases, and `-term` / `NOT term` — operator words are UPPERCASE-ONLY (lowercase and/or/not are plain terms, so natural phrases search literally), and malformed boolean syntax degrades to a literal phrase search instead of erroring. A plain multi-word query ANDs its terms; if that matches nothing, the search auto-relaxes to OR (any term) and flags [degraded:and_relaxed_to_or] — so a single off-corpus word doesn\'t dead-end the query. Pass `query: "*"` (or `""`) to list every node (survey mode) — useful as a first pass before adding to a memory. mode:vector / mode:hybrid run semantic search over the memory\'s vector index; mode:regex matches a POSIX regular expression against node text. To browse the tree structure, use `hadron_list_nodes` instead. Scope with `parentRel` (a subtree), `memoryUrn` (one memory), or `memoryUrns` (a set); pass `allMemories: true` to search EVERY memory you can read — the stemmed, ranked org-wide "does anyone know about X?" probe (this is the right tool for cross-memory concept/content questions; hadron_search matches literal substrings only). Each scored hit shows its score as a percentage of the top hit; when many hits sit in a narrow band the result carries a [weak_results] note, meaning the ranking found nothing clearly relevant — treat that as "the answer is probably not here" rather than reading the whole list. Use `minScore` to drop weak hits and `limit` to widen the default 10-hit page. Soft-deleted nodes are excluded.',
    {
      query: z.string().describe('For mode:keyword (default) / mode:hybrid — a full-text query: stemmed terms ranked by relevance, with boolean operators `(a OR b) AND c`, quoted phrases, and `-term` / `NOT`. For mode:vector / mode:hybrid — also embedded and matched semantically against the memory\'s vector index. For mode:regex — a POSIX regular expression. Use "*" or "" to list all nodes (survey mode; rejected for mode:vector / mode:hybrid).'),
      mode: z.enum(['keyword', 'vector', 'hybrid', 'regex']).optional().describe('keyword (default): full-text search — stemmed, relevance-ranked, boolean operators, body + abstract indexed. vector: semantic search over the memory\'s vector index (requires vectorIndexEnabled). hybrid: keyword + vector fused by reciprocal-rank fusion (RRF, k=60). regex: POSIX regular-expression match over node text. On a non-indexed memory, mode:hybrid degrades to keyword-only and emits a [degraded:no_vector_index] note. Spec 033 + cor:api:090.'),
      parentRel: z.string().optional().describe('Scope search to this subtree'),
      memoryUrn: z.string().optional().describe('Scope search to a single memory (fully-qualified URN). Omit to search all memories you can read — see allMemories.'),
      memoryUrns: z.array(z.string()).min(1).optional().describe('Scope search to this SET of memories (each a fully-qualified memory URN, org::memory) — a targeted multi-memory search. Must be non-empty (for "everything", use allMemories). Mutually exclusive with memoryUrn and allMemories.'),
      allMemories: z.boolean().optional().describe('Search across ALL memories you can read — the org-wide "does anyone know about X?" probe (stemmed + relevance-ranked in keyword mode). The explicit, self-documenting form of omitting a memory scope. Mutually exclusive with memoryUrn / memoryUrns.'),
      isRunnable: z.boolean().optional().describe('Filter by runnable status (applies in every mode). true = only task nodes (Node.isRunnable=true) — the canonical "tasks I can run" predicate hadron_run_task gates on. false = only nodes explicitly marked non-runnable (most nodes leave it NULL, so false does NOT include them). Omit to ignore runnable status. Spec cor:api:060.'),
      objectType: z.string().optional().describe('#725 — collection facet: only nodes whose objectType equals this (the domain-object discriminator, e.g. "competitor" / "insight"). Orthogonal to nodeType. Composes with query/mode + where.'),
      brief: z.boolean().optional().describe('Return index info only: name, description, edges'),
      limit: z.number().optional().describe('Max results (default 10 for a query; 50 for survey mode "*"/""). Raise it if the top hits do not cover what you need.'),
      minScore: z.number().optional().describe('Absolute relevance floor: drop hits scoring below this. Scores are NOT comparable across modes — keyword ranks run roughly 0..a-few, vector cosine similarity is 0..1, hybrid is a small RRF fraction — so read the (score …) values in a first unfiltered call, then set a floor for the mode in use. Prefer this (or a narrower query) over reading a long tail of weak hits. Returns fewer hits, never weaker ones; does not apply to survey mode.'),
      expand: z.number().int().min(0).max(3).optional().describe('Append undirected graph neighbors (all edge types) within depth N AFTER the ranked hits, unscored. Default 0 (no expansion). Max 3. Useful for context-stuffing — the ranked nodes plus their immediate graph context in one tool call. Spec 033 FR-020.'),
      granularity: z.enum(['node', 'chunk']).optional().describe('node (default): one entry per matching node, ranked by best-chunk similarity for content-chunk indexes. chunk: return matching passages (span text + character offsets + chunk index + parent node URN), useful for RAG context-stuffing. **chunk requires mode:vector** — hybrid + chunk is out of v1 (the design call for how RRF fuses with passage-level results was deferred). Spec 033 US2 FR-022.'),
      where: z.record(z.string(), z.unknown()).optional().describe('Structured predicate over a node\'s `properties`/`data` JSONB (#719) — filters, then the chosen mode ranks the survivors (composes with keyword/vector/hybrid/regex and survey/browse). A node is EITHER a branch (exactly one of `and`/`or`/`not`) OR a leaf: a `path` (array of JSON keys, e.g. ["sourceKind"]) plus exactly ONE operator — eq | ne | in | lt | lte | gt | gte | between | exists | contains. `field`: "properties" (default) | "data". `as`: "text" (default) | "number" | "datetime" | "boolean" — number/datetime route through DB guards so unparseable values drop the row (never an error); `contains` is jsonb @> containment. Bounded: depth ≤ 4, ≤ 32 leaves, path ≤ 8. Example: {"and":[{"path":["sourceKind"],"eq":"substack"},{"path":["extractedAt"],"as":"datetime","gte":"2026-07-04T00:00:00Z"}]}'),
    },
    async ({ query, mode, parentRel, memoryUrn, memoryUrns, allMemories, isRunnable, objectType, brief, limit, minScore, expand, granularity, where }) => {
      try {
        validateParentRel(parentRel);
      } catch (e) {
        if (e instanceof InvalidParentRelError) return textResult(e.message);
        throw e;
      }

      // PR2 (#403): delegate retrieval to resolvers.Query.findNodes (the unified
      // cor:api:090 engine) instead of re-implementing keyword/vector/hybrid
      // inline. This is what adopts the Postgres FTS keyword semantics (stemmed,
      // relevance-ranked, boolean operators, body + abstract indexed) on the MCP
      // surface. Scope resolution + the BOLA gates below stay HERE (the MCP
      // surface's memoryUrn / parentRel resolution, canReadMemory checks, and the
      // exact "not found" strings are its contract); the resolved scope is handed
      // to findNodes as filter.memoryIds / filter.locPrefix, and the envelope is
      // re-rendered into the tool's text output.
      const effectiveMode = mode ?? 'keyword';

      // Spec 033 US2 — chunk granularity requires explicit mode:vector. MCP's
      // default mode is keyword (no chunks); hybrid's RRF is node-level.
      if (granularity === 'chunk' && effectiveMode !== 'vector') {
        return textResult(
          `granularity:chunk requires mode:vector (got mode:${effectiveMode}). Hybrid + chunk passages is out of v1.`,
        );
      }

      // Survey mode: "*" / "" lists every node in the lexical modes, but is
      // meaningless to a vector embedder — reject it up front for vector/hybrid
      // (preserves the pre-delegation [empty_vector_query] contract). For the
      // lexical modes it maps to a query-omitted findNodes call (filtered list).
      // createTestableMcpServer bypasses zod validation (the test-parity gap),
      // so coerce a non-string query before .trim() rather than crash.
      const safeQuery = typeof query === 'string' ? query : '';
      const trimmedQuery = safeQuery.trim();
      const isSurvey = trimmedQuery === '' || trimmedQuery === '*';
      if (isSurvey && (effectiveMode === 'vector' || effectiveMode === 'hybrid')) {
        return textResult(
          `Note: empty or "*" queries are keyword-only (survey mode); supply a natural-language query for mode:${effectiveMode}. [empty_vector_query]\n\nFound 0 node(s).`,
        );
      }

      const trimmedParentRel = parentRel?.trim();
      const accessibleMemoryIds = await getAccessibleMemoryIds(db, auth);

      // App Key + active session hard-isolates reads to the session's memory
      // (+ the agent's system memory) — findNodes enforces this downstream
      // (getAccessibleMemoryIds, checked first, ahead of any role). The
      // pre-scope memoryUrn / parentRel gates must enforce the SAME boundary,
      // or an out-of-session ref would pass canReadMemory here and then
      // silently yield "No nodes found" instead of the contract "not found"
      // (a session-boundary access oracle). Mirrors the resolver's
      // getAccessibleMemoryIds app+session branch.
      let sessionMemoryIds: Set<string> | null = null;
      if (auth.appId && auth.sessionId) {
        const session = await db.session.findUnique({
          where: { id: auth.sessionId },
          select: { memoryId: true, agent: { select: { systemMemoryId: true } } },
        });
        sessionMemoryIds = new Set<string>();
        if (session?.memoryId) sessionMemoryIds.add(session.memoryId);
        if (session?.agent?.systemMemoryId) sessionMemoryIds.add(session.agent.systemMemoryId);
      }

      // Resolved scope handed to findNodes. When neither memoryUrn nor a
      // memory-resolvable parentRel is supplied, both stay undefined and
      // findNodes falls back to its own accessible-set scoping.
      let filterMemoryIds: string[] | undefined;
      let filterLocPrefix: string | undefined;

      // #498 — at most one memory selector. memoryUrn (single), memoryUrns (a
      // set), and allMemories (everything accessible) are three ways to say
      // "where"; combining them is ambiguous. allMemories needs no scope work —
      // leaving filterMemoryIds undefined makes findNodes use the accessible set
      // (session-scoped downstream); it exists as the explicit, discoverable
      // form of "omit the scope" so agents reach for the org-wide probe.
      const memSelectors = [
        memoryUrn ? 'memoryUrn' : null,
        memoryUrns && memoryUrns.length > 0 ? 'memoryUrns' : null,
        allMemories ? 'allMemories' : null,
      ].filter(Boolean);
      if (memSelectors.length > 1) {
        return textResult(
          `Pass only one memory scope — got ${memSelectors.join(' + ')}. Use memoryUrn (one), memoryUrns (a set), or allMemories (everything you can read).`,
        );
      }

      // Scope to memory URN if provided. Spec 022 (FR-003): no fallback to the
      // active memory — the caller supplies a fully-qualified URN. #188: route
      // through canReadMemory so personal/private memories (FR-016 strict
      // ownership; ADMIN/OWNER do NOT bypass) and non-admin scope gating both
      // apply. Match hadron_get_node's "not found" phrasing so absence and
      // denial are indistinguishable.
      if (memoryUrn) {
        try {
          assertFullyQualifiedUrn(memoryUrn, 'memory');
        } catch (e) {
          if (e instanceof UrnNotQualifiedError) return textResult(e.message);
          throw e;
        }
        const mem = await resolveMemoryByUrn(memoryUrn);
        if (
          !mem ||
          !(await canReadMemory(db, auth, mem.id)) ||
          (sessionMemoryIds && !sessionMemoryIds.has(mem.id))
        ) {
          return textResult(
            `Memory not found or invalid: '${memoryUrn}'. Use hadron_list_memories to see what is available.`,
          );
        }
        filterMemoryIds = [mem.id];
      }

      // Scope to a SET of memories (#498). Each URN gets the SAME gates as the
      // single-memory path (qualification + canReadMemory + session boundary),
      // so absence and denial stay indistinguishable per the memoryUrn contract.
      // Dedup + resolve in parallel (#567 review, Gemini); surface the first
      // failure in input order.
      if (memoryUrns && memoryUrns.length > 0) {
        const resolved = await Promise.all(
          [...new Set(memoryUrns)].map(async (urn): Promise<{ id: string } | { error: string }> => {
            try {
              assertFullyQualifiedUrn(urn, 'memory');
            } catch (e) {
              if (e instanceof UrnNotQualifiedError) return { error: e.message };
              throw e;
            }
            const mem = await resolveMemoryByUrn(urn);
            if (
              !mem ||
              !(await canReadMemory(db, auth, mem.id)) ||
              (sessionMemoryIds && !sessionMemoryIds.has(mem.id))
            ) {
              return {
                error: `Memory not found or invalid: '${urn}'. Use hadron_list_memories to see what is available.`,
              };
            }
            return { id: mem.id };
          }),
        );
        const bad = resolved.find((r): r is { error: string } => 'error' in r);
        if (bad) return textResult(bad.error);
        filterMemoryIds = resolved.map((r) => (r as { id: string }).id);
      }

      // Explicit org-wide scope (#498). Materialize the readable set so
      // SYSTEM-class memories are included: findNodes hides class='system' on a
      // scope-less broad search, but explicit ids bypass that (#567 review,
      // Codex), so a bare undefined here would silently drop the agent's own
      // system memory despite "every memory you can read". accessibleMemoryIds
      // is null for see-all admins → materialize every live memory so "all"
      // really means all. The resolver re-gates whatever ids we pass, so this
      // cannot broaden beyond the caller's actual reach.
      if (allMemories) {
        filterMemoryIds =
          accessibleMemoryIds ??
          (
            await db.memory.findMany({ where: { deletedAt: null }, select: { id: true } })
          ).map((m) => m.id);
      }

      // Scope to subtree if parentRel provided. #188: same BOLA shape as the
      // memoryUrn branch — resolveLocFromUrn already gates the URN-typed path on
      // the accessible set, but ADMIN/OWNER pass null there, so canReadMemory
      // enforces the personal/private gate uniformly.
      if (trimmedParentRel) {
        const resolvedParent = await resolveLocFromUrn(trimmedParentRel, accessibleMemoryIds);
        filterLocPrefix = resolvedParent.loc;
        if (resolvedParent.memoryId) {
          if (
            !(await canReadMemory(db, auth, resolvedParent.memoryId)) ||
            (sessionMemoryIds && !sessionMemoryIds.has(resolvedParent.memoryId))
          ) {
            return textResult(`Node "${trimmedParentRel}" not found.`);
          }
          filterMemoryIds = [resolvedParent.memoryId];
        }
      }

      // Build a GraphQL Context from the MCP auth, including appId + sessionId so
      // access scoping resolves the same way it does for the other delegating
      // tools (the gqlCtx helper omits those — #206 finding).
      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };

      let result: Awaited<ReturnType<typeof resolvers.Query.findNodes>>;
      try {
        result = await resolvers.Query.findNodes(
          {},
          {
            // Survey mode → omit query so findNodes returns the filtered list
            // (subsumes the old matchesQuery "*" / "" path).
            query: isSurvey ? undefined : safeQuery,
            mode: effectiveMode,
            filter: {
              memoryIds: filterMemoryIds,
              isRunnable: isRunnable ?? undefined,
              objectType: objectType ?? undefined,
              locPrefix: filterLocPrefix,
              // #719 — structured JSONB predicate; findNodes validates it and
              // throws BAD_USER_INPUT on a malformed/oversized tree (surfaced as
              // tool-error text by the catch below).
              where: (where ?? undefined) as NodeWhere | undefined,
            },
            expand: expand ?? undefined,
            granularity: granularity ?? undefined,
            // #497 — a query defaults to a tight page (10); an agent iterating
            // search shouldn't pay 50 full abstracts of context per call. Survey
            // mode ("*"/"") is a deliberate full listing, so it keeps 50. The
            // minScore floor never applies to survey (those hits are unscored).
            limit: limit ?? (isSurvey ? 50 : 10),
            minScore: isSurvey ? undefined : minScore,
          },
          ctx,
        );
      } catch (e) {
        // findNodes throws BAD_USER_INPUT for a malformed boolean query, an
        // invalid regex, etc. The MCP contract surfaces tool errors as text.
        return textResult(e instanceof Error ? e.message : 'Search failed.');
      }

      // ── Chunk (passage) rendering ──────────────────────────────────────────
      // findNodes passages carry parentNodeId + parentNodeUrn; re-fetch the
      // parent so the URN is emitted in canonical form (nodeUrn) and the node
      // name is shown, matching the pre-delegation output.
      if (granularity === 'chunk') {
        const passages = result.passages ?? [];
        if (passages.length === 0) return textResult('Found 0 passage(s).');
        const parentIds = [...new Set(passages.map((p) => p.parentNodeId))];
        const parentNodes = await db.node.findMany({
          where: { id: { in: parentIds } },
          select: { id: true, name: true, loc: true, memoryId: true },
        });
        const parentById = new Map(parentNodes.map((n) => [n.id, n]));
        const lines: string[] = [];
        for (const p of passages) {
          const parent = parentById.get(p.parentNodeId);
          const urn = parent ? await nodeUrn(parent.loc, parent.memoryId) : p.parentNodeUrn;
          const name = parent?.name ?? '';
          // Guard the score like renderHit does — a passage without a numeric
          // score renders without the trailing marker rather than crashing.
          const scoreStr = p.score != null ? `  (score ${p.score.toFixed(3)})` : '';
          const header = `- **${urn}** [chunk ${p.chunkIndex} @ chars ${p.charStart}-${p.charEnd}] — ${name}${scoreStr}`;
          const bodyLines = p.text.split(/\r?\n/).map((l) => `  ${l}`);
          lines.push([header, ...bodyLines].join('\n'));
        }
        return textResult(`Found ${lines.length} passage(s):\n\n${lines.join('\n')}`);
      }

      // ── Diagnostic states → text notes (FR-021) ────────────────────────────
      // Map findNodes's reason/degraded codes back to the tool's note lines.
      // A vector-mode `reason` is terminal (empty envelope); a hybrid `degraded`
      // note is prepended to the keyword-only results.
      if (result.reason === 'no_vector_index') {
        return textResult(
          'Note: this memory has no vector index — enable it on the memory to use mode:vector. [no_vector_index]\n\nFound 0 node(s).',
        );
      }
      if (result.reason === 'embedding_unavailable') {
        // findNodes collapses "no endpoint configured" and "embed() failed" into
        // one code, so the note names both causes (the pre-delegation surface
        // had separate messages).
        return textResult(
          'Note: vector search is unavailable — no embedding endpoint is configured or embed() failed. [embedding_unavailable]\n\nFound 0 node(s).',
        );
      }
      // `degraded` may carry MULTIPLE comma-separated flags (PR-482 — e.g.
      // 'no_vector_index,literal_fallback'), so parse the set instead of
      // comparing the whole string.
      const degradedFlags = new Set((result.degraded ?? '').split(',').filter(Boolean));
      const noteLines: string[] = [];
      if (degradedFlags.has('no_vector_index')) {
        noteLines.push(
          'Note: vector half unavailable (no vector index); showing keyword results only. [degraded:no_vector_index]',
        );
      }
      if (degradedFlags.has('embedding_unavailable')) {
        // findNodes sets this code both when no endpoint is configured AND when
        // embed() throws — name both causes rather than assert one.
        noteLines.push(
          'Note: vector half unavailable — no embedding endpoint is configured or embed() failed; showing keyword results only. [degraded:embedding_unavailable]',
        );
      }
      if (degradedFlags.has('literal_fallback')) {
        noteLines.push(
          'Note: the query was not valid boolean syntax, so it ran as a literal phrase search. Operators are UPPERCASE-only (AND/OR/NOT). [degraded:literal_fallback]',
        );
      }
      if (degradedFlags.has('and_relaxed_to_or')) {
        noteLines.push(
          'Note: no node matched ALL of your terms (keyword search ANDs them), so the search was relaxed to ANY term (OR). These hits each match at least one term — a single missing word likely zeroed the strict search; drop or change it to narrow back down. [degraded:and_relaxed_to_or]',
        );
      }
      const note: string | null = noteLines.length ? noteLines.join('\n') : null;

      // ── Node rendering ─────────────────────────────────────────────────────
      // #497 — the top score of the result set, used to show each hit's score as
      // a fraction of the best hit. Relative score is mode-independent (it
      // normalizes within one result set), so an agent can judge "is anything
      // here actually strong?" without knowing each mode's absolute score scale.
      // Unscored expand-neighbours carry score null and are excluded.
      const scores = (result.hits ?? [])
        .map((h) => h.score)
        .filter((s): s is number => typeof s === 'number');
      // Reduce, not Math.max(...scores): `limit` is caller-controlled, so a huge
      // page would spread too many args into Math.max and throw RangeError.
      const topScore = scores.length ? scores.reduce((m, s) => (s > m ? s : m), -Infinity) : null;

      const renderHit = async (hit: {
        node: {
          id: string;
          loc: string;
          memoryId: string;
          name: string;
          description: string | null;
          abstract: string | null;
          abstractOriginHash: string | null;
          content: string | null;
          tags: string[] | null;
          outgoingEdges?: Array<{
            target: { loc: string; memoryId: string; deletedAt: Date | null } | null;
            name: string | null;
            loc: string;
          }>;
        };
        score: number | null;
      }): Promise<string> => {
        const n = hit.node;
        const urn = await nodeUrn(n.loc, n.memoryId);
        const score = hit.score;
        // #497: show the score relative to the top hit (mode-independent signal).
        const relStr =
          score != null && topScore != null && topScore > 0
            ? `, ${Math.round((score / topScore) * 100)}% of top`
            : '';
        // #322: surface the stable PK so callers can reference this node by id.
        const parts = [
          score != null
            ? `- **${urn}** (id: ${n.id}) — ${n.name}  (score ${score.toFixed(3)}${relStr})`
            : `- **${urn}** (id: ${n.id}) — ${n.name}`,
        ];
        // Spec 033 FR-023 — `Source: abstract-stale` on a ranked hit whose stored
        // abstract no longer matches the current (plaintext) content. Unscored
        // expand-neighbours are skipped (they weren't matched via an abstract).
        const isStale =
          score != null &&
          n.abstract != null && n.abstract.length > 0 &&
          n.content != null && n.content.length > 0 &&
          !isCiphertext(n.content) &&
          n.abstractOriginHash != null &&
          n.abstractOriginHash !== computeContentHash(n.content);
        if (isStale) parts.push('  Source: abstract-stale');
        if (n.description) parts.push(`  ${n.description}`);
        // Spec 031 US2 — surface the abstract as a two-space-indented block
        // beneath the description (excluded from brief mode). `/\r?\n/` so
        // CRLF-terminated lines don't leave a trailing `\r` mid-output.
        if (!brief && n.abstract) {
          for (const absLine of n.abstract.split(/\r?\n/)) parts.push(`  ${absLine}`);
        }
        if (n.tags?.length) parts.push(`  Tags: ${n.tags.join(', ')}`);
        // Brief edge rendering — hide edges whose target is soft-deleted
        // (#180 Bug 2); findNodes includes them, so filter here.
        if (brief) {
          const edges = (n.outgoingEdges ?? []).filter(
            (e) => e.target && e.target.deletedAt == null,
          );
          if (edges.length) {
            const edgeStrs = await Promise.all(
              edges.map(async (e) => {
                const targetUrn = await nodeUrn(e.target!.loc, e.target!.memoryId);
                return `→ ${targetUrn} (${e.name ?? e.loc})`;
              }),
            );
            parts.push(`  Edges: ${edgeStrs.join(', ')}`);
          }
        }
        return parts.join('\n');
      };

      const lines = await Promise.all((result.hits ?? []).map(renderHit));
      if (lines.length === 0) {
        // Preserve the byte-identical "no match" output for the lexical path —
        // when hybrid degraded to keyword AND found nothing, prepend the note.
        const baseMsg = `No nodes found matching "${safeQuery}".`;
        return textResult(note ? `${note}\n\n${baseMsg}` : baseMsg);
      }

      // #497 — "weak results" heuristic. When several scored hits all sit in a
      // narrow band just below the top (the weakest is still a large fraction of
      // the best), the ranking failed to single out a clear match — the classic
      // "the answer isn't here, but the search dumped 50 plausible-looking rows
      // anyway" failure. Flag it so an agent can rule the query out without
      // reading the whole tail. Advisory only: it annotates, never drops (that's
      // what minScore is for). The band is measured over the shown scored hits,
      // and relative (fraction of top), so it's sound across every mode.
      let weakNote: string | null = null;
      if (scores.length >= 5 && topScore != null && topScore > 0) {
        const lo = scores.reduce((m, s) => (s < m ? s : m), Infinity); // reduce, not spread (see topScore)
        const relLo = lo / topScore;
        if (relLo >= 0.6) {
          weakNote =
            `Note: these ${scores.length} hits sit in a narrow score band ` +
            `(${lo.toFixed(3)}–${topScore.toFixed(3)}; the weakest is ${Math.round(relLo * 100)}% of the top), ` +
            `so the ranking did not single out a clear best match — what you're looking for may not be present. ` +
            `Verify the top hits directly, or try a narrower query / different mode before trusting the full list. [weak_results]`;
        }
      }

      const body = `Found ${lines.length} node(s):\n\n${lines.join('\n')}`;
      const notes = [note, weakNote].filter(Boolean).join('\n\n');
      return textResult(notes ? `${notes}\n\n${body}` : body);
    },
  );

  // ── hadron_get_node ──────────────────────────────────────────────────────────

  server.tool(
    'hadron_get_node',
    "Read a node by its fully-qualified URN. The URN MUST be fully qualified (org::memory::loc). Optional `contentScope` selects what the response includes: 'content' (default) — meta block + body, with the abstract substituted into the body slot when content is null/empty (a `Source: abstract-fallback` line then appears in the meta block); 'abstract' — meta block + abstract, no body; 'all' — meta block + abstract + body. When the abstract is in the response and its origin hash disagrees with the current content's hash, the meta block also carries a `Source: abstract-stale` line — treat the abstract as a possibly-outdated preview (spec 032 FR-010; on encrypted memories only while unlocked — spec 041). Spec 031 + 032.",
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com::mmdata::architecture" or "hrn:node:acme.com::mmdata::architecture"'),
      contentScope: z
        .enum(['content', 'abstract', 'all'])
        .optional()
        .describe("Selects what the response includes. 'content' (default): meta block + body, with abstract substituted into the body slot when content is null/empty (Source: abstract-fallback line appears). 'abstract': meta block + abstract, no body. 'all': meta block + abstract + body."),
    },
    async ({ urn: rawUrn, contentScope }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const { memoryUrn, loc } = splitNodeUrn(rawUrn);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      if (!(await canReadMemory(db, auth, memory.id))) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }

      // #180 Bug 2: soft-deleted nodes are not addressable via read.
      // findFirst with explicit deletedAt: null instead of findUnique so
      // tombstoned rows return "not found" rather than leaking their last
      // content.
      const node = await db.node.findFirst({
        where: { loc, memoryId: memory.id, deletedAt: null },
        include: {
          // Filter edges whose other-end node is soft-deleted; dangling
          // tombstones in the Related / Referenced-by section are no
          // more useful than the deleted node itself.
          outgoingEdges: {
            include: { target: true },
            where: { target: { deletedAt: null } },
          },
          incomingEdges: {
            include: { source: true },
            where: { source: { deletedAt: null } },
          },
          // Spec 032 — encryption gate for the abstract-stale predicate
          // (FR-010). Riding the node fetch avoids a second round-trip
          // (PR-210 review). resolveMemoryByUrn above doesn't carry
          // `isEncrypted` and changing it has a wider blast radius.
          memory: { select: { isEncrypted: true } },
        },
      });
      if (!node) {
        return textResult(`Node "${rawUrn}" not found.`);
      }

      // Record usage event (fire-and-forget)
      db.usageEvent.create({
        data: {
          id: generateId(),
          type: 'read',
          nodeLoc: loc,
          nodeId: node.id,
          // #796: attributed directly so the event stays counted for this
          // memory after the node is deleted (nodeId is SetNull).
          memoryId: node.memoryId,
          appId: auth.appId ?? null,
          // 046-usage-metering FR-001: user attribution when the
          // authenticated principal is a user (createdBy unchanged).
          userId: auth.userId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      // Spec 031 — contentScope-driven response shape. Default 'content'
      // preserves pre-spec output byte-for-byte. Defensive enum check: zod
      // validates the same set at the MCP transport boundary, but direct-
      // handler callers (createTestableMcpServer's _registeredTools shortcut)
      // bypass that parsing, so re-validate here. InvalidContentScopeError is
      // the single source of truth for the message (and any future GraphQL
      // `extensions.code` mapping). MCP convention: return error text, not throw.
      if (
        contentScope !== undefined &&
        contentScope !== 'content' &&
        contentScope !== 'abstract' &&
        contentScope !== 'all'
      ) {
        const err = new InvalidContentScopeError(String(contentScope));
        return textResult(err.message);
      }
      const scope = contentScope ?? 'content';
      // Spec 041: decrypt when this session holds the key; mark locked
      // otherwise (blanked fields + Locked meta line, never raw ciphertext).
      const lockState = mcpDecryptOrMark(node);
      // Shared with hadron_get_nodes (batch) so the per-node projection can never
      // drift between the single-read and batch-read surfaces (cor:api:040:01).
      return textResult(
        await renderNodeReadProjection(node, scope, { locked: lockState === 'locked' }),
      );
    },
  );

  // ── hadron_get_nodes (batch multi-node read) ──────────────────────────────────

  server.tool(
    'hadron_get_nodes',
    "Batch read — return the full per-node projection (meta + edges + contentScope body, identical to hadron_get_node) for MANY nodes in one call. Two mutually-exclusive forms: (1) `refs` — an explicit list of node references, returned in input order; (2) `memoryUrn` + `locPrefix` — every readable node whose loc starts with the prefix in one memory, returned in loc order. Each `refs` entry is a node's primary key OR its fully-qualified URN, so a caller holding either form reads in ONE call. Optional `contentScope` ('content' default | 'abstract' | 'all') applies to every node, so abstract-only triage is cheap. Per-node authorization: unreadable or non-existent refs are reported in a separate Unavailable list (denied and not-found are indistinguishable) and never fail the batch. A ref whose SHAPE is wrong (relative/unqualified, or a URN of another entity kind) is a loud error instead — a caller mistake never hides among denials. Bounded by hard caps — exceeding the node-count cap is a loud error; exceeding the response-size cap returns a partial result flagged `truncated` (never a silent short read). Spec cor:api:040.",
    {
      refs: z
        .array(z.string())
        .optional()
        .describe('Explicit-set form: node references, each a primary key OR a fully-qualified node URN (org::memory::loc). Returned in input order. Mutually exclusive with memoryUrn/locPrefix.'),
      memoryUrn: z
        .string()
        .optional()
        .describe('Prefix form: fully-qualified memory URN to read from. Use together with locPrefix.'),
      locPrefix: z
        .string()
        .optional()
        .describe('Prefix form: return every readable node whose loc starts with this prefix (loc order). Use together with memoryUrn.'),
      contentScope: z
        .enum(['content', 'abstract', 'all'])
        .optional()
        .describe("Per-node projection scope, as on hadron_get_node. Default 'content'."),
    },
    async ({ refs, memoryUrn, locPrefix, contentScope }) => {
      // Defensive contentScope validation — parity with hadron_get_node (covers
      // direct-handler callers that bypass the transport's zod parsing).
      if (
        contentScope !== undefined &&
        contentScope !== 'content' &&
        contentScope !== 'abstract' &&
        contentScope !== 'all'
      ) {
        return textResult(new InvalidContentScopeError(String(contentScope)).message);
      }
      const scope = contentScope ?? 'content';

      const hasSet = Array.isArray(refs) && refs.length > 0;
      // locPrefix '' is a valid "whole memory" prefix — test for presence, not
      // truthiness, so an empty prefix isn't mistaken for the absent form.
      const hasPrefix = memoryUrn !== undefined && locPrefix !== undefined;
      // Exactly one form (FR-002: both capabilities exist; one tool, two modes).
      if (hasSet === hasPrefix) {
        return textResult(
          'hadron_get_nodes: provide EITHER `refs` (an explicit set) OR `memoryUrn` + `locPrefix` (a subtree) — not both, not neither.',
        );
      }

      // Authorized, existing nodes in caller-meaningful order, plus the refs we
      // couldn't return — denied OR not-found, reported indistinguishably so the
      // result never discloses whether an unreadable node exists (cor:api:040:03).
      const ordered: Array<ReadProjectionNode & { id: string }> = [];
      const unavailable: string[] = [];

      if (hasPrefix) {
        // ── Prefix subtree (one memory, gated once) ──────────────────────────
        const mem = await resolveMemoryByUrn(memoryUrn!);
        if (!mem || !(await canReadMemory(db, auth, mem.id))) {
          // Don't leak existence — mirror the single read's phrasing.
          return textResult(`Memory not found: "${memoryUrn}".`);
        }
        // Count cap (cor:api:040:02): take MAX+1 to detect overflow, then fail
        // loud rather than silently returning a truncated subtree.
        const rows = await db.node.findMany({
          where: { memoryId: mem.id, loc: { startsWith: locPrefix! }, deletedAt: null },
          orderBy: { loc: 'asc' },
          take: BATCH_READ_MAX_NODES + 1,
          include: {
            outgoingEdges: { include: { target: true }, where: { target: { deletedAt: null } } },
            incomingEdges: { include: { source: true }, where: { source: { deletedAt: null } } },
            memory: { select: { isEncrypted: true } },
          },
        });
        if (rows.length > BATCH_READ_MAX_NODES) {
          return textResult(
            `hadron_get_nodes: prefix "${locPrefix}" matches more than the ${BATCH_READ_MAX_NODES}-node cap. Narrow the prefix (or page by sub-prefix); the batch read does not silently truncate.`,
          );
        }
        ordered.push(...(rows as unknown as Array<ReadProjectionNode & { id: string }>));
      } else {
        // ── Explicit set (mixed-memory; per-node gate) ───────────────────────
        // Count cap up front — the caller knows the count, so fail loud before
        // any work (cor:api:040:02).
        if (refs!.length > BATCH_READ_MAX_NODES) {
          return textResult(
            `hadron_get_nodes: ${refs!.length} refs exceeds the ${BATCH_READ_MAX_NODES}-node cap. Split into smaller batches; the batch read does not silently truncate.`,
          );
        }
        // Dedup the input strings up front so a repeated ref isn't rendered (and
        // billed via a UsageEvent) twice. This only collapses byte-identical
        // repeats; the load-bearing dedup is on the RESOLVED node below, since a
        // PK and that node's URN are different strings naming one node.
        // First-occurrence order is preserved.
        const uniqueRefs = [...new Set(refs!)];

        // A ref is a PK or a fully-qualified node URN (cor:api:140). Splitting by
        // shape keeps the URN path's group-by-memory fetch — one gate + one query
        // per distinct memory, not N lookups — while a PK needs no resolution at
        // all: it IS the node id, and the gate below still decides readability.
        //
        // A ref whose SHAPE is wrong fails the whole call. Filing it under
        // `unavailable` next to genuinely-denied nodes is what let this tool's
        // missing PK capability sit unnoticed: the symptom was indistinguishable
        // from a legitimate access outcome (#822, mirroring #813 on GraphQL).
        type UrnRef = { raw: string; memoryUrn: string; loc: string };
        const urnRefs: UrnRef[] = [];
        const pkRefs: string[] = [];
        for (const raw of uniqueRefs) {
          if (isId(raw)) {
            pkRefs.push(raw);
            continue;
          }
          // A wrong-type URN (`hrn:mem:…`, `hrn:app:…`) is a coercion bug, not a
          // miss — the same screen hadron_get_node and nodeBatch(refs:) apply.
          const typeErr = validateUrnType(parseUrnInput(raw), 'node');
          if (typeErr) {
            return textResult(`hadron_get_nodes: ${typeErr} (ref "${raw}")`);
          }
          try {
            assertFullyQualifiedUrn(raw, 'node');
            const { memoryUrn: mu, loc } = splitNodeUrn(raw);
            urnRefs.push({ raw, memoryUrn: mu, loc });
          } catch {
            return textResult(
              `hadron_get_nodes: "${raw}" is neither a node id nor a fully-qualified node URN (org::memory::loc). A relative or malformed ref is a caller error, not an access outcome, so it is reported here rather than in the Unavailable list.`,
            );
          }
        }

        // The per-node projection every fetch below must produce, identical to
        // hadron_get_node's (cor:api:040:01) — kept in one place so the PK and
        // URN paths cannot drift apart.
        const projectionInclude = {
          outgoingEdges: { include: { target: true }, where: { target: { deletedAt: null } } },
          incomingEdges: { include: { source: true }, where: { source: { deletedAt: null } } },
          memory: { select: { isEncrypted: true } },
        } as const;

        const nodeByRef = new Map<string, ReadProjectionNode & { id: string }>();

        // URN refs: group by memory so each distinct memory is gated + fetched
        // once (not N findFirsts).
        const byMemory = new Map<string, UrnRef[]>();
        for (const r of urnRefs) {
          const arr = byMemory.get(r.memoryUrn);
          if (arr) arr.push(r);
          else byMemory.set(r.memoryUrn, [r]);
        }
        for (const [mu, group] of byMemory) {
          const mem = await resolveMemoryByUrn(mu);
          if (!mem || !(await canReadMemory(db, auth, mem.id))) {
            for (const r of group) unavailable.push(r.raw);
            continue;
          }
          const rows = await db.node.findMany({
            where: { memoryId: mem.id, loc: { in: group.map((r) => r.loc) }, deletedAt: null },
            include: projectionInclude,
          });
          const rowByLoc = new Map(rows.map((r) => [r.loc, r]));
          for (const r of group) {
            const row = rowByLoc.get(r.loc);
            if (row) nodeByRef.set(r.raw, row as unknown as ReadProjectionNode & { id: string });
            else unavailable.push(r.raw);
          }
        }

        // PK refs: gate BEFORE fetching the projection, mirroring the URN path
        // above (which gates a memory, then reads only inside it). A PK carries
        // no memory, so that takes two queries: a cheap id+memoryId probe to
        // learn each row's memory, then the full projection for the readable
        // subset only. Fetching everything first and filtering after would pull
        // denied nodes' content and edges into memory just to discard them —
        // wasted work on a 200-ref batch, and content the caller was refused
        // has no reason to be materialized at all (PR #824 review, Copilot).
        //
        // A PK naming an unreadable node and a PK naming nothing both land in
        // `unavailable`, indistinguishably — the same answer the URN path gives
        // (cor:api:040:03).
        if (pkRefs.length > 0) {
          const probes = await db.node.findMany({
            where: { id: { in: pkRefs }, deletedAt: null },
            select: { id: true, memoryId: true },
          });
          const readable = new Map<string, boolean>();
          for (const memId of new Set(probes.map((p) => p.memoryId))) {
            readable.set(memId, await canReadMemory(db, auth, memId));
          }
          const allowedIds = probes.filter((p) => readable.get(p.memoryId)).map((p) => p.id);
          const rowById = new Map(
            (allowedIds.length > 0
              ? await db.node.findMany({
                  where: { id: { in: allowedIds } },
                  include: projectionInclude,
                })
              : []
            ).map((r) => [r.id, r]),
          );
          for (const pk of pkRefs) {
            const row = rowById.get(pk);
            if (row) {
              nodeByRef.set(pk, row as unknown as ReadProjectionNode & { id: string });
            } else {
              unavailable.push(pk);
            }
          }
        }

        // Reassemble in input order (cor:api:040:01), deduping on the RESOLVED
        // node so a PK and that node's URN in one call render — and bill — once.
        const seenIds = new Set<string>();
        for (const raw of uniqueRefs) {
          const n = nodeByRef.get(raw);
          if (!n || seenIds.has(n.id)) continue;
          seenIds.add(n.id);
          ordered.push(n);
        }
      }

      // Render in order, packing until the response-size cap. Over the cap we
      // stop and flag `truncated` (cor:api:040:02) — never a silent short read.
      // At least one node always renders so a single oversize node still
      // returns. One `read` UsageEvent per RETURNED node (cor:api:040:01 —
      // per-node parity with hadron_get_node).
      const blocks: string[] = [];
      const omitted: string[] = [];
      const readEvents: Prisma.UsageEventCreateManyInput[] = [];
      let bytes = 0;
      let truncated = false;
      for (const n of ordered) {
        if (truncated) {
          omitted.push(await nodeUrn(n.loc, n.memoryId));
          continue;
        }
        const lockState = mcpDecryptOrMark(n); // spec 041 — same posture as hadron_get_node
        const projection = await renderNodeReadProjection(n, scope, {
          locked: lockState === 'locked',
        });
        const size = Buffer.byteLength(projection, 'utf8');
        if (blocks.length > 0 && bytes + size > BATCH_READ_MAX_BYTES) {
          truncated = true;
          omitted.push(await nodeUrn(n.loc, n.memoryId));
          continue;
        }
        blocks.push(projection);
        bytes += size;
        readEvents.push({
          id: generateId(),
          type: 'read',
          nodeLoc: n.loc,
          nodeId: n.id,
          memoryId: n.memoryId, // #796 (as in hadron_get_node's event)
          appId: auth.appId ?? null,
          // 046-usage-metering FR-001 (as in hadron_get_node's event).
          userId: auth.userId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        });
      }
      // One batched insert for all returned nodes' read events, fire-and-forget
      // (parity with hadron_get_node's non-blocking single create). A per-node
      // create loop would fire up to BATCH_READ_MAX_NODES concurrent unawaited
      // inserts and pressure the connection pool — createMany is one round-trip
      // (PR #283 review).
      if (readEvents.length > 0) {
        db.usageEvent.createMany({ data: readEvents }).catch(() => {});
      }

      const headerParts = [`returned ${blocks.length} node(s)`];
      if (unavailable.length) headerParts.push(`${unavailable.length} unavailable`);
      if (truncated) headerParts.push(`truncated: response-size cap reached, ${omitted.length} omitted`);
      const parts: string[] = [`Batch read — ${headerParts.join('; ')}.`];
      if (blocks.length) {
        parts.push(blocks.join('\n\n────────────────────────────────────────\n\n'));
      }
      if (unavailable.length) {
        parts.push(
          `Unavailable (denied or not found):\n${unavailable.map((u) => `  - ${u}`).join('\n')}`,
        );
      }
      if (truncated) {
        parts.push(
          `Omitted (response-size cap — re-request with contentScope: 'abstract' or a narrower set):\n${omitted
            .map((u) => `  - ${u}`)
            .join('\n')}`,
        );
      }
      return textResult(parts.join('\n\n'));
    },
  );

  // ── hadron_get_next_node ─────────────────────────────────────────────────────

  server.tool(
    'hadron_get_next_node',
    'Read the next sibling node under a parent, ordered by `seq`. Returns the first child if current is omitted. The URN MUST be fully qualified (org::memory::loc).',
    {
      parent: z.string().describe('Fully-qualified parent node URN, e.g. "acme.com:mmdata:sections"'),
      current: z.string().optional().describe('Fully-qualified current child node URN (must be in the same memory as `parent`)'),
    },
    async ({ parent: rawParent, current: rawCurrent }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawParent, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(`Parent: ${e.message}`);
        throw e;
      }
      if (rawCurrent) {
        try {
          assertFullyQualifiedUrn(rawCurrent, 'node');
        } catch (e) {
          if (e instanceof UrnNotQualifiedError) return textResult(`Current: ${e.message}`);
          throw e;
        }
      }

      const { memoryUrn, loc: parentLoc } = splitNodeUrn(rawParent);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      if (!(await canReadMemory(db, auth, memory.id))) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      const prefix = parentLoc + ':';

      const allNodes = await db.node.findMany({
        // #180 Bug 2: skip tombstoned children so `next` doesn't land on
        // a soft-deleted row and either error or expose stale content.
        where: { memoryId: memory.id, loc: { startsWith: prefix }, deletedAt: null },
        orderBy: { loc: 'asc' },
      });
      // Direct children only (no further colons after prefix)
      const children = allNodes
        .filter((n) => !n.loc.slice(prefix.length).includes(':'))
        .sort((a, b) => {
          // Sort by seq first (nodes with seq come before those without), then by loc
          if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
          if (a.seq !== null) return -1;
          if (b.seq !== null) return 1;
          return a.loc.localeCompare(b.loc);
        });

      if (children.length === 0) {
        return textResult(`No children found under "${parentLoc}".`);
      }

      let next;
      if (!rawCurrent) {
        next = children[0];
      } else {
        const { memoryUrn: currentMemoryUrn, loc: currentLoc } = splitNodeUrn(rawCurrent);
        if (currentMemoryUrn !== memoryUrn) {
          return textResult(`Current URN's memory (${currentMemoryUrn}) doesn't match parent's memory (${memoryUrn}).`);
        }
        const idx = children.findIndex((n) => n.loc === currentLoc);
        if (idx === -1) {
          return textResult(`Current node "${currentLoc}" not found among children of "${parentLoc}".`);
        }
        if (idx + 1 >= children.length) {
          return textResult(`No more nodes after "${currentLoc}".`);
        }
        next = children[idx + 1];
      }

      const node = await db.node.findUnique({
        where: { id: next.id },
        include: {
          // #180 Bug 2: hide edges whose other end is tombstoned.
          outgoingEdges: {
            include: { target: true },
            where: { target: { deletedAt: null } },
          },
          incomingEdges: {
            include: { source: true },
            where: { source: { deletedAt: null } },
          },
        },
      });
      if (!node) return textResult('Node not found.');

      const urn = await nodeUrn(node.loc, node.memoryId);
      const outEdgeLines = await Promise.all(node.outgoingEdges.map(async (e) => {
        const targetUrn = await nodeUrn(e.target.loc, (e.target as any).memoryId);
        // #322: surface the target's stable PK alongside the URN.
        return `  - ${targetUrn} (id: ${e.target.id}) (${e.target.name}) — ${e.name ?? e.loc}`;
      }));
      // #186: nodeType in the meta block, mirroring hadron_get_node's format.
      const meta = [
        `**${node.name}**`,
        urn,
        // #322: stable PK (immutable across move/rename) — see hadron_get_node.
        `ID: ${node.id}`,
        node.description ? `> ${node.description}` : '',
        `Type: ${node.nodeType}`,
        node.tags.length ? `Tags: ${node.tags.join(', ')}` : '',
        node.seq !== null ? `Seq: ${node.seq}` : '',
        outEdgeLines.length ? `Related:\n${outEdgeLines.join('\n')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      return textResult(meta + '\n\n---\n\n' + (node.content || ''));
    },
  );

  // ── hadron_list_nodes ─────────────────────────────────────────────────────────

  server.tool(
    'hadron_list_nodes',
    'Browse the tree structure of a Hadron memory. Returns an indented tree view.',
    {
      parentRel: z.string().optional().describe('Parent node rel path; omit to list from memory root'),
      memoryUrn: z.string().optional().describe('Memory URN; uses active memory if not provided'),
      depth: z.number().optional().describe('Max depth to traverse (default: 1)'),
      isRunnable: z.boolean().optional().describe('Filter the tree to runnable status. true = only task nodes (Node.isRunnable=true) — the canonical "tasks I can run" predicate hadron_run_task gates on. false = only nodes explicitly marked non-runnable (most nodes leave it NULL, so false does NOT include them). Omit to list every node. Spec cor:api:060.'),
    },
    async ({ parentRel, memoryUrn, depth, isRunnable }) => {
      try {
        validateParentRel(parentRel);
      } catch (e) {
        if (e instanceof InvalidParentRelError) return textResult(e.message);
        throw e;
      }

      // Normalize parentRel once (matches the hadron_find_nodes pattern).
      const trimmedParentRel = parentRel?.trim();

      // Spec 022 (FR-003): no fallback to `activeMemoryUrn`. Caller MUST
      // supply either `memoryUrn` or `parentRel`.
      if (!memoryUrn && !trimmedParentRel) {
        return textResult('Please provide a memoryUrn or parentRel.');
      }

      const memoryIds = await getAccessibleMemoryIds(db, auth);
      const maxDepth = depth ?? 1;

      // Resolve the parent prefix
      let prefix: string;
      let memoryId: string | undefined;
      if (trimmedParentRel) {
        const resolved = await resolveLocFromUrn(trimmedParentRel, memoryIds);
        prefix = resolved.loc;
        memoryId = resolved.memoryId;
        // #188 (Gemini): canReadMemory gate matches hadron_find_nodes.
        // resolveLocFromUrn's accessibleMemoryIds filter handles non-
        // admin scope, but ADMIN/OWNER pass null and would otherwise
        // be able to browse another user's personal/private memory.
        if (memoryId && !(await canReadMemory(db, auth, memoryId))) {
          return textResult(`Node "${trimmedParentRel}" not found.`);
        }
      } else {
        prefix = '';
        // Find memory by URN. #100 #3: route through resolveMemoryByUrn so
        // a canonical 'urn:memory:' input doesn't miss against bare-stored
        // Memory.urn. Spec 022: require qualification at this boundary.
        if (memoryUrn) {
          try {
            assertFullyQualifiedUrn(memoryUrn, 'memory');
          } catch (e) {
            if (e instanceof UrnNotQualifiedError) return textResult(e.message);
            throw e;
          }
          const mem = await resolveMemoryByUrn(memoryUrn);
          if (!mem) {
            return textResult(
              `Memory not found or invalid: '${memoryUrn}'. Use hadron_list_memories to see what is available.`,
            );
          }
          // #188 (Gemini): canReadMemory gate — same shape as the
          // hadron_find_nodes memoryUrn branch.
          if (!(await canReadMemory(db, auth, mem.id))) {
            return textResult(
              `Memory not found or invalid: '${memoryUrn}'. Use hadron_list_memories to see what is available.`,
            );
          }
          memoryId = mem.id;
        }
      }

      // #180 Bug 2: tombstoned nodes are not part of the live tree, so
      // they shouldn't show up in browse output. (Their absence also
      // means a parent ceases to be "implicit" once its only child is
      // soft-deleted — the synthesize-parent pass below operates on the
      // filtered set.)
      const where: Record<string, unknown> = { deletedAt: null };
      if (prefix) where.loc = { startsWith: prefix + ':' };
      if (memoryId) where.memoryId = memoryId;
      else if (memoryIds) where.memoryId = { in: memoryIds };
      else {
        // memoryIds === null ⇒ ADMIN/OWNER "see all", and no single memory was
        // resolved (bare parentRel loc). WITHOUT this carve-out the query would
        // browse EVERY memory at the loc prefix, exposing another user's
        // personal/private nodes (FR-016) AND (spec 047) user-owned nodes to a
        // platform admin — the canReadMemory gate above only fires when a
        // memoryId resolved. Mirror the globalSearch admin carve-out (codex
        // review, #676).
        where.memory = {
          NOT: {
            OR: [
              { class: { in: ['personal', 'private'] }, userId: { not: auth.userId ?? '__none__' } },
              { AND: [{ ownerUserId: { not: null } }, { ownerUserId: { not: auth.userId ?? '__none__' } }] },
            ],
          },
        };
      }
      // NB: the runnable filter (cor:api:060) is applied IN-MEMORY below, not
      // here — see the realByKey/nodes split. Filtering it into this DB query
      // would hide real-but-non-runnable ancestors (parent nodes are usually
      // isRunnable=null), so the synthesize-parent walk would mislabel them as
      // "(missing — materialize)" even though they exist.

      const allNodes = await db.node.findMany({ where, orderBy: { loc: 'asc' } });

      // Deduplicate by (memoryId, loc): prefer canonical (isLink=false)
      // over link nodes. Multi-memory listings (memoryUrn unset, parentRel
      // resolving without a memoryId) can legitimately have the same loc
      // in two different memories, so the key MUST include memoryId.
      const dedupKey = (memId: string, loc: string) => `${memId}::${loc}`;
      const byKey = new Map<string, typeof allNodes[0]>();
      for (const n of allNodes) {
        const k = dedupKey(n.memoryId, n.loc);
        const existing = byKey.get(k);
        if (!existing || (existing.isLink && !n.isLink)) byKey.set(k, n);
      }
      const allDeduped = Array.from(byKey.values());
      // Runnable filter (cor:api:060) — prune the VISIBLE rows + child counts
      // to (non-)task nodes. `realByKey` is intentionally built from the
      // UNFILTERED set so the synthesize-parent walk renders a real-but-non-
      // runnable ancestor (typical parent node: isRunnable=null) as the node it
      // is, rather than a misleading "(missing — materialize)" gap. An implicit
      // parent still surfaces only when a matching descendant keeps it in view.
      const realByKey = new Map(
        allDeduped.map((n) => [dedupKey(n.memoryId, n.loc), n] as const),
      );
      const nodes =
        isRunnable != null
          ? allDeduped.filter((n) => n.isRunnable === isRunnable)
          : allDeduped;

      // Depth math: prefix has `prefixDepth` segments; a node's depth-
      // relative-to-prefix is the number of segments BEYOND the prefix
      // (1 = direct child).
      const prefixDepth = prefix ? prefix.split(':').length : 0;
      const depthRelative = (loc: string) => loc.split(':').length - prefixDepth;
      const isWithinScope = (loc: string) =>
        !prefix || loc === prefix || loc.startsWith(prefix + ':');

      // Issue #183 (#3, #4): render a true tree rather than a flat
      // depth-from-colons list.
      //   - Indent reflects actual parent depth in this view (a depth-2
      //     loc following an unrelated depth-1 loc no longer LOOKS like
      //     a child of it — the previous renderer indented purely by
      //     colon count, which made orphaned subtrees appear nested
      //     under the previous row).
      //   - Missing intermediate parents are synthesized so a node
      //     added bottom-up (e.g. `data-model:entities:user` with no
      //     `data-model:entities`) shows the gap explicitly instead of
      //     leaving the descendant visually floating.
      interface TreeRow {
        loc: string;
        depth: number;
        node: typeof allNodes[0] | null; // null = synthesized intermediate
        memoryId: string;
      }
      const visibleByKey = new Map<string, TreeRow>();

      for (const n of nodes) {
        const d = depthRelative(n.loc);
        if (d <= 0) continue;
        const k = dedupKey(n.memoryId, n.loc);
        // Only nodes within the depth window become visible rows; deeper
        // nodes still feed the synthesize-parent walk so their in-window
        // ancestors materialize (#185 F4 — a depth-2 orphan must surface
        // its missing depth-1 parent at maxDepth=1).
        if (d <= maxDepth) {
          visibleByKey.set(k, { loc: n.loc, depth: d, node: n, memoryId: n.memoryId });
        }

        // Walk up the parent chain WITHIN this memory and add missing
        // intermediates as synthesized rows for ancestors that fall in
        // the depth window. Before #185 F4 this loop early-exited any
        // node deeper than maxDepth, so implicit parents at depth=1
        // with only depth=2+ children rendered as gaps — agents read
        // those gaps as "data lost."
        let cur = n.loc;
        while (true) {
          const idx = cur.lastIndexOf(':');
          if (idx === -1) break;
          cur = cur.substring(0, idx);
          const pd = depthRelative(cur);
          if (pd <= 0) break;
          if (!isWithinScope(cur)) break;
          if (pd > maxDepth) continue; // ancestor out of window; keep walking up
          const pk = dedupKey(n.memoryId, cur);
          if (visibleByKey.has(pk)) break;
          const real = realByKey.get(pk) ?? null;
          visibleByKey.set(pk, { loc: cur, depth: pd, node: real, memoryId: n.memoryId });
        }
      }

      if (visibleByKey.size === 0) {
        return textResult(`No child nodes found under "${prefix || memoryUrn}".`);
      }

      // Sort so parents render before children. Across memories, sort
      // by memoryId first to keep each memory's subtree contiguous.
      // Within a memory, compare loc SEGMENT-BY-SEGMENT instead of
      // running localeCompare on the full string: `:` is ASCII 58, so
      // a sibling like `services-helper` (ASCII `-` = 45) or any digit
      // sorts BEFORE `services:db` (a child of `services`) under a
      // naive string compare, splitting parents from their descendants
      // in the rendered tree. Segment-by-segment compare keeps the
      // hierarchy intact: same prefix → shorter path wins (parent
      // first), then break the tie at the first differing segment.
      const compareLocs = (a: string, b: string): number => {
        const aParts = a.split(':');
        const bParts = b.split(':');
        const minLen = Math.min(aParts.length, bParts.length);
        for (let i = 0; i < minLen; i++) {
          if (aParts[i] !== bParts[i]) return aParts[i].localeCompare(bParts[i]);
        }
        return aParts.length - bParts.length;
      };
      const sortedRows = Array.from(visibleByKey.values()).sort((a, b) => {
        if (a.memoryId !== b.memoryId) return a.memoryId.localeCompare(b.memoryId);
        return compareLocs(a.loc, b.loc);
      });

      const lines = await Promise.all(sortedRows.map(async (row) => {
        const indent = '  '.repeat(row.depth - 1);
        // Direct-child count uses the full node set (not just visible
        // rows) so the hint reflects what's actually in the memory,
        // even when the depth window hides them.
        const childPrefix = row.loc + ':';
        const rowSegCount = row.loc.split(':').length;
        const childCount = nodes.filter((c) =>
          c.memoryId === row.memoryId &&
          c.loc.startsWith(childPrefix) &&
          c.loc.split(':').length === rowSegCount + 1,
        ).length;
        const childInfo = childCount > 0 ? ` (${childCount} children)` : '';
        const nUrn = await nodeUrn(row.loc, row.memoryId);
        if (row.node) {
          return `${indent}├── ${nUrn} — ${row.node.name}${childInfo}`;
        }
        // Synthesized intermediate. Surface the gap explicitly rather
        // than silently rendering it as a real row.
        return `${indent}├── ${nUrn} — (missing — use hadron_create_parent_node to materialize)${childInfo}`;
      }));

      const header = `Tree: ${prefix || memoryUrn}`;
      return textResult(`${header}\n${lines.join('\n')}`);
    },
  );

  // Spec 031 — normalize an inbound `abstract` value before the DB write.
  // Length cap on the raw input; then trim-then-check (empty AND
  // whitespace-only collapse to null; non-empty trimmed values persist
  // untrimmed so intentional surrounding whitespace on real paragraphs
  // is lossless). `undefined` (key absent on hadron_update_node) is passed
  // through unchanged so the caller can implement "omitted = preserve"
  // by spreading conditionally. The throw is the typed-error class —
  // the MCP transport catches and surfaces the error message to the
  // caller as a tool-result error.
  function normalizeAbstract(raw: string | null | undefined): string | null | undefined {
    if (raw === undefined) return undefined;
    if (raw === null) return null;
    if (raw.length > 2000) {
      throw new NodeAbstractTooLongError(raw.length);
    }
    if (raw.trim() === '') return null;
    return raw;
  }

  // ── hadron_unlock_memory / hadron_lock_memory (spec 041 PR-2, closes #206) ──

  server.tool(
    'hadron_unlock_memory',
    'Unlock an encrypted PRIVATE memory for THIS MCP session (spec 041). Supply exactly one of passphrase / dataKey; owner-only. While unlocked, reads return plaintext and writes encrypt; other sessions are unaffected. The key lives only in server memory and is dropped when the session closes (or via hadron_lock_memory).',
    {
      memoryUrn: z.string().describe('Memory URN or id'),
      passphrase: z.string().optional().describe('The passphrase the memory was encrypted with'),
      dataKey: z.string().optional().describe('Raw base64 32-byte data key (alternative to passphrase)'),
    },
    async ({ memoryUrn, passphrase, dataKey }) => {
      // Owner-only, mirroring the GraphQL header-unlock rule (PR-514):
      // private memories are owner-only by class; an App-key session has no
      // business unlocking them, and unowned refs get a uniform not-found.
      if (!auth.userId) {
        return textResult('hadron_unlock_memory requires a user-authenticated MCP connection.');
      }
      const sid = getSessionId();
      if (!sid) return textResult('No active MCP session.');
      const mem = await resolveMemoryByUrn(memoryUrn);
      const row = mem
        ? await db.memory.findUnique({
            where: { id: mem.id },
            select: {
              id: true, urn: true, userId: true, isEncrypted: true,
              kdfSalt: true, kdfParams: true, keyVerifier: true,
            },
          })
        : null;
      if (!row || row.userId !== auth.userId) {
        return textResult(`Memory "${memoryUrn}" not found.`);
      }
      if (!row.isEncrypted) {
        return textResult(`Memory "${row.urn}" is not encrypted.`);
      }
      try {
        const key = await resolveSuppliedKey(row, { passphrase, dataKey });
        sessionKeyCache.set(`mcp:${sid}`, row.id, key);
      } catch (err) {
        if (err instanceof MemoryUnlockError) return textResult(err.message);
        // Key conflict (another live session holds a DIFFERENT key) or
        // unexpected — surface the message, never the stack.
        return textResult(String((err as Error).message));
      }
      return textResult(
        `Memory unlocked for this session: ${row.urn}. Reads now return plaintext; writes encrypt. ` +
          'The key is dropped when this session ends (or call hadron_lock_memory).',
      );
    },
  );

  server.tool(
    'hadron_lock_memory',
    'Drop THIS MCP session\'s key for an encrypted memory (spec 041) — reads return to locked markers, writes to it are rejected. Other sessions holding the key are unaffected.',
    { memoryUrn: z.string().describe('Memory URN or id') },
    async ({ memoryUrn }) => {
      const sid = getSessionId();
      if (!sid) return textResult('No active MCP session.');
      // Same owner gate + uniform not-found as hadron_unlock_memory
      // (PR-517 review, Codex P2): without it, the existing-vs-missing
      // response split makes lock an existence oracle for private URNs.
      if (!auth.userId) {
        return textResult('hadron_lock_memory requires a user-authenticated MCP connection.');
      }
      const mem = await resolveMemoryByUrn(memoryUrn);
      const row = mem
        ? await db.memory.findUnique({ where: { id: mem.id }, select: { id: true, userId: true } })
        : null;
      if (!row || row.userId !== auth.userId) {
        return textResult(`Memory "${memoryUrn}" not found.`);
      }
      sessionKeyCache.release(`mcp:${sid}`, row.id);
      return textResult(`Memory locked for this session: ${memoryUrn}.`);
    },
  );

  // ── hadron_create_node ───────────────────────────────────────────────────────────

  server.tool(
    'hadron_create_node',
    'Add a new node to the memory graph (creates or updates). The URN MUST be fully qualified (org::memory::loc). Requires write access to the memory.',
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com::mmdata::review:sort-imports" or "hrn:node:acme.com::mmdata::review:sort-imports". Both bare and prefixed forms accepted. Relative-form URNs (no memory) are rejected.'),
      name: z.string().describe('Node name'),
      nodeType: z.string().optional().describe('Node classification (free-form; canonical values: abstract, chat, data, info (default), prompt, record, reference, system). Running is gated by isRunnable, independent of nodeType.'),
      objectType: z.string().optional().describe('#725 — collection this node belongs to (the domain-object discriminator, e.g. "competitor" / "insight"), orthogonal to nodeType. On a memory with a property schema, it MUST name a declared collection and the node\'s properties are validated against it; free-form on an unschema\'d memory. Omit for an ordinary node.'),
      isRunnable: z.boolean().optional().describe('Whether this node can be run as a task by hadron_run_task (cor:api:060). Defaults to not-runnable. Independent of nodeType — a runnable node may carry any nodeType.'),
      description: z.string().optional().describe('Short description'),
      abstract: z.string().optional().describe('Paragraph-length summary (max 2000 chars). Opt-in on hadron_get_node via the contentScope parameter. (hadron_find_nodes preview surfacing of abstract ships in spec 031 US2 — not yet live.) Empty + whitespace-only values normalize to null. Spec 031.'),
      content: z.string().optional().describe('Markdown content'),
      seq: z.number().optional().describe('Sort order among siblings (lower values first)'),
      tags: tagsInputSchema.optional().describe('Tags'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
      data: z.record(z.string(), z.unknown()).optional().describe('Runtime data (e.g. stageOrder, promptRef, extractionSpec for chat config)'),
      llmModel: z.string().optional().describe('LLM model used (e.g. claude-opus-4-6)'),
      aiAgent: z.string().optional().describe('AI agent tool used (e.g. claude-code, cursor)'),
      edges: z.array(z.object({
        targetUrn: z.string().describe('Target node fully-qualified URN'),
        name: z.string().optional().describe('Relationship name (was "label"), e.g. depends-on, documents'),
        loc: z.string().optional().describe('Explicit edge loc. Omit to derive <sourceLoc>:<name>:<targetLoc>.'),
        description: z.string().optional().describe('Edge description'),
        isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed (task/conversation flows)'),
      })).optional().describe('Outgoing edges (replaces the full set on the source node)'),
    },
    async ({ urn: rawUrn, name, nodeType, objectType, isRunnable, description, abstract, content, seq, tags, properties, data: nodeData, llmModel, aiAgent, edges }) => {
      // Spec 022: enforce qualification at the API boundary. Relative-form
      // URNs (e.g., `review:sort-imports` without org+memory) reject here
      // before any DB lookup runs.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      // Split into memory URN + loc and resolve the memory.
      const { memoryUrn, loc } = splitNodeUrn(rawUrn);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      const memoryId = memory.id;

      try {
        validateLoc(loc);
      } catch (e) {
        return textResult((e as Error).message);
      }

      if (!(await canWriteToMemory(db, auth, memoryId))) {
        return textResult('Write access denied for this memory.');
      }

      // Resolve edge targets BEFORE the source upsert so an
      // unresolvable target rolls back cleanly with no source-node
      // mutation (parallel to the GraphQL upsertNode resolver from
      // #106). Issue #107 review feedback.
      //
      // Spec 022: each edge target MUST be a fully-qualified URN (or an
      // ID-shape value via spec 007 dispatch). Pre-validate so short-loc
      // targets reject at the API boundary, before resolveEdgeRefs.
      let resolvedEdges: ResolvedEdge[] | null = null;
      if (edges) {
        for (const edge of edges) {
          try {
            if (!isId(edge.targetUrn)) {
              assertFullyQualifiedUrn(edge.targetUrn, 'node');
            }
          } catch (e) {
            if (e instanceof UrnNotQualifiedError) {
              return textResult(`Edge target: ${e.message}`);
            }
            throw e;
          }
        }
        const r = await resolveEdgeRefs(
          edges.map((e) => ({
            targetId: e.targetUrn,
            name: e.name ?? null,
            loc: e.loc ?? null,
            description: e.description ?? null,
            isRunnable: e.isRunnable ?? null,
          })),
          memoryId,
          auth,
        );
        if ('error' in r) return textResult(r.error);
        resolvedEdges = r.resolved;
      }

      const existing = await db.node.findUnique({ where: { loc_memoryId: { loc, memoryId } } });

      // Issue #543 — hadron_create_node is create-or-update (upsert). When the
      // target loc holds a SOFT-DELETED node, writing to it must resurrect the
      // row (clear deletedAt/deletedBy), matching the GraphQL createNode
      // contract (resolvers.mutation.node.ts `isResurrect`). Without this the
      // update branch below writes the new fields but leaves the row flagged
      // deleted — the "worst of both worlds": findable nowhere, yet still
      // feeding compiled reads only via stale paths.
      const isResurrect = !!existing?.deletedAt;

      // Spec 031 — length-cap + trim-then-check the abstract before write.
      let normalizedAbstract: string | null;
      try {
        normalizedAbstract = normalizeAbstract(abstract) ?? null;
      } catch (e) {
        if (e instanceof NodeAbstractTooLongError) return textResult(e.message);
        throw e;
      }

      // Spec 032 — hadron_create_node is upsert-semantically a fresh write: every
      // call writes the full set of provided fields. If the caller is
      // supplying an abstract, the hash is recomputed from the supplied
      // content (FR-003). Null/empty content with an abstract yields null
      // hash (FR-007). No abstract → no hash (FR-006). Hash is computed
      // on plaintext content (FR-009).
      const nextAbstractOriginHash: string | null =
        normalizedAbstract !== null ? computeContentHash(content ?? null) : null;

      // Spec: cor:dmo:020:01 (Node ordering).
      // Auto-assign `seq` for a NEW node joining an already-ordered sibling
      // list (parity with the GraphQL upsertNode resolver). Create-only; an
      // explicit `seq` arg wins; an unordered / empty list leaves it null.
      const createSeq =
        seq !== undefined
          ? seq
          : existing == null
            ? await nextSiblingSeq(db, memoryId, loc)
            : null;

      // Spec 041 (PR-2, closes #206 write-side): on an encrypted memory,
      // encrypt with this session's key — or REJECT when locked. Pre-041 the
      // MCP path silently stored plaintext rows into encrypted memories.
      // abstractOriginHash above is computed on PLAINTEXT (FR-009), before
      // this envelope; the enqueueNodeEmbedding call below keeps the
      // in-closure plaintext (FR-027 prompt-drain).
      const memEncRow = await db.memory.findUnique({
        where: { id: memoryId },
        select: { isEncrypted: true, schema: true },
      });
      // #725 — enforce the property schema on the RESULTING node state (input
      // overrides, else the existing value). An empty/whitespace objectType is
      // normalized to null (no collection). Only a collection member on a
      // schema'd memory is checked; a violation is a tool error (text), not a crash.
      const resultObjectType =
        objectType !== undefined ? (objectType.trim() || null) : (existing?.objectType ?? null);
      if (resultObjectType != null) {
        const resultProps = (properties !== undefined ? properties : existing?.properties) as
          | Record<string, unknown>
          | null
          | undefined;
        try {
          validateNodeAgainstSchema(memEncRow?.schema as unknown as MemorySchema | null, resultObjectType, resultProps ?? null);
        } catch (e) {
          if (e instanceof NodeSchemaViolation) return textResult(`Schema violation: ${e.message}`);
          throw e;
        }
      }
      let storedContent = content ?? null;
      let storedAbstract = normalizedAbstract;
      let storedData = (nodeData ?? undefined) as unknown;
      if (memEncRow?.isEncrypted) {
        const key = sessionKeyCache.getByMemoryId(memoryId);
        if (!key) {
          return textResult(
            'This memory is encrypted and locked — call hadron_unlock_memory first (spec 041).',
          );
        }
        const enc = encryptNodeFieldsWithKey(
          { content: storedContent, abstract: storedAbstract, data: storedData ?? null },
          key,
        );
        storedContent = enc.content ?? null;
        storedAbstract = enc.abstract ?? null;
        storedData = enc.data ?? undefined;
      }

      const upsertArgs = {
        where: { loc_memoryId: { loc, memoryId } },
        create: {
          id: existing?.id ?? generateId(),
          memoryId,
          loc,
          name,
          nodeType: nodeType ?? 'info',
          objectType: objectType?.trim() || null,
          isRunnable: isRunnable ?? null,
          description: description ?? null,
          abstract: storedAbstract,
          abstractOriginHash: nextAbstractOriginHash,
          content: storedContent,
          seq: createSeq,
          tags: tags ?? [],
          properties: properties as any ?? undefined,
          data: storedData as any ?? undefined,
          llmModel: llmModel ?? null,
          aiAgent: aiAgent ?? null,
          createdBy: auth.clientId ?? null,
        },
        update: {
          name,
          ...(nodeType ? { nodeType } : {}),
          ...(objectType !== undefined ? { objectType: objectType.trim() || null } : {}),
          ...(isRunnable !== undefined ? { isRunnable } : {}),
          description: description ?? null,
          abstract: storedAbstract,
          abstractOriginHash: nextAbstractOriginHash,
          content: storedContent,
          // seq is structural ordering, not content: preserve it on update when
          // omitted (parity with the upsertNode resolver) so a content-only
          // re-write doesn't wipe a node out of its ordered list (PR #309 review).
          ...(seq !== undefined ? { seq } : {}),
          tags: tags ?? [],
          ...(properties !== undefined ? { properties: properties as any } : {}),
          ...(nodeData !== undefined ? { data: storedData as any } : {}),
          ...(llmModel ? { llmModel } : {}),
          ...(aiAgent ? { aiAgent } : {}),
          // Resurrect a soft-deleted node on write (#543).
          ...(isResurrect ? { deletedAt: null, deletedBy: null } : {}),
        } as any,
      };
      // #664 (Model A — see nodeSubtreeLock.ts): serialize this create against a
      // concurrent ancestor-delete by holding advisory locks on the node's
      // ancestor path across the upsert, matching the GraphQL createNode path.
      // A root-level loc has no ancestor to coordinate against, so it skips the
      // transaction. READ COMMITTED (the default) is required so the delete's
      // descendant count sees this row once our commit releases the lock.
      const upserted =
        ancestorLocs(loc).length === 0
          ? await db.node.upsert(upsertArgs)
          : await db.$transaction(async (tx) => {
              await lockAncestorsForCreate(tx, memoryId, loc);
              return tx.node.upsert(upsertArgs);
            });

      if (resolvedEdges !== null) {
        await replaceOutgoingEdges({
          sourceNodeId: upserted.id,
          sourceLoc: loc,
          sourceMemoryId: memoryId,
          resolved: resolvedEdges,
          createdBy: auth.clientId ?? null,
        });
      }

      // Resolve any PendingEdges waiting for this node (by ID or loc).
      // Spec 037: the promoted Edge lives in its SOURCE node's memory and
      // gets a loc (the pending edge's authored loc, else derived from the
      // source loc + name + this newly-arrived target's loc).
      const pendingByLoc = await db.pendingEdge.findMany({ where: { targetId: loc } });
      const pendingById = await db.pendingEdge.findMany({ where: { targetId: upserted.id } });
      for (const p of [...pendingByLoc, ...pendingById]) {
        const pSource = await db.node.findUnique({
          where: { id: p.sourceId },
          select: { loc: true, memoryId: true },
        });
        if (pSource) {
          const pEdgeLoc = p.loc ?? deriveEdgeLoc(pSource.loc, p.name, upserted.loc);
          await db.edge.upsert({
            where: { loc_memoryId: { loc: pEdgeLoc, memoryId: pSource.memoryId } },
            create: {
              id: generateId(),
              memoryId: pSource.memoryId,
              sourceId: p.sourceId,
              targetId: upserted.id,
              loc: pEdgeLoc,
              name: p.name,
            },
            update: {},
          });
        }
        await db.pendingEdge.delete({ where: { id: p.id } });
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          id: generateId(),
          type: 'write',
          nodeLoc: loc,
          nodeId: upserted.id,
          memoryId, // #796 (as in hadron_get_node's event)
          appId: auth.appId ?? null,
          // 046-usage-metering FR-001 (as in hadron_get_node's event).
          userId: auth.userId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      // Announce the write (event pivot): the git mirror subscriber re-reads
      // and mirrors — this replaced the re-fetch + direct writeNodeToGit.
      // Note: on an ENCRYPTED memory the subscriber punts, so MCP writes
      // (which store plaintext on the row, #206) no longer git-mirror there —
      // acceptable in the #206 gray zone and safer than pushing maybe-mixed
      // rows.
      void publishNodeWritten({
        nodeId: upserted.id,
        memoryId,
        ownerRepo: '',
        clientId: auth.clientId,
      });

      // 033 — (re-)embed on write. MCP stores plaintext on the row (#206), and
      // `content`/`normalizedAbstract` are plaintext here.
      void enqueueNodeEmbedding(db, {
        nodeId: upserted.id,
        memoryId,
        plaintext: { content: content ?? null, abstract: normalizedAbstract },
      });

      const savedUrn = await nodeUrn(loc, memoryId);
      // #322: return the stable PK too — edges/replies created against the URN
      // break if the node is later moved/renamed; the id never changes.
      return textResult(`Node saved: ${savedUrn} (id: ${upserted.id})`);
    },
  );

  // ── hadron_update_node ────────────────────────────────────────────────────────

  server.tool(
    'hadron_update_node',
    'Partially update an existing node. Only the fields you provide are changed — everything else is preserved. The URN MUST be fully qualified (org::memory::loc).',
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com::mmdata::review:sort-imports"'),
      name: z.string().optional().describe('New node name'),
      nodeType: z.string().optional().describe('Node classification (free-form; canonical values: abstract, chat, data, info (default), prompt, record, reference, system). Changing nodeType does NOT change isRunnable or properties (e.g. claudeSkill) — a retyped runnable node stays runnable until you clear isRunnable yourself. Running is gated by isRunnable, not nodeType.'),
      objectType: z.string().optional().describe('#725 — collection this node belongs to (e.g. "competitor" / "insight"), orthogonal to nodeType. On a schema-governed memory it must name a declared collection and the resulting properties are validated against it. Omit to preserve.'),
      isRunnable: z.boolean().optional().describe('Set whether this node can be run as a task by hadron_run_task. Pass true/false; omit to preserve. Independent of nodeType — retyping the node never changes this flag.'),
      description: z.string().optional().describe('New short description'),
      abstract: z.string().nullable().optional().describe('New paragraph-length summary (max 2000 chars). Pass `null` to clear; omit to preserve. Empty + whitespace-only normalize to null. Surfaced on hadron_get_node via contentScope; hadron_find_nodes preview surfacing ships in spec 031 US2. Spec 031.'),
      content: z.string().nullable().optional().describe('New markdown content. Pass `null` to clear; omit to preserve. Spec 032 widened the schema from string-only to allow null per the consistent partial-update convention; clearing content interacts with abstractOriginHash maintenance (FR-006/FR-007).'),
      seq: z.number().optional().describe('New sort order among siblings'),
      tags: tagsInputSchema.optional().describe('Replace tags'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
      data: z.record(z.string(), z.unknown()).optional().describe('Runtime data (e.g. stageOrder, promptRef, extractionSpec for chat config). REPLACES the whole data bag — to merge in a few keys while preserving the rest, use hadron_update_node_data instead.'),
      llmModel: z.string().optional().describe('LLM model used'),
      aiAgent: z.string().optional().describe('AI agent tool used'),
      edges: z.array(z.object({
        targetUrn: z.string().describe('Target node fully-qualified URN'),
        name: z.string().optional().describe('Relationship name (was "label"), e.g. depends-on, documents'),
        loc: z.string().optional().describe('Explicit edge loc. Omit to derive <sourceLoc>:<name>:<targetLoc>.'),
        description: z.string().optional().describe('Edge description'),
        isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed (task/conversation flows)'),
      })).optional().describe('Replace outgoing edges (the full set on this node)'),
      reason: z.string().optional().describe('Why this change was made (stored in revision history)'),
    },
    async ({ urn: rawUrn, name, nodeType, objectType, isRunnable, description, abstract, content, seq, tags, properties, data: nodeData, llmModel, aiAgent, edges, reason }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const { memoryUrn, loc } = splitNodeUrn(rawUrn);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }

      // Auth BEFORE any node-existence probe: returning "not found" for an
      // existing-but-forbidden node while "access denied" for others would be
      // a membership oracle (Gemini review). Gate on the resolved memory.id
      // first — matches hadron_create_node's auth-first ordering.
      if (!(await canWriteToMemory(db, auth, memory.id))) {
        return textResult('Write access denied for this memory.');
      }

      const existing = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
      });
      // A soft-deleted node is treated as not-found here (#543), mirroring the
      // GraphQL update-mode contract (resolvers.mutation.node.ts) and every MCP
      // read/find/list path, which all exclude deletedAt. hadron_update_node is
      // a partial update, not a resurrect — a caller who wants a deleted loc
      // back must recreate it via hadron_create_node (which resurrects).
      if (!existing || existing.deletedAt) {
        return textResult(`Node not found: "${rawUrn}"`);
      }

      // Resolve edge targets BEFORE the revision snapshot + node update
      // so an unresolvable target rolls back cleanly with no source-
      // node mutation. Issue #107 review feedback.
      //
      // Spec 022: pre-validate edge URN qualification (matches hadron_create_node).
      let resolvedEdges: ResolvedEdge[] | null = null;
      if (edges !== undefined) {
        for (const edge of edges) {
          try {
            if (!isId(edge.targetUrn)) {
              assertFullyQualifiedUrn(edge.targetUrn, 'node');
            }
          } catch (e) {
            if (e instanceof UrnNotQualifiedError) {
              return textResult(`Edge target: ${e.message}`);
            }
            throw e;
          }
        }
        const r = await resolveEdgeRefs(
          edges.map((e) => ({
            targetId: e.targetUrn,
            name: e.name ?? null,
            loc: e.loc ?? null,
            description: e.description ?? null,
            isRunnable: e.isRunnable ?? null,
          })),
          existing.memoryId,
          auth,
        );
        if ('error' in r) return textResult(r.error);
        resolvedEdges = r.resolved;
      }

      // Spec 031 — length-cap + trim-then-check the abstract BEFORE the
      // revision snapshot, so an over-cap abstract aborts cleanly without
      // mutating either the row or the revision history.
      let normalizedAbstract: string | null | undefined;
      try {
        normalizedAbstract = normalizeAbstract(abstract);
      } catch (e) {
        if (e instanceof NodeAbstractTooLongError) return textResult(e.message);
        throw e;
      }

      // Spec 041 (PR-2, PR-517 review): the encrypted-memory gate runs
      // BEFORE any side effect — a locked rejection must leave NO trace,
      // including the revision-history row below (Codex P2).
      const updMemEnc = await db.memory.findUnique({
        where: { id: existing.memoryId },
        select: { isEncrypted: true, schema: true },
      });
      // #725 — enforce the property schema on the RESULTING node state (empty
      // objectType normalized to null).
      const updResultObjectType =
        objectType !== undefined ? (objectType.trim() || null) : (existing.objectType ?? null);
      if (updResultObjectType != null) {
        const updResultProps = (properties !== undefined ? properties : existing.properties) as
          | Record<string, unknown>
          | null
          | undefined;
        try {
          validateNodeAgainstSchema(updMemEnc?.schema as unknown as MemorySchema | null, updResultObjectType, updResultProps ?? null);
        } catch (e) {
          if (e instanceof NodeSchemaViolation) return textResult(`Schema violation: ${e.message}`);
          throw e;
        }
      }
      const updKey = updMemEnc?.isEncrypted
        ? sessionKeyCache.getByMemoryId(existing.memoryId)
        : null;
      if (updMemEnc?.isEncrypted && !updKey) {
        return textResult(
          'This memory is encrypted and locked — call hadron_unlock_memory first (spec 041).',
        );
      }

      // Snapshot current state for revision history.
      // Spec 032 — capture existing.abstractOriginHash so the revision
      // history round-trips the staleness signal. On an encrypted memory
      // `existing` still holds CIPHERTEXT here — revisions store the
      // at-rest form, deliberately (the decrypt happens just below).
      // #620 — shared builder: editedBy carries the user PK (when the MCP
      // caller is a user token), `reason` rides in revLabel, and `changes`
      // records the fields this update supplies with a different value.
      await createNodeRevision(db, {
        id: generateId(),
        ...buildNodeRevisionSnapshot(existing, editorFromAuth(auth), {
            revLabel: reason,
            changes: diffNodeChanges(existing, {
              name,
              nodeType,
              objectType,
              isRunnable,
              description,
              abstract: normalizedAbstract,
              content,
              seq,
              tags,
              properties,
              data: nodeData,
              llmModel,
              aiAgent,
            }),
          }),
      }).catch(() => {});

      // Spec 041 (PR-517 review, Codex P2): decrypt `existing` in place NOW
      // — everything below (the abstractOriginHash matrix, the embedding
      // enqueue's fallback plaintext) treats existing.content/abstract as
      // PLAINTEXT. Without this, an abstract-only update hashes ciphertext
      // (false-stale forever) and a content-only update embeds ciphertext.
      if (updKey) {
        decryptNodeFieldsWithKey(existing, updKey);
      }

      // Spec 032 — abstractOriginHash partial-update matrix (9 rows from
      // the contract). Drives off whether `normalizedAbstract` was
      // supplied (undefined = preserve, null = clear, string = set).
      // Hash always computed on plaintext per FR-009 (existing.* is
      // plaintext here — decrypted above for encrypted memories).
      let nextAbstractOriginHash: string | null | undefined;
      if (normalizedAbstract === undefined) {
        nextAbstractOriginHash = undefined;
      } else if (normalizedAbstract === null) {
        nextAbstractOriginHash = null;
      } else {
        const nextContent = content !== undefined ? content : existing.content;
        nextAbstractOriginHash = computeContentHash(nextContent ?? null);
      }

      // Build partial update — only fields that were provided
      const data: Record<string, unknown> = {};
      if (name !== undefined) data.name = name;
      if (nodeType !== undefined) data.nodeType = nodeType;
      if (objectType !== undefined) data.objectType = objectType.trim() || null;
      if (isRunnable !== undefined) data.isRunnable = isRunnable;
      if (description !== undefined) data.description = description;
      if (normalizedAbstract !== undefined) data.abstract = normalizedAbstract;
      if (nextAbstractOriginHash !== undefined) data.abstractOriginHash = nextAbstractOriginHash;
      if (content !== undefined) data.content = content;
      if (seq !== undefined) data.seq = seq;
      if (tags !== undefined) data.tags = tags;
      if (properties !== undefined) data.properties = properties as any;
      if (nodeData !== undefined) data.data = nodeData as any;
      if (llmModel !== undefined) data.llmModel = llmModel;
      if (aiAgent !== undefined) data.aiAgent = aiAgent;

      // Spec 041 (PR-2): encrypted memory — encrypt the provided encrypted-
      // envelope fields with this session's key (gate + key resolved above,
      // before the revision snapshot).
      if (updKey) {
        const enc = encryptNodeFieldsWithKey(
          {
            content: (data.content as string | null | undefined) ?? null,
            abstract: (data.abstract as string | null | undefined) ?? null,
            data: (data.data as unknown) ?? null,
          },
          updKey,
        );
        if (data.content !== undefined) data.content = enc.content ?? null;
        if (data.abstract !== undefined) data.abstract = enc.abstract ?? null;
        if (data.data !== undefined) data.data = (enc.data ?? null) as never;
      }

      if (Object.keys(data).length > 0) {
        await db.node.update({ where: { id: existing.id }, data });
      }

      if (resolvedEdges !== null) {
        await replaceOutgoingEdges({
          sourceNodeId: existing.id,
          sourceLoc: existing.loc,
          sourceMemoryId: existing.memoryId,
          resolved: resolvedEdges,
          createdBy: auth.clientId ?? null,
        });
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          id: generateId(),
          type: 'write',
          nodeLoc: loc,
          nodeId: existing.id,
          memoryId: existing.memoryId, // #796 (as in hadron_get_node's event)
          appId: auth.appId ?? null,
          // 046-usage-metering FR-001 (as in hadron_get_node's event).
          userId: auth.userId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      // Announce the write (event pivot): the git mirror subscriber re-reads
      // and mirrors (encrypted memories punt there — see hadron_create_node).
      void publishNodeWritten({
        nodeId: existing.id,
        memoryId: existing.memoryId,
        ownerRepo: '',
        clientId: auth.clientId,
      });

      // 033 — re-embed when content or abstract changed (existing.* is plaintext
      // on the MCP path, #206). Other-field-only updates don't touch the index.
      if (content !== undefined || normalizedAbstract !== undefined) {
        void enqueueNodeEmbedding(db, {
          nodeId: existing.id,
          memoryId: existing.memoryId,
          plaintext: {
            content: content !== undefined ? content : existing.content,
            abstract: normalizedAbstract !== undefined ? normalizedAbstract : existing.abstract,
          },
        });
      }

      const updatedUrn = await nodeUrn(loc, existing.memoryId);
      // #322: surface the stable PK (immutable across move/rename).
      return textResult(`Node updated: ${updatedUrn} (id: ${existing.id})`);
    },
  );

  // ── hadron_update_node_data ───────────────────────────────────────────
  //
  // Shallow-MERGE a JSON patch into a node's `data` bag (issue #366).
  // Distinct from hadron_update_node's `data` arg, which REPLACES the whole
  // bag — use this when you want to set/overwrite a few keys and keep the
  // rest. Delegates to the GraphQL updateNodeData resolver so the single-write
  // invariants (per-memory auth, encryption, revision history, git mirror) have
  // ONE implementation; like hadron_replace_text (and unlike the inline write
  // tools, #206) the delegated path encrypts/decrypts correctly.

  server.tool(
    'hadron_update_node_data',
    "Merge a JSON object into a node's `data` bag, preserving keys you don't mention. The patch's top-level keys are written over the node's existing data (the patch wins on collision); other keys stay as they were; a node with no data yet takes the patch as-is. The merge is SHALLOW — a nested object value is replaced wholesale, not deep-merged. Use this for partial data edits; to REPLACE the whole `data` bag instead, use hadron_update_node's `data` argument. Honors write permissions, revision history, and encryption.",
    {
      nodeUrn: z.string().describe('Node to update — a fully-qualified node URN (org::memory::loc) or an ID-shape PK.'),
      data: z.record(z.string(), z.unknown()).describe('JSON object to merge into the node\'s `data`. Must be an object (not an array or scalar). Its top-level keys overwrite existing ones; unmentioned keys are preserved.'),
    },
    async ({ nodeUrn: rawNodeUrn, data }) => {
      // Build a GraphQL Context from the MCP auth, including appId + sessionId
      // so app-keyed write authorization resolves the same way it does for
      // hadron_update_node (the gqlCtx helper omits those — #206 finding).
      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };

      try {
        const node = await resolvers.Mutation.updateNodeData(
          {},
          { nodeRef: rawNodeUrn, data },
          ctx,
        );
        const urn = await nodeUrn(node.loc, node.memoryId);
        return textResult(`Node data merged: ${urn} (id: ${node.id})`);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'update failed'}`);
      }
    },
  );

  // ── Object store (#745): hadron_create_object / _get_object / _update_object
  //    / _delete_object / _find_objects ─────────────────────────────────────
  //
  // The legible sugar surface over structured storage — an object IS a node.
  // Each tool delegates to a GraphQL object resolver (createObject / object /
  // updateObject / deleteObject / findObjects), which is itself a thin
  // projection over the node write/read paths, so auth, encryption, schema
  // conformance, revisions and the atomic merge have ONE implementation.
  // Objects are flat JSON records { id, type, ...fields }.

  const objectCtx = (): Context => ({
    db,
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    appId: auth.appId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
  });

  server.tool(
    'hadron_create_object',
    'Create a structured object (record) in a collection — the object store\'s legible surface over structured storage. `type` is the collection (e.g. "competitor"); `fields` are the flat, typed properties. On a memory with a declared schema for the collection, the fields are validated against it (an error is returned on a violation). The node loc/name are auto-derived and hidden; pass `key` for a human-meaningful id. Returns the flat object { id, type, ...fields }. "id" and "type" are reserved and cannot be field names.',
    {
      memoryUrn: z.string().describe('Memory to create the object in — a fully-qualified URN (org::memory) or an ID.'),
      type: z.string().describe('The collection this object belongs to (e.g. "competitor"). A single segment (no ":").'),
      fields: z.record(z.string(), z.unknown()).describe('The object\'s flat fields (typed properties). "id"/"type" are reserved.'),
      key: z.string().optional().describe('Optional natural id → a human-meaningful loc (<type>:<key>); a single segment (no ":"). Omit for an auto-generated id.'),
      name: z.string().optional().describe('Optional display name for the underlying node (defaults to a name/title field, else the type).'),
    },
    async ({ memoryUrn, type, fields, key, name }) => {
      try {
        const obj = await resolvers.Mutation.createObject(
          {},
          { memoryRef: memoryUrn, type, fields: fields ?? {}, key, name },
          objectCtx(),
        );
        return textResult(JSON.stringify(obj, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'create failed'}`);
      }
    },
  );

  server.tool(
    'hadron_get_object',
    'Read one object by id (or node URN) from the object store, as a flat JSON record { id, type, ...fields }. Returns "Object not found." when it does not exist, is inaccessible, or the node is not an object (has no collection).',
    {
      ref: z.string().describe('Object id (or a fully-qualified node URN).'),
    },
    async ({ ref }) => {
      try {
        const obj = await resolvers.Query.object({}, { ref }, objectCtx());
        return obj ? textResult(JSON.stringify(obj, null, 2)) : textResult('Object not found.');
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'read failed'}`);
      }
    },
  );

  server.tool(
    'hadron_update_object',
    'Merge fields into an existing object (server-side ATOMIC shallow merge — the patch wins on key collision, unmentioned fields preserved). On a schema-governed collection the merged result is validated. Returns the updated flat object. "id" and "type" are reserved and cannot be field names.',
    {
      ref: z.string().describe('Object id (or a fully-qualified node URN).'),
      fields: z.record(z.string(), z.unknown()).describe('Fields to merge in. "id"/"type" are reserved.'),
      reason: z.string().optional().describe('Optional rationale, recorded in revision history.'),
    },
    async ({ ref, fields, reason }) => {
      try {
        const obj = await resolvers.Mutation.updateObject({}, { ref, fields: fields ?? {}, reason }, objectCtx());
        return textResult(JSON.stringify(obj, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'update failed'}`);
      }
    },
  );

  server.tool(
    'hadron_delete_object',
    'Delete an object (soft by default — it disappears from reads/queries; pass hard:true to permanently remove the row).',
    {
      ref: z.string().describe('Object id (or a fully-qualified node URN).'),
      hard: z.boolean().optional().describe('Permanently remove the row (default false = soft delete).'),
    },
    async ({ ref, hard }) => {
      try {
        await resolvers.Mutation.deleteObject({}, { ref, hard }, objectCtx());
        return textResult(`Object deleted${hard ? ' (hard)' : ''}: ${ref}`);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'delete failed'}`);
      }
    },
  );

  server.tool(
    'hadron_find_objects',
    'Query a collection in a memory. Returns { objects, total } — objects of `type` as flat records, plus the full match count for paging with limit/offset. `match` is an equality shorthand ({ field: value }) with each field\'s cast inferred from the memory schema; `where` is the full #719 structured predicate (ANDed with match; same grammar as hadron_find_nodes\' where); `sort` is a single-field shorthand ({ field: "asc" | "desc" }).',
    {
      memoryUrn: z.string().describe('Memory to query — a fully-qualified URN (org::memory) or an ID.'),
      type: z.string().describe('The collection to query (e.g. "competitor").'),
      match: z.record(z.string(), z.unknown()).optional().describe('Equality shorthand: { field: value, ... } → an AND of eq predicates (cast inferred from the schema).'),
      where: z.record(z.string(), z.unknown()).optional().describe('Full #719 structured predicate over the object\'s fields (ANDed with match).'),
      sort: z.record(z.string(), z.unknown()).optional().describe('Single-field sort: { field: "asc" | "desc" }, e.g. { "fundingUsd": "desc" }.'),
      limit: z.number().optional(),
      offset: z.number().optional(),
    },
    async ({ memoryUrn, type, match, where, sort, limit, offset }) => {
      try {
        const result = await resolvers.Query.findObjects(
          {},
          { memoryRef: memoryUrn, type, match: match ?? undefined, where: (where ?? undefined) as NodeWhere | undefined, sort: sort ?? undefined, limit, offset },
          objectCtx(),
        );
        // Return { objects, total } so agents can page deterministically with limit/offset.
        return textResult(JSON.stringify({ objects: result.objects, total: result.total }, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'query failed'}`);
      }
    },
  );

  // ── hadron_replace_text ──────────────────────────────────────────────
  //
  // Bulk literal/regex search-and-replace across many nodes at once. Delegates
  // to the GraphQL searchReplaceInNodes resolver so there is ONE implementation
  // of the write invariants (per-memory auth, encryption, revision history,
  // abstract-staleness, re-embedding, git mirror). Unlike the other MCP write
  // tools (#206), the delegated path encrypts/decrypts correctly because the
  // resolver owns that logic.

  server.tool(
    'hadron_replace_text',
    "Search-and-replace a piece of text across MANY nodes in one call. Selection is the union of explicit node URNs and whole memories (memoryUrns), optionally narrowed to a subtree by 'prefix' (a parent loc — matches that node plus its descendants on ':' path boundaries, so 'auth' matches 'auth' and 'auth:tokens' but not 'authoring'; requires memoryUrns). Searches the chosen text fields (content, name, alias, description, abstract, tags); JSON fields are not touched. Literal substring match by default; set regex:true to treat oldText as a regular expression and newText as a replacement pattern (supports $1/$& backrefs). ALWAYS run with dryRun:true first to preview match counts before writing — this tool can rewrite a lot of nodes at once. Honors write permissions, revision history (each change is undoable), and re-embeds changed nodes.",
    {
      oldText: z.string().describe('Text to find (literal substring), or a regular-expression source when regex:true. Must be non-empty.'),
      newText: z.string().describe('Replacement text. May be empty to delete the matched text. In regex mode, $1/$<name>/$& are honored.'),
      nodeUrns: z.array(z.string()).optional().describe('Explicit nodes to edit — fully-qualified node URNs (org::memory::loc) or ID-shape values.'),
      memoryUrns: z.array(z.string()).optional().describe('Edit every live node in these memories — fully-qualified memory URNs (org::memory) or ID-shape values. At least one of nodeUrns / memoryUrns is required.'),
      prefix: z.string().optional().describe("Restrict the memoryUrns selection to a subtree: the node at this loc plus its descendants. Requires memoryUrns (loc is only unique within a memory)."),
      fields: z.array(z.enum(['content', 'name', 'alias', 'description', 'abstract', 'tags']))
        .describe('Which text fields to search. At least one required.'),
      caseInsensitive: z.boolean().optional().describe('Match case-insensitively (default false).'),
      regex: z.boolean().optional().describe('Treat oldText as a regular-expression source and newText as a replacement pattern (default false).'),
      dryRun: z.boolean().optional().describe('Preview only: report per-node match counts WITHOUT writing anything. Strongly recommended before a real run.'),
    },
    async ({ oldText, newText, nodeUrns, memoryUrns, prefix, fields, caseInsensitive, regex, dryRun }) => {
      // Build a GraphQL Context from the MCP auth. Include appId + sessionId so
      // app-keyed write authorization (requireMemoryWriteAccess) resolves the
      // same way it does for hadron_create_node / hadron_update_node.
      const ctx: Context = {
        db,
        clientId: auth.clientId ?? undefined,
        userId: auth.userId ?? undefined,
        appId: auth.appId ?? undefined,
        sessionId: auth.sessionId ?? undefined,
        roles: auth.roles as Context['roles'],
        organizationId: auth.organizationId ?? undefined,
      };

      // The resolver accepts IDs OR URNs for both selectors, so URNs pass
      // through unchanged.
      try {
        const result = await resolvers.Mutation.searchReplaceInNodes(
          {},
          {
            input: {
              oldText,
              newText,
              nodeIds: nodeUrns,
              memoryIds: memoryUrns,
              prefix,
              fields,
              caseInsensitive: caseInsensitive ?? false,
              regex: regex ?? false,
              dryRun: dryRun ?? false,
            },
          } as never,
          ctx,
        );

        // Render a compact, URN-addressed summary.
        const lines = await Promise.all(
          result.results.map(async (r: { loc: string; memoryId: string; replacements: number; fields: Array<{ field: string; matches: number }> }) => {
            const urn = await nodeUrn(r.loc, r.memoryId);
            const breakdown = r.fields.map((f) => `${f.field}×${f.matches}`).join(', ');
            return `  - ${urn} (${r.replacements}: ${breakdown})`;
          }),
        );

        const verb = result.dryRun ? 'Would replace' : 'Replaced';
        const header =
          `${verb} ${result.totalReplacements} occurrence(s) across ` +
          `${result.nodesChanged} of ${result.nodesScanned} node(s) scanned` +
          (result.dryRun ? ' (dry run — nothing written).' : '.');

        return textResult(lines.length ? `${header}\n${lines.join('\n')}` : header);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'search-and-replace failed'}`);
      }
    },
  );

  // ── hadron_create_edge ───────────────────────────────────────────────────────────
  //
  // Issue #183 — hadron_update_node.edges replaces the full outgoing-edge set,
  // which means the only way to add a single edge to an existing node
  // without hadron_create_edge is to re-send EVERY existing edge plus the new
  // one. Easy to drop edges by accident. This tool fills that gap with
  // an idempotent single-edge upsert that leaves all other edges alone.

  server.tool(
    'hadron_create_edge',
    'Add a single outgoing edge from one node to another. Non-destructive — leaves all other edges on the source node intact (unlike hadron_update_node, which replaces the full edge set). Idempotent: re-running with the same loc is a no-op (loc is the edge identity; omit it and the same source/target/name always derive the same loc). Both endpoints may be given as an ID-shape PK OR a fully-qualified node URN (org::memory::loc). Prefer the PK: it is immutable, so an edge created against it survives a later move/rename of the node, whereas a URN does not (#322). Both endpoints must already exist — use hadron_create_node first to create them. Cross-memory edges are supported, but the caller must have read access on the target memory.',
    {
      sourceUrn: z.string().describe('Source node, as an ID-shape PK (preferred — immutable across move/rename) OR a fully-qualified URN, e.g. "acme.com::mmdata::services:db-helper". The source node must already exist; this tool will not create it.'),
      targetUrn: z.string().describe('Target node, as an ID-shape PK (preferred) OR a fully-qualified URN. The target must already exist; use hadron_create_node first if it does not.'),
      name: z.string().optional().describe('Relationship name (was "label"), e.g. "depends-on", "documents", "supersedes". Optional — loc is the identity.'),
      loc: z.string().optional().describe('Explicit edge loc (its identity + URN suffix hrn:edge:<org>::<memory>::<loc>). Omit to derive <sourceLoc>:<name>:<targetLoc>.'),
      description: z.string().optional().describe('Human-readable description of the edge.'),
      isRunnable: z.boolean().optional().describe('Whether this edge can be run/executed (task automation, conversation transitions).'),
    },
    async ({ sourceUrn, targetUrn, name, loc, description, isRunnable }) => {
      const result = await addEdge({ sourceUrn, targetUrn, name, loc, description, isRunnable, auth });
      if ('error' in result) return textResult(result.error);
      return textResult(
        `Edge saved: ${result.edgeUrn}${result.name ? ` (${result.name})` : ''}\n  ${result.sourceUrn} → ${result.targetUrn}`,
      );
    },
  );

  // ── hadron_delete_node ────────────────────────────────────────────────────────
  //
  // #180 Bug 1 — agents had no way to remove a node they created in error.
  // Soft-delete is the default; `hard: true` opts into the row delete.
  //
  // Refuses if the node has descendants (by URN hierarchy) unless the
  // caller passes `recursive: true`. The refusal envelope includes the
  // descendant count so agents can decide what to do. Safest default —
  // an `archive` node with 19 children should not vanish as a side-
  // effect of a single delete call.
  //
  // Hard-delete cascade (per Node FK relations in prisma/schema.prisma):
  //   - Edge (source + target): onDelete: Cascade.
  //   - PendingEdge (source): onDelete: Cascade for the SOURCE side
  //     only. The targetId column is INTENTIONALLY NOT a foreign key
  //     (it points at nodes that don't exist yet), so the target side
  //     does NOT cascade — we delete those rows explicitly inside the
  //     transaction below. Caught in PR-189 review.
  //   - NodeRevision: onDelete: Cascade.
  //   - UsageEvent.nodeId: SetNull — audit history preserved.
  //
  // Cross-memory edge gate (hard-delete only): if any edge bridges this
  // memory to another and either endpoint is in the to-be-deleted set,
  // the call refuses without `cascadeCrossMemoryEdges: true`. The caller
  // has write access here but NOT necessarily to the other memory;
  // cascading would silently mutate data the caller doesn't own.
  //
  // Atomicity: descendant-count → refuse-or-act runs inside a single
  // transaction (#664) so a descendant created mid-flight either appears in the
  // recursive scope or causes the refusal to fire — never a half-complete state
  // where the descendant is silently orphaned. An advisory lock on this node's
  // loc (taken first, keyed identically to the lock every descendant-create
  // holds on it as an ancestor — see nodeSubtreeLock.ts) closes the
  // count-then-act race: a concurrent descendant-create either commits before
  // the lock (counted → refused) or waits until this delete commits (create
  // after delete — tolerated). READ COMMITTED (the default) is required so the
  // count runs on a fresh snapshot taken after the lock is granted.

  server.tool(
    'hadron_delete_node',
    `Delete a node. Soft-delete by default (sets deletedAt; node disappears from find/read/list and is excluded from Related / Referenced-by edge surfaces). Pass \`hard: true\` to remove the row entirely.

Hard-delete cascades to Edge (both directions) and NodeRevision via FK. PendingEdge source-side rows also cascade via FK, but the target-side column is intentionally not a foreign key — those rows are deleted explicitly inside the same transaction. UsageEvent.nodeId is SetNull so audit history is preserved.

Refuses if the node has descendants under its URN prefix unless \`recursive: true\`. Hard-delete additionally refuses if any edge bridges this memory to another (the caller doesn't necessarily own the other memory) unless \`cascadeCrossMemoryEdges: true\`. The URN MUST be fully qualified (org::memory::loc).`,
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com::mmdata::review:sort-imports".'),
      hard: z.boolean().optional().describe('Default false (soft-delete). Pass true to delete the row entirely; cascades to Edge and NodeRevision via FK and explicitly cleans up PendingEdge target-side rows. Irreversible.'),
      recursive: z.boolean().optional().describe('Default false (refuses with descendants). Pass true to apply the same soft/hard mode to every descendant under the node\'s URN prefix.'),
      cascadeCrossMemoryEdges: z.boolean().optional().describe('Hard-delete only; default false. Pass true to acknowledge that hard-deleting will remove edges whose other endpoint lives in a different memory (the other memory\'s view loses them silently).'),
    },
    async ({ urn: rawUrn, hard, recursive, cascadeCrossMemoryEdges }) => {
      try {
        assertFullyQualifiedUrn(rawUrn, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const { memoryUrn, loc } = splitNodeUrn(rawUrn);
      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Node "${rawUrn}" not found.`);
      }
      if (!(await canWriteToMemory(db, auth, memory.id))) {
        // Match the "not found" phrasing used elsewhere on access denial
        // so the response doesn't distinguish absence from denial.
        return textResult(`Node "${rawUrn}" not found.`);
      }

      // Find the node by (loc, memoryId). Already-tombstoned nodes are
      // treated as not-found for soft-delete (idempotent no-op shape) but
      // are addressable for hard-delete so callers can compact them.
      const existing = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
      });
      if (!existing) return textResult(`Node "${rawUrn}" not found.`);
      if (existing.deletedAt && !hard) {
        return textResult(
          `Node "${rawUrn}" is already soft-deleted. Pass hard: true to remove the row entirely.`,
        );
      }

      type DeleteResult =
        | { refused: 'descendants'; count: number }
        | { refused: 'crossMem'; count: number }
        | { ok: true; descendantCount: number };

      const result: DeleteResult = await db.$transaction(async (tx) => {
        await lockNodeForDelete(tx, memory.id, loc);
        // Descendants by URN hierarchy: loc startsWith node.loc + ':'.
        // Soft-delete refuses based on LIVE descendants; hard-delete
        // refuses based on the union (a tombstoned descendant still has
        // an FK that the row delete would cascade through, surprising
        // for the caller).
        const descendantWhere = {
          memoryId: memory.id,
          loc: { startsWith: loc + ':' },
          ...(hard ? {} : { deletedAt: null }),
        };
        const descendantCount = await tx.node.count({ where: descendantWhere });
        if (descendantCount > 0 && !recursive) {
          return { refused: 'descendants', count: descendantCount };
        }

        if (hard) {
          // Resolve affected ids for cross-memory check + PendingEdge cleanup.
          const affectedIds =
            recursive && descendantCount > 0
              ? (await tx.node.findMany({
                  where: {
                    memoryId: memory.id,
                    OR: [{ id: existing.id }, { loc: { startsWith: loc + ':' } }],
                  },
                  select: { id: true },
                })).map((n) => n.id)
              : [existing.id];

          if (!cascadeCrossMemoryEdges) {
            const crossMemEdges = await tx.edge.count({
              where: {
                OR: [
                  { targetId: { in: affectedIds }, source: { memoryId: { not: memory.id } } },
                  { sourceId: { in: affectedIds }, target: { memoryId: { not: memory.id } } },
                ],
              },
            });
            if (crossMemEdges > 0) {
              return { refused: 'crossMem', count: crossMemEdges };
            }
          }

          // PendingEdge target-side cleanup — NOT a FK, so the cascade
          // misses these (PR-189 review caught this).
          await tx.pendingEdge.deleteMany({ where: { targetId: { in: affectedIds } } });

          if (recursive && descendantCount > 0) {
            await tx.node.deleteMany({
              where: {
                memoryId: memory.id,
                OR: [{ id: existing.id }, { loc: { startsWith: loc + ':' } }],
              },
            });
          } else {
            await tx.node.delete({ where: { id: existing.id } });
          }
        } else {
          const now = new Date();
          const deletedBy = auth.userId ?? auth.clientId ?? null;
          if (recursive && descendantCount > 0) {
            await tx.node.updateMany({
              where: {
                memoryId: memory.id,
                deletedAt: null,
                OR: [{ id: existing.id }, { loc: { startsWith: loc + ':' } }],
              },
              data: { deletedAt: now, deletedBy },
            });
          } else {
            await tx.node.update({
              where: { id: existing.id },
              data: { deletedAt: now, deletedBy },
            });
          }
        }

        return { ok: true, descendantCount };
      });

      if ('refused' in result) {
        if (result.refused === 'descendants') {
          const mode = hard ? 'hard delete' : 'soft delete';
          return textResult(
            `Node "${rawUrn}" has ${result.count} descendant(s). ` +
              `${mode} refuses without recursive: true. ` +
              `Pass recursive: true to apply the same ${hard ? 'hard' : 'soft'} delete to every descendant.`,
          );
        }
        return textResult(
          `Hard-delete refused: ${result.count} edge(s) bridge this memory to another. ` +
            `Pass cascadeCrossMemoryEdges: true to acknowledge that cascading will remove those edges ` +
            `(the other memory's view loses them with no further notice).`,
        );
      }

      const totalAffected = (recursive ? result.descendantCount : 0) + 1;
      const mode = hard ? 'Hard-deleted' : 'Soft-deleted';
      const suffix =
        recursive && result.descendantCount > 0
          ? ` (1 node + ${result.descendantCount} descendant(s) = ${totalAffected} total)`
          : '';
      return textResult(`${mode} "${rawUrn}"${suffix}.`);
    },
  );

  // ── hadron_move_node ──────────────────────────────────────────────────────────

  server.tool(
    'hadron_move_node',
    `Move or rename a node, optionally across memories. The node keeps its stable ID so all edge references remain valid. Both URNs MUST be fully qualified (org::memory::loc).

Collision policy: if a live node already occupies \`targetUrn\`, the call refuses with a URN_ALREADY_EXISTS error. Pass \`overwrite: true\` to soft-delete the existing target first; the evicted row is re-stamped to \`<loc>__deleted-<full-id>\` so the unique \`(loc, memoryId)\` constraint doesn't block. Hard-overwrite isn't supported — call hadron_delete_node (hard: true) on the target first if you need that.

Descendants move WITH the node (#768): a node's loc-subtree (every node whose loc is prefixed by \`<loc>:\`) is rebased onto the new loc, so children's URNs follow the parent. This works within one memory OR across memories (#781) — a different memory in \`targetUrn\` relocates the whole subtree there, carrying the moved nodes' embeddings and rewriting the edges whose source moved to the destination memory. A boundary edge to a node left behind becomes a cross-memory edge (its far endpoint is access-gated on read). A same-memory move leaves edge locs untouched (a derived denormalization; keep addressing those edges by their existing URN). A collision at any DESCENDANT slot refuses the whole move (overwrite only evicts the explicitly-named target loc).

Atomicity: collision-evict → per-node NodeRevision snapshot → subtree move all run inside a single db.$transaction so a partial failure cannot leave the URN slot empty.

On success returns the moved node's record: new URN, name, type, tags, edge counts, and immediate-child count (empty sections omitted).`,
    {
      urn: z.string().describe('Current node fully-qualified URN, e.g. "acme.com::mmdata::services:db-helper"'),
      targetUrn: z.string().describe('Destination node fully-qualified URN. Different memory in the target URN performs a cross-memory move.'),
      overwrite: z.boolean().optional().describe('Default false (refuses on collision). Pass true to soft-delete an existing live target node before moving; the move then proceeds into the freed URN slot.'),
    },
    async ({ urn: rawFrom, targetUrn: rawTo, overwrite }) => {
      // Spec 022: qualification at the API boundary for both source and target.
      try {
        assertFullyQualifiedUrn(rawFrom, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(`Source: ${e.message}`);
        throw e;
      }
      try {
        assertFullyQualifiedUrn(rawTo, 'node');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(`Target: ${e.message}`);
        throw e;
      }

      const { memoryUrn: fromMemoryUrn, loc: fromLoc } = splitNodeUrn(rawFrom);
      const { memoryUrn: toMemoryUrn, loc: toLoc } = splitNodeUrn(rawTo);

      const fromMemory = await resolveMemoryByUrn(fromMemoryUrn);
      if (!fromMemory) {
        return textResult(`Source memory not found: "${fromMemoryUrn}".`);
      }
      const toMemory = await resolveMemoryByUrn(toMemoryUrn);
      if (!toMemory) {
        return textResult(`Target memory not found: "${toMemoryUrn}".`);
      }

      try {
        validateLoc(toLoc);
      } catch (e) {
        return textResult((e as Error).message);
      }

      const existing = await db.node.findUnique({
        where: { loc_memoryId: { loc: fromLoc, memoryId: fromMemory.id } },
      });
      if (!existing) return textResult(`Node "${rawFrom}" not found.`);

      if (!(await canWriteToMemory(db, auth, fromMemory.id))) {
        return textResult('Write access denied for source memory.');
      }
      if (toMemory.id !== fromMemory.id && !(await canWriteToMemory(db, auth, toMemory.id))) {
        return textResult('Write access denied for target memory.');
      }

      const isSameSlot = toLoc === fromLoc && toMemory.id === fromMemory.id;

      // Transactional core. Collision-check, eviction-re-stamp, NodeRevision
      // snapshot, and the row move all run inside one transaction. The move
      // itself targets the row BY ID (not by composite key) so the post-
      // move record fetch can't race against a concurrent move into the
      // same slot — `id` is stable across moves.
      type MoveResult =
        | { refused: 'urn-exists'; targetUrn: string }
        | {
            ok: true;
            moved: {
              name: string;
              description: string | null;
              nodeType: string;
              tags: string[];
              outgoingEdges: Array<{ id: string }>;
              incomingEdges: Array<{ id: string }>;
            };
            childCount: number;
          };

      let result: MoveResult;
      try {
        result = await db.$transaction(async (tx) => {
          // #664/#752: moving a node INTO a subtree is the same orphan vector as
          // creating there — lock the destination's ancestor path first (matching
          // the GraphQL moveNode resolver and hadron_delete_node's own-loc lock),
          // so a concurrent non-recursive delete of a destination ancestor can't
          // count zero descendants and then let this move land under it. Taken
          // before any row-locking statement to keep advisory-before-row ordering
          // consistent with the delete path (no lock-order inversion).
          await lockAncestorsForCreate(tx, toMemory.id, toLoc);

          if (isSameSlot) {
            // Same-slot "move" — normalize the node's name to the loc leaf, as
            // before. Nothing to cascade (destLoc === the current loc).
            const newName = toLoc.split(':').pop()!;
            await createNodeRevision(tx, {
              id: generateId(),
              ...buildNodeRevisionSnapshot(existing, editorFromAuth(auth), {
                changes: diffNodeChanges(existing, { loc: toLoc, name: newName, memoryId: toMemory.id }),
              }),
            });
            await tx.node.update({
              where: { id: existing.id },
              data: { loc: toLoc, name: newName, memoryId: toMemory.id },
            });
          } else {
            const crossMemory = toMemory.id !== fromMemory.id;

            // Collision policy for the EXPLICITLY-named target loc: a live
            // occupant refuses unless overwrite:true, which soft-deletes it and
            // re-stamps its loc out of the way so the (loc, memoryId) unique
            // doesn't block. Use the FULL id in the archived loc — UUIDv7's first
            // 6 bytes are the ms timestamp, so an 8-char slice was timestamp-only
            // entropy (PR-189). Descendant-slot collisions are always refused —
            // moveNodeSubtree throws SubtreeMoveCollisionError (caught below).
            const existingTarget = await tx.node.findUnique({
              where: { loc_memoryId: { loc: toLoc, memoryId: toMemory.id } },
            });
            if (existingTarget && !existingTarget.deletedAt && !overwrite) {
              const targetUrn = await nodeUrn(toLoc, toMemory.id);
              return { refused: 'urn-exists', targetUrn };
            }
            if (existingTarget) {
              const archivedLoc = `${toLoc}__deleted-${existingTarget.id}`;
              await tx.node.update({
                where: { id: existingTarget.id },
                data: {
                  loc: archivedLoc,
                  ...(existingTarget.deletedAt
                    ? {}
                    : { deletedAt: new Date(), deletedBy: auth.userId ?? auth.clientId ?? null }),
                },
              });
            }

            // #768/#781: rebase the whole loc-subtree via the shared helper (the
            // ONE implementation the GraphQL moveNode resolver also uses) — SAME-
            // memory or CROSS-memory (destMemoryId carries nodes + embeddings +
            // outgoing edges across). renameSourceLeaf sets the moved node's name
            // to the loc leaf (this tool's long-standing behavior); it locks +
            // revalidates the source and writes a NodeRevision per moved node.
            await moveNodeSubtree(tx, {
              source: existing,
              destLoc: toLoc,
              destMemoryId: crossMemory ? toMemory.id : undefined,
              editor: editorFromAuth(auth),
              renameSourceLeaf: true,
            });
          }

          // Move BY ID — id is stable across moves, so this refetch can't race a
          // concurrent move into the same slot.
          const moved = await tx.node.findUniqueOrThrow({
            where: { id: existing.id },
            include: {
              outgoingEdges: {
                where: { target: { deletedAt: null } },
                select: { id: true },
              },
              incomingEdges: {
                where: { source: { deletedAt: null } },
                select: { id: true },
              },
            },
          });

          // Immediate children now living under the destination loc (the moved
          // descendants plus any that were pre-staged there).
          const childCount = await tx.node.count({
            where: {
              memoryId: toMemory.id,
              loc: { startsWith: toLoc + ':' },
              deletedAt: null,
            },
          });

          return { ok: true, moved, childCount };
        },
        // A large same-memory subtree touches many rows (two updates + a revision
        // per node); the default 5s interactive-txn timeout is too tight — match
        // the GraphQL moveNode path so inputs that succeed there don't time out
        // here (mirrors extractParentNodeGraph / cloneMemory).
        { timeout: 120_000 });
      } catch (e) {
        // A descendant-slot collision (or a move-into-own-subtree) aborts the
        // whole transaction — including any overwrite eviction — and surfaces as
        // a refusal, not a partial move.
        if (e instanceof SubtreeMoveCollisionError) {
          return textResult(
            `URN_ALREADY_EXISTS: A node already occupies loc "${e.loc}" in the destination memory ` +
              `(a descendant slot of this move). Free it first, then retry.`,
          );
        }
        if (e instanceof SubtreeMoveIntoSelfError) {
          return textResult('Cannot move a node into its own subtree.');
        }
        if (e instanceof SubtreeMoveSourceChangedError) {
          return textResult('The node was moved concurrently; re-read it and retry.');
        }
        if (
          e instanceof CrossMemoryMoveUnsupportedError ||
          e instanceof SubtreeMoveSchemaViolationError
        ) {
          return textResult(e.message);
        }
        throw e;
      }

      const fromUrn = await nodeUrn(fromLoc, fromMemory.id);
      const toUrn = await nodeUrn(toLoc, toMemory.id);

      if ('refused' in result) {
        return textResult(
          `URN_ALREADY_EXISTS: A live node already occupies "${result.targetUrn}". ` +
            `Pass overwrite: true to soft-delete it first and move into its place, ` +
            `or use hadron_delete_node (hard: true) to compact it before retrying.`,
        );
      }

      const { moved, childCount } = result;

      // Empty sections omitted, matching hadron_get_node's pattern (PR-189
      // review feedback).
      const lines: string[] = [
        `Moved "${fromUrn}" → "${toUrn}".`,
        ``,
        `**${moved.name}**`,
        toUrn,
      ];
      if (moved.description) lines.push(`> ${moved.description}`);
      lines.push(`Type: ${moved.nodeType}`);
      if (moved.tags.length) lines.push(`Tags: ${moved.tags.join(', ')}`);
      const outgoing = moved.outgoingEdges.length;
      const incoming = moved.incomingEdges.length;
      if (outgoing + incoming > 0) {
        lines.push(`Edges: ${outgoing} outgoing, ${incoming} incoming.`);
      }
      if (childCount > 0) {
        lines.push(`Children: ${childCount} immediate descendant(s).`);
      }

      return textResult(lines.join('\n'));
    },
  );

  // ── hadron_run_action ─────────────────────────────────────────────────────────

  server.tool(
    'hadron_run_action',
    'Load an action node and resolve its dependencies. Returns the action instructions with all referenced node content. The URN MUST be fully qualified (org::memory::loc).',
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com::mmdata::actions:review"'),
      args: z.record(z.string(), z.string()).optional().describe('Action arguments as key-value pairs'),
    },
    async ({ urn: rawUrn, args }) => {
      // Spec 022 qualification + loading + rendering are shared with hadron_run_task
      // (cor:api:060) via loadNodeForRun / renderRunNode below.
      const loaded = await loadNodeForRun(rawUrn);
      if ('error' in loaded) return textResult(loaded.error);
      return textResult(await renderRunNode(loaded.node, loaded.loc, args));
    },
  );

  // ── Shared run core (hadron_run_action + hadron_run_task, spec cor:api:060) ──────────
  //
  // Loading a node for execution and rendering its run-bundle are factored out
  // so the direct-URN runner (hadron_run_action, above) and the by-name runner
  // (hadron_run_task, below) produce a byte-identical bundle and record the same
  // action-run usage event. These are hoisted function declarations, so the
  // thinned hadron_run_action handler above resolves them at call time.

  type RunNode = Prisma.NodeGetPayload<{
    include: { outgoingEdges: { include: { target: true } } };
  }>;

  // Qualify (spec 022) + read-gate the URN, then fetch the node with its
  // dependency edges. Returns the node or a user-facing error string.
  async function loadNodeForRun(
    rawUrn: string,
  ): Promise<{ node: RunNode; loc: string } | { error: string }> {
    try {
      assertFullyQualifiedUrn(rawUrn, 'node');
    } catch (e) {
      if (e instanceof UrnNotQualifiedError) return { error: e.message };
      throw e;
    }
    const { memoryUrn, loc } = splitNodeUrn(rawUrn);
    const memory = await resolveMemoryByUrn(memoryUrn);
    if (!memory || !(await canReadMemory(db, auth, memory.id))) {
      return { error: `Memory not found: "${memoryUrn}".` };
    }
    const node = await db.node.findUnique({
      where: { loc_memoryId: { loc, memoryId: memory.id } },
      include: { outgoingEdges: { include: { target: true } } },
    });
    if (!node) return { error: `Node "${rawUrn}" not found.` };
    return { node, loc };
  }

  // {{arg}} substitution + inlined edge-linked node content + one action-run
  // usage event. Returns the rendered markdown bundle.
  async function renderRunNode(
    node: RunNode,
    loc: string,
    args?: Record<string, string>,
  ): Promise<string> {
    let actionContent = node.content || '';
    if (args) {
      for (const [key, value] of Object.entries(args)) {
        actionContent = actionContent.replaceAll(`{{${key}}}`, value);
      }
    }
    const topicSections: string[] = [];
    for (const edge of node.outgoingEdges) {
      const target = edge.target;
      if (target.content) {
        const targetUrn = await nodeUrn(target.loc, target.memoryId);
        topicSections.push(`## Node: ${target.name} (${targetUrn})\n\n${target.content}`);
      }
    }
    db.usageEvent
      .create({
        data: {
          id: generateId(),
          type: 'action-run',
          nodeLoc: loc,
          nodeId: node.id,
          memoryId: node.memoryId, // #796 (as in hadron_get_node's event)
          appId: auth.appId ?? null,
          // 046-usage-metering FR-001 (as in hadron_get_node's event).
          userId: auth.userId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
          actionArgs: (args ?? undefined) as Record<string, string> | undefined,
        },
      })
      .catch(() => {});
    const parts = [`# Node: ${node.name}\n\n${actionContent}`];
    if (topicSections.length > 0) {
      parts.push('---\n\n# Referenced Nodes\n\n' + topicSections.join('\n\n---\n\n'));
    }
    return parts.join('\n\n');
  }

  // ── hadron_run_task name resolution (spec cor:api:060) ─────────────────────────

  type RunTaskMem = { id: string; urn: string; name: string };
  type RunTaskNode = {
    id: string;
    loc: string;
    name: string;
    alias: string | null;
    description: string | null;
  };
  type ToolText = ReturnType<typeof textResult>;
  // cor:api:060:03 tunable — max candidates to offer before asking to narrow.
  const RUN_TASK_PICK_CAP = 25;

  // Rank runnable candidates against a loose hint: case-insensitive, matching
  // name/alias/loc/description, exact > prefix > substring. Pure (cor:api:060:02
  // — substring today; a semantic name index can swap in here later).
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
      else if (name.startsWith(h) || alias.startsWith(h) || loc === h || loc.endsWith(`:${h}`))
        score = 80;
      else if (name.includes(h) || alias.includes(h) || loc.includes(h)) score = 60;
      else if (desc.includes(h)) score = 40;
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    return scored.map((s) => s.item);
  }

  function clientSupportsElicitation(): boolean {
    try {
      return !!server.server.getClientCapabilities()?.elicitation;
    } catch {
      return false;
    }
  }

  // Ask the client to pick one option. Returns the chosen value, or null on
  // decline/cancel. Throws if the transport can't service the request — callers
  // fall back to the list relay (cor:api:060:03).
  async function elicitSelect(
    options: Array<{ const: string; title: string }>,
    message: string,
  ): Promise<string | null> {
    const result = await server.server.elicitInput({
      mode: 'form',
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          selection: { type: 'string', title: 'Selection', oneOf: options },
        },
        required: ['selection'],
      },
    });
    if (result.action === 'accept' && typeof result.content?.selection === 'string') {
      return result.content.selection;
    }
    return null;
  }

  // The caller's readable memory set for task discovery: the App/org access map
  // PLUS the caller's own personal/private memories (which the access map
  // excludes — their owner-only gate lives in canReadMemory), so free-standing
  // personal memories stay reachable by hint (cor:api:060:02).
  async function listRunnableMemories(): Promise<RunTaskMem[]> {
    const byId = new Map<string, RunTaskMem>();
    const ids = await getAccessibleMemoryIds(db, auth);
    if (ids === null) {
      // ADMIN/OWNER "see all" — minus other users' personal/private memories
      // AND (spec 047) other users' user-owned memories (strictly owner-only).
      // Filter in the DB (not in-memory) so it leverages the userId/ownerUserId
      // indexes and mirrors the globalSearch admin carve-out (gemini review,
      // #676). The NOT/OR keeps the caller's OWN strict-owner rows in view.
      const all = await db.memory.findMany({
        where: {
          deletedAt: null,
          NOT: {
            OR: [
              { class: { in: ['personal', 'private'] as any }, userId: { not: auth.userId ?? '__none__' } },
              { AND: [{ ownerUserId: { not: null } }, { ownerUserId: { not: auth.userId ?? '__none__' } }] },
            ],
          },
        },
        select: { id: true, urn: true, name: true },
      });
      for (const m of all) byId.set(m.id, { id: m.id, urn: m.urn, name: m.name });
    } else if (ids.length > 0) {
      const mems = await db.memory.findMany({
        where: { id: { in: ids }, deletedAt: null },
        select: { id: true, urn: true, name: true },
      });
      for (const m of mems) byId.set(m.id, m);
    }
    if (auth.userId) {
      const own = await db.memory.findMany({
        where: {
          userId: auth.userId,
          class: { in: ['personal', 'private'] },
          deletedAt: null,
        },
        select: { id: true, urn: true, name: true },
      });
      for (const m of own) byId.set(m.id, m);
    }
    return [...byId.values()];
  }

  function loadRunnableNodes(memoryId: string): Promise<RunTaskNode[]> {
    return db.node.findMany({
      where: { memoryId, isRunnable: true, deletedAt: null },
      select: { id: true, loc: true, name: true, alias: true, description: true },
      orderBy: [{ seq: 'asc' }, { loc: 'asc' }],
    });
  }

  // Build a canonical node URN from a memory's stored URN + a node loc, so
  // loadNodeForRun → splitNodeUrn (and, in execute mode, resolveNodeRef)
  // recovers the same memory. Delegates to the shared emitNodeUrnV2 (#697
  // emission flip), which composes the flat grammar-v2 node URN from the
  // stored bare urn — accepting BOTH legacy `org:memory` (single colon) and
  // migrated `org::memory` shapes. This is the same composer the GraphQL
  // runTask path uses.
  function nodeUrnFromMem(memUrn: string, loc: string): string {
    return emitNodeUrnV2(memUrn, loc);
  }

  function runTaskCandidate(mem: RunTaskMem, node: RunTaskNode) {
    return {
      urn: nodeUrnFromMem(mem.urn, node.loc),
      label: node.name,
      description: node.description,
    };
  }

  // Present candidates and run the chosen one: an interactive single-select
  // where the client supports elicitation, otherwise a numbered list the agent
  // relays for re-invocation by `urn` (cor:api:060:03).
  async function presentAndRun(
    candidates: Array<{ urn: string; label: string; description: string | null }>,
    header: string,
    run: (nodeUrn: string) => Promise<ToolText>,
  ): Promise<ToolText> {
    if (candidates.length > RUN_TASK_PICK_CAP) {
      return textResult(
        `${header}\n\n${candidates.length} matches — too many to list. Narrow it with a more specific \`task\` or \`memory\` hint.`,
      );
    }
    if (clientSupportsElicitation()) {
      try {
        const choice = await elicitSelect(
          candidates.map((c) => ({ const: c.urn, title: c.label })),
          header,
        );
        if (choice === null) return textResult('No task selected — nothing run.');
        return run(choice);
      } catch {
        // Transport can't service the picker — fall back to the list relay.
      }
    }
    const lines = candidates.map(
      (c, i) => `${i + 1}. ${c.label}${c.description ? ` — ${c.description}` : ''}\n   urn: ${c.urn}`,
    );
    return textResult(
      `${header}\n\n${lines.join('\n')}\n\nRe-run hadron_run_task with \`urn\` set to your choice.`,
    );
  }

  // Resolve the target memory from a loose hint, the active memory, or a pick.
  async function resolveRunTaskMemory(
    hint: string,
  ): Promise<{ memory: RunTaskMem } | { done: ToolText }> {
    const mems = await listRunnableMemories();
    if (mems.length === 0) {
      return {
        done: textResult('No memories you can read. Use hadron_list_memories to see what is available.'),
      };
    }
    const asRankable = (m: RunTaskMem) => ({ ...m, alias: null, loc: m.urn, description: null });

    if (hint) {
      const matches = rankByHint(mems.map(asRankable), hint);
      if (matches.length === 1) return { memory: matches[0] };
      if (matches.length === 0) {
        return {
          done: textResult(
            `No memory matching "${hint}". Use hadron_list_memories to see what is available.`,
          ),
        };
      }
      if (clientSupportsElicitation()) {
        try {
          const choice = await elicitSelect(
            matches.map((m) => ({ const: m.urn, title: m.name })),
            `Multiple memories match "${hint}" — pick the one with your task:`,
          );
          if (choice === null) return { done: textResult('No memory selected — nothing run.') };
          const chosen = matches.find((m) => m.urn === choice);
          if (chosen) return { memory: chosen };
        } catch {
          // fall through to the list relay
        }
      }
      const lines = matches.map((m, i) => `${i + 1}. ${m.name}\n   memory: ${m.urn}`);
      return {
        done: textResult(
          `Multiple memories match "${hint}":\n\n${lines.join('\n')}\n\nRe-run hadron_run_task with \`memory\` set to one of these.`,
        ),
      };
    }

    // No memory hint — default to the session's active memory (cor:api:060:02).
    if (activeMemoryUrn) {
      const active = mems.find((m) => m.urn === activeMemoryUrn);
      if (active) return { memory: active };
    }
    if (mems.length === 1) return { memory: mems[0] };
    if (clientSupportsElicitation() && mems.length <= RUN_TASK_PICK_CAP) {
      try {
        const choice = await elicitSelect(
          mems.map((m) => ({ const: m.urn, title: m.name })),
          'Which memory holds the task you want to run?',
        );
        if (choice === null) return { done: textResult('No memory selected — nothing run.') };
        const chosen = mems.find((m) => m.urn === choice);
        if (chosen) return { memory: chosen };
      } catch {
        // fall through
      }
    }
    const names = mems.slice(0, RUN_TASK_PICK_CAP).map((m) => m.name).join(', ');
    return {
      done: textResult(
        `Pass a \`memory\` hint (or set an active memory with hadron_set_active_memory). You can reach: ${names}.`,
      ),
    };
  }

  // Find runnable nodes matching `hint` across the caller's OTHER readable
  // memories — the conservative widening of cor:api:060:02 (never auto-runs;
  // surfaces matches for an explicit pick).
  async function searchRunnableAcross(
    hint: string,
    excludeMemoryId: string,
  ): Promise<Array<{ mem: RunTaskMem; node: RunTaskNode }>> {
    const mems = (await listRunnableMemories()).filter((m) => m.id !== excludeMemoryId);
    const memById = new Map(mems.map((m) => [m.id, m]));
    if (memById.size === 0) return [];
    const nodes = await db.node.findMany({
      where: { memoryId: { in: [...memById.keys()] }, isRunnable: true, deletedAt: null },
      select: { id: true, loc: true, name: true, alias: true, description: true, memoryId: true },
    });
    return rankByHint(nodes, hint).map((n) => ({ mem: memById.get(n.memoryId)!, node: n }));
  }

  // ── hadron_run_task ─────────────────────────────────────────────────────────────

  server.tool(
    'hadron_run_task',
    "Run a task — a runnable node (isRunnable=true) — by loose name, without a fully-qualified URN. Give `task` (and optionally `memory`); the server resolves both against what you can read and runs the match. When a name is ambiguous or omitted you get a list to choose from (an interactive picker where the client supports it, otherwise a numbered list to re-invoke with `urn`). Pass a fully-qualified `urn` to skip resolution and run directly. By DEFAULT this RENDERS the task — returns the assembled instructions ({{arg}} substitution + inlined dependencies) for YOU to execute. Pass `appRef` to EXECUTE server-side instead (#529): the server mints a MANUAL app run and returns the run id to poll. Spec cor:api:060.",
    {
      task: z
        .string()
        .optional()
        .describe(
          'Loose name of the task to run (matched against runnable nodes by name/alias/loc/description).',
        ),
      memory: z
        .string()
        .optional()
        .describe('Loose memory name or URN to scope the search. Omit to use the active memory.'),
      urn: z
        .string()
        .optional()
        .describe('Fully-qualified node URN to run directly, skipping name resolution.'),
      args: z
        .record(z.string(), z.string())
        .optional()
        .describe('Task arguments as key-value pairs ({{key}} substitution).'),
      appRef: z
        .string()
        .optional()
        .describe(
          'App (PK or URN) to EXECUTE the task under (#529). When set, the server mints a MANUAL app run for the resolved task and returns the run id (poll the app-run status surface) instead of the rendered prompt. Omit to get the rendered instructions for you to run yourself.',
        ),
      runAsSelf: z
        .boolean()
        .optional()
        .describe('Attribute the executed run to the calling user (only with appRef).'),
    },
    async (rawArgs) => {
      // createTestableMcpServer bypasses zod — normalize args defensively.
      const a = (rawArgs ?? {}) as {
        task?: unknown;
        memory?: unknown;
        urn?: unknown;
        args?: unknown;
        appRef?: unknown;
        runAsSelf?: unknown;
      };
      const taskHint = typeof a.task === 'string' ? a.task.trim() : '';
      const memoryHint = typeof a.memory === 'string' ? a.memory.trim() : '';
      const directUrn = typeof a.urn === 'string' ? a.urn.trim() : '';
      const args =
        a.args && typeof a.args === 'object' && !Array.isArray(a.args)
          ? (a.args as Record<string, string>)
          : undefined;
      const appRef = typeof a.appRef === 'string' && a.appRef.trim() ? a.appRef.trim() : undefined;
      const runAsSelf = a.runAsSelf === true;

      // Single run chokepoint: MCP resolves the task to a concrete node URN via
      // its own fuzzy-match + interactive picker (below), then this runs it.
      // #542 — in EXECUTE mode (appRef set) delegate to the GraphQL runTask
      // resolver with the resolved `nodeRef`, which mints a MANUAL app run via
      // the spec-040 kernel and returns the run id (#529). Without appRef,
      // RENDER the assembled prompt like hadron_run_action. Both modes now share
      // MCP's resolution UX — execute mode gets the picker too.
      const runOrRender = async (nodeUrn: string): Promise<ToolText> => {
        if (!auth.clientId && !auth.appId && !auth.userId) return textResult('Not authenticated.');
        if (appRef) {
          const ctx: Context = {
            db,
            clientId: auth.clientId ?? undefined,
            userId: auth.userId ?? undefined,
            appId: auth.appId ?? undefined,
            sessionId: auth.sessionId ?? undefined,
            roles: auth.roles as Context['roles'],
            organizationId: auth.organizationId ?? undefined,
          };
          try {
            const runId = await resolvers.Mutation.runTask(
              {},
              { nodeRef: nodeUrn, args, appRef, runAsSelf },
              ctx,
            );
            return textResult(
              `Run started: ${runId}\nPoll its status/output via the app-run surface (appRun(ref: "${runId}")).`,
            );
          } catch (err) {
            return textResult(`Could not start run: ${(err as Error).message}`);
          }
        }
        const loaded = await loadNodeForRun(nodeUrn);
        if ('error' in loaded) return textResult(loaded.error);
        return textResult(await renderRunNode(loaded.node, loaded.loc, args));
      };

      // URN bypass — run directly, exactly like hadron_run_action (cor:api:060:02).
      if (directUrn) {
        return runOrRender(directUrn);
      }

      if (!auth.clientId && !auth.appId && !auth.userId) return textResult('Not authenticated.');

      const mem = await resolveRunTaskMemory(memoryHint);
      if ('done' in mem) return mem.done;
      const memory = mem.memory;

      const runnable = await loadRunnableNodes(memory.id);

      if (taskHint) {
        const matches = rankByHint(runnable, taskHint);
        if (matches.length === 1) {
          return runOrRender(nodeUrnFromMem(memory.urn, matches[0].loc));
        }
        if (matches.length > 1) {
          return presentAndRun(
            matches.map((n) => runTaskCandidate(memory, n)),
            `Multiple tasks match "${taskHint}" in ${memory.name} — pick one:`,
            runOrRender,
          );
        }
        // Miss in the resolved memory — widen, but never auto-run elsewhere.
        const wide = await searchRunnableAcross(taskHint, memory.id);
        if (wide.length === 0) {
          return textResult(`No runnable task matching "${taskHint}" in ${memory.name}.`);
        }
        return presentAndRun(
          wide.map((w) => runTaskCandidate(w.mem, w.node)),
          `No match in ${memory.name}, but "${taskHint}" matches runnable tasks in other memories — pick one:`,
          runOrRender,
        );
      }

      // No task hint — offer the memory's runnable tasks.
      if (runnable.length === 0) return textResult(`No runnable tasks in ${memory.name}.`);
      if (runnable.length === 1) {
        return runOrRender(nodeUrnFromMem(memory.urn, runnable[0].loc));
      }
      return presentAndRun(
        runnable.map((n) => runTaskCandidate(memory, n)),
        `Tasks in ${memory.name} — pick one to run:`,
        runOrRender,
      );
    },
  );

  // ── hadron_start_session ──────────────────────────────────────────────────────

  server.tool(
    'hadron_start_session',
    'Start a new work session. All subsequent tool calls can reference this session ID for attribution.',
    {
      description: z.string().describe("What this session is about"),
      type: z.string().optional().describe('Session type: DEVELOPER, CHATBOT, AUTOMATION, EDGE'),
      repo: z.string().optional().describe('Repository being worked on (e.g. org/repo)'),
      branch: z.string().optional().describe('Git branch'),
      prNumber: z.number().optional().describe('Pull request number'),
      customerId: z.string().optional().describe('Customer ID for chatbot sessions'),
      language: z.string().optional().describe('Programming language'),
      llmModel: z.string().optional().describe('LLM model being used'),
      parentSessionId: z.string().optional().describe('Parent session ID'),
      prevSessionId: z.string().optional().describe('Previous session ID'),
    },
    async ({ description, type, repo, branch, prNumber, customerId, language, llmModel, parentSessionId, prevSessionId }) => {
      // Spec 026 / D-2026-05-21-003 strict tool: session-start needs App
      // context to attribute the session. Errors with typed [no_active_app]
      // envelope for multi-App OAuth callers without selection.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;

      const sessionId = generateId();

      const session = await db.session.create({
        data: {
          id: sessionId,
          type: (type || 'DEVELOPER') as SessionType,
          plan: description,
          appId: auth.appId ?? null,
          createdBy: auth.clientId ?? null,
          repo: repo ?? null,
          branch: branch ?? null,
          prNumber: prNumber ?? null,
          customerId: customerId ?? null,
          language: language ?? null,
          llmModel: llmModel ?? null,
          parentSessionId: parentSessionId ?? null,
          prevSessionId: prevSessionId ?? null,
        },
      });

      return textResult(
        `Session started: ${session.id}\n> ${description}`,
      );
    },
  );

  // ── hadron_end_session ────────────────────────────────────────────────────────

  server.tool(
    'hadron_end_session',
    'End a session. Records summary and final metrics.',
    {
      id: z.string().describe('Session ID to end'),
      summary: z.string().optional().describe('Summary of what was accomplished'),
      inputTokens: z.number().optional().describe('Total input tokens used'),
      outputTokens: z.number().optional().describe('Total output tokens used'),
      turnCount: z.number().optional().describe('Number of conversation turns'),
      errorCount: z.number().optional().describe('Number of errors encountered'),
    },
    async ({ id, summary, inputTokens, outputTokens, turnCount, errorCount }) => {
      // Spec 026 / D-2026-05-21-003 strict tool: paired with hadron_start_session.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;

      const session = await db.session.findUnique({ where: { id } });
      if (!session) return textResult(`Session "${id}" not found.`);

      await db.session.update({
        where: { id },
        data: {
          endedAt: new Date(),
          summary: summary ?? null,
          inputTokens: inputTokens ?? null,
          outputTokens: outputTokens ?? null,
          turnCount: turnCount ?? null,
          errorCount: errorCount ?? null,
        },
      });

      return textResult(`Session ended: ${id}`);
    },
  );

  // ── hadron_validate ───────────────────────────────────────────────────────────

  server.tool(
    'hadron_validate',
    'Check a memory for broken edge references, sparse nodes, stale-abstract warnings (spec 032 FR-011 — abstract no longer reflects current content), embedding-failure flags (spec 033 — nodes with `embedding_failed_at` set; covers BOTH in-flight transient failures awaiting retry AND terminal failures, including the #206 encrypted-no-plaintext perma-fail class), and property-schema conformance (#725 — a node whose objectType/properties violate the memory\'s declared schema; catches records written before the schema was defined/tightened, a non-destructive audit). The memory URN MUST be fully qualified. On encrypted memories the stale-abstract check is skipped in v1 (hadron_validate does not decrypt; tracked by #206).',
    {
      memoryUrn: z.string().describe('Fully-qualified memory URN, e.g. "acme.com:mmdata"'),
    },
    async ({ memoryUrn }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(memoryUrn, 'memory');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const memory = await resolveMemoryByUrn(memoryUrn);
      if (!memory) {
        return textResult(`Memory not found: "${memoryUrn}".`);
      }
      if (!(await canReadMemory(db, auth, memory.id))) {
        return textResult('Access denied for this memory.');
      }

      // Spec 032 FR-011 — encryption gate for the stale-abstract check.
      // hadron_validate does NOT call decryptNodesBatch, so on encrypted
      // memories `node.content` is ciphertext and
      // `computeContentHash(ciphertext)` would compare unequal to every
      // plaintext-derived abstractOriginHash (false-positive on every
      // node). v1 skips the check; the #206 encryption-parity follow-up
      // adds a decrypt step before this loop. Symmetric with the
      // hadron_get_node gate (US2). Riding the existing nodes findMany
      // (memory column auto-projected via separate findUnique) keeps
      // the wider blast radius of changing resolveMemoryByUrn contained.
      const memEnc = await db.memory.findUnique({
        where: { id: memory.id },
        select: { isEncrypted: true, schema: true },
      });
      const checkStale = !memEnc?.isEncrypted;
      // #725 — property-schema conformance audit. Unlike write enforcement (which
      // only governs new writes), this catches nodes that reached a
      // non-conforming state some other way: written before the schema was
      // defined/tightened, or via a path outside the write seam. Non-destructive.
      const conformanceSchema = memEnc?.schema as unknown as MemorySchema | null;

      const nodes = await db.node.findMany({
        where: { memoryId: memory.id },
        include: { outgoingEdges: true },
      });
      const nodeIds = new Set(nodes.map((n) => n.id));
      const issues: string[] = [];

      for (const node of nodes) {
        const nUrn = await nodeUrn(node.loc, node.memoryId);
        for (const edge of node.outgoingEdges) {
          if (!nodeIds.has(edge.targetId)) {
            issues.push(`[broken-ref] ${nUrn} → id:${edge.targetId} (${edge.name ?? edge.loc})`);
          }
        }
        // Spec 031 FR-011 — abstract counts as legitimate content for the
        // validator's "this node has zero text" intent. A node carrying
        // only an abstract (e.g., a nodeType='abstract' archive whose
        // source is gone) is NOT sparse.
        if (!node.description && !node.content && !node.abstract) {
          issues.push(`[sparse] ${nUrn} — no description, content, or abstract`);
        }
        // Spec 032 FR-011 — stale-abstract warning. Mirrors the
        // hadron_get_node predicate (US2). The explicit `abstractOriginHash
        // != null` guard short-circuits legacy pre-spec-032 rows so the
        // validator stays quiet by design on data that pre-dates the
        // signal (PR-207 review item 5).
        if (
          checkStale &&
          node.abstract != null && node.abstract.length > 0 &&
          node.content != null && node.content.length > 0 &&
          node.abstractOriginHash != null &&
          node.abstractOriginHash !== computeContentHash(node.content)
        ) {
          issues.push(`[stale-abstract] ${nUrn} — abstract may not reflect current content`);
        }
        // Spec 033 T058 — surface embedding-failure diagnosability.
        // `embedding_failed_at` is stamped on EVERY failed attempt:
        //   - transient failures awaiting retry → both pendingAt AND
        //     failedAt are set (markTransientFailure)
        //   - transient failures that hit the attempts cap → pendingAt
        //     cleared, failedAt stays (giveUp branch)
        //   - permanent encrypted-no-plaintext (#206) → same shape as
        //     the cap (markPermanentFailure)
        // hadron_validate surfaces ALL of these because each is operator-
        // useful: in-flight retries say "this node has failed at least
        // once but the sweep will retry"; terminal failures say "this
        // node will never embed without intervention." PR-226 review
        // (Copilot) corrected an earlier comment that described only
        // the terminal cases.
        //
        // Why this matters: an empty vector index from outside
        // hadron_validate looks identical to "no hits matched". Surfacing
        // the failure flag here gives operators (and the agents who
        // proactively run hadron_validate before debugging an empty index)
        // a single-tool diagnostic surface. Default Prisma findMany
        // without a select includes every scalar column, so
        // embeddingFailedAt + embeddingError are already on `node`
        // without a select change.
        if (node.embeddingFailedAt) {
          // PR-226 review (Gemini): `??` only catches null/undefined, so an
          // empty or whitespace-only error message would render as a blank
          // reason. `?.trim() || 'unknown'` handles all three cases.
          const reason = node.embeddingError?.trim() || 'unknown';
          issues.push(`[embed-failed] ${nUrn} — ${reason}`);
        }
        // #725 — schema conformance: a collection member must satisfy its
        // memory's declared schema. Reports (never mutates) — this is the audit
        // backstop for pre-existing / non-write-seam non-conformance.
        //
        // normalizeObjectType so the audit matches write-seam semantics: a
        // legacy blank/whitespace objectType is "no collection" (an ordinary
        // node), not an undeclared collection — validating it raw would emit a
        // false [schema] violation. Skip soft-deleted tombstones; a
        // non-conforming row that's already deleted isn't actionable (the other
        // checks retain their historical include-tombstones scope on purpose).
        const auditObjectType = normalizeObjectType(node.objectType);
        if (conformanceSchema != null && auditObjectType != null && node.deletedAt == null) {
          try {
            validateNodeAgainstSchema(
              conformanceSchema,
              auditObjectType,
              (node.properties ?? null) as Record<string, unknown> | null,
            );
          } catch (e) {
            if (e instanceof NodeSchemaViolation) issues.push(`[schema] ${nUrn} — ${e.message}`);
            else throw e;
          }
        }
      }

      if (issues.length === 0) {
        return textResult(`Validated ${nodes.length} nodes. No issues found.`);
      }
      return textResult(
        `Found ${issues.length} issue(s) in ${nodes.length} nodes:\n\n${issues.join('\n')}`,
      );
    },
  );

  // ── hadron_sync_graph ─────────────────────────────────────────────────────────

  server.tool(
    'hadron_sync_graph',
    'Trigger an on-demand sync for a memory from its GitHub source. The memory URN MUST be fully qualified.',
    {
      memoryUrn: z.string().describe('Fully-qualified memory URN, e.g. "acme.com:mmdata"'),
    },
    async ({ memoryUrn }) => {
      // Spec 022: qualification at the API boundary.
      try {
        assertFullyQualifiedUrn(memoryUrn, 'memory');
      } catch (e) {
        if (e instanceof UrnNotQualifiedError) return textResult(e.message);
        throw e;
      }

      const memoryRef = await resolveMemoryByUrn(memoryUrn);
      if (!memoryRef) return textResult(`Memory not found: "${memoryUrn}".`);
      if (!(await canWriteToMemory(db, auth, memoryRef.id))) {
        return textResult('Access denied.');
      }

      const memory = await db.memory.findUnique({
        where: { id: memoryRef.id },
        include: { organization: true },
      });
      if (!memory) return textResult('Memory not found.');
      if (!memory.source) return textResult('Memory has no source repository configured.');

      // Import and call syncGraphFromGithub
      const { syncGraphFromGithub } = await import('../integrations/github/syncGraphFromGithub.js');
      const result = await syncGraphFromGithub(memory as Parameters<typeof syncGraphFromGithub>[0]);

      if (result.error) return textResult(`Sync failed: ${result.error}`);
      return textResult(`Synced ${result.nodeCount ?? 0} nodes.`);
    },
  );

  // ── Chat tools ───────────────────────────────────────────────────────────
  // These call the GraphQL mutation resolvers directly with a constructed
  // Context. The MCP App-key auth maps to ctx.appId; the userId param
  // identifies the persona being tested.

  function gqlCtx(userIdOverride?: string): Context {
    return {
      db,
      clientId: auth.clientId ?? undefined,
      userId: userIdOverride ?? auth.userId ?? undefined,
      roles: auth.roles as Context['roles'],
      organizationId: auth.organizationId ?? undefined,
    };
  }

  // ── hadron_chatbot_start ─────────────────────────────────────────────────────

  server.tool(
    'hadron_chatbot_start',
    'Start a new chat session with an agent. Returns the chat ID, compiled system prompt, tool schema, conversation name, and first stage. The LLM should use the system prompt and tools to generate a welcome message, then call hadron_chatbot_process with the result.',
    {
      agentId: z.string().describe('ID of the agent to chat with'),
      userId: z.string().optional().describe('User/persona identifier (e.g. "alex-chen"). Used to scope the per-user memory. If omitted, uses the authenticated user.'),
      conversationName: z.string().optional().describe('Specific conversation to start (e.g. "onboarding"). If omitted, picks the first non-setup conversation.'),
    },
    async ({ agentId, userId, conversationName }) => {
      // Spec 026 / D-2026-05-21-003 strict tool: chat tools need
      // an active App for persona/agent context.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        const ctx = gqlCtx(userId);
        const result = await resolvers.Mutation.startChat(
          null,
          { agentId, userId, conversationName },
          ctx,
        );
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'startChat failed'}`);
      }
    },
  );

  // ── hadron_chatbot_send ──────────────────────────────────────────────────────

  server.tool(
    'hadron_chatbot_send',
    "Send a user message in an existing chat. Returns the recompiled system prompt for the current stage, tool schema, message history, and whether summarization is needed. Use the returned prompt + tools to generate the assistant's response, then call hadron_chatbot_process.",
    {
      chatId: z.string().describe('Chat ID returned by hadron_chatbot_start (e.g. "chats:20260417-abc12345-onboarding")'),
      userMessage: z.string().describe("The user's message text"),
    },
    async ({ chatId, userMessage }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        const ctx = gqlCtx();
        const result = await resolvers.Mutation.sendChatMessage(
          null,
          { chatId, userMessage },
          ctx,
        );
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'sendChatMessage failed'}`);
      }
    },
  );

  // ── hadron_chatbot_process ───────────────────────────────────────────────────

  server.tool(
    'hadron_chatbot_process',
    "Process the LLM's structured response for a chat turn. The toolResponse must match the respond() tool schema: { message, data, next_stage }. Hadron saves the assistant message, extracts data into user memory, and handles stage transitions. Returns the display message, whether a stage transition occurred, and the new stage name.",
    {
      chatId: z.string().describe('Chat ID'),
      message: z.string().describe("The assistant's response message to display to the user"),
      data: z.record(z.string(), z.unknown()).optional().describe('Extracted data fields matching the stage extractionSpec (e.g. { "memory.name": "Alex Chen" })'),
      next_stage: z.string().nullable().optional().describe('Stage to transition to (null or omitted to stay in current stage)'),
    },
    async ({ chatId, message, data, next_stage }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        const ctx = gqlCtx();
        const toolResponse = {
          message,
          ...(data !== undefined ? { data } : {}),
          ...(next_stage !== undefined ? { next_stage } : {}),
        };
        const result = await resolvers.Mutation.processChatResponse(
          null,
          { chatId, toolResponse },
          ctx,
        );
        return textResult(JSON.stringify(result, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'processChatResponse failed'}`);
      }
    },
  );

  // ── hadron_chatbot_get_routing_map ───────────────────────────────────────────

  server.tool(
    'hadron_chatbot_get_routing_map',
    "Download the full routing map for an agent: topics, conversations (with goals/signals), stages, and edges. Use this to understand the chatbot's conversation structure before routing.",
    {
      agentId: z.string().describe('ID of the agent'),
    },
    async ({ agentId }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        const agent = await db.agent.findUnique({ where: { id: agentId } });
        if (!agent) return textResult('Agent not found.');
        const sysMemId = (agent as any).systemMemoryId as string | null;
        if (!sysMemId) return textResult('Agent has no system memory.');

        // Load all conversation-related nodes from the system memory
        const nodes = await db.node.findMany({
          where: { memoryId: sysMemId, deletedAt: null },
          select: { id: true, loc: true, name: true, description: true, data: true, nodeType: true },
          orderBy: { loc: 'asc' },
        });

        const topics = nodes
          .filter((n) => n.loc.startsWith('topics:') && n.loc.split(':').length === 2)
          .map((n) => ({ loc: n.loc, name: n.name, data: n.data }));

        const conversations = nodes
          .filter((n) => n.loc.startsWith('conversations:') && n.loc.split(':').length === 2)
          .map((n) => ({ loc: n.loc, name: n.name, description: n.description, data: n.data }));

        const stages = nodes
          .filter((n) => n.loc.startsWith('conversations:') && n.loc.split(':').length === 3)
          .map((n) => ({ loc: n.loc, name: n.name, description: n.description, data: n.data }));

        // Load edges between these nodes
        const nodeIds = nodes.map((n) => n.id);
        const edges = await db.edge.findMany({
          where: { sourceId: { in: nodeIds }, deletedAt: null },
          include: { source: { select: { loc: true } }, target: { select: { loc: true } } },
        });

        const edgeList = edges.map((e) => ({
          id: e.id,
          sourceLoc: e.source.loc,
          targetLoc: e.target.loc,
          loc: e.loc,
          name: e.name,
          data: e.data,
        }));

        // Include training entries if they exist
        const trainingNode = nodes.find((n) => n.loc === 'goals:training');
        const trainingEntries = trainingNode
          ? ((trainingNode.data as Record<string, unknown>)?.entries as unknown[]) ?? []
          : [];

        return textResult(JSON.stringify({ topics, conversations, stages, edges: edgeList, trainingEntries }, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to get routing map'}`);
      }
    },
  );

  // ── hadron_chatbot_get_route_history ──────────────────────────────────────────

  server.tool(
    'hadron_chatbot_get_route_history',
    'Get the route history and goal stack for a chat. Shows where the chat has been and what goals are active.',
    {
      chatId: z.string().describe('Chat ID'),
    },
    async ({ chatId }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        // loc-scope-ok: a chat loc is chats:<ts>-<8 hex>-<name>, unique in practice; the unscoped read is tracked in #825
        const chatNode = await db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
        if (!chatNode) return textResult(`Chat "${chatId}" not found.`);
        const chatData = (chatNode.data as Record<string, unknown>) ?? {};
        return textResult(JSON.stringify({
          conversationName: chatData.conversationName,
          stageName: chatData.stageName,
          goalStack: chatData.goalStack ?? [],
          routeHistory: chatData.routeHistory ?? [],
        }, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to get route history'}`);
      }
    },
  );

  // ── hadron_chatbot_push_goal ──────────────────────────────────────────────────

  server.tool(
    'hadron_chatbot_push_goal',
    'Push a new goal onto the goal stack. Use this when the user mentions something they want to do later, or when a detour is needed.',
    {
      chatId: z.string().describe('Chat ID'),
      description: z.string().describe('Description of the goal'),
      createdBy: z.enum(['ASSISTANT', 'USER']).optional().describe('Who identified this goal (default: ASSISTANT)'),
    },
    async ({ chatId, description, createdBy }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        // loc-scope-ok: a chat loc is chats:<ts>-<8 hex>-<name>, unique in practice; the unscoped read is tracked in #825
        const chatNode = await db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
        if (!chatNode) return textResult(`Chat "${chatId}" not found.`);
        const chatData = (chatNode.data as Record<string, unknown>) ?? {};
        const stack = (chatData.goalStack as Array<Record<string, unknown>>) ?? [];
        stack.push({
          description,
          createdBy: createdBy ?? 'ASSISTANT',
          createdAt: new Date().toISOString(),
          conversationUrn: chatData.conversationName ? `conversations:${chatData.conversationName}` : undefined,
          nodeUrn: chatData.stageName && chatData.conversationName
            ? `conversations:${chatData.conversationName}:${chatData.stageName}`
            : undefined,
          status: 'ACTIVE',
        });
        chatData.goalStack = stack;
        await db.node.update({
          where: { id: chatNode.id },
          data: { data: chatData as InputJsonValue },
        });
        return textResult(`Goal pushed: "${description}". Stack depth: ${stack.filter((g: any) => g.status === 'ACTIVE').length}`);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to push goal'}`);
      }
    },
  );

  // ── hadron_chatbot_pop_goal ───────────────────────────────────────────────────

  server.tool(
    'hadron_chatbot_pop_goal',
    'Complete the current goal and return to the previous one. Use this when a detour conversation has finished its purpose.',
    {
      chatId: z.string().describe('Chat ID'),
    },
    async ({ chatId }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        // loc-scope-ok: a chat loc is chats:<ts>-<8 hex>-<name>, unique in practice; the unscoped read is tracked in #825
        const chatNode = await db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
        if (!chatNode) return textResult(`Chat "${chatId}" not found.`);
        const chatData = (chatNode.data as Record<string, unknown>) ?? {};
        const stack = (chatData.goalStack as Array<Record<string, unknown>>) ?? [];

        // Find and complete the topmost ACTIVE goal
        let completed: Record<string, unknown> | null = null;
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].status === 'ACTIVE') {
            stack[i].status = 'COMPLETED';
            stack[i].completedAt = new Date().toISOString();
            completed = stack[i];
            break;
          }
        }

        chatData.goalStack = stack;
        await db.node.update({
          where: { id: chatNode.id },
          data: { data: chatData as InputJsonValue },
        });

        if (completed) {
          const remaining = stack.filter((g: any) => g.status === 'ACTIVE').length;
          return textResult(`Goal completed: "${completed.description}". ${remaining} active goal(s) remaining.`);
        }
        return textResult('No active goals to complete.');
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to pop goal'}`);
      }
    },
  );

  // ── hadron_chatbot_add_training_entry ───────────────────────────────────────

  server.tool(
    'hadron_chatbot_add_training_entry',
    'Add a user statement to the agent-wide routing training set. These entries help the routing engine match future user messages to the right conversation. Stored in the system memory (not encrypted user memory).',
    {
      agentId: z.string().describe('ID of the agent'),
      userStatement: z.string().describe('The user statement that should route here (e.g. "Is Nina back in town?")'),
      matchedConversation: z.string().describe('The conversation name this statement should route to (e.g. "class-schedule")'),
      language: z.string().optional().describe('Language code (e.g. "en", "es"). Defaults to "en".'),
    },
    async ({ agentId, userStatement, matchedConversation, language }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        const agent = await db.agent.findUnique({ where: { id: agentId } });
        if (!agent) return textResult('Agent not found.');
        const sysMemId = (agent as any).systemMemoryId as string | null;
        if (!sysMemId) return textResult('Agent has no system memory.');

        // Ensure the training node exists
        const trainingLoc = 'goals:training';
        let trainingNode = await db.node.findFirst({
          where: { memoryId: sysMemId, loc: trainingLoc, deletedAt: null },
        });

        if (!trainingNode) {
          // Create parent + training node
          try {
            await db.node.upsert({
              where: { loc_memoryId: { loc: 'goals', memoryId: sysMemId } },
              create: { id: generateId(), memoryId: sysMemId, loc: 'goals', name: 'goals', nodeType: 'system' },
              update: {},
            });
          } catch { /* exists */ }
          trainingNode = await db.node.create({
            data: {
              id: generateId(), memoryId: sysMemId, loc: trainingLoc, name: 'training',
              nodeType: 'system', data: { entries: [] } as InputJsonValue,
            },
          });
        }

        const trainingData = (trainingNode.data as Record<string, unknown>) ?? {};
        const entries = (trainingData.entries as Array<Record<string, unknown>>) ?? [];

        entries.push({
          userStatement,
          matchedConversation,
          language: language ?? 'en',
          addedAt: new Date().toISOString(),
          addedBy: auth.userId ?? auth.clientId ?? 'system',
        });

        await db.node.update({
          where: { id: trainingNode.id },
          data: { data: { ...trainingData, entries } as InputJsonValue },
        });

        return textResult(`Training entry added: "${userStatement}" → ${matchedConversation}. Total entries: ${entries.length}`);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to add training entry'}`);
      }
    },
  );

  // ── hadron_chatbot_define_persona ───────────────────────────────────────────

  server.tool(
    'hadron_chatbot_define_persona',
    'Define a test persona for automated chatbot testing. The persona has a name, description, opening message, and optionally an expected conversation path. Stored in the system memory under test-personas:*.',
    {
      agentId: z.string().describe('ID of the agent'),
      name: z.string().describe('Persona name (e.g. "Maria Santos")'),
      description: z.string().describe('Brief description: who they are, what they want (e.g. "Freelance designer in Austin, wants to find a mentor")'),
      openingMessage: z.string().describe('The first message the persona sends to start the chat'),
      conversationName: z.string().optional().describe('Which conversation to start with (omit to let routing decide)'),
      followUpMessages: z.array(z.string()).optional().describe('Subsequent messages the persona sends, in order. If omitted, the LLM improvises based on the persona description.'),
      expectedConversations: z.array(z.string()).optional().describe('Expected conversation path for validation (e.g. ["onboarding", "strategy"])'),
    },
    async ({ agentId, name, description, openingMessage, conversationName, followUpMessages, expectedConversations }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        const agent = await db.agent.findUnique({ where: { id: agentId } });
        if (!agent) return textResult('Agent not found.');
        const sysMemId = (agent as any).systemMemoryId as string | null;
        if (!sysMemId) return textResult('Agent has no system memory.');

        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        const personaLoc = `test-personas:${slug}`;

        // Ensure parent exists
        try {
          await db.node.upsert({
            where: { loc_memoryId: { loc: 'test-personas', memoryId: sysMemId } },
            create: { id: generateId(), memoryId: sysMemId, loc: 'test-personas', name: 'test-personas', nodeType: 'system', description: 'Test personas for automated chatbot testing' },
            update: {},
          });
        } catch { /* exists */ }

        await db.node.upsert({
          where: { loc_memoryId: { loc: personaLoc, memoryId: sysMemId } },
          create: {
            id: generateId(), memoryId: sysMemId, loc: personaLoc, name: slug,
            nodeType: 'system', description: name,
            data: {
              personaName: name, description, openingMessage,
              conversationName: conversationName ?? null,
              followUpMessages: followUpMessages ?? [],
              expectedConversations: expectedConversations ?? [],
              createdAt: new Date().toISOString(),
            } as InputJsonValue,
          },
          update: {
            description: name,
            data: {
              personaName: name, description, openingMessage,
              conversationName: conversationName ?? null,
              followUpMessages: followUpMessages ?? [],
              expectedConversations: expectedConversations ?? [],
              updatedAt: new Date().toISOString(),
            } as InputJsonValue,
            deletedAt: null,
          },
        });

        return textResult(`Persona "${name}" saved at ${personaLoc}.\nOpening: "${openingMessage}"\nFollow-ups: ${(followUpMessages ?? []).length}`);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to define persona'}`);
      }
    },
  );

  // ── hadron_chatbot_list_personas ──────────────────────────────────────────

  server.tool(
    'hadron_chatbot_list_personas',
    'List all test personas defined for an agent.',
    {
      agentId: z.string().describe('ID of the agent'),
    },
    async ({ agentId }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        const agent = await db.agent.findUnique({ where: { id: agentId } });
        if (!agent) return textResult('Agent not found.');
        const sysMemId = (agent as any).systemMemoryId as string | null;
        if (!sysMemId) return textResult('Agent has no system memory.');

        const personas = await db.node.findMany({
          where: { memoryId: sysMemId, loc: { startsWith: 'test-personas:' }, deletedAt: null },
          select: { loc: true, description: true, data: true },
          orderBy: { loc: 'asc' },
        });

        if (personas.length === 0) return textResult('No test personas defined. Use hadron_chatbot_define_persona to create one.');

        const lines = personas.map((p) => {
          const d = (p.data as Record<string, unknown>) ?? {};
          return `- ${d.personaName ?? p.description ?? p.loc}: "${d.openingMessage ?? ''}"${d.conversationName ? ` (starts: ${d.conversationName})` : ''}`;
        });
        return textResult(`${personas.length} persona(s):\n${lines.join('\n')}`);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to list personas'}`);
      }
    },
  );

  // ── hadron_chatbot_run_persona ────────────────────────────────────────────

  server.tool(
    'hadron_chatbot_run_persona',
    'Run a test persona through the chatbot in "dry run" mode. This starts a chat as the persona, sends their opening message, and returns the chatbot\'s compiled prompt + tool schema so the client LLM can generate the response. Call hadron_chatbot_process with the response, then call this tool again with the next follow-up message. Use this iteratively to walk through the full conversation.\n\nWorkflow:\n1. Call hadron_chatbot_run_persona to start (sets up chat, sends opening message)\n2. Read the returned prompt, generate a chatbot response as the client LLM\n3. Call hadron_chatbot_process with the response\n4. Call hadron_chatbot_run_persona again with step=1 (next follow-up)\n5. Repeat until all follow-ups are done or the conversation ends\n\nAt the end, call hadron_chatbot_get_route_history to see the full path taken.',
    {
      agentId: z.string().describe('ID of the agent'),
      personaLoc: z.string().describe('Loc of the persona (e.g. "test-personas:maria-santos")'),
      step: z.number().optional().describe('Follow-up message index (0 = opening message, 1 = first follow-up, etc.). Defaults to 0.'),
      chatId: z.string().optional().describe('Chat ID from a previous step. Omit on step 0 to start a new chat.'),
    },
    async ({ agentId, personaLoc, step, chatId }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
        const agent = await db.agent.findUnique({ where: { id: agentId } });
        if (!agent) return textResult('Agent not found.');
        const sysMemId = (agent as any).systemMemoryId as string | null;
        if (!sysMemId) return textResult('Agent has no system memory.');

        const personaNode = await db.node.findFirst({
          where: { memoryId: sysMemId, loc: personaLoc, deletedAt: null },
        });
        if (!personaNode) return textResult(`Persona "${personaLoc}" not found.`);
        const persona = (personaNode.data as Record<string, unknown>) ?? {};
        const followUps = (persona.followUpMessages as string[]) ?? [];
        const currentStep = step ?? 0;

        const ctx = gqlCtx(persona.personaName as string ?? 'test-persona');

        if (currentStep === 0) {
          // Start a new chat
          const startResult = await resolvers.Mutation.startChat(
            null,
            {
              agentId,
              userId: persona.personaName as string,
              conversationName: (persona.conversationName as string) ?? undefined,
            },
            ctx,
          );

          // Send the opening message
          const sendResult = await resolvers.Mutation.sendChatMessage(
            null,
            { chatId: startResult.chatId, userMessage: persona.openingMessage as string },
            ctx,
          );

          return textResult(JSON.stringify({
            chatId: startResult.chatId,
            step: 0,
            personaMessage: persona.openingMessage,
            totalFollowUps: followUps.length,
            conversationName: startResult.conversationName,
            stageName: startResult.stageName,
            systemMessage: sendResult.systemMessage,
            tools: sendResult.tools,
            messageHistory: sendResult.messageHistory,
            instruction: 'Generate a chatbot response based on the systemMessage and tools above. Then call hadron_chatbot_process with chatId, message, data, and next_stage. After that, call hadron_chatbot_run_persona with step=1 to send the next follow-up.',
          }, null, 2));
        }

        // Follow-up steps
        if (!chatId) return textResult('chatId is required for follow-up steps.');
        const followUpIdx = currentStep - 1;

        if (followUpIdx >= followUps.length) {
          // All follow-ups done — generate the test report
          // loc-scope-ok: a chat loc is chats:<ts>-<8 hex>-<name>, unique in practice; the unscoped read is tracked in #825
          const chatNode = await db.node.findFirst({ where: { loc: chatId, deletedAt: null } });
          const chatData = (chatNode?.data as Record<string, unknown>) ?? {};
          const expected = (persona.expectedConversations as string[]) ?? [];
          const routeHistory = (chatData.routeHistory as Array<Record<string, unknown>>) ?? [];
          const visitedConvs = [...new Set(routeHistory.filter((r) => r.conversationUrn).map((r) => (r.conversationUrn as string).replace('conversations:', '')))];

          let pass = true;
          const issues: string[] = [];
          if (expected.length > 0) {
            for (const exp of expected) {
              if (!visitedConvs.includes(exp)) {
                pass = false;
                issues.push(`Expected conversation "${exp}" was not visited.`);
              }
            }
          }

          return textResult(JSON.stringify({
            chatId,
            step: currentStep,
            status: 'COMPLETE',
            pass,
            issues,
            visitedConversations: visitedConvs,
            totalTurns: (chatData.messageCount as number) ?? 0,
            routeHistory,
            goalStack: chatData.goalStack ?? [],
            instruction: 'Test complete. Review the results above.',
          }, null, 2));
        }

        const userMessage = followUps[followUpIdx];

        // Send the follow-up message
        const sendResult = await resolvers.Mutation.sendChatMessage(
          null,
          { chatId, userMessage },
          ctx,
        );

        return textResult(JSON.stringify({
          chatId,
          step: currentStep,
          personaMessage: userMessage,
          remainingFollowUps: followUps.length - followUpIdx - 1,
          systemMessage: sendResult.systemMessage,
          tools: sendResult.tools,
          messageHistory: sendResult.messageHistory,
          instruction: `Generate a chatbot response for: "${userMessage}". Then call hadron_chatbot_process, then hadron_chatbot_run_persona with step=${currentStep + 1}.`,
        }, null, 2));
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : 'Failed to run persona'}`);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transport management — one transport per MCP session
// ---------------------------------------------------------------------------

const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Spec 026 — per-MCP-session active App, used by both regime (b)
 * (directory-aware, seeded from `initialize` capability parameter) and
 * regime (c) (session-scoped, set by the `hadron_set_active_app` tool).
 * Keyed by transport `sessionId`. Cleaned up in `transport.onclose`
 * alongside `transports.delete(sid)`. Single-replica only per spec 026
 * §Clarifications Q3; horizontal scale-out requires either sticky
 * sessions or persistent `McpSessionState` first.
 */
const activeAppByMcpSession = new Map<
  string,
  { appId: string; organizationId: string | null }
>();

/**
 * Handle MCP requests on the Express /mcp endpoint.
 * Authenticates via Bearer token, creates or reuses transport sessions.
 */
export async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  // Check for existing session first — skip expensive auth if already authenticated
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // Stale session — the client presented a session ID we don't know
  // (typically: the server restarted and the in-memory registry was wiped).
  // Per the MCP streamable-HTTP spec the recoverable signal is HTTP 404
  // ("Session not found"): on a 404 the client MUST transparently start a
  // new session with a fresh InitializeRequest, and work resumes. Anything
  // else — in particular the 400 "Server not initialized" the SDK emits if
  // we feed a non-initialize request to a brand-new transport — is a
  // generic protocol error the client gives up on, permanently severing
  // the connection until the client itself restarts.
  //
  // Initialize requests fall through: the block below builds a fresh
  // transport for them (reusing the presented session ID, so a client that
  // re-inits with a stale ID keeps working). No auth is required to learn
  // "session not found" — session IDs are server-generated UUIDs and the
  // DELETE handler already answers 404 pre-auth for unknown sessions.
  if (sessionId) {
    const body: unknown = req.body;
    const hasInitialize = Array.isArray(body)
      ? body.some((m) => isInitializeRequest(m))
      : isInitializeRequest(body);
    if (!hasInitialize) {
      mcpLog('info', 'stale_mcp_session_404', { mcpSessionId: sessionId, method: req.method });
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      });
      return;
    }
  }

  // New session — authenticate. Accept JWT users (userId/clientId set by
  // resolveAuthContext) OR App Keys (appId set) OR User API Keys (userId
  // set without appId, per spec 025-oauth-for-mcp). App Keys are the
  // canonical way for hadron-client / Claude Code MCP / Cursor / etc. to
  // authenticate; user-credential MCP arrives via OAuth or portal-minted
  // hdr_user_<…> bearer tokens.
  const auth = await resolveAuthContext(req, db);
  if (!auth.appId && !auth.userId && !auth.clientId) {
    // Advertise the protected-resource metadata URL per RFC 9728 §5.1 so
    // MCP-spec-compliant clients (Claude Desktop, MCP Inspector) can
    // discover the OAuth authorization server and walk the OAuth dance.
    //
    // Origin resolution is delegated to `getServerOrigin` so this path
    // shares the same precedence as the discovery endpoints (the
    // `BASE_URL` env var when set, else
    // `req.protocol + req.get('host')`). Without that consolidation,
    // a misconfigured deployment could emit an `https://` issuer in
    // the AS metadata but an `http://` URL in this WWW-Authenticate
    // header (or vice versa) — same root cause as the original
    // catch-all "everything is http://" production bug.
    const origin = getServerOrigin(req);
    if (!origin) {
      // RFC 7230 §5.4 requires Host on every HTTP/1.1 request. A request
      // without one is malformed; we can't synthesize a usable
      // resource_metadata URL. Respond 400 honestly rather than emit a
      // partially-formed URL that downstream clients would 404 against.
      res.status(400).json({ error: 'Missing Host header' });
      return;
    }
    const prmUrl = `${origin}/.well-known/oauth-protected-resource`;
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="hadron", error="invalid_token", resource_metadata="${prmUrl}"`,
    );
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  // Spec 025 / 026 — App-identification resolution at the MCP boundary for
  // user-credential callers (userId set, appId not set; JWT or
  // hdr_user_<…> Bearer). App-key callers already have appId populated by
  // the middleware and skip this block.
  //
  // **Spec-026 change** (relative to spec-025):
  // - The legacy `multiple_apps_resolved` HTTP 409 NO LONGER fires here at
  //   session-init time. Spec 026 requires multi-App sessions to OPEN so
  //   the user can call `hadron_list_apps` + `hadron_set_active_app` to pick an App.
  // - For multi-App users, `auth.appId` is left unset at session-init and
  //   the resolution is cached for per-tool-call dispatch.
  // - Single-App users continue to get `auth.appId` populated here (regime
  //   `a` unchanged from spec 025).
  // - The legacy 409 text survives as the FR-016 fall-through tool-error
  //   envelope: an App-scoped tool call from a multi-App user who has NOT
  //   touched the new selection surface gets that text in a tool error
  //   instead of an HTTP 409.
  //
  // **`auth` is mutated in place** on the resolved path. Today this is
  // safe — `auth` is local to handleMcpRequest and the closure inside
  // `createMcpServerInstance` reads the post-mutation state.
  let cachedAppResolution: AppResolution | null = null;
  if (auth.userId && !auth.appId) {
    cachedAppResolution = await resolveAppForRequest(auth.userId, db);
    if (cachedAppResolution.kind === 'resolved') {
      auth.appId = cachedAppResolution.appId;
      auth.organizationId = cachedAppResolution.organizationId ?? undefined;
    }
    if (cachedAppResolution.kind === 'multi-app') {
      mcpLog('warn', 'multi_app_session_opened_without_selection', {
        userId: auth.userId,
      });
    }
    // 'no-app': continue without setting appId; downstream tool calls
    // fail with their existing errors (zero-App fall-through unchanged
    // from spec 025).
  }

  // Session not found or no session — create a new one.
  // This handles both first-time connections and reconnections after server restart.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: sessionId
      ? () => sessionId  // Reuse the client's session ID so it doesn't need to re-init
      : () => randomUUID(),
  });

  const mcpServer = createMcpServerInstance(
    auth,
    () => transport.sessionId,
    cachedAppResolution,
  );

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      transports.delete(sid);
      activeAppByMcpSession.delete(sid); // spec 026 — clear per-session active App
      sessionKeyCache.evict(`mcp:${sid}`); // spec 041 — drop unlock keys with the session
    }
  };

  await mcpServer.connect(transport);

  // Handle the request with the new transport
  await transport.handleRequest(req, res, req.body);

  const sid = transport.sessionId;
  if (sid) {
    transports.set(sid, transport);
  }
}

/**
 * Handle DELETE requests to close an MCP session.
 */
export async function handleMcpDelete(req: Request, res: Response): Promise<void> {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !transports.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }

  const transport = transports.get(sessionId)!;
  await transport.close();
  transports.delete(sessionId);
  activeAppByMcpSession.delete(sessionId); // spec 026 — DELETE path also clears
  sessionKeyCache.evict(`mcp:${sessionId}`); // spec 041 — DELETE drops unlock keys too
  res.status(200).json({ ok: true });
}
