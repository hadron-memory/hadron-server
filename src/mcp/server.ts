import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { generateId } from '../lib/id.js';
import {
  parseUrnInput,
  formatCanonicalUrn,
  assertFullyQualifiedUrn,
  splitNodeUrn,
  normalizeUrnForLookup,
  UrnNotQualifiedError,
} from '../lib/urn.js';
import { validateParentRel, InvalidParentRelError } from '../lib/parentRel.js';
import { validateLoc } from '../lib/validateLoc.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { db } from '../integrations/db/client.js';
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
import { writeNodeToGit } from '../integrations/github/writeNodeToGit.js';
import { computeContentHash } from '../lib/contentHash.js';
import { isCiphertext } from '../lib/crypto.js';
import { enqueueNodeEmbedding } from '../services/embedding/enqueue.js';
import { vectorSearchNodes } from '../services/embedding/vectors.js';
import { getEmbeddingClient, isEmbeddingConfigured } from '../lib/embedding/index.js';
import { resolveNodeRef } from '../lib/entityRef/nodeRef.js';
import {
  NodeNotFoundError,
  NodeAbstractTooLongError,
  InvalidContentScopeError,
} from '../lib/entityRef/errors.js';
import { isId } from '../lib/entityRef/shape.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import type { SessionType } from '../generated/prisma/index.js';
import type { InputJsonValue } from '../generated/prisma/runtime/library.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

/**
 * Hadron MCP server version — single source of truth for the MCP-
 * protocol-level server identity. Used both as the `version` field in
 * the McpServer constructor (the MCP initialize response's server
 * identity) and in the deployment-info diagnostics surface (h-server-
 * info / h-set-active-memory success message).
 *
 * Bump when the MCP tool surface changes in a way callers should be
 * able to detect: new tool added, tool removed or renamed, response-
 * shape break, semantics change that would surprise a previously-
 * working caller.
 *
 * Intentionally NOT tied to `package.json`'s version — that tracks the
 * repo's release identity (deploy / npm-publish cadence), and the two
 * may legitimately diverge. The MCP-protocol-level identity is its
 * own contract: callers care about "what tools and shapes does this
 * server expose?", not "what release of the hadron-server repo am I
 * talking to?"
 */
export const HADRON_SERVER_VERSION = '0.3.0';

/**
 * Diagnostics surface — answers "which hadron-server am I talking to?"
 * from the agent side. Agents can call h-server-info (this exact object,
 * formatted) to see the bound deployment URL + version; h-set-active-
 * memory's success message also includes it inline.
 *
 * Motivated by #187 / #190 (dual-MCP-namespace divergence): when
 * `mcp__hadron__*` and `mcp__claude_ai_Hadron__*` are bound to different
 * hadron-server instances backed by different databases, agents had no
 * server-side way to notice they'd reached the wrong one. Exposing the
 * BASE_URL lets a transcript reader (or the agent itself, on the next
 * call) see the mismatch directly.
 *
 * Intentionally does NOT expose the DATABASE_URL — the connection
 * string may carry credentials. If a future need arises to disambiguate
 * two deployments that share a BASE_URL but point at different DBs, add
 * a separate `dbName` field that parses the path segment only.
 */
export interface DeploymentInfo {
  baseUrl: string;
  version: string;
}

export function getDeploymentInfo(): DeploymentInfo {
  // Treat empty string and `"/"` as effectively-unset, matching the
  // pattern in src/auth/oauth.ts which special-cases `BASE_URL === '/'`
  // (a known sentinel left by Vitest's globalSetup when no explicit
  // value is configured). Without this guard a single empty/`"/"`
  // value silently propagates into `server: ` lines and h-server-info
  // output — exactly the wrong-server-but-no-way-to-tell symptom this
  // surface exists to fix. Gemini review caught this on PR-191.
  const raw = process.env.BASE_URL;
  // PORT uses `||` (not `??`) so an empty-string PORT — e.g. shell `PORT= node ...`
  // or `vi.stubEnv('PORT', '')` — falls back to 4000. Symmetric with the
  // empty-string handling on BASE_URL above; `??` would only catch null/undefined
  // and let `""` slip through, producing `http://localhost:`. PR-194 review.
  const baseUrl =
    raw && raw !== '/'
      ? raw
      : `http://localhost:${process.env.PORT || 4000}`;
  return { baseUrl, version: HADRON_SERVER_VERSION };
}

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

/** A single resolved edge ready to be written to the database. */
export type ResolvedEdge = { targetNodeId: string; label: string };

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
 * Issue #107: prior inline logic in h-add-node / h-update-node used a
 * `targetId.includes(':')` heuristic plus `findFirst({loc})` (no
 * memory scope), which silently no-op'd memory-prefixed/URN forms and
 * FK-errored on single-segment short locs.
 */
export async function resolveEdgeRefs(
  edges: Array<{ targetId: string; label: string }>,
  sourceMemoryId: string,
): Promise<{ resolved: ResolvedEdge[] } | { error: string }> {
  const resolved: ResolvedEdge[] = [];
  for (const edge of edges) {
    try {
      const { id: targetNodeId } = await resolveNodeRef(db, edge.targetId, sourceMemoryId);
      resolved.push({ targetNodeId, label: edge.label });
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
 * idempotently (re-running with the same triple is a no-op against
 * the `@@unique([sourceId, targetId, label])` composite). Backs the
 * `h-add-edge` MCP tool — extracted so the auth-gated flow (resolve
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
  | { sourceUrn: string; targetUrn: string; label: string };

export async function addEdge(args: {
  sourceUrn: string;
  targetUrn: string;
  label: string;
  auth: AuthContext;
}): Promise<AddEdgeResult> {
  const { sourceUrn: rawSource, targetUrn: rawTarget, label, auth } = args;

  // Spec 022: qualification at the API boundary. Source MUST be a
  // fully-qualified URN — we need to recover the memory URN from it
  // for the write-permission check, so an ID-shape source isn't
  // accepted. Target accepts ID-shape per spec-007 dispatch.
  try {
    assertFullyQualifiedUrn(rawSource, 'node');
  } catch (e) {
    if (e instanceof UrnNotQualifiedError) return { error: `Source: ${e.message}` };
    throw e;
  }
  try {
    if (!isId(rawTarget)) {
      assertFullyQualifiedUrn(rawTarget, 'node');
    }
  } catch (e) {
    if (e instanceof UrnNotQualifiedError) return { error: `Target: ${e.message}` };
    throw e;
  }

  // Resolve source strictly — h-add-edge never auto-creates the
  // source (use h-add-node for that).
  const { memoryUrn: sourceMemoryUrn, loc: sourceLoc } = splitNodeUrn(rawSource);
  const sourceMem = await resolveMemoryByUrn(sourceMemoryUrn);
  if (!sourceMem) {
    return { error: `Source memory not found: "${sourceMemoryUrn}".` };
  }
  const sourceNode = await db.node.findUnique({
    where: { loc_memoryId: { loc: sourceLoc, memoryId: sourceMem.id } },
    select: { id: true, deletedAt: true },
  });
  if (!sourceNode || sourceNode.deletedAt) {
    return { error: `Source node not found: "${rawSource}".` };
  }

  if (!(await canWriteToMemory(db, auth, sourceMem.id))) {
    return { error: 'Write access denied for source memory.' };
  }

  let targetNodeId: string;
  try {
    ({ id: targetNodeId } = await resolveNodeRef(db, rawTarget, sourceMem.id));
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

  await db.edge.upsert({
    where: {
      sourceId_targetId_label: {
        sourceId: sourceNode.id,
        targetId: targetNodeId,
        label,
      },
    },
    create: {
      id: generateId(),
      sourceId: sourceNode.id,
      targetId: targetNodeId,
      label,
      createdBy: auth.clientId ?? null,
    },
    update: {},
  });

  const savedSourceUrn = await nodeUrn(sourceLoc, sourceMem.id);
  const savedTargetUrn = await nodeUrn(target.loc, target.memoryId);
  return { sourceUrn: savedSourceUrn, targetUrn: savedTargetUrn, label };
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
          sourceId: args.sourceNodeId,
          targetId: e.targetNodeId,
          label: e.label,
          createdBy: args.createdBy,
        })),
        skipDuplicates: true,
      });
    }
  });
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
  // Spec 027: produce a canonical-form node URN regardless of how
  // Memory.urn is stored (legacy `acme.com:dev` or canonical
  // `acme.com::dev` depending on spec-021's per-row migration).
  //
  // Approach: canonicalize the memory URN first to obtain a known-shape
  // canonical bare form, then attach the loc as the node's leaf
  // path-segment with `::` as the explicit hierarchy separator. This
  // preserves the semantic that `loc` is a single multi-atom leaf
  // (e.g. `review:sort-imports`), rather than letting the parser
  // re-split it as additional hierarchy levels. Calling
  // formatCanonicalUrn('node', `${memUrn}:${loc}`) directly would
  // produce `urn:node:acme.com::dev::review::sort-imports` (4 levels)
  // for a legacy memUrn — parser-correct but semantically wrong.
  const memCanonical = formatCanonicalUrn('memory', memUrn);
  const bareMemCanonical = memCanonical.substring('urn:memory:'.length);
  return `urn:node:${bareMemCanonical}::${loc}`;
}

export function matchesQuery(
  node: { name: string; loc: string; description: string | null; tags: string[] },
  query: string,
): boolean {
  // Issue #170: `*` and empty string are "match all". Without this an
  // agent surveying a memory will reasonably try `query: "*"` first,
  // get "No nodes found", and proceed to write — overlooking the
  // existing tree. Now `*` (and trimmed-empty) surface every node so
  // the agent can see what's already there.
  const trimmed = query.trim();
  if (trimmed === '' || trimmed === '*') return true;
  const terms = trimmed.toLowerCase().split(/\s+/);
  const haystack = [node.name, node.loc, node.description || '', ...node.tags]
    .join(' ')
    .toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

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
  // Either way, callers (h-list-nodes / h-find-nodes) end up with a
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
  // h-add-edge source path inherits the same hazard via splitNodeUrn).
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

  // Per-session state. The field is preserved per spec 022 D4a as advisory
  // metadata — the agent inference layer (hadron-client) MAY read it as a
  // future hint signal, but no server-side code reads it. Set via
  // `h-set-active-memory`; never consumed here.
  // TODO(spec-022-cleanup): tracked as Q-2026-05-07-001 in the design
  // discussion registry; revisit if usage stays "set, never read" past pilot.
  let activeMemoryUrn: string | undefined;

  // Spec 026 — has the session called `h-list-apps` or `h-set-active-app`,
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
        auth.organizationId = sel.organizationId;
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
        const message = `No active Hadron App. Call h-list-apps to see options, then h-set-active-app with the one you want. If you're calling from a project directory, set 'app' in '.hadron/config.json'.`;
        mcpLog('warn', 'no_active_app_typed_error', { userId: auth.userId, mcpSessionId: sid });
        return appSelectionError(APP_SELECTION_ERROR_CODES.NO_ACTIVE_APP, message);
      }
      // FR-016 fall-through for un-engaged callers. The MULTIPLE_APPS_RESOLVED
      // code carries the literal `multiple_apps_resolved` token in the
      // envelope's `[<code>]` prefix so SC-003's production-log grep
      // continues to work even when the legacy spec-025 HTTP 409 path is
      // gone.
      const message = `User has more than one Hadron App; this MCP client does not support App selection. See ${MULTIPLE_APPS_DOCS_URL} for guidance. Or call h-list-apps to see your accessible Apps and h-set-active-app to pick one.`;
      mcpLog('warn', 'multiple_apps_resolved_fallthrough', { userId: auth.userId, mcpSessionId: sid });
      return appSelectionError(APP_SELECTION_ERROR_CODES.MULTIPLE_APPS_RESOLVED, message);
    }

    return null; // zero-App or other path — fall through
  }

  // ── h-list-memories ──────────────────────────────────────────────────────

  server.tool(
    'h-list-memories',
    'List all memories this caller has access to, with URN and access level (read-only or read-write).',
    {},
    async () => {
      // Spec 026 / D-2026-05-21-003: h-list-memories is advisory — it
      // works without an active App. When auth.appId is unset but
      // auth.userId is set (multi-App OAuth caller without selection),
      // getMemoryAccess unions memory access across the user's
      // accessible Apps. No requireAppScope() gate on purpose.
      if (!auth.clientId && !auth.appId && !auth.userId) return textResult('Not authenticated.');

      const access = await getMemoryAccess(db, auth);
      if (access.size === 0) {
        return textResult('No memories accessible. Subscribe to an agent with memories first.');
      }

      const memoryIds = [...access.keys()];
      const memories = await db.memory.findMany({
        where: { id: { in: memoryIds } },
        select: { id: true, urn: true, name: true },
      });

      const lines = memories.map((m) => {
        const level = access.get(m.id) === 'READ_WRITE' ? 'read-write' : 'read-only';
        return `- **${formatCanonicalUrn('memory', m.urn)}** — ${m.name} (${level})`;
      });

      return textResult(`${memories.length} accessible memories:\n\n${lines.join('\n')}`);
    },
  );

  // ── h-set-active-memory ──────────────────────────────────────────────────

  server.tool(
    'h-set-active-memory',
    'Set the active memory for this session. Subsequent tree tools will use this as the default scope.',
    {
      memoryUrn: z.string().describe('Memory URN, e.g. hadronmemory.com::dev or urn:memory:hadronmemory.com::dev'),
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
        const prefix = parsed.type === 'loc' ? 'loc:' : `urn:${parsed.type}:`;
        return textResult(
          `Expected a memory URN, got '${prefix}'. Pass 'hadronmemory.com::dev' or 'urn:memory:hadronmemory.com::dev'.`,
        );
      }

      // Resolve via the shared helper — soft-delete filtering, trimming, and
      // bare-URN normalization all live in one place so every read-side
      // scoping point behaves consistently.
      const mem = await resolveMemoryByUrn(memoryUrn);
      if (!mem) {
        return textResult(`Memory not found: '${memoryUrn}'. Use h-list-memories to see what's available.`);
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
      // ignore in transcripts. Full diagnostic dump lives on h-server-
      // info; this is the inline hint.
      const dep = getDeploymentInfo();
      return textResult(
        `Active memory set to: ${formatCanonicalUrn('memory', mem.urn)} ` +
          `(server: ${dep.baseUrl}, version: ${dep.version}).`,
      );
    },
  );

  // ── h-server-info ────────────────────────────────────────────────────────
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
    'h-server-info',
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

  // ── h-list-apps (spec 026 regime c) ──────────────────────────────────────

  server.tool(
    'h-list-apps',
    'List the Hadron Apps you have access to. Use this to find an App to pass to h-set-active-app, or to check what an `app` field in `.hadron/config.json` resolves to.',
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
          `1 accessible app:\n\n- **${formatCanonicalUrn('app', app.urn)}** — ${app.name} (via App Key)`,
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
        (a) => `- **${formatCanonicalUrn('app', a.urn)}** — ${a.name} (role: ${a.role})`,
      );
      const header =
        apps.length === 1
          ? `1 accessible app:`
          : `${apps.length} accessible apps:`;
      const trailer =
        apps.length === 1
          ? `\n\n(You only have one App, so h-set-active-app isn't required — it's already the active one by default.)`
          : '';
      return textResult(`${header}\n\n${lines.join('\n')}${trailer}`);
    },
  );

  // ── h-set-active-app (spec 026 regime c) ─────────────────────────────────

  server.tool(
    'h-set-active-app',
    "Set the active Hadron App for this session. Subsequent tools (h-find-nodes, h-add-node, etc.) will use this as the App scope. Pass the App URN (e.g. 'urn:app:acme-corp::notes') or an App name that matches exactly one App you have access to. Use h-list-apps to see options.",
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
          'AppKey callers already carry App identity in the credential; h-set-active-app is not applicable.',
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
          auth.organizationId = r.app.organizationId;
          mcpLog('info', 'regime_c_selection_set', {
            userId: auth.userId,
            mcpSessionId: sid,
            appId: r.app.id,
            appUrn: r.app.urn,
          });
          return textResult(
            `Active App set to: **${formatCanonicalUrn('app', r.app.urn)}** (${r.app.name}). Subsequent App-scoped tools will operate against this App. Call h-set-active-app again with a different identifier to switch, or h-list-apps to see other options.`,
          );
        }
        case 'ambiguous': {
          const candidatesText = r.candidates
            .map((c) => `  - ${formatCanonicalUrn('app', c.urn)}`)
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
            `App '${app}' is no longer available (${r.reason}). Ask the App owner to reinstall, or pick another with h-list-apps.`,
          );
        }
        case 'not-member': {
          return appSelectionError(
            APP_SELECTION_ERROR_CODES.APP_NOT_FOUND,
            `No accessible App matches '${app}'. Use h-list-apps to see what's available.`,
          );
        }
        case 'not-found': {
          return appSelectionError(
            APP_SELECTION_ERROR_CODES.APP_NOT_FOUND,
            `No accessible App matches '${app}'. Use h-list-apps to see what's available.`,
          );
        }
      }
    },
  );

  // ── h-add-parent-node ───────────────────────────────────────────────────

  server.tool(
    'h-add-parent-node',
    'Create a parent (section/category) node in the memory graph. Lightweight container for organizing nodes. The URN MUST be fully qualified (org::memory::loc).',
    {
      urn: z.string().describe('Fully-qualified node URN for the new section, e.g. "acme.com::mmdata::services" or "acme.com::mmdata::services:db-helpers"'),
      name: z.string().optional().describe('Display name (defaults to the last loc atom)'),
      description: z.string().optional().describe('What this section contains'),
      tags: z.array(z.string()).optional(),
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

      await db.node.upsert({
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
      });

      const urn = await nodeUrn(loc, memoryId);
      return textResult(`Node saved: ${urn}`);
    },
  );

  // ── h-find-nodes ─────────────────────────────────────────────────────────

  server.tool(
    'h-find-nodes',
    'Substring/keyword search across node name, loc, description, and tags. ALL whitespace-separated terms must appear (case-insensitive) somewhere in those fields — no semantic / vector search, no fuzzy matching, no stemming, and node BODY content is NOT indexed. Multi-word natural-language queries that don\'t share literal substrings with the corpus will return zero hits; pick discriminating keywords. Pass `query: "*"` (or `""`) to match every node — useful as a first survey before adding to a memory. To browse the tree structure, use `h-list-nodes` instead. Use `parentRel` to scope to a subtree and `memoryUrn` to scope to a memory. Soft-deleted nodes are excluded.',
    {
      query: z.string().describe('For mode:keyword (default) — whitespace-separated keywords; each must literally appear (case-insensitive) in name/loc/description/tags. For mode:vector — a natural-language query embedded and matched semantically against the memory\'s vector index (spec 033). Use "*" or "" to match all nodes (keyword survey mode).'),
      mode: z.enum(['keyword', 'vector']).optional().describe('keyword (default): substring match. vector: semantic search over the memory\'s vector index (requires the memory to have vectorIndexEnabled). Spec 033.'),
      parentRel: z.string().optional().describe('Scope search to this subtree (keyword mode)'),
      memoryUrn: z.string().optional().describe('Scope search to this memory'),
      brief: z.boolean().optional().describe('Return index info only: name, description, edges'),
      limit: z.number().optional().describe('Max results (default 50)'),
    },
    async ({ query, mode, parentRel, memoryUrn, brief, limit }) => {
      try {
        validateParentRel(parentRel);
      } catch (e) {
        if (e instanceof InvalidParentRelError) return textResult(e.message);
        throw e;
      }

      // Normalize parentRel once so validation, resolution, and scoping all
      // operate on the same string. Without this, ' review ' passes
      // validation (which trims internally) but then resolveLocFromUrn /
      // findFirst-by-loc see the whitespace-padded version and miss.
      const trimmedParentRel = parentRel?.trim();

      const memoryIds = await getAccessibleMemoryIds(db, auth);
      // Issue #180 Bug 2: exclude tombstoned nodes from the search index.
      // Before this filter, soft-deleted nodes continued to surface through
      // find/read, so callers had no reliable way to "make a node go away"
      // short of hard-deleting the row.
      const where: Record<string, unknown> = { deletedAt: null };
      if (memoryIds) where.memoryId = { in: memoryIds };

      // Scope to memory URN if provided. Spec 022 (FR-003): no fallback to
      // `activeMemoryUrn` — the caller must supply a fully-qualified memory
      // URN when scoping a search, otherwise the search runs across all
      // accessible memories (set in `where.memoryId` above). #100 #3:
      // route through resolveMemoryByUrn so a canonical 'urn:memory:' input
      // from the caller doesn't silently miss against a bare-stored
      // Memory.urn.
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
            `Memory not found or invalid: '${memoryUrn}'. Use h-list-memories to see what is available.`,
          );
        }
        // #188 (Gemini): the prior `where.memoryId = mem.id` override
        // bypassed the access-scoped filter set above — any authenticated
        // caller could search any memory by URN. Route through
        // canReadMemory so personal/private memories (FR-016 strict
        // ownership; ADMIN/OWNER do NOT bypass) and non-admin scope-map
        // gating both apply. Match h-read-node's "not found" phrasing
        // so the response doesn't distinguish absence from denial.
        if (!(await canReadMemory(db, auth, mem.id))) {
          return textResult(
            `Memory not found or invalid: '${memoryUrn}'. Use h-list-memories to see what is available.`,
          );
        }
        where.memoryId = mem.id;
      }

      // Scope to subtree if parentRel provided
      if (trimmedParentRel) {
        const resolvedParent = await resolveLocFromUrn(trimmedParentRel, memoryIds);
        where.loc = { startsWith: resolvedParent.loc };
        // #188 (Gemini): same BOLA shape as the memoryUrn branch.
        // resolveLocFromUrn already gates the URN-typed path on
        // accessibleMemoryIds, but ADMIN/OWNER pass accessibleMemoryIds
        // as null (= "see all"), which still leaks personal/private
        // memories. canReadMemory enforces both gates uniformly.
        if (resolvedParent.memoryId) {
          if (!(await canReadMemory(db, auth, resolvedParent.memoryId))) {
            return textResult(
              `Node "${trimmedParentRel}" not found.`,
            );
          }
          where.memoryId = resolvedParent.memoryId;
        }
      }

      // 033 — vector (semantic) search. Per-memory: resolves the target memory
      // set from the same scoping as keyword, then searches only the vector-
      // indexed ones. Diagnostic states are surfaced as text lines (FR-021).
      if (mode === 'vector') {
        let targetIds: string[];
        const scoped = where.memoryId as unknown;
        if (typeof scoped === 'string') {
          targetIds = [scoped];
        } else if (
          scoped &&
          typeof scoped === 'object' &&
          Array.isArray((scoped as { in?: unknown }).in)
        ) {
          targetIds = (scoped as { in: string[] }).in;
        } else {
          // Admin/all scope: restrict to vector-indexed memories explicitly.
          const all = await db.memory.findMany({
            where: { vectorIndexEnabled: true, deletedAt: null },
            select: { id: true },
          });
          targetIds = all.map((m) => m.id);
        }
        const indexed = await db.memory.findMany({
          where: { id: { in: targetIds }, vectorIndexEnabled: true, deletedAt: null },
          select: { id: true },
        });
        const indexedIds = indexed.map((m) => m.id);
        if (indexedIds.length === 0) {
          return textResult(
            'Note: this memory has no vector index — enable it on the memory to use mode:vector. [no_vector_index]\n\nFound 0 node(s).',
          );
        }
        if (!isEmbeddingConfigured()) {
          return textResult(
            'Note: vector search is unavailable — no embedding endpoint is configured. [embedding_unavailable]\n\nFound 0 node(s).',
          );
        }
        // The `query` arg's describe documents `"*"`/`""` as keyword survey
        // mode — those values are meaningless to a vector embedder (and
        // some backends reject empty input outright). Reject explicitly so
        // callers get a clear message instead of a 400/garbage-vector
        // (PR-219 review, Copilot).
        const trimmed = query.trim();
        if (trimmed === '' || trimmed === '*') {
          return textResult(
            'Note: empty or "*" queries are keyword-only (survey mode); supply a natural-language query for mode:vector. [empty_vector_query]\n\nFound 0 node(s).',
          );
        }
        const [qvec] = await getEmbeddingClient().embed([query], 'query');
        if (!qvec) {
          // Same defensive guard as the GraphQL nodeSearch path: a
          // malformed/empty embed response would TypeError downstream.
          return textResult(
            'Note: vector search is unavailable — embedding generation returned no vector. [embedding_unavailable]\n\nFound 0 node(s).',
          );
        }
        const hits = await vectorSearchNodes(db, {
          memoryIds: indexedIds,
          queryEmbedding: qvec,
          limit: limit ?? 50,
        });
        if (hits.length === 0) return textResult('Found 0 node(s).');
        const hitNodes = await db.node.findMany({
          where: { id: { in: hits.map((h) => h.nodeId) }, deletedAt: null },
        });
        const nodeById = new Map(hitNodes.map((n) => [n.id, n]));
        const vlines: string[] = [];
        for (const hit of hits) {
          const n = nodeById.get(hit.nodeId);
          if (!n) continue;
          const urn = await nodeUrn(n.loc, n.memoryId);
          // Spec 033 FR-023 — `Source: abstract-stale` marker on stale
          // abstract-vector hits. Every v1 hit is an abstract-kind hit
          // (chunks ship in US2; once they do, this needs to gate on
          // `hit.kind === 'abstract'` once vectorSearchNodes surfaces it).
          //
          // The predicate mirrors spec 032's read-time check (four clauses
          // + the load-bearing `!= null` legacy short-circuit). NOTE: we
          // do NOT apply spec 032's `!memory.isEncrypted` gate here —
          // spec 033 FR-025 calls this out explicitly: because the vector
          // and the abstractOriginHash are both stamped at write time on
          // in-closure plaintext, the predicate IS computable on encrypted
          // memories whose MCP write path stores plaintext at rest (#206).
          // A defensive `!isCiphertext(content)` skip would still let a
          // GraphQL-encrypted row (ciphertext at rest) fall through quietly
          // rather than false-positive.
          const isStale =
            n.abstract != null && n.abstract.length > 0 &&
            n.content != null && n.content.length > 0 &&
            !isCiphertext(n.content) &&
            n.abstractOriginHash != null &&
            n.abstractOriginHash !== computeContentHash(n.content);
          const parts = [`- **${urn}** — ${n.name}  (score ${hit.score.toFixed(3)})`];
          if (isStale) parts.push('  Source: abstract-stale');
          if (n.description) parts.push(`  ${n.description}`);
          if (!brief && n.abstract) {
            for (const absLine of (n.abstract as string).split(/\r?\n/)) parts.push(`  ${absLine}`);
          }
          if (n.tags?.length) parts.push(`  Tags: ${(n.tags as string[]).join(', ')}`);
          vlines.push(parts.join('\n'));
        }
        return textResult(`Found ${vlines.length} node(s):\n\n${vlines.join('\n')}`);
      }

      const allNodes = await db.node.findMany({
        where,
        take: 1000,
        // #180 Bug 2: when `brief` includes edges, hide edges whose
        // target/source is soft-deleted. The edge itself isn't soft-
        // deleted on its own column; the gate is whether the node on
        // the other end is alive.
        include: brief
          ? {
              outgoingEdges: {
                include: { target: true },
                where: { target: { deletedAt: null } },
              },
              incomingEdges: {
                include: { source: true },
                where: { source: { deletedAt: null } },
              },
            }
          : undefined,
      });
      // Deduplicate by loc: prefer canonical (isLink=false) over link nodes
      const byLoc = new Map<string, typeof allNodes[0]>();
      for (const n of allNodes) {
        const existing = byLoc.get(n.loc);
        if (!existing || (existing.isLink && !n.isLink)) byLoc.set(n.loc, n);
      }
      const nodes = Array.from(byLoc.values());
      const matches = nodes.filter((n) => matchesQuery(n, query));
      const limited = matches.slice(0, limit ?? 50);

      if (limited.length === 0) {
        return textResult(`No nodes found matching "${query}".`);
      }

      const lines = await Promise.all(limited.map(async (n: any) => {
        const urn = await nodeUrn(n.loc, n.memoryId);
        const parts = [`- **${urn}** — ${n.name}`];
        if (n.description) parts.push(`  ${n.description}`);
        // Spec 031 US2 — surface the abstract as a two-space-indented block
        // beneath the description (no `>` prefix; matches the existing
        // description-line format in this tool — h-read-node uses `>` but
        // h-find-nodes never has). Multi-paragraph abstracts get the
        // prefix on each line. Excluded from brief mode (preserves the
        // existing brief contract; index-info-only). Per PR-196 US3
        // deferral, the matchesQuery haystack is NOT extended — abstract
        // is preview-only, not searchable, until the RAG follow-up.
        if (!brief && n.abstract) {
          // `/\r?\n/` rather than `'\n'` so CRLF-terminated lines (common
          // from Windows clients / certain text areas) don't leave a
          // trailing `\r` embedded mid-output. PR-202 review.
          for (const absLine of (n.abstract as string).split(/\r?\n/)) {
            parts.push(`  ${absLine}`);
          }
        }
        if (n.tags?.length) parts.push(`  Tags: ${n.tags.join(', ')}`);
        if (brief && n.outgoingEdges?.length) {
          const edgeStrs = await Promise.all(n.outgoingEdges.map(async (e: any) => {
            const targetUrn = await nodeUrn(e.target.loc, e.target.memoryId);
            return `→ ${targetUrn} (${e.label})`;
          }));
          parts.push(`  Edges: ${edgeStrs.join(', ')}`);
        }
        return parts.join('\n');
      }));

      return textResult(`Found ${limited.length} node(s):\n\n${lines.join('\n')}`);
    },
  );

  // ── h-read-node ──────────────────────────────────────────────────────────

  server.tool(
    'h-read-node',
    "Read a node by its fully-qualified URN. The URN MUST be fully qualified (org::memory::loc). Optional `contentScope` selects what the response includes: 'content' (default) — meta block + body, with the abstract substituted into the body slot when content is null/empty (a `Source: abstract-fallback` line then appears in the meta block); 'abstract' — meta block + abstract, no body; 'all' — meta block + abstract + body. When the abstract is in the response and its origin hash disagrees with the current content's hash, the meta block also carries a `Source: abstract-stale` line — treat the abstract as a possibly-outdated preview (spec 032 FR-010; not emitted on encrypted memories in v1 — see #206). Spec 031 + 032.",
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com::mmdata::architecture" or "urn:node:acme.com::mmdata::architecture"'),
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
          appId: auth.appId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      const urn = await nodeUrn(node.loc, node.memoryId);
      const outgoingLines = await Promise.all(node.outgoingEdges.map(async (e) => {
        const targetUrn = await nodeUrn(e.target.loc, (e.target as any).memoryId);
        return `  - ${targetUrn} (${e.target.name}) — ${e.label}`;
      }));
      const incomingLines = await Promise.all(node.incomingEdges.map(async (e) => {
        const sourceUrn = await nodeUrn(e.source.loc, (e.source as any).memoryId);
        return `  - ${sourceUrn} (${e.source.name}) — ${e.label}`;
      }));
      // Spec 031 — contentScope-driven response shape. Default 'content'
      // preserves pre-spec output byte-for-byte when content is non-empty
      // (or when content AND abstract are both null). Content-fallback fires
      // ONLY under 'content' scope when content is null/empty AND abstract
      // is non-null — and ONLY then does the meta block carry a
      // `Source: abstract-fallback` line.
      //
      // Defensive enum check: zod validates the same set at the MCP
      // transport boundary, but defensive validation here catches direct-
      // handler callers (e.g. createTestableMcpServer's _registeredTools
      // shortcut, which bypasses the transport's zod parsing) and any
      // future internal caller. Constructs the typed
      // `InvalidContentScopeError` and returns its `message` as a tool-
      // result string — the class is the single source of truth for
      // both the message and any future GraphQL `extensions.code` mapping
      // (the MCP convention is "return error text," not "throw" — the
      // GraphQL surface, when it adds contentScope, would throw + the
      // formatter would map name → extensions.code).
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
      const hasContent = !!(node.content && node.content.length > 0);
      const hasAbstract = !!(node.abstract && node.abstract.length > 0);
      const isFallback = scope === 'content' && !hasContent && hasAbstract;

      // Spec 032 FR-010 — `Source: abstract-stale` marker.
      //
      // Encryption gate: the MCP read path does NOT call
      // `decryptNodesBatch` today (asymmetry tracked by #206). On an
      // encrypted memory, `node.content` may be ciphertext, and
      // `computeContentHash(ciphertext)` would compare unequal to every
      // plaintext-derived `abstractOriginHash` (false-positive on every
      // node). v1 skips the predicate on encrypted memories; the
      // encryption-parity follow-up lifts the gate by adding a decrypt
      // step before this point. Symmetric with the h-validate gate (US3).
      //
      // Scope gate: FR-010 condition e — the marker only fires under
      // scopes that surface the abstract. Default `'content'` scope
      // omits it (the abstract isn't in the response, so alarming
      // would be unrelatable). Hoisting the gate above the predicate
      // (PR-210 review) skips the hash recomputation on the default-
      // scope read path entirely — preserves byte-identical-pre-spec
      // behaviour at zero cost.
      const shouldCheckStale = scope === 'abstract' || scope === 'all';
      let includeStaleMarker = false;
      if (
        shouldCheckStale &&
        !node.memory.isEncrypted &&
        hasAbstract &&
        hasContent &&
        node.abstractOriginHash != null
      ) {
        // The explicit `abstractOriginHash != null` above is load-bearing
        // for legacy nodes — without it, `null !== "abc12345"` is `true`
        // and the marker would fire on every pre-spec-032 row.
        includeStaleMarker =
          node.abstractOriginHash !== computeContentHash(node.content);
      }

      // #186: surface nodeType so callers can tell `parent` from `info`
      // (portal rendering + tool dispatch both branch on this; without it
      // there's no way to detect a node mis-typed at creation time).
      const meta = [
        `**${node.name}**`,
        urn,
        node.description ? `> ${node.description}` : '',
        `Type: ${node.nodeType}`,
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

      // Render the response per the 12-cell matrix in
      // specs/031-node-abstract-field/contracts/h-read-node.md.
      if (scope === 'abstract') {
        // meta + abstract (no `---`, no body). Meta alone when abstract null.
        return hasAbstract
          ? textResult(`${meta}\n\n${node.abstract}`)
          : textResult(meta);
      }
      if (scope === 'all') {
        // Sections collapse cleanly when components are missing:
        //   both present  → meta + abstract + --- + content
        //   only abstract → meta + abstract  (no `---`)
        //   only content  → meta + --- + content
        //   both null     → meta alone
        const parts: string[] = [meta];
        if (hasAbstract) parts.push(node.abstract!);
        if (hasContent) parts.push(`---\n\n${node.content}`);
        return textResult(parts.join('\n\n'));
      }
      // scope === 'content' (default)
      // Body slot is filled by content when present, else by abstract
      // (fallback rule), else empty string (byte-identical pre-spec when
      // content is null AND abstract is null).
      const body = hasContent ? node.content! : isFallback ? node.abstract! : '';
      return textResult(meta + '\n\n---\n\n' + body);
    },
  );

  // ── h-read-next-node ─────────────────────────────────────────────────────

  server.tool(
    'h-read-next-node',
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
        return `  - ${targetUrn} (${e.target.name}) — ${e.label}`;
      }));
      // #186: nodeType in the meta block, mirroring h-read-node's format.
      const meta = [
        `**${node.name}**`,
        urn,
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

  // ── h-list-nodes ─────────────────────────────────────────────────────────

  server.tool(
    'h-list-nodes',
    'Browse the tree structure of a Hadron memory. Returns an indented tree view.',
    {
      parentRel: z.string().optional().describe('Parent node rel path; omit to list from memory root'),
      memoryUrn: z.string().optional().describe('Memory URN; uses active memory if not provided'),
      depth: z.number().optional().describe('Max depth to traverse (default: 1)'),
    },
    async ({ parentRel, memoryUrn, depth }) => {
      try {
        validateParentRel(parentRel);
      } catch (e) {
        if (e instanceof InvalidParentRelError) return textResult(e.message);
        throw e;
      }

      // Normalize parentRel once (matches the h-find-nodes pattern).
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
        // #188 (Gemini): canReadMemory gate matches h-find-nodes.
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
              `Memory not found or invalid: '${memoryUrn}'. Use h-list-memories to see what is available.`,
            );
          }
          // #188 (Gemini): canReadMemory gate — same shape as the
          // h-find-nodes memoryUrn branch.
          if (!(await canReadMemory(db, auth, mem.id))) {
            return textResult(
              `Memory not found or invalid: '${memoryUrn}'. Use h-list-memories to see what is available.`,
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
      const nodes = Array.from(byKey.values());

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
      const realByKey = new Map(nodes.map((n) => [dedupKey(n.memoryId, n.loc), n] as const));
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
        return `${indent}├── ${nUrn} — (missing — use h-add-parent-node to materialize)${childInfo}`;
      }));

      const header = `Tree: ${prefix || memoryUrn}`;
      return textResult(`${header}\n${lines.join('\n')}`);
    },
  );

  // Spec 031 — normalize an inbound `abstract` value before the DB write.
  // Length cap on the raw input; then trim-then-check (empty AND
  // whitespace-only collapse to null; non-empty trimmed values persist
  // untrimmed so intentional surrounding whitespace on real paragraphs
  // is lossless). `undefined` (key absent on h-update-node) is passed
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

  // ── h-add-node ───────────────────────────────────────────────────────────

  server.tool(
    'h-add-node',
    'Add a new node to the memory graph (creates or updates). The URN MUST be fully qualified (org::memory::loc). Requires write access to the memory.',
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com::mmdata::review:sort-imports" or "urn:node:acme.com::mmdata::review:sort-imports". Both bare and prefixed forms accepted. Relative-form URNs (no memory) are rejected.'),
      name: z.string().describe('Node name'),
      nodeType: z.string().optional().describe('Node type: info, data, task, record, chat, plan, parent'),
      description: z.string().optional().describe('Short description'),
      abstract: z.string().optional().describe('Paragraph-length summary (max 2000 chars). Opt-in on h-read-node via the contentScope parameter. (h-find-nodes preview surfacing of abstract ships in spec 031 US2 — not yet live.) Empty + whitespace-only values normalize to null. Spec 031.'),
      content: z.string().optional().describe('Markdown content'),
      seq: z.number().optional().describe('Sort order among siblings (lower values first)'),
      tags: z.array(z.string()).optional().describe('Tags'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
      data: z.record(z.string(), z.unknown()).optional().describe('Runtime data (e.g. stageOrder, promptRef, extractionSpec for chat config)'),
      llmModel: z.string().optional().describe('LLM model used (e.g. claude-opus-4-6)'),
      aiAgent: z.string().optional().describe('AI agent tool used (e.g. claude-code, cursor)'),
      edges: z.array(z.object({
        targetUrn: z.string().describe('Target node fully-qualified URN'),
        label: z.string().describe('Relationship label'),
      })).optional().describe('Outgoing edges'),
    },
    async ({ urn: rawUrn, name, nodeType, description, abstract, content, seq, tags, properties, data: nodeData, llmModel, aiAgent, edges }) => {
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
          edges.map((e) => ({ targetId: e.targetUrn, label: e.label })),
          memoryId,
        );
        if ('error' in r) return textResult(r.error);
        resolvedEdges = r.resolved;
      }

      const existing = await db.node.findUnique({ where: { loc_memoryId: { loc, memoryId } } });

      // Spec 031 — length-cap + trim-then-check the abstract before write.
      let normalizedAbstract: string | null;
      try {
        normalizedAbstract = normalizeAbstract(abstract) ?? null;
      } catch (e) {
        if (e instanceof NodeAbstractTooLongError) return textResult(e.message);
        throw e;
      }

      // Spec 032 — h-add-node is upsert-semantically a fresh write: every
      // call writes the full set of provided fields. If the caller is
      // supplying an abstract, the hash is recomputed from the supplied
      // content (FR-003). Null/empty content with an abstract yields null
      // hash (FR-007). No abstract → no hash (FR-006). Hash is computed
      // on plaintext content (FR-009).
      const nextAbstractOriginHash: string | null =
        normalizedAbstract !== null ? computeContentHash(content ?? null) : null;

      const upserted = await db.node.upsert({
        where: { loc_memoryId: { loc, memoryId } },
        create: {
          id: existing?.id ?? generateId(),
          memoryId,
          loc,
          name,
          nodeType: nodeType ?? 'info',
          description: description ?? null,
          abstract: normalizedAbstract,
          abstractOriginHash: nextAbstractOriginHash,
          content: content ?? null,
          seq: seq ?? null,
          tags: tags ?? [],
          properties: properties as any ?? undefined,
          data: nodeData as any ?? undefined,
          llmModel: llmModel ?? null,
          aiAgent: aiAgent ?? null,
          createdBy: auth.clientId ?? null,
        },
        update: {
          name,
          ...(nodeType ? { nodeType } : {}),
          description: description ?? null,
          abstract: normalizedAbstract,
          abstractOriginHash: nextAbstractOriginHash,
          content: content ?? null,
          seq: seq ?? null,
          tags: tags ?? [],
          ...(properties !== undefined ? { properties: properties as any } : {}),
          ...(nodeData !== undefined ? { data: nodeData as any } : {}),
          ...(llmModel ? { llmModel } : {}),
          ...(aiAgent ? { aiAgent } : {}),
        } as any,
      });

      if (resolvedEdges !== null) {
        await replaceOutgoingEdges({
          sourceNodeId: upserted.id,
          resolved: resolvedEdges,
          createdBy: auth.clientId ?? null,
        });
      }

      // Resolve any PendingEdges waiting for this node (by ID or loc)
      const pendingByLoc = await db.pendingEdge.findMany({ where: { targetId: loc } });
      const pendingById = await db.pendingEdge.findMany({ where: { targetId: upserted.id } });
      for (const p of [...pendingByLoc, ...pendingById]) {
        await db.edge.upsert({
          where: { sourceId_targetId_label: { sourceId: p.sourceId, targetId: upserted.id, label: p.label ?? '' } },
          create: { id: generateId(), sourceId: p.sourceId, targetId: upserted.id, label: p.label ?? '' },
          update: {},
        });
        await db.pendingEdge.delete({ where: { id: p.id } });
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          id: generateId(),
          type: 'write',
          nodeLoc: loc,
          nodeId: upserted.id,
          appId: auth.appId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      // Write to git (fire-and-forget)
      const nodeForGit = await db.node.findUnique({
        where: { id: upserted.id },
        include: { outgoingEdges: { include: { target: true } } },
      });
      if (nodeForGit) {
        writeNodeToGit({
          id: nodeForGit.id,
          loc: nodeForGit.loc,
          name: nodeForGit.name,
          alias: nodeForGit.alias,
          description: nodeForGit.description,
          abstract: nodeForGit.abstract,
          abstractOriginHash: nodeForGit.abstractOriginHash,
          content: nodeForGit.content,
          tags: nodeForGit.tags as string[],
          outgoingEdges: nodeForGit.outgoingEdges ?? [],
        }, '', auth.clientId, memoryId).catch((err) => {
          console.error('[h-add-node] git write error:', err);
        });
      }

      // 033 — (re-)embed on write. MCP stores plaintext on the row (#206), and
      // `content`/`normalizedAbstract` are plaintext here.
      void enqueueNodeEmbedding(db, {
        nodeId: upserted.id,
        memoryId,
        plaintext: { content: content ?? null, abstract: normalizedAbstract },
      });

      const savedUrn = await nodeUrn(loc, memoryId);
      return textResult(`Node saved: ${savedUrn}`);
    },
  );

  // ── h-update-node ────────────────────────────────────────────────────────

  server.tool(
    'h-update-node',
    'Partially update an existing node. Only the fields you provide are changed — everything else is preserved. The URN MUST be fully qualified (org::memory::loc).',
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com::mmdata::review:sort-imports"'),
      name: z.string().optional().describe('New node name'),
      nodeType: z.string().optional().describe('Node type: info, data, task, record, chat, plan, parent'),
      description: z.string().optional().describe('New short description'),
      abstract: z.string().nullable().optional().describe('New paragraph-length summary (max 2000 chars). Pass `null` to clear; omit to preserve. Empty + whitespace-only normalize to null. Surfaced on h-read-node via contentScope; h-find-nodes preview surfacing ships in spec 031 US2. Spec 031.'),
      content: z.string().nullable().optional().describe('New markdown content. Pass `null` to clear; omit to preserve. Spec 032 widened the schema from string-only to allow null per the consistent partial-update convention; clearing content interacts with abstractOriginHash maintenance (FR-006/FR-007).'),
      seq: z.number().optional().describe('New sort order among siblings'),
      tags: z.array(z.string()).optional().describe('Replace tags'),
      properties: z.record(z.string(), z.unknown()).optional().describe('Structured key-value properties'),
      data: z.record(z.string(), z.unknown()).optional().describe('Runtime data (e.g. stageOrder, promptRef, extractionSpec for chat config)'),
      llmModel: z.string().optional().describe('LLM model used'),
      aiAgent: z.string().optional().describe('AI agent tool used'),
      edges: z.array(z.object({
        targetUrn: z.string().describe('Target node fully-qualified URN'),
        label: z.string().describe('Relationship label'),
      })).optional().describe('Replace outgoing edges'),
      reason: z.string().optional().describe('Why this change was made (stored in version history)'),
    },
    async ({ urn: rawUrn, name, nodeType, description, abstract, content, seq, tags, properties, data: nodeData, llmModel, aiAgent, edges, reason }) => {
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

      const existing = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
      });
      if (!existing) {
        return textResult(`Node not found: "${rawUrn}"`);
      }

      if (!(await canWriteToMemory(db, auth, existing.memoryId))) {
        return textResult('Write access denied for this memory.');
      }

      // Resolve edge targets BEFORE the version snapshot + node update
      // so an unresolvable target rolls back cleanly with no source-
      // node mutation. Issue #107 review feedback.
      //
      // Spec 022: pre-validate edge URN qualification (matches h-add-node).
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
          edges.map((e) => ({ targetId: e.targetUrn, label: e.label })),
          existing.memoryId,
        );
        if ('error' in r) return textResult(r.error);
        resolvedEdges = r.resolved;
      }

      // Spec 031 — length-cap + trim-then-check the abstract BEFORE the
      // version snapshot, so an over-cap abstract aborts cleanly without
      // mutating either the row or the version history.
      let normalizedAbstract: string | null | undefined;
      try {
        normalizedAbstract = normalizeAbstract(abstract);
      } catch (e) {
        if (e instanceof NodeAbstractTooLongError) return textResult(e.message);
        throw e;
      }

      // Snapshot current state for version history.
      // Spec 032 — capture existing.abstractOriginHash so the version
      // history round-trips the staleness signal.
      await db.nodeVersion.create({
        data: {
          id: generateId(),
          nodeId: existing.id,
          loc: existing.loc,
          name: existing.name,
          alias: existing.alias,
          description: existing.description,
          abstract: existing.abstract,
          abstractOriginHash: existing.abstractOriginHash,
          content: existing.content,
          tags: existing.tags as string[],
          editedBy: reason ?? (auth.clientId ?? null),
          createdBy: auth.clientId ?? null,
        },
      }).catch(() => {});

      // Spec 032 — abstractOriginHash partial-update matrix (9 rows from
      // the contract). Drives off whether `normalizedAbstract` was
      // supplied (undefined = preserve, null = clear, string = set).
      //
      // Encryption posture: MCP write path stores content plaintext
      // today (encryption parity for MCP is deferred — see #206), so
      // `existing.content` IS plaintext. Hash always computed on
      // plaintext per FR-009.
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

      if (Object.keys(data).length > 0) {
        await db.node.update({ where: { id: existing.id }, data });
      }

      if (resolvedEdges !== null) {
        await replaceOutgoingEdges({
          sourceNodeId: existing.id,
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
          appId: auth.appId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
        },
      }).catch(() => {});

      // Write to git (fire-and-forget)
      const updatedNode = await db.node.findUnique({
        where: { id: existing.id },
        include: { outgoingEdges: { include: { target: true } } },
      });
      if (updatedNode) {
        writeNodeToGit({
          id: updatedNode.id,
          loc: updatedNode.loc,
          name: updatedNode.name,
          alias: updatedNode.alias,
          description: updatedNode.description,
          abstract: updatedNode.abstract,
          abstractOriginHash: updatedNode.abstractOriginHash,
          content: updatedNode.content,
          tags: updatedNode.tags as string[],
          outgoingEdges: updatedNode.outgoingEdges ?? [],
        }, '', auth.clientId, existing.memoryId).catch((err) => {
          console.error('[h-update-node] git write error:', err);
        });
      }

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
      return textResult(`Node updated: ${updatedUrn}`);
    },
  );

  // ── h-add-edge ───────────────────────────────────────────────────────────
  //
  // Issue #183 — h-update-node.edges replaces the full outgoing-edge set,
  // which means the only way to add a single edge to an existing node
  // without h-add-edge is to re-send EVERY existing edge plus the new
  // one. Easy to drop edges by accident. This tool fills that gap with
  // an idempotent single-edge upsert that leaves all other edges alone.

  server.tool(
    'h-add-edge',
    'Add a single outgoing edge from one node to another. Non-destructive — leaves all other edges on the source node intact (unlike h-update-node, which replaces the full edge set). Idempotent: re-running with the same (source, target, label) is a no-op. The source URN MUST be a fully-qualified node URN (org::memory::loc) — ID-shape sources are rejected because the write-permission check needs the source memory, which is derived from the URN. The target URN may be fully-qualified OR an ID-shape value. Both endpoints must already exist — use h-add-node first to create them. Cross-memory edges are supported, but the caller must have read access on the target memory.',
    {
      sourceUrn: z.string().describe('Fully-qualified source node URN, e.g. "acme.com::mmdata::services:db-helper". ID-shape sources are not accepted (the source\'s memory must be recoverable from the URN for the permission check). The source node must already exist; this tool will not create it.'),
      targetUrn: z.string().describe('Fully-qualified target node URN OR an ID-shape value. The target must already exist; use h-add-node first if it does not.'),
      label: z.string().describe('Relationship label, e.g. "depends-on", "documents", "supersedes".'),
    },
    async ({ sourceUrn, targetUrn, label }) => {
      const result = await addEdge({ sourceUrn, targetUrn, label, auth });
      if ('error' in result) return textResult(result.error);
      return textResult(
        `Edge saved: ${result.sourceUrn} → ${result.targetUrn} (${result.label})`,
      );
    },
  );

  // ── h-delete-node ────────────────────────────────────────────────────────
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
  //   - NodeVersion: onDelete: Cascade.
  //   - UsageEvent.nodeId: SetNull — audit history preserved.
  //
  // Cross-memory edge gate (hard-delete only): if any edge bridges this
  // memory to another and either endpoint is in the to-be-deleted set,
  // the call refuses without `cascadeCrossMemoryEdges: true`. The caller
  // has write access here but NOT necessarily to the other memory;
  // cascading would silently mutate data the caller doesn't own.
  //
  // Atomicity: descendant-count → refuse-or-act runs inside a single
  // db.$transaction so a descendant created mid-flight either appears
  // in the recursive scope or causes the refusal to fire — never a
  // half-complete state where the descendant is silently orphaned.

  server.tool(
    'h-delete-node',
    `Delete a node. Soft-delete by default (sets deletedAt; node disappears from find/read/list and is excluded from Related / Referenced-by edge surfaces). Pass \`hard: true\` to remove the row entirely.

Hard-delete cascades to Edge (both directions) and NodeVersion via FK. PendingEdge source-side rows also cascade via FK, but the target-side column is intentionally not a foreign key — those rows are deleted explicitly inside the same transaction. UsageEvent.nodeId is SetNull so audit history is preserved.

Refuses if the node has descendants under its URN prefix unless \`recursive: true\`. Hard-delete additionally refuses if any edge bridges this memory to another (the caller doesn't necessarily own the other memory) unless \`cascadeCrossMemoryEdges: true\`. The URN MUST be fully qualified (org::memory::loc).`,
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com::mmdata::review:sort-imports".'),
      hard: z.boolean().optional().describe('Default false (soft-delete). Pass true to delete the row entirely; cascades to Edge and NodeVersion via FK and explicitly cleans up PendingEdge target-side rows. Irreversible.'),
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

  // ── h-move-node ──────────────────────────────────────────────────────────

  server.tool(
    'h-move-node',
    `Move or rename a node, optionally across memories. The node keeps its stable ID so all edge references remain valid. Both URNs MUST be fully qualified (org::memory::loc).

Collision policy: if a live node already occupies \`targetUrn\`, the call refuses with a URN_ALREADY_EXISTS error. Pass \`overwrite: true\` to soft-delete the existing target first; the evicted row is re-stamped to \`<loc>__deleted-<full-id>\` so the unique \`(loc, memoryId)\` constraint doesn't block. Hard-overwrite isn't supported — call h-delete-node (hard: true) on the target first if you need that.

Descendants of the source node are NOT moved automatically — they remain at their original locs and become children of an implicit parent at the old prefix. Move them explicitly if needed.

Atomicity: collision-evict → NodeVersion snapshot → row move all run inside a single db.$transaction so a partial failure cannot leave the URN slot empty.

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

      // Transactional core. Collision-check, eviction-re-stamp, NodeVersion
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

      const result: MoveResult = await db.$transaction(async (tx) => {
        if (!isSameSlot) {
          const existingTarget = await tx.node.findUnique({
            where: { loc_memoryId: { loc: toLoc, memoryId: toMemory.id } },
          });
          if (existingTarget && !existingTarget.deletedAt && !overwrite) {
            const targetUrn = await nodeUrn(toLoc, toMemory.id);
            return { refused: 'urn-exists', targetUrn };
          }
          if (existingTarget) {
            // Re-stamp the occupant out of the way. Use the FULL id —
            // UUIDv7's first 6 bytes are the ms timestamp, so the
            // previous 8-char slice was timestamp-only entropy and two
            // nodes ever stamped within a ~65s window of timestamp-
            // collision-territory shared the same suffix. PR-189 review
            // flagged this as exactly the failure mode this collision-
            // policy work was meant to eliminate.
            const archivedLoc = `${toLoc}__deleted-${existingTarget.id}`;
            await tx.node.update({
              where: { id: existingTarget.id },
              data: {
                loc: archivedLoc,
                ...(existingTarget.deletedAt
                  ? {}
                  : {
                      deletedAt: new Date(),
                      deletedBy: auth.userId ?? auth.clientId ?? null,
                    }),
              },
            });
          }
        }

        // NodeVersion snapshot of the pre-move state — mirrors the
        // pattern h-update-node already follows. Loc / name / memoryId
        // changes are audit-worthy. Spec 031 — `abstract` is included so
        // version history captures the pre-move state in full. Spec 032
        // — `abstractOriginHash` joins on the same logic (every snapshot
        // site must include new columns; spec 031 lesson).
        await tx.nodeVersion.create({
          data: {
            id: generateId(),
            nodeId: existing.id,
            loc: existing.loc,
            name: existing.name,
            alias: existing.alias,
            description: existing.description,
            abstract: existing.abstract,
            abstractOriginHash: existing.abstractOriginHash,
            content: existing.content,
            tags: existing.tags as string[],
            editedBy: auth.clientId ?? null,
            createdBy: auth.clientId ?? null,
          },
        });

        const newName = toLoc.split(':').pop()!;

        // Move BY ID — see comment above the transaction.
        const moved = await tx.node.update({
          where: { id: existing.id },
          data: { loc: toLoc, name: newName, memoryId: toMemory.id },
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

        const childCount = await tx.node.count({
          where: {
            memoryId: toMemory.id,
            loc: { startsWith: toLoc + ':' },
            deletedAt: null,
          },
        });

        return { ok: true, moved, childCount };
      });

      const fromUrn = await nodeUrn(fromLoc, fromMemory.id);
      const toUrn = await nodeUrn(toLoc, toMemory.id);

      if ('refused' in result) {
        return textResult(
          `URN_ALREADY_EXISTS: A live node already occupies "${result.targetUrn}". ` +
            `Pass overwrite: true to soft-delete it first and move into its place, ` +
            `or use h-delete-node (hard: true) to compact it before retrying.`,
        );
      }

      const { moved, childCount } = result;

      // Empty sections omitted, matching h-read-node's pattern (PR-189
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
        lines.push(
          `Children: ${childCount} immediate descendant(s) (NOT moved — still under the old prefix).`,
        );
      }

      return textResult(lines.join('\n'));
    },
  );

  // ── h-run-action ─────────────────────────────────────────────────────────

  server.tool(
    'h-run-action',
    'Load an action node and resolve its dependencies. Returns the action instructions with all referenced node content. The URN MUST be fully qualified (org::memory::loc).',
    {
      urn: z.string().describe('Fully-qualified node URN, e.g. "acme.com::mmdata::actions:review"'),
      args: z.record(z.string(), z.string()).optional().describe('Action arguments as key-value pairs'),
    },
    async ({ urn: rawUrn, args }) => {
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

      const node = await db.node.findUnique({
        where: { loc_memoryId: { loc, memoryId: memory.id } },
        include: { outgoingEdges: { include: { target: true } } },
      });
      if (!node) return textResult(`Node "${rawUrn}" not found.`);

      let actionContent = node.content || '';

      // Substitute args
      if (args) {
        for (const [key, value] of Object.entries(args)) {
          actionContent = actionContent.replaceAll(`{{${key}}}`, value);
        }
      }

      // Resolve referenced node content from edges
      const topicSections: string[] = [];
      for (const edge of node.outgoingEdges) {
        const target = edge.target;
        if (target.content) {
          const targetUrn = await nodeUrn(target.loc, (target as any).memoryId);
          topicSections.push(
            `## Node: ${target.name} (${targetUrn})\n\n${target.content}`,
          );
        }
      }

      // Record usage event
      db.usageEvent.create({
        data: {
          id: generateId(),
          type: 'action-run',
          nodeLoc: loc,
          nodeId: node.id,
          appId: auth.appId ?? null,
          createdBy: auth.clientId ?? null,
          sessionId: null,
          actionArgs: (args ?? undefined) as Record<string, string> | undefined,
        },
      }).catch(() => {});

      const parts = [`# Node: ${node.name}\n\n${actionContent}`];
      if (topicSections.length > 0) {
        parts.push(
          '---\n\n# Referenced Nodes\n\n' + topicSections.join('\n\n---\n\n'),
        );
      }
      return textResult(parts.join('\n\n'));
    },
  );

  // ── h-start-session ──────────────────────────────────────────────────────

  server.tool(
    'h-start-session',
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

  // ── h-end-session ────────────────────────────────────────────────────────

  server.tool(
    'h-end-session',
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
      // Spec 026 / D-2026-05-21-003 strict tool: paired with h-start-session.
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

  // ── h-validate ───────────────────────────────────────────────────────────

  server.tool(
    'h-validate',
    'Check a memory for broken edge references, sparse nodes, and stale-abstract warnings (spec 032 FR-011 — abstract no longer reflects current content). The memory URN MUST be fully qualified. On encrypted memories the stale-abstract check is skipped in v1 (h-validate does not decrypt; tracked by #206).',
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
      // h-validate does NOT call decryptNodesBatch, so on encrypted
      // memories `node.content` is ciphertext and
      // `computeContentHash(ciphertext)` would compare unequal to every
      // plaintext-derived abstractOriginHash (false-positive on every
      // node). v1 skips the check; the #206 encryption-parity follow-up
      // adds a decrypt step before this loop. Symmetric with the
      // h-read-node gate (US2). Riding the existing nodes findMany
      // (memory column auto-projected via separate findUnique) keeps
      // the wider blast radius of changing resolveMemoryByUrn contained.
      const memEnc = await db.memory.findUnique({
        where: { id: memory.id },
        select: { isEncrypted: true },
      });
      const checkStale = !memEnc?.isEncrypted;

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
            issues.push(`[broken-ref] ${nUrn} → id:${edge.targetId} (${edge.label})`);
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
        // h-read-node predicate (US2). The explicit `abstractOriginHash
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
      }

      if (issues.length === 0) {
        return textResult(`Validated ${nodes.length} nodes. No issues found.`);
      }
      return textResult(
        `Found ${issues.length} issue(s) in ${nodes.length} nodes:\n\n${issues.join('\n')}`,
      );
    },
  );

  // ── h-sync-graph ─────────────────────────────────────────────────────────

  server.tool(
    'h-sync-graph',
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

  // ── h-chat-start ─────────────────────────────────────────────────────

  server.tool(
    'h-chat-start',
    'Start a new chat session with an agent. Returns the chat ID, compiled system prompt, tool schema, conversation name, and first stage. The LLM should use the system prompt and tools to generate a welcome message, then call h-chat-process with the result.',
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

  // ── h-chat-send ──────────────────────────────────────────────────────

  server.tool(
    'h-chat-send',
    "Send a user message in an existing chat. Returns the recompiled system prompt for the current stage, tool schema, message history, and whether summarization is needed. Use the returned prompt + tools to generate the assistant's response, then call h-chat-process.",
    {
      chatId: z.string().describe('Chat ID returned by h-chat-start (e.g. "chats:20260417-abc12345-onboarding")'),
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

  // ── h-chat-process ───────────────────────────────────────────────────

  server.tool(
    'h-chat-process',
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

  // ── h-chat-get-routing-map ───────────────────────────────────────────

  server.tool(
    'h-chat-get-routing-map',
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
          label: e.label,
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

  // ── h-chat-get-route-history ──────────────────────────────────────────

  server.tool(
    'h-chat-get-route-history',
    'Get the route history and goal stack for a chat. Shows where the chat has been and what goals are active.',
    {
      chatId: z.string().describe('Chat ID'),
    },
    async ({ chatId }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
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

  // ── h-chat-push-goal ──────────────────────────────────────────────────

  server.tool(
    'h-chat-push-goal',
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

  // ── h-chat-pop-goal ───────────────────────────────────────────────────

  server.tool(
    'h-chat-pop-goal',
    'Complete the current goal and return to the previous one. Use this when a detour conversation has finished its purpose.',
    {
      chatId: z.string().describe('Chat ID'),
    },
    async ({ chatId }) => {
      // Spec 026 / D-2026-05-21-003 strict tool.
      const appScopeError = requireAppScope();
      if (appScopeError) return appScopeError;
      try {
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

  // ── h-chat-add-training-entry ───────────────────────────────────────

  server.tool(
    'h-chat-add-training-entry',
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

  // ── h-chat-define-persona ───────────────────────────────────────────

  server.tool(
    'h-chat-define-persona',
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

  // ── h-chat-list-personas ──────────────────────────────────────────

  server.tool(
    'h-chat-list-personas',
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

        if (personas.length === 0) return textResult('No test personas defined. Use h-chat-define-persona to create one.');

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

  // ── h-chat-run-persona ────────────────────────────────────────────

  server.tool(
    'h-chat-run-persona',
    'Run a test persona through the chatbot in "dry run" mode. This starts a chat as the persona, sends their opening message, and returns the chatbot\'s compiled prompt + tool schema so the client LLM can generate the response. Call h-chat-process with the response, then call this tool again with the next follow-up message. Use this iteratively to walk through the full conversation.\n\nWorkflow:\n1. Call h-chat-run-persona to start (sets up chat, sends opening message)\n2. Read the returned prompt, generate a chatbot response as the client LLM\n3. Call h-chat-process with the response\n4. Call h-chat-run-persona again with step=1 (next follow-up)\n5. Repeat until all follow-ups are done or the conversation ends\n\nAt the end, call h-chat-get-route-history to see the full path taken.',
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
            instruction: 'Generate a chatbot response based on the systemMessage and tools above. Then call h-chat-process with chatId, message, data, and next_stage. After that, call h-chat-run-persona with step=1 to send the next follow-up.',
          }, null, 2));
        }

        // Follow-up steps
        if (!chatId) return textResult('chatId is required for follow-up steps.');
        const followUpIdx = currentStep - 1;

        if (followUpIdx >= followUps.length) {
          // All follow-ups done — generate the test report
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
          instruction: `Generate a chatbot response for: "${userMessage}". Then call h-chat-process, then h-chat-run-persona with step=${currentStep + 1}.`,
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
 * regime (c) (session-scoped, set by the `h-set-active-app` tool).
 * Keyed by transport `sessionId`. Cleaned up in `transport.onclose`
 * alongside `transports.delete(sid)`. Single-replica only per spec 026
 * §Clarifications Q3; horizontal scale-out requires either sticky
 * sessions or persistent `McpSessionState` first.
 */
const activeAppByMcpSession = new Map<
  string,
  { appId: string; organizationId: string }
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
  //   the user can call `h-list-apps` + `h-set-active-app` to pick an App.
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
      auth.organizationId = cachedAppResolution.organizationId;
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
  res.status(200).json({ ok: true });
}
