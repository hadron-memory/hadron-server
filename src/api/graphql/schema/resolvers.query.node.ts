import { normalizeFindNodesPaging } from '../../../lib/findNodesPaging.js';
import { readCompiledRevision } from '../../../lib/bootCompile/provenance.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE } from '../../../lib/bootPrompt.js';
import { liveTxContext, liveReadSnapshotContext } from './authorizedTx.js';
import { withReconciledNodeRead } from '../../../lib/includes/reconciledNodeRead.js';
import { markBatchReadNodes } from './resolvers.nodeBatchEdges.js';
// nodeQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { contentScopeWhere, effectiveContentScope, type ContentScope } from '../../../lib/comments/scope.js';
import { isConcealedCommentHistory } from './resolvers.comments.js';
import { COMMENT_NODE_TYPE } from '../../../lib/comments/index.js';
import { effectiveScope, findEffectiveNodeIdByLoc, markInherited, retainEffective, stillInherited, type InheritedFrom } from '../../../lib/effectiveSystemMemory.js';
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
  getEmbeddingClient,
  isEmbeddingConfigured,
} from '../../../lib/embedding/index.js';
import { composeHybridRanking, hybridKeywordCandidates } from '../../../lib/retrieval/hybrid.js';
import { emitNodeUrnV2, bestEffortFlatNodeUrn } from '../../../lib/urnEmit.js';
import { getRetrievalProvider } from '../../../lib/retrieval/postgres.js';
import { BooleanQueryError, literalQuery, relaxConjunctionToOr } from '../../../lib/retrieval/tsquery.js';
import {
  compileNodeWhere,
  compileNodePropertySort,
  makePropertySortComparator,
  NodeWhereError,
  type NodeWhere,
  type NodePropertySort,
} from '../../../lib/retrieval/nodeWhere.js';
import type { LexicalField, BrowseSort, NodeSqlFilter } from '../../../lib/retrieval/provider.js';
import { expandWithNeighbors } from '../../../lib/search.js';
import { decryptNodesBatch } from '../../../lib/nodeCrypto.js';
import { decryptReadableRevisions } from '../../../lib/nodeRevisionRead.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { sortSiblings } from '../../../lib/siblingOrder.js';
import { escapePrismaLikePattern } from '../../../lib/literalLocPrefix.js';
import {
  parseUrnInput,
  validateUrnType,
  splitNodeUrn,
} from '../../../lib/urn.js';
import { compileTemplate } from '../../../lib/template.js';
import { resolveNodeContent } from '../../../lib/includes/resolveNodeContent.js';
import { assembleRunNodePrompt } from '../../../lib/runNodeRender.js';
import { resolveAgentRef } from '../../../lib/entityRef/agentRef.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { appMemoryScopePage, resolveAppNodeScope } from './resolvers.appMemoryScope.js';
// Spec 049 Phase 3 — the search ladder's GraphQL entry + disclosure envelope.
import { resolveNamedScopeForQuery, scopeInfoOf, mergeDegraded as mergeDegradedCodes, SCOPE_NARROWED } from '../../../lib/scopes.js';
import { resolveAppRunRef } from '../../../lib/entityRef/appRunRef.js';
import { resolveWorkerRef } from '../../../lib/entityRef/workerRef.js';
import { requireWorkerReadAccess } from './resolvers.worker.js';
import { resolveNodeRevRef } from '../../../lib/entityRef/nodeRevRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { MemoryNotFoundError } from '../../../lib/asset/gate.js';
import { resolveNodeRefForCaller } from './resolvers.nodeRefAccess.js';
import { recoveryMemoryIds } from './resolvers.recovery.js';
import { AmbiguousLegacyUrnError, NodeNotFoundError } from '../../../lib/entityRef/errors.js';
import { resolveOrgRef } from '../../../lib/entityRef/orgRef.js';
import { resolveUserRef } from '../../../lib/entityRef/userRef.js';
import { isId } from '../../../lib/entityRef/shape.js';
import { GraphQLError } from 'graphql';
import {
  deserializeTags,
  tagsFilter,
} from '../../../integrations/db/provider.js';
import {
  type Context,
  ROLE_ORDER,
  requireRole,
  requireOrgRole,
  isOwnerOrOrgMember,
  canReadMemoryRecord,
  getAccessibleMemoryIds,
  pageArgs,
  pageEnvelope,
  memoryAccessFilter,
  isMemoryReadableCached,
  loadMemoryUrn,
  CONTENT_RAW_DEFAULT,
} from './resolvers.helpers.js';
import { getMemberOrgIds } from '../../../lib/auth/memberOrgIds.js';
import {
  recordNodeRead,
  recordNodeUsage,
  toUsageNodeRef,
  toUsageNodeRefs,
} from '../../../lib/usageRecorder.js';
import { approvalStatePrismaWhere, mintedPrismaWhere, type NodeApprovalState } from '../../../lib/nodeApproval.js';
import { LIVE_ORG_MEMBERSHIP } from '../../../lib/auth/liveOrgMembership.js';
import { INDEXED_MEMORY_WHERE } from '../../../lib/embedding/indexing.js';

/** findNodes' arguments (cor:api:090), shared by the resolver and its spec-049 scope wrapper. */
export interface FindNodesArgs {
  /** Internal object-store request only, not a GraphQL/MCP search argument. Counts no-query browse matches. */
  includeTotal?: boolean;
  query?: string | null;
  mode?: 'keyword' | 'vector' | 'hybrid' | 'regex' | null;
  minScore?: number | null;
  filter?: {
    memoryIds?: string[] | null;
    memoryClasses?: string[] | null;
    nodeType?: string | null;
    /** #1608 — CONTENT (default) | COMMENTS | ALL (cor:dmo:110:08). */
    contentScope?: ContentScope | null;
    objectType?: string | null;
    tags?: string[] | null;
    isRunnable?: boolean | null;
    role?: string | null;
    locPrefix?: string | null;
    createdBy?: string | null;
    updatedAfter?: string | null;
    updatedBefore?: string | null;
    includeDeleted?: boolean | null;
    where?: NodeWhere | null;
    /** #1591 */
    approvalState?: NodeApprovalState | null;
    /** #1591 */
    minted?: boolean | null;
  } | null;
  fields?: string[] | null;
  sort?: 'relevance' | 'loc' | 'seq' | 'updatedAt' | null;
  sortProperty?: NodePropertySort | null;
  expand?: number | null;
  granularity?: 'node' | 'chunk' | null;
  orgId?: string | null;
  limit?: number | null;
  offset?: number | null;
}

/**
 * The admission shared by `nodeRevisions` and `nodeRevisionsPage` (#2212 A1): READER, a node ref that
 * resolves for the caller (a genuine miss collapses to the empty answer; a malformed ref propagates), a
 * live node, read on its CURRENT memory (#602) and no concealed comment history (#1663). `null` is the
 * empty answer. `canRead` is the per-snapshot memory gate; `accessible` (null = unrestricted) is the set
 * it tests, for callers that push it into SQL.
 */
export async function nodeRevisionsScope(ctx: Context, nodeRef: string) {
  requireRole(ctx, 'READER');
  // cor:api:140 / 007-entity-id-or-urn: nodeRef may be an ID or a fully-
  // qualified node URN. A genuine miss collapses to [] (no existence
  // disclosure); a malformed / unqualified URN propagates — mirrors
  // memoryUsageSummary / resolveReadableMemoryId.
  let nodeId: string;
  try {
    ({ id: nodeId } = await resolveNodeRefForCaller(ctx, nodeRef));
  } catch (e) {
    if (e instanceof NodeNotFoundError) return null;
    throw e;
  }
  // Access control (#602): this resolver previously had NO gate — any
  // authenticated caller could read any tenant's node revision history.
  const node = await ctx.db.node.findUnique({ where: { id: nodeId }, select: { memoryId: true } });
  if (!node) return null;
  // Full accessible-memory set for the principal (null = unrestricted).
  // getAccessibleMemoryIds encodes the principal + memory-class rules
  // (spec 034). We gate the node's CURRENT memory AND each snapshot's
  // memory: a node MOVED across memories keeps its stable id (moveNode),
  // so its history can hold snapshots captured while it lived in a memory
  // the caller can't read (#602 / Codex P1) — gating the current memory
  // alone would leak those.
  const accessible = await getAccessibleMemoryIds(ctx);
  const canRead = (memId: string) => accessible === null || accessible.includes(memId);
  // No read on the current memory ⇒ empty (no existence disclosure, matching memoryUsageSummary).
  if (!canRead(node.memoryId)) return null;
  // #1663 — a comment stub's history is for memory managers.
  if (await isConcealedCommentHistory(ctx, nodeId)) return null;
  return { nodeId, memoryId: node.memoryId, accessible, canRead };
}

export const nodeQueries = {
    /** #2046 P5: provenance belongs to a compiled revision, never its latest derived edge. */
    compiledPromptProvenance: async (
      _: unknown,
      args: { nodeRef: string; revNo: number; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => ctx.db.$transaction(async (tx) => {
      // One read-only snapshot for admission, revision identity, and pruning observations.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const fresh = await liveReadSnapshotContext(ctx, tx);
      const scope = await nodeRevisionsScope(fresh, args.nodeRef);
      if (!scope) return null;
      const node = await tx.node.findUnique({ where: { id: scope.nodeId }, select: { nodeType: true } });
      if (node?.nodeType !== COMPILED_BOOT_PROMPT_NODE_TYPE) return null;
      if (!Number.isInteger(args.revNo) || args.revNo < 1) return null;
      // Numbered snapshots are unique by (nodeId, revNo). Unknown snapshot ownership
      // cannot authorize this provenance read, even when the live node is readable.
      const historical = await tx.nodeRevision.findUnique({
        where: { nodeId_revNo: { nodeId: scope.nodeId, revNo: args.revNo } }, select: { memoryId: true },
      });
      if (historical && (!historical.memoryId || !scope.canRead(historical.memoryId))) return null;
      const revision = await readCompiledRevision(tx, scope.nodeId, args.revNo);
      if (!revision) return null;
      const { take, skip } = pageArgs(args);
      const occurrences = revision.provenance.occurrences.slice(skip, skip + Math.min(100, take));
      // Only the requested page's source revision identities are looked up. No source body or
      // related entity object is exposed; recorded IDs/hashes/settings are the compiled artifact.
      const ids = [...new Set(occurrences.map((o) => o.nodeId))];
      const sourceScopes = new Map(await Promise.all(ids.map(async (id) =>
        [id, await nodeRevisionsScope(fresh, id)] as const)));
      const readableIds = ids.filter((id) => sourceScopes.get(id));
      const readableOccurrences = occurrences.filter((o) => sourceScopes.get(o.nodeId));
      const [current, history] = await Promise.all([
        tx.node.findMany({ where: { id: { in: readableIds } }, select: { id: true, revSeq: true } }),
        readableOccurrences.length ? tx.nodeRevision.findMany({
          where: { OR: readableOccurrences.map((o) => ({ nodeId: o.nodeId, revNo: o.revNo })) },
          select: { nodeId: true, revNo: true, memoryId: true },
        }) : Promise.resolve([]),
      ]);
      const currentRevs = new Map(current.map((n) => [n.id, n.revSeq]));
      // Numbered snapshots are unique by (nodeId, revNo); no row-order selection.
      const retained = new Map(history.map((row) => [`${row.nodeId}:${row.revNo}`, row]));
      const pruningStatus = (o: typeof occurrences[number]) => {
        const sourceScope = sourceScopes.get(o.nodeId);
        if (!sourceScope) return null;
        if (currentRevs.get(o.nodeId) === o.revNo) return false;
        const snapshot = retained.get(`${o.nodeId}:${o.revNo}`);
        if (snapshot && (!snapshot.memoryId || !sourceScope.canRead(snapshot.memoryId))) return null;
        return !snapshot;
      };
      const items = occurrences.map((o) => ({
        order: o.order, depth: o.depth, parent: o.parent, kind: o.kind,
        nodeId: o.nodeId, revNo: o.revNo, hash: o.hash,
        replacesNodeId: o.replacesNodeId ?? null,
        position: o.position ? { line: o.position.line, column: o.position.column } : null,
        selection: { rev: o.selection.rev, approved: o.selection.approved, signed: o.selection.signed },
        pruned: pruningStatus(o),
      }));
      return { nodeId: revision.nodeId, revNo: revision.revNo, contentHash: revision.contentHash,
        pruned: revision.pruned, version: revision.provenance.version,
        ...pageEnvelope(items, revision.occurrenceCount, skip) };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }),

    /**
     * #817 — the next sibling under a parent, by `seq`. The GraphQL twin of
     * `hadron_get_next_node`, which was MCP-only, locking the CLI and portal
     * out of ordered traversal.
     *
     * A client cannot compose this today: `NodeFilter` has no parent
     * predicate, so a caller must fetch the parent's whole SUBTREE, filter to
     * DIRECT children itself, and find the successor of `current` by seq — and
     * repeat all of it on every step, so walking N siblings costs N subtree
     * reads.
     *
     * ORDER (matching the MCP tool exactly, so guided reading order can't
     * diverge between surfaces — the two questions the issue asked to settle):
     *   - `seq` ascending;
     *   - a NULL `seq` sorts LAST, after every explicitly ordered sibling;
     *   - ties (equal seq, or two nulls) break on `loc` ascending.
     *
     * NOT a cursor and not session-backed — it holds no state; `currentRef`
     * omitted means "the first child".
     */
    nextNode: async (
      _: unknown,
      { parentRef, currentRef, raw }: { parentRef: string; currentRef?: string | null; raw?: boolean | null },
      ctx: Context,
    ) => {
      // Resolve the parent. A genuine miss is null; a MALFORMED ref still
      // throws (UrnNotQualifiedError from assertFullyQualifiedUrn) — a shape
      // error discloses nothing about what exists, while a not-found must not
      // become an existence oracle.
      let parentId: string;
      try {
        ({ id: parentId } = await resolveNodeRefForCaller(ctx, parentRef));
      } catch (e) {
        if (e instanceof NodeNotFoundError) return null;
        throw e;
      }
      const parent = await ctx.db.node.findFirst({
        where: { id: parentId, deletedAt: null },
        select: { loc: true, memoryId: true },
      });
      if (!parent) return null;
      // Node-CONTENT gate, the same predicate node(ref:) authorizes through.
      // Denied ≡ not-found.
      if (!(await isMemoryReadableCached(ctx, parent.memoryId))) return null;

      const prefix = `${parent.loc}:`;
      // Project only what picking a winner needs; the chosen node is fetched in
      // full through node(ref:) below.
      const descendants = await ctx.db.node.findMany({
        where: { memoryId: parent.memoryId, loc: { startsWith: prefix }, deletedAt: null },
        select: { id: true, loc: true, seq: true },
      });
      // DIRECT children only — no further ':' beyond the prefix. Prisma can't
      // express that, so the subtree is narrowed here (the same shape the MCP
      // tool uses); the projection above keeps it cheap.
      //
      // Ordering is done with the SHARED comparator rather than in SQL. PR #857
      // review (Codex P2): SQL ties fall to the database collation while the
      // MCP tool uses localeCompare, and locs may contain either case
      // (SEGMENT_RE permits [a-zA-Z0-9]) — so a C-collation Postgres would
      // order `A` before `a` where MCP orders `a` before `A`, and the traversal
      // chain would change with the surface. One comparator, no divergence.
      const children = sortSiblings(
        descendants.filter((n) => !n.loc.slice(prefix.length).includes(':')),
      );
      if (children.length === 0) return null;

      let nextId: string | null = null;
      if (!currentRef) {
        nextId = children[0].id;
      } else {
        let currentId: string;
        try {
          ({ id: currentId } = await resolveNodeRefForCaller(ctx, currentRef));
        } catch (e) {
          // Same posture as the parent: miss → null, malformed → throw.
          if (e instanceof NodeNotFoundError) return null;
          throw e;
        }
        const idx = children.findIndex((n) => n.id === currentId);
        // `current` not among these children (wrong memory, not a sibling, or
        // deleted) is indistinguishable from "no more siblings" — deliberately,
        // so this can't probe for a node's parentage.
        if (idx === -1 || idx + 1 >= children.length) return null;
        nextId = children[idx + 1].id;
      }

      // Delegate the actual read to node(ref:) so the returned Node gets the
      // identical treatment — access filter, decryption, Mustache compilation,
      // edge includes — and cannot drift from the canonical single-node read.
      return nodeQueries.node(_, { ref: nextId, raw }, ctx);
    },

    /**
     * #818 — render a run node WITHOUT executing it: the GraphQL twin of
     * `hadron_run_action`, which despite the name executes nothing. It loads
     * the node, resolves its dependency edges, and renders with `args`.
     *
     * `runTask` covers the EXECUTE half; nothing exposed the render half, so
     * there was no way to ask "what would this render to?" — needed for a
     * `task run --dry-run`, for reading an action's assembled instructions
     * when the CALLER is the executor, and for debugging template/dependency
     * resolution without side effects.
     *
     * A QUERY, not a mutation (the issue left this open): it is
     * side-effect-free. Unlike the MCP tool it records NO `action-run`
     * UsageEvent — metering a preview would inflate the ledger with actions
     * nobody took. It DOES record `read` events (#1061) for the run node and
     * every dependency inlined into the bundle: not being an execution says
     * nothing about whether content was returned, and it was.
     *
     * Assembles with `assembleRunNodePrompt` — the SAME function `runTask`
     * executes (Mustache via compileTemplate; flow-routing edges skipped) —
     * NOT the legacy `renderRunNodeBundle` the MCP tools call, which does a
     * literal replaceAll and inlines every edge. A preview that disagrees with
     * the run is worse than none (#858 review, Codex P1).
     */
    renderRunNode: async (
      _: unknown,
      { nodeRef, args }: { nodeRef: string; args?: Record<string, unknown> | null },
      ctx: Context,
    ) => {
      let nodeId: string;
      try {
        ({ id: nodeId } = await resolveNodeRefForCaller(ctx, nodeRef));
      } catch (e) {
        // Genuine miss → NOT_FOUND; a malformed ref propagates as itself.
        if (e instanceof NodeNotFoundError) {
          throw new GraphQLError(`Node not found: "${nodeRef}"`, {
            extensions: { code: 'NODE_NOT_FOUND' },
          });
        }
        throw e;
      }
      const node = await ctx.db.node.findFirst({
        where: { id: nodeId, deletedAt: null },
        include: {
          // #858 review (Codex P2): exclude edges whose TARGET is a tombstone.
          // deleteNode soft-deletes and promises the row drops out of every
          // read surface, but it leaves the edges intact — so an unfiltered
          // include would let a preview resurrect removed instructions. Also
          // skips soft-deleted EDGE rows, which revision-restore can leave
          // behind and every other edge surface excludes.
          outgoingEdges: {
            where: { deletedAt: null, target: { deletedAt: null } },
            include: { target: true },
          },
        },
      });
      // Denied and missing share one message — no existence oracle.
      const denied = () =>
        new GraphQLError(`Node not found: "${nodeRef}"`, { extensions: { code: 'NODE_NOT_FOUND' } });
      if (!node) throw denied();
      if (!(await isMemoryReadableCached(ctx, node.memoryId))) throw denied();

      // Decrypt the node AND its referenced targets — an encrypted memory
      // would otherwise render ciphertext into the bundle. A dangling edge can
      // still carry a null target defensively (PR #858 review, Copilot).
      type RunEdge = (typeof node.outgoingEdges)[number];
      const liveEdges: RunEdge[] = node.outgoingEdges.filter((e) => e.target != null);
      await decryptNodesBatch(ctx.db, [node, ...liveEdges.map((e) => e.target)] as never);

      // Only inline a referenced node the caller may actually READ. An edge
      // can point across memories (#781), and the bundle must not become a
      // way to read a foreign node's content through a dependency link.
      const visibleEdges: RunEdge[] = [];
      for (const edge of liveEdges) {
        if (await isMemoryReadableCached(ctx, edge.target!.memoryId)) visibleEdges.push(edge);
      }

      // Args are typed JSON on the wire; the assembler substitutes strings.
      const stringArgs = args
        ? Object.fromEntries(
            Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
          )
        : undefined;

      // #1061 — a render returns the node's assembled content, so it counts as
      // a read of the run node AND of every dependency inlined into the bundle.
      // Collected from the assembler's own `onTargetInlined` hook rather than
      // from `visibleEdges`: the assembler ALSO skips routing edges and
      // empty-content targets (PR #1062 review — Codex P2, Copilot), so
      // recording the gate's output would count reads for content that never
      // crossed the boundary. Recorded AFTER assembly, so a compileTemplate
      // failure records nothing at all.
      //
      // This resolver deliberately records no `action-run` event — see the doc
      // comment — but that is about metering an execution, not about node
      // reads, which did happen.
      const inlined: unknown[] = [];

      // #858 review (Codex P1): assemble with the SAME function runTask
      // executes — Mustache via compileTemplate, routing edges skipped — not
      // the legacy MCP bundle, which does a literal replaceAll and inlines
      // every edge. A preview that disagrees with the run is worse than none.
      const bundle = await assembleRunNodePrompt(
        { ...node, outgoingEdges: visibleEdges } as never,
        stringArgs,
        {
          memoryUrnOf: (memoryId: string) =>
            loadMemoryUrn(ctx, memoryId).then((u: string | null) => u ?? memoryId),
          compileTemplate: (content: string, data: Record<string, string> | null, memoryId: string) =>
            compileTemplate(content, data, memoryId, ctx.db, {}),
          // visibleEdges was already filtered through this caller's read gate.
          includeTarget: target => !!target,
          onTargetInlined: (target) => inlined.push(target),
        },
      );
      recordNodeUsage(ctx.db, 'read', toUsageNodeRefs([node, ...inlined]), ctx);
      return bundle;
    },

    // Spec: cor:api:180 — cross-entity URN resolution
    // (:00 surface & result shape, :01 resolution semantics).
    resolveUrn: async (_: unknown, { urn }: { urn: string }, ctx: Context) => {
      const isGlobalAdmin =
        !!ctx.roles?.includes('ADMIN') || !!ctx.roles?.includes('OWNER');
      // Membership check mirroring the per-kind queries' "member of the org"
      // gate, but returning a boolean instead of throwing so we can collapse
      // no-access to null.
      const isOrgMember = async (orgId: string): Promise<boolean> => {
        // Impersonation: only the session's shared org can admit.
        if (ctx.impersonation && orgId !== ctx.impersonation.orgId) return false;
        if (isGlobalAdmin) return true;
        if (!ctx.userId) return false;
        const member = await ctx.db.orgMember.findFirst({
          where: { organizationId: orgId, userId: ctx.userId, ...LIVE_ORG_MEMBERSHIP },
        });
        return !!member;
      };

      // #696: a `#data` fragment addresses its parent (node / apprun). Strip
      // it, resolve the parent, and tag the result so a caller knows it named
      // the data view. Only `#data` is defined.
      let fragment: string | undefined;
      let baseUrn = urn;
      const hashIdx = urn.indexOf('#');
      if (hashIdx !== -1) {
        fragment = urn.slice(hashIdx + 1);
        baseUrn = urn.slice(0, hashIdx);
        if (fragment !== 'data') return null;
      }
      // Extract the type word generically from the scheme prefix — parseUrnInput
      // only recognizes the fixed v1 type list, so the v2-only apprun/noderev
      // types (#696) would fall through to 'unknown'. Fall back to parseUrnInput
      // for unprefixed / loc: inputs.
      const schemeType = baseUrn.match(/^(?:hrn|urn):([a-z][a-z0-9-]*):/i)?.[1]?.toLowerCase();
      const type = schemeType ?? (parseUrnInput(baseUrn).type as string);
      if (fragment && type !== 'node' && type !== 'apprun') return null;
      switch (type) {
        // `mem` is the grammar-v2 type word for a memory (#697 emission flip);
        // it dispatches identically to the v1 `memory` word so a v2-emitted
        // `hrn:mem:root:slug` resolves (resolveMemoryRef accepts both via the
        // urn-lib `mem`→`memory` input alias).
        case 'mem':
        case 'memory': {
          let id: string;
          try {
            ({ id } = await resolveMemoryRef(ctx.db, urn));
          } catch {
            return null;
          }
          // #1104 — the RECORD gate, not the generic org/owner one this branch
          // used to call, and not the node-content gate either. `resolveUrn`
          // hands back a memory REFERENCE that the caller then opens as a
          // record, so `findings:record-vs-node-content-memory-gate` picks the
          // record gate — and using the same gate `Query.memory` uses is what
          // makes a memory's two addresses agree by construction rather than by
          // a second hand-rolled copy.
          //
          // `isOwnerOrOrgMember` is a generic org/owner predicate, and a memory
          // is the one entity here whose access is CLASS-driven. It was wrong in
          // BOTH directions, which is what a generic gate on a specific model
          // looks like:
          //   - too NARROW: it cannot see a MemoryShare, so a grantee who can
          //     list the memory, open it by PK and read its nodes was refused at
          //     `/app/u/<urn>` — the one address we ask people to hand around
          //     (portal#630).
          //   - too WIDE: with `ownerUserId` NULL it falls through to ORG
          //     MEMBERSHIP, which no personal memory grants (`cor:acl:010:01`).
          //     Any org member could resolve a colleague's org-owned personal
          //     memory to its PK — not content, but a confirmation that it
          //     exists, which is precisely what collapsing not-found and
          //     no-access to null exists to prevent.
          //
          // `deletedAt` is checked here rather than left to the gate: a
          // soft-deleted memory must resolve to null like a missing one.
          const memory = await ctx.db.memory.findUnique({
            where: { id },
            select: {
              id: true,
              class: true,
              userId: true,
              ownerUserId: true,
              organizationId: true,
              appId: true,
              // Load-bearing: `canReadMemoryRecord`'s share path reads it, and
              // omitting it silently refuses every grantee.
              userMemoryOfAgentId: true,
              deletedAt: true,
            },
          });
          if (!memory || memory.deletedAt) return null;
          if (!(await canReadMemoryRecord(ctx, memory))) return null;
          return { kind: 'memory', id };
        }
        case 'node': {
          let id: string;
          try {
            ({ id } = await resolveNodeRefForCaller(ctx, baseUrn));
          } catch (error) {
            if (error instanceof AmbiguousLegacyUrnError) throw error;
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
          return { kind: 'node', id, memoryId: node.memoryId, ...(fragment ? { fragment } : {}) };
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
            select: { organizationId: true, visibility: true, ownerUserId: true },
          });
          if (!agent) return null;
          // #551: a PUBLIC agent resolves for any caller (marketplace share
          // links), mirroring the agent(ref:) gate; otherwise fall back to the
          // owner-or-org-membership check.
          if (agent.visibility !== 'PUBLIC' && !(await isOwnerOrOrgMember(ctx, agent))) {
            return null;
          }
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
            select: { organizationId: true, ownerUserId: true },
          });
          if (!app) return null;
          // The dedicated app(ref:) query admits any member of the App's org
          // (#473 relaxed it from org ADMIN); mirror that so a member's
          // /app/u/<app-urn> share link resolves to the same page they can
          // already open directly. isOwnerOrOrgMember covers the
          // global-admin bypass, the App's owner-user, and the
          // revoked-membership (deletedAt) rule.
          if (!(await isOwnerOrOrgMember(ctx, app))) return null;
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
                // Impersonation: co-membership counts only in the shared org.
                ...(ctx.impersonation ? { organizationId: ctx.impersonation.orgId } : {}),
                organization: { deletedAt: null, members: { some: { userId: id, deletedAt: null } } },
              },
              select: { organizationId: true },
            });
            if (!shared) return null;
          }
          return { kind: 'user', id };
        }
        case 'apprun': {
          // #696: hrn:apprun:<root>:<app>:<run-id> (+ optional #data fragment).
          let id: string;
          try {
            ({ id } = await resolveAppRunRef(ctx.db, baseUrn));
          } catch {
            return null;
          }
          const run = await ctx.db.appRun.findUnique({
            where: { id },
            select: { organizationId: true },
          });
          if (!run) return null;
          // Same READER-of-the-org gate the appRun(ref:) query enforces.
          if (!(await isOrgMember(run.organizationId))) return null;
          return {
            kind: 'apprun',
            id,
            organizationId: run.organizationId,
            ...(fragment ? { fragment } : {}),
          };
        }
        case 'worker': {
          // #991: hrn:worker:<root>:<app-slug>:<worker-slug>.
          let id: string;
          try {
            ({ id } = await resolveWorkerRef(ctx.db, baseUrn));
          } catch {
            return null;
          }
          const worker = await ctx.db.worker.findUnique({
            where: { id },
            select: { appId: true },
          });
          if (!worker) return null;
          const app = await ctx.db.app.findUnique({ where: { id: worker.appId } });
          if (!app || app.deletedAt) return null;
          // The SHARED worker read gate, not a hand-rolled copy — a bespoke
          // admin-or-member check here would drift from the `workers` query's
          // (CLAUDE.md authorization invariants). App participants at any role,
          // the App's own key, or the owner of a user-owned App.
          try {
            await requireWorkerReadAccess(ctx, app);
          } catch {
            return null;
          }
          // A RETIRED worker still resolves: retirement never frees the name or
          // slug (cor:agt:020:02), and history — PR trailers, chat archives —
          // must keep resolving.
          return { kind: 'worker', id, organizationId: app.organizationId };
        }
        case 'noderev': {
          // #696: hrn:noderev:<root>:<mem>:<loc...>:<rev> (end-anchored).
          let id: string;
          try {
            ({ id } = await resolveNodeRevRef(ctx.db, baseUrn));
          } catch {
            return null;
          }
          // Gate on the revision's captured memory (#602/#618) — legacy rows
          // (null memoryId) fall back to the node's current memory.
          const rev = await ctx.db.nodeRevision.findUnique({
            where: { id },
            select: { memoryId: true, nodeId: true },
          });
          if (!rev) return null;
          if (await isConcealedCommentHistory(ctx, rev.nodeId)) return null; // #1663
          let memoryId = rev.memoryId;
          if (!memoryId) {
            const node = await ctx.db.node.findUnique({
              where: { id: rev.nodeId },
              select: { memoryId: true },
            });
            memoryId = node?.memoryId ?? null;
          }
          if (!memoryId) return null;
          const access = await memoryAccessFilter(ctx);
          if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
            if (!(access.memoryId.in as string[]).includes(memoryId)) return null;
          }
          return { kind: 'noderev', id, memoryId };
        }
        default:
          return null;
      }
    },

    // #473 — the uniform single-node read: node(ref:) subsumes the former
    // nodeById(id:) + node(loc:, memory:) split. `ref` dispatch order:
    //   1. PK (the old nodeById path),
    //   2. explicit `hrn:node:` URN → strict resolveNodeRef,
    //   3. bare loc — pinned by `memory:` when given (#335 scoped path);
    //      unscoped, an unprefixed 3+-segment ref whose 2-segment prefix
    //      names a live memory reads as a full URN, anything else resolves
    //      across every readable memory with the #335 ambiguity guard.
    node: async (
      _: unknown,
      { ref, memoryRef, raw }: { ref: string; memoryRef?: string | null; raw?: boolean | null },
      ctx: Context,
    ) => {
      const access = await memoryAccessFilter(ctx);
      const include = {
        outgoingEdges: { include: { target: true } },
        incomingEdges: { include: { source: true } },
      };
      // Denied ≡ not-found (null) — same non-disclosure the old queries had.
      const allowed = (memoryId: string): boolean => {
        if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
          return (access.memoryId.in as string[]).includes(memoryId);
        }
        return true;
      };
      // Decrypt + (unless raw) compile Mustache templates — shared tail of
      // every dispatch form. Generic so the full node row type flows through.
      const finish = async <T extends { id: string; loc: string; deletedAt: Date | null; content: string | null; data: unknown; memoryId: string }>(
        selected: T,
        // #1885 — set only by Form 3a's effective-memory lookup: the node is a
        // base's, read through a system memory `allowed` already admitted, so
        // its own memory is not re-gated here (cor:dmo:050:14 ruling 4).
        inheritedFrom?: InheritedFrom,
      ) => {
        // The lookup above selects the address. Reconcile and re-fetch while
        // holding its row lock so Node.revision and every sibling field come
        // from one database state (never old body + new counter).
        const current = await withReconciledNodeRead(ctx.db, selected.id, selected.memoryId,
          async (tx, mayReconcile) => {
            const fresh = await (mayReconcile ? liveTxContext : liveReadSnapshotContext)(ctx, tx);
            return isMemoryReadableCached(fresh, inheritedFrom?.via ?? selected.memoryId);
          },
          (tx) => tx.node.findUnique({ where: { id: selected.id }, include }),
          { timeoutMs: 5_000, maxWaitMs: 2_000 });
        if (
          !current ||
          current.deletedAt ||
          current.memoryId !== selected.memoryId ||
          current.loc !== selected.loc ||
          (!inheritedFrom && !allowed(current.memoryId))
        ) return null;
        // An inherited selection is re-checked on the version actually served:
        // a base node turned boot prompt, or a child override added, since
        // the selection is no longer the child's to show (Diego, #1891 P2-1).
        if (inheritedFrom && !(await stillInherited(ctx.db, inheritedFrom, current))) return null;
        const node = inheritedFrom ? Object.assign(current, { inheritedFrom }) : current;
        // #1061 — every dispatch form of this query funnels its ONE successful
        // return through `finish`, so this is the single place a `read` is
        // recorded for the canonical node read (and for `nextNode`, which
        // delegates here). A denied or missing ref returns null earlier and
        // records nothing — an event must never name a node the caller could
        // not read (#825).
        //
        // Recorded at the END, not the top: `decryptNodesBatch` and
        // `compileTemplate` can both throw (a missing session key, an
        // unresolvable template reference), and the caller then gets an error
        // instead of content (PR #1062 review — Copilot).
        await decryptNodesBatch(ctx.db, [node]);
        recordNodeRead(ctx.db, toUsageNodeRef(node), ctx);
        // Includes and variables resolve in the `Node.content` field (#2041);
        // the row keeps its stored text. `raw` only picks that field's default.
        return raw ? Object.assign(node, { [CONTENT_RAW_DEFAULT]: true }) : node;
      };

      // Form 1: primary key. #391: a soft-deleted node must not resolve by PK
      // (findUnique can't carry deletedAt in its where, so guard post-fetch).
      if (isId(ref)) {
        const node = await ctx.db.node.findUnique({ where: { id: ref }, include });
        if (!node || node.deletedAt || !allowed(node.memoryId)) return null;
        return finish(node);
      }

      const parsed = parseUrnInput(ref);
      const typeErr = validateUrnType(parsed, 'node');
      if (typeErr) throw new Error(typeErr);
      const value = parsed.value;
      // #1885 (cor:dmo:050:14) — a node URN in an Agent's system memory whose
      // loc has no node of its own (and none moved from it) reads through to
      // the nearest base that passes one down, as MCP hadron_get_node does.
      // Gated on the URN's own memory; the node keeps the base's address.
      const inheritedUrnRead = async () => {
        let parts: { memoryUrn: string; loc: string };
        try {
          parts = splitNodeUrn(ref);
        } catch {
          return null;
        }
        const memory = await resolveMemoryRef(ctx.db, parts.memoryUrn).catch(() => null);
        if (!memory || !allowed(memory.id)) return null;
        const effective = await findEffectiveNodeIdByLoc(ctx.db, memory.id, parts.loc);
        if (!effective?.inheritedFrom) return null;
        const inherited = await ctx.db.node.findUnique({ where: { id: effective.id }, include });
        return inherited && !inherited.deletedAt ? finish(inherited, effective.inheritedFrom) : null;
      };
      const movedUrnRead = async () => {
        let id: string;
        try {
          ({ id } = await resolveNodeRefForCaller(ctx, ref));
        } catch (e) {
          if (e instanceof NodeNotFoundError) return inheritedUrnRead();
          throw e;
        }
        const selected = await ctx.db.node.findUnique({ where: { id }, include });
        return selected && !selected.deletedAt && allowed(selected.memoryId)
          ? finish(selected)
          : null;
      };

      // Form 2: explicit `hrn:node:` URN — strict resolution, no loc
      // fallback (resolveNodeRef enforces the fully-qualified shape; a
      // malformed input propagates as UrnNotQualifiedError rather than
      // masking as not-found).
      if (parsed.type === 'node') {
        return movedUrnRead();
      }

      // Form 3a: bare loc pinned by `memory:` (ID or URN per
      // 007-entity-id-or-urn). #335: scoping pins the lookup; the access
      // filter is still intersected so `memory` can never widen visibility.
      if (memoryRef != null && memoryRef !== '') {
        // #1316: a missing `memory:` throws MEMORY_NOT_FOUND, so an unreadable
        // one must too — the bare null it used to return disclosed that the
        // memory exists. (The loc inside a READABLE memory still answers null
        // when absent: that caller may already see the memory.) `allowed` is
        // the node-content gate this resolver already computed, so the
        // concealment costs no second authorization round (@copilot, #1350).
        const { id: scopedMemoryId } = await resolveMemoryRef(ctx.db, memoryRef);
        if (!allowed(scopedMemoryId)) throw new MemoryNotFoundError(memoryRef);
        const node = await ctx.db.node.findFirst({
          where: { loc: value, memoryId: scopedMemoryId, deletedAt: null },
          include,
        });
        if (node) return finish(node);
        // #1885 (cor:dmo:050:14) — no node of its own at the loc: a system
        // memory reads through to the nearest base that passes one down.
        const effective = await findEffectiveNodeIdByLoc(ctx.db, scopedMemoryId, value);
        if (!effective?.inheritedFrom) return null;
        const inherited = await ctx.db.node.findUnique({ where: { id: effective.id }, include });
        return inherited && !inherited.deletedAt ? finish(inherited, effective.inheritedFrom) : null;
      }

      // Form 3b: unprefixed + unscoped. A 3+-segment ref whose memory prefix
      // names a live memory is a full URN (mirrors resolveNodeRef's
      // fallthrough); pass `memory:` to force loc interpretation of such a
      // ref. Canonical `::` input: loc is the FINAL leaf and the memory URN
      // is everything before it (memory URNs may span >2 hierarchy levels,
      // e.g. per-user `<org>::<agent>::app-user:<id>` — PR-475 review);
      // legacy single-`:` input keeps the two-segment heuristic.
      const isCanonical = value.includes('::');
      const parts = isCanonical ? value.split('::') : value.split(':');
      if (parts.length >= 3) {
        const urnLoc = isCanonical ? parts[parts.length - 1] : parts.slice(2).join(':');
        const memoryUrnCandidates = isCanonical
          ? [parts.slice(0, -1).join('::'), parts.slice(0, -1).join(':')]
          : [`${parts[0]}:${parts[1]}`, `${parts[0]}::${parts[1]}`];
        const memory = await ctx.db.memory.findFirst({
          where: { urn: { in: memoryUrnCandidates }, deletedAt: null },
          select: { id: true },
        });
        if (memory) {
          if (allowed(memory.id)) {
            const node = await ctx.db.node.findFirst({
              where: { loc: urnLoc, memoryId: memory.id, deletedAt: null },
              include,
            });
            if (node) return finish(node);
          }
          // The memory may be unreadable now while its former node moved to
          // one the caller CAN read. resolveNodeRef still checks the live old
          // address first, so a new occupant cannot be shadowed by an alias.
          return movedUrnRead();
        }
        const moved = await movedUrnRead();
        if (moved) return moved;
      }

      // Form 3c: bare loc across EVERY readable memory. #391: exclude
      // soft-deleted rows so node(ref:) matches resolveUrn.
      const candidates = await ctx.db.node.findMany({
        // loc-scope-ok: deliberately cross-memory — scoped to the caller's readable set by ...access, then fails loud with AMBIGUOUS_NODE_LOC on >1 (#335)
        where: { loc: value, ...access, deletedAt: null },
        include,
      });
      if (candidates.length === 0) return null;

      // #335: fail loud on a cross-memory loc collision instead of silently
      // picking one. The (loc, memoryId) unique guarantees >1 candidate ⇒
      // distinct memories, so this only fires for a genuinely ambiguous
      // unscoped read.
      if (candidates.length > 1) {
        const memoryIds = candidates.map((n) => n.memoryId);
        throw new GraphQLError(
          `loc "${value}" matches ${candidates.length} readable memories ` +
            `(${memoryIds.join(', ')}). Pass \`memory:\` to scope the lookup, ` +
            `or pass the node's PK or full URN as \`ref\` for an unambiguous read.`,
          { extensions: { code: 'AMBIGUOUS_NODE_LOC', loc: value, memoryIds } },
        );
      }
      return finish(candidates[0]);
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
      // #1061 — an export hands the caller the node's full content, so it is a
      // read like any other. Recorded in each SUCCESSFUL format branch below
      // rather than here: the PDF path calls the external hadrontool-pdf
      // service and `renderNodeExport` can throw, and a failed export returned
      // no content (PR #1062 review — Copilot).
      const memory = await ctx.db.memory.findUnique({
        where: { id: node.memoryId },
        select: { urn: true },
      });

      const fmt: NodeExportFormat = format ?? 'MD';

      // cor:dmo:150:03 (R40/R47): `full` is the restore export and reads with
      // resolution off, so a round trip keeps its include tags; a presentation
      // render (PDF, or `full: false`) reads like any reader, with includes
      // resolved by the exporter's access. Variables stay as stored in both.
      const exportContent = fmt === 'PDF' || full === false
        ? await resolveNodeContent(ctx, node, { mode: 'includes' })
        : node.content;

      // PDF is a presentation render produced by the external hadrontool-pdf
      // service from the node's (already-decrypted) Markdown content. Unlike
      // MD/JSON it is not the canonical round-trippable file, so `full` /
      // `sections` do not apply. Delivered BASE64.
      if (fmt === 'PDF') {
        const markdown =
          exportContent && exportContent.trim().length > 0 ? exportContent : `# ${node.name}`;
        const { base64, bytes } = await renderMarkdownToPdf(markdown, { title: node.name });
        const leaf = node.loc ? node.loc.split(':').pop() || node.loc : node.name || 'node';
        recordNodeRead(ctx.db, toUsageNodeRef(node), ctx);
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
          objectType: node.objectType,
          alias: node.alias,
          description: node.description,
          abstract: node.abstract,
          abstractOriginHash: node.abstractOriginHash,
          content: exportContent,
          tags: deserializeTags(node.tags) as string[],
          seq: node.seq,
          role: node.role,
          isRunnable: node.isRunnable,
          data: node.data,
          properties: node.properties,
          edges: node.outgoingEdges as unknown as EdgeForGit[],
        },
        { format: fmt, full: full !== false, sections: sections ?? null },
      );

      const leaf = node.loc ? node.loc.split(':').pop() || node.loc : node.name || 'node';
      recordNodeRead(ctx.db, toUsageNodeRef(node), ctx);
      return {
        format: fmt,
        mimeType,
        filename: `${leaf}.${fmt === 'JSON' ? 'json' : 'md'}`,
        encoding: 'TEXT',
        data,
        bytes: Buffer.byteLength(data, 'utf8'),
      };
    },

    // cor:api:090 — unified node search. Supersedes `nodes` (filter/list) +
    // `nodeSearch` (rank): omit `query` for a filtered list; pass it to rank by
    // `mode` (keyword | vector | hybrid | regex). Lexical modes go through the
    // Postgres FTS engine behind the retrieval seam (field-weighted ranking +
    // boolean operators). Access-scoped exactly like the per-kind node queries.
    findNodes: async (
      _: unknown,
      args: FindNodesArgs & {
        /** Spec 049 Phase 3 — a scope named in the call; see the SDL. */
        scope?: string | null;
        /** Spec 049 Phase 3 — the App context for a bare scope name / `app`. */
        appRef?: string | null;
      },
      ctx: Context,
    ) => {
      const { scope, appRef, ...coreArgs } = args;

      // The pre-spec-049 resolver, unchanged, as a local so the scope wrapper
      // at the bottom can re-enter it without a self-reference (which would
      // leave TypeScript unable to infer the return type).
      const core = async ({
        query, mode, filter, fields, sort, sortProperty, expand, granularity, orgId, limit, offset, minScore, includeTotal,
      }: FindNodesArgs) => {
      const f = filter ?? {};

      // ── (spec 049 scope handling lives in the wrapper at the end of core) ──
      const { limit: finalLimit, offset: off } = normalizeFindNodesPaging(limit, offset);
      // #497 — optional absolute relevance floor. Applied to the ranked scores
      // before paging (a NaN guard so a bad arg is simply ignored, never throws).
      // Scores are NOT commensurable across modes, so the meaningful floor scale
      // differs per mode (keyword ts_rank ≈ 0..a-few; vector cosine ≈ 0..1;
      // hybrid RRF ≈ small fractions) — documented on the arg. Never applies to
      // the no-query browse list (those hits are unscored) or expand-neighbours.
      const scoreFloor = typeof minScore === 'number' && Number.isFinite(minScore) ? minScore : null;
      const applyFloor = (ranked: { nodeId: string; score: number }[]) =>
        scoreFloor == null ? ranked : ranked.filter((r) => r.score >= scoreFloor);
      const provider = getRetrievalProvider();
      const badInput = (msg: string) =>
        new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });

      if (expand != null && (expand < 0 || expand > 3 || !Number.isInteger(expand))) {
        throw badInput('findNodes `expand` must be an integer in [0, 3].');
      }
      const expandDepth = expand ?? 0;
      if (f.updatedAfter && Number.isNaN(Date.parse(f.updatedAfter))) {
        throw badInput('findNodes filter.updatedAfter must be a valid date string.');
      }
      if (f.updatedBefore && Number.isNaN(Date.parse(f.updatedBefore))) {
        throw badInput('findNodes filter.updatedBefore must be a valid date string.');
      }
      // #719 — validate the `where` predicate up front (a throwaway compile) so a
      // malformed/oversized tree surfaces as BAD_USER_INPUT before dispatch; the
      // downstream compiles (filterClause / filterSearch) then can't throw.
      if (f.where != null) {
        try {
          compileNodeWhere(f.where, () => '$0');
        } catch (e) {
          if (e instanceof NodeWhereError) throw badInput(`findNodes filter.where: ${e.message}`);
          throw e;
        }
      }
      // #719 — validate the property-path sort up front (throwaway compile) so a
      // malformed path/direction is BAD_USER_INPUT before dispatch. Reuses the
      // where-leaf addressing; missing/unparseable values sort last, loc breaks ties.
      if (sortProperty != null) {
        try {
          compileNodePropertySort(sortProperty);
        } catch (e) {
          if (e instanceof NodeWhereError) throw badInput(`findNodes sortProperty: ${e.message}`);
          throw e;
        }
      }

      // #463: optional single-org narrowing. Resolve + membership-gate up front
      // (member → scope; non-member → empty envelope, no existence disclosure),
      // then push the org filter into the scope queries below. Uniform
      // member-only — NO platform-admin bypass; an App-key caller may scope to
      // its own App's org. AND-narrowing only: it can never widen the caller's
      // accessible set. Combined with filter.isRunnable: true this is the
      // "runnable task nodes in one org" query (there is no separate myTasks).
      const emptyResult = { hits: [], passages: [], total: 0, reason: null, degraded: null };
      let orgScopeId: string | null = null;
      if (orgId != null) {
        let resolvedOrgId: string;
        try {
          ({ id: resolvedOrgId } = await resolveOrgRef(ctx.db, orgId));
        } catch {
          return emptyResult;
        }
        let authorized = false;
        if (ctx.userId) {
          const memberOrgIds = await getMemberOrgIds(ctx.db, ctx.userId, ctx.impersonation?.orgId);
          authorized = memberOrgIds.includes(resolvedOrgId);
        } else if (ctx.appId) {
          // App-key: its access is already confined to its App's org via the
          // session, so authorize scoping to that org (any other → empty).
          const app = await ctx.db.app.findUnique({
            where: { id: ctx.appId },
            select: { organizationId: true },
          });
          authorized = app?.organizationId === resolvedOrgId;
        }
        if (!authorized) return emptyResult;
        orgScopeId = resolvedOrgId;
      }

      // ── Resolve scope: accessible ∩ requested memories (ID/URN mix) ──
      const accessible = await getAccessibleMemoryIds(ctx);
      const explicitIds = !!(f.memoryIds && f.memoryIds.length > 0);
      const memClassClause: unknown =
        f.memoryClasses && f.memoryClasses.length > 0
          ? { in: f.memoryClasses }
          : (!explicitIds ? { not: 'system' } : undefined); // broad search hides system-class; explicit ids win

      // #463: push the org narrowing straight into the scope queries (rather
      // than selecting all ids then intersecting) so the admin/broad path never
      // materializes every memory id just to filter it down.
      const orgWhere = orgScopeId ? { organizationId: orgScopeId } : {};

      let scopeIds: string[];
      if (explicitIds) {
        const resolved = await Promise.all(
          f.memoryIds!.map((ref) =>
            isId(ref)
              ? Promise.resolve(ref)
              : resolveMemoryRef(ctx.db, ref).then((r) => r.id).catch(() => null)),
        );
        const requested = resolved.filter((id): id is string => id !== null);
        const allowed = accessible === null ? null : new Set(accessible);
        scopeIds = allowed === null ? requested : requested.filter((id) => allowed.has(id));
        // Query only when a class or org filter must be applied to the requested
        // set; otherwise the requested ∩ accessible ids stand as-is.
        if ((memClassClause || orgScopeId) && scopeIds.length > 0) {
          const rows = await ctx.db.memory.findMany({
            where: { id: { in: scopeIds }, ...(memClassClause ? { class: memClassClause as never } : {}), ...orgWhere },
            select: { id: true },
          });
          scopeIds = rows.map((m) => m.id);
        }
      } else if (accessible === null) {
        // Admin/broad — resolve scope + class + org filter in one query.
        const rows = await ctx.db.memory.findMany({
          where: { deletedAt: null, ...(memClassClause ? { class: memClassClause as never } : {}), ...orgWhere },
          select: { id: true },
        });
        scopeIds = rows.map((m) => m.id);
      } else {
        const rows = await ctx.db.memory.findMany({
          where: { id: { in: accessible }, ...(memClassClause ? { class: memClassClause as never } : {}), ...orgWhere },
          select: { id: true },
        });
        scopeIds = rows.map((m) => m.id);
      }
      if (scopeIds.length === 0) {
        return { hits: [], passages: [], total: 0, reason: null, degraded: null };
      }
      // #1885 (cor:dmo:050:14) — a system memory in the scope reads as its
      // effective memory: its bases' inherited nodes join it, under their own
      // URNs and marked inherited, and a base's overridden nodes and boot
      // prompts stay out. Widened only from memories already gated above.
      const inheritance = await effectiveScope(ctx.db, scopeIds);
      scopeIds = inheritance.memoryIds;
      const inheritanceExcluded = new Set(inheritance.excludeNodeIds);

      // Structured node-attribute filters (cor:api:090:02), AND-combined. Applied
      // to BOTH the no-query list path and the ranked-query path (via re-fetch),
      // so query results respect them exactly like the list does.
      const contentScope = effectiveContentScope(f);
      const scopeWhere = contentScopeWhere(contentScope);
      const recoverableIds = f.includeDeleted ? await recoveryMemoryIds(ctx, scopeIds) : [];
      const structuredWhere: Record<string, unknown> = {
        ...(f.includeDeleted ? {} : { deletedAt: null }),
        // Explicit nodeType wins; otherwise exclude system-type nodes (orthogonal
        // to the memory-class exclusion above).
        ...(f.nodeType ? { nodeType: f.nodeType } : { nodeType: { not: 'system' } }),
        ...(f.objectType ? { objectType: f.objectType } : {}),
        ...(f.isRunnable != null ? { isRunnable: f.isRunnable } : {}),
        ...(f.role != null
          ? {
              OR: [
                { role: f.role },
                { role: { startsWith: escapePrismaLikePattern(`${f.role}.`) } },
              ],
            }
          : {}),
        ...(f.tags?.length ? tagsFilter(f.tags) : {}),
        ...(f.locPrefix ? { loc: { startsWith: f.locPrefix } } : {}),
        ...(f.createdBy ? { createdBy: f.createdBy } : {}),
        ...((f.updatedAfter || f.updatedBefore)
          ? { updatedAt: {
              ...(f.updatedAfter ? { gte: new Date(f.updatedAfter) } : {}),
              ...(f.updatedBefore ? { lte: new Date(f.updatedBefore) } : {}),
            } }
          : {}),
        ...approvalStatePrismaWhere(f.approvalState, ctx.db),
        // #1607 (cor:dmo:110:06) — approval and mint status sets never contain
        // comments; #1608 (cor:dmo:110:08) — content, comments or both, CONTENT
        // by default. Both ride AND so neither clobbers the nodeType key above.
        AND: [
          ...(f.includeDeleted ? [{ OR: [{ deletedAt: null }, { memoryId: { in: recoverableIds }, nodeType: { not: COMMENT_NODE_TYPE } }] }] : []),
          ...(f.minted != null ? [mintedPrismaWhere(f.minted)] : []),
          ...(f.approvalState != null || f.minted != null ? [{ nodeType: { not: COMMENT_NODE_TYPE } }] : []),
          ...(scopeWhere ? [scopeWhere] : []),
          ...(inheritance.excludeNodeIds.length > 0 ? [{ id: { notIn: inheritance.excludeNodeIds } }] : []),
        ],
      };
      const nodeInclude = {
        memory: true,
        outgoingEdges: { include: { target: true } },
        incomingEdges: { include: { source: true } },
      } as const;

      const hasQuery = typeof query === 'string' && query.trim() !== '';

      // Structured filters for the SQL paths (the lexical modes, and the no-query
      // browse when a `where` predicate is present). Mirrors `structuredWhere`
      // (the Prisma form) but adds the JSONB `where`, which Prisma can't express.
      const sqlFilter: NodeSqlFilter = {
        ...(f.includeDeleted ? { tombstoneMemoryIds: recoverableIds } : {}),
        nodeType: f.nodeType ?? null,
        objectType: f.objectType ?? null,
        isRunnable: f.isRunnable ?? null,
        role: f.role ?? null,
        tags: f.tags ?? null,
        locPrefix: f.locPrefix ?? null,
        createdBy: f.createdBy ?? null,
        updatedAfter: f.updatedAfter ?? null,
        updatedBefore: f.updatedBefore ?? null,
        where: f.where ?? null,
        approvalState: f.approvalState ?? null,
        minted: f.minted ?? null,
        contentScope,
      };

      // #1061 — one `read` per node this query hands back, across every branch
      // below (browse, keyword, regex, vector, hybrid, and the neighbours an
      // `expand` appends). A search that returns 30 hits IS thirty node reads:
      // the unit of the usage series is node content returned, not calls made,
      // so a caller that reads 30 nodes through one search and one that reads
      // them one at a time land in the same place. Every branch has already
      // scoped its rows to the caller's readable memories before reaching here.
      const recordSearchHits = async (hits: { node: unknown }[]): Promise<void> => {
        // #1885 — the exclusion list was a snapshot taken before this query:
        // re-check every inherited hit on the version read (P2-1), in place.
        if (inheritance.inheritedFrom.size > 0) {
          const kept = new Set((await retainEffective(ctx.db, hits.map((h) => h.node as { id: string; memoryId: string; role?: string | null }), inheritance)).map((n) => n.id));
          for (let i = hits.length - 1; i >= 0; i--) if (!kept.has((hits[i]!.node as { id: string }).id)) hits.splice(i, 1);
        }
        markInherited(hits.map((h) => h.node as { memoryId: string }), inheritance.inheritedFrom);
        recordNodeUsage(ctx.db, 'read', toUsageNodeRefs(hits.map((h) => h.node)), ctx);
      };

      // ── No query → filtered list (subsumes `nodes`) ──
      if (!hasQuery) {
        // #2514: object queries promise an exact count before paging. Ordinary
        // search remains uncounted; reuse the already admitted scope and filters.
        const total = includeTotal ? await provider.filterCount({
          db: ctx.db, memoryIds: scopeIds, filter: sqlFilter,
          includeDeleted: !!f.includeDeleted, excludeNodeIds: inheritance.excludeNodeIds,
        }) : null;
        // A `where` predicate (JSONB the Prisma query can't express) OR a
        // property-path sort (an ORDER BY over a JSON path Prisma can't express)
        // → run the filtered browse in SQL (ordered ids), then hydrate. The plain
        // browse (no where, no property sort) keeps the Prisma path below.
        if (f.where != null || sortProperty != null) {
          const browseSort: BrowseSort | undefined =
            sort === 'seq' ? 'seq' : sort === 'updatedAt' ? 'updatedAt' : undefined;
          const ids = await provider.filterSearch({
            db: ctx.db, memoryIds: scopeIds, filter: sqlFilter,
            includeDeleted: !!f.includeDeleted, sort: browseSort,
            propertySort: sortProperty ?? undefined, offset: off, limit: finalLimit,
          });
          // Re-assert the memory scope on hydration (defense-in-depth): the ids
          // are already scoped by filterSearch's `memory_id IN (scopeIds)`, but
          // re-scoping here means a concurrent cross-memory move (cf. #409) can
          // never surface an out-of-scope node — cross-tenant reads are the
          // first-class invariant, not a cosmetic one.
          // #1345 review (@copilot): the structured filters too, not only scope,
          // so a node that stopped matching (e.g. its role changed) between the
          // SQL filter and this read is not returned against the filter.
          const rows = await ctx.db.node.findMany({
            where: { id: { in: ids }, memoryId: { in: scopeIds }, ...structuredWhere },
            include: nodeInclude,
          });
          await decryptNodesBatch(ctx.db, rows);
          const byId = new Map(rows.map((n) => [n.id, n]));
          const ordered = ids.map((id) => byId.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
          const browseHits = ordered.map((n) => ({ node: n, score: null, vector: null }));
          await recordSearchHits(browseHits);
          return { hits: browseHits, passages: [], total, reason: null, degraded: null };
        }
        const orderBy =
          sort === 'seq' ? { seq: 'asc' as const }
          : sort === 'updatedAt' ? { updatedAt: 'desc' as const }
          : { loc: 'asc' as const }; // relevance is meaningless without a query → deterministic browse order
        const rows = await ctx.db.node.findMany({
          where: { memoryId: { in: scopeIds }, ...structuredWhere },
          orderBy,
          skip: off,
          take: finalLimit,
          include: nodeInclude,
        });
        await decryptNodesBatch(ctx.db, rows);
        const listHits = rows.map((n) => ({ node: n, score: null, vector: null }));
        await recordSearchHits(listHits);
        return {
          hits: listHits,
          passages: [],
          total,
          reason: null,
          degraded: null,
        };
      }

      const q = query!.trim();
      const effectiveMode = mode ?? 'hybrid';
      const lexFields = (fields ?? undefined) as LexicalField[] | undefined;
      const model = isEmbeddingConfigured() ? getEmbeddingClient().model : null;
      // A selective structured filter can drop many ranked candidates, so over-fetch
      // from the retrieval layer to keep the page full after post-filtering + offset.
      const hasStructuredFilters = !!(
        f.nodeType || f.objectType || f.isRunnable != null || f.role != null || f.tags?.length || f.locPrefix ||
        f.createdBy || f.updatedAfter || f.updatedBefore || f.includeDeleted || f.where || f.approvalState || f.minted != null
      );
      const page = off + finalLimit;
      const VECTOR_FETCH_CAP = 2000;
      const fetchN = hasStructuredFilters ? Math.min(page * 5, VECTOR_FETCH_CAP) : page;

      /**
       * The ids among `ids` that pass every structured filter and `where`, in
       * the caller's scope — the same predicate `buildResult` and the chunk
       * branch apply on hydration.
       */
      const eligibleIds = async (ids: string[]): Promise<Set<string>> => {
        let candidates = ids;
        if (f.where != null) {
          candidates = await provider.filterWhere({
            db: ctx.db, ids, memoryIds: scopeIds, where: f.where, includeDeleted: !!f.includeDeleted,
            tombstoneMemoryIds: recoverableIds,
          });
        }
        const rows = await ctx.db.node.findMany({
          where: { id: { in: candidates }, memoryId: { in: scopeIds }, ...structuredWhere },
          select: { id: true },
        });
        return new Set(rows.map((r) => r.id));
      };

      /**
       * #1345 review (@codex P2): a vector candidate window is selected WITHOUT
       * the structured filters (the ANN scan is index-driven), so a fixed
       * over-fetch could leave the page empty when the matches rank past it —
       * `limit: 1` returned nothing when the five nearest nodes had other roles.
       * With filters present, widen the window (x4, to the same cap) until the
       * filtered, floored hits fill the page, or the provider reports its raw
       * candidate window exhausted.
       * Past the cap a page can still be short; it is never wrong.
       */
      const widenVectorWindow = async <T extends { nodeId: string; score: number }>(
        search: (limit: number, onWindow: (w: { exhausted: boolean }) => void) => Promise<T[]>,
      ): Promise<T[]> => {
        let limit = fetchN;
        for (;;) {
          // Exhaustion comes from the PROVIDER's raw window, never from the
          // result size: node search dedupes chunk vectors to nodes, so a short
          // or unchanged hit count can be duplicates with more of the index
          // unread (@codex + @copilot, #1345 rounds 3-4). Unreported ⇒ not
          // exhausted, so an unknown provider widens to the cap.
          let exhausted = false;
          const hits = await search(limit, (w) => { exhausted = w.exhausted; });
          if (!hasStructuredFilters || limit >= VECTOR_FETCH_CAP || exhausted) return hits;
          const floored = scoreFloor == null ? hits : hits.filter((h) => h.score >= scoreFloor);
          const ok = await eligibleIds([...new Set(floored.map((h) => h.nodeId))]);
          if (floored.filter((h) => ok.has(h.nodeId)).length >= page) return hits;
          limit = Math.min(limit * 4, VECTOR_FETCH_CAP);
        }
      };

      // Hydrate a ranked (nodeId, score) list into hits: enforce the structured
      // filters via a Prisma re-fetch, order (by rank, or by an explicit sort),
      // page with offset/limit, then optionally append expand-neighbours.
      const buildResult = async (
        ranked: { nodeId: string; score: number }[],
        simById: Map<string, number> | null,
        reason: string | null,
        degraded: string | null,
      ) => {
        ranked = applyFloor(ranked);
        const scoreById = new Map(ranked.map((r) => [r.nodeId, r.score]));
        const rankOrder = new Map(ranked.map((r, i) => [r.nodeId, i]));
        // #719 — compose `where` with vector/hybrid ranking: the JSONB predicate
        // can't ride the ranking query (that runs against node_embeddings, not
        // the nodes' JSONB), so intersect the bounded ranked candidate set with
        // the where-satisfying subset (which also re-asserts the memory scope).
        // Only when there ARE vector-ranked candidates (`simById` set): the
        // keyword-only hybrid fallbacks (no_vector_index / embedding_unavailable)
        // already applied `where` in the lexical SQL via sqlFilter, so a
        // filterWhere there would be a redundant query.
        let candidateIds = ranked.map((r) => r.nodeId);
        if (f.where != null && simById != null) {
          const allowed = new Set(
            await provider.filterWhere({
              db: ctx.db, ids: candidateIds, memoryIds: scopeIds,
              where: f.where, includeDeleted: !!f.includeDeleted, tombstoneMemoryIds: recoverableIds,
            }),
          );
          candidateIds = candidateIds.filter((id) => allowed.has(id));
        }
        // #1345 review (@copilot): re-assert the memory scope at hydration. The
        // candidates were scoped when RANKED, in a separate query; a node moved
        // to another memory in between must not come back from outside scope.
        const rows = await ctx.db.node.findMany({
          where: { id: { in: candidateIds }, memoryId: { in: scopeIds }, ...structuredWhere },
          include: nodeInclude,
        });
        await decryptNodesBatch(ctx.db, rows);
        // #719 — a property-path sort re-orders the ranked candidate WINDOW in
        // memory (the vector/hybrid query ranks against node_embeddings, not the
        // JSONB), mirroring the SQL ORDER BY the browse/lexical paths use; missing
        // values sort last, loc breaks ties. Like the enum sort here, it orders
        // only the retrieved candidates — not the whole corpus.
        const propComparator = sortProperty ? makePropertySortComparator(sortProperty) : null;
        const ordered = rows.slice().sort((a, b) => {
          if (propComparator) return propComparator(a, b);
          if (sort === 'loc') return a.loc.localeCompare(b.loc);
          if (sort === 'seq') return (a.seq ?? 0) - (b.seq ?? 0);
          if (sort === 'updatedAt') return b.updatedAt.getTime() - a.updatedAt.getTime();
          return (rankOrder.get(a.id) ?? 0) - (rankOrder.get(b.id) ?? 0); // relevance (default)
        });
        const pageRows = ordered.slice(off, off + finalLimit);
        const hits = pageRows.map((n) => ({
          node: n,
          score: scoreById.get(n.id) ?? null,
          vector: simById?.has(n.id)
            ? { similarity: simById.get(n.id)!, model, chunkIndex: null, offsets: null, abstractStale: null, source: null }
            : null,
        }));
        // Graph-neighbour expansion (context; not re-filtered). Appended after the page.
        if (expandDepth > 0 && pageRows.length > 0) {
          const shown = new Set(pageRows.map((n) => n.id));
          const neighbourIds = (await expandWithNeighbors(
            ctx.db, pageRows.map((n) => n.id), expandDepth, { memoryIds: scopeIds },
          )).filter((id) => !shown.has(id) && !inheritanceExcluded.has(id));
          if (neighbourIds.length > 0) {
            // Neighbours are deliberately UNFILTERED (appended context), but
            // never out of scope: re-assert it here, like every other hydration
            // in findNodes (#1345 review) — expandWithNeighbors scoped them in a
            // separate query.
            // #1608 — neighbours stay in the content scope too: a comment's
            // governed edge must not pull it into a content search, or its
            // target into a comments-only one (cor:dmo:110:08).
            const nRows = await ctx.db.node.findMany({
              where: { id: { in: neighbourIds }, memoryId: { in: scopeIds }, deletedAt: null, ...(scopeWhere ? { AND: [scopeWhere] } : {}) },
              include: nodeInclude,
            });
            await decryptNodesBatch(ctx.db, nRows);
            const nById = new Map(nRows.map((n) => [n.id, n]));
            for (const id of neighbourIds) {
              const n = nById.get(id);
              if (n) hits.push({ node: n, score: null, vector: null });
            }
          }
        }
        await recordSearchHits(hits);
        return { hits, passages: [], total: null, reason, degraded };
      };

      // `sqlFilter` (built above, incl. the JSONB `where`) is passed to the lexical
      // SQL so keyword/regex results are filtered + sorted + paged exactly
      // (no relevance-truncate-then-filter).
      const lexSort = (sort ?? 'relevance') as 'relevance' | 'loc' | 'seq' | 'updatedAt';

      // Hydrate a ranked list the provider has ALREADY filtered/sorted/paged:
      // fetch by id (order preserved), decrypt, attach scores, append neighbours.
      const hydrateInOrder = async (
        ranked: { nodeId: string; score: number }[],
        simById: Map<string, number> | null,
        reason: string | null,
        degraded: string | null,
      ) => {
        // The lexical provider already applied offset/limit in SQL, so the floor
        // trims sub-threshold hits from the returned page (it does not backfill
        // from deeper ranks — a floor returns fewer, never weaker, results).
        ranked = applyFloor(ranked);
        const scoreById = new Map(ranked.map((r) => [r.nodeId, r.score]));
        // #1345 review (@copilot): the lexical/regex SQL applied scope and the
        // structured filters when RANKING; re-assert them at hydration, as
        // buildResult does, so a node whose role (or memory, or deletion) changed
        // in between is not returned against the filter it no longer meets.
        const rows = await ctx.db.node.findMany({
          where: { id: { in: ranked.map((r) => r.nodeId) }, memoryId: { in: scopeIds }, ...structuredWhere },
          include: nodeInclude,
        });
        await decryptNodesBatch(ctx.db, rows);
        const byId = new Map(rows.map((n) => [n.id, n]));
        const pageRows = ranked
          .map((r) => byId.get(r.nodeId))
          .filter((n): n is NonNullable<typeof n> => !!n);
        const hits = pageRows.map((n) => ({
          node: n,
          score: scoreById.get(n.id) ?? null,
          vector: simById?.has(n.id)
            ? { similarity: simById.get(n.id)!, model, chunkIndex: null, offsets: null, abstractStale: null, source: null }
            : null,
        }));
        if (expandDepth > 0 && pageRows.length > 0) {
          const shown = new Set(pageRows.map((n) => n.id));
          const neighbourIds = (await expandWithNeighbors(
            ctx.db, pageRows.map((n) => n.id), expandDepth, { memoryIds: scopeIds },
          )).filter((id) => !shown.has(id) && !inheritanceExcluded.has(id));
          if (neighbourIds.length > 0) {
            const nRows = await ctx.db.node.findMany({ where: { id: { in: neighbourIds }, memoryId: { in: scopeIds }, deletedAt: null, ...(scopeWhere ? { AND: [scopeWhere] } : {}) }, include: nodeInclude }); // #1608
            await decryptNodesBatch(ctx.db, nRows);
            const nById = new Map(nRows.map((n) => [n.id, n]));
            for (const id of neighbourIds) { const n = nById.get(id); if (n) hits.push({ node: n, score: null, vector: null }); }
          }
        }
        await recordSearchHits(hits);
        return { hits, passages: [], total: null, reason, degraded };
      };

      // Literal fallback for malformed boolean syntax: run the literalized
      // query; a quote-only/empty input still compiles to 'Empty query.'
      // even after literalQuery, which is genuinely zero searchable text —
      // return zero hits, never an error (PR-482 review).
      const safeLiteralSearch = async (
        searchArgs: Omit<Parameters<typeof provider.lexicalSearch>[0], 'query'>,
      ) => {
        try {
          return await provider.lexicalSearch({ ...searchArgs, query: literalQuery(q) });
        } catch (e) {
          if (e instanceof BooleanQueryError) return [];
          throw e;
        }
      };

      // ── LEXICAL modes: keyword (FTS) / regex — filter + sort + page in SQL ──
      if (effectiveMode === 'keyword' || effectiveMode === 'regex') {
        const common = {
          db: ctx.db, memoryIds: scopeIds, fields: lexFields, filter: sqlFilter,
          includeDeleted: !!f.includeDeleted, sort: lexSort,
          propertySort: sortProperty ?? undefined, offset: off, limit: finalLimit,
        };
        try {
          if (effectiveMode === 'regex') {
            return await hydrateInOrder(await provider.regexSearch({ ...common, pattern: q }), null, null, null);
          }
          const ranked = await provider.lexicalSearch({ ...common, query: q });
          // #496 — a natural-language query implicitly ANDs its terms, so one
          // word absent from the corpus zeroes the whole result set. When a bare
          // multi-term conjunction ANDs to zero, retry with the terms OR'd and
          // flag it — the agent gets partial recall (hits matching ANY term)
          // instead of a dead end plus a manual boolean rewrite. Only when the
          // relaxed query actually finds something; otherwise the terms genuinely
          // aren't present, so we keep the honest empty result.
          if (ranked.length === 0) {
            const orQuery = relaxConjunctionToOr(q);
            if (orQuery) {
              // Relax only when the STRICT query is GLOBALLY empty, not when the
              // caller has merely paged past the end of a matching set (PR-571
              // review, Gemini). On page 1 an empty `ranked` already proves that;
              // a deeper page needs a cheap offset-0 probe to distinguish the two
              // (else page 2+ of a relaxed set would come back empty, unpaginable).
              const strictGloballyEmpty =
                off === 0 ||
                (await provider.lexicalSearch({ ...common, query: q, offset: 0, limit: 1 })).length === 0;
              if (strictGloballyEmpty) {
                const relaxed = await provider.lexicalSearch({ ...common, query: orQuery });
                if (relaxed.length > 0) {
                  return await hydrateInOrder(relaxed, null, null, 'and_relaxed_to_or');
                }
              }
            }
          }
          return await hydrateInOrder(ranked, null, null, null);
        } catch (e) {
          // keyword only, explicitly: regexSearch never parses the boolean
          // grammar, but regex must stay hard-error by contract, so the
          // guard is self-documenting rather than incidental.
          if (e instanceof BooleanQueryError && effectiveMode === 'keyword') {
            // Literal fallback: malformed boolean syntax (unmatched paren,
            // unterminated quote, dangling operator) runs as a literal
            // phrase, flagged in the envelope — a search box never turns a
            // typo into BAD_USER_INPUT.
            return await hydrateInOrder(await safeLiteralSearch(common), null, null, 'literal_fallback');
          }
          if (e instanceof Error && (/invalid regular expression/i.test(e.message) || (e as { code?: string }).code === '2201B')) {
            throw badInput(`Invalid regex: ${e.message}`);
          }
          throw e;
        }
      }

      // ── VECTOR / HYBRID: narrow to vector-indexed memories ──
      const indexed = await ctx.db.memory.findMany({
        // #2199: a system memory is indexed by summary whatever its setting; indexing grants no access (scopeIds is already the caller's).
        where: { id: { in: scopeIds }, deletedAt: null, ...INDEXED_MEMORY_WHERE },
        select: { id: true },
      });
      const indexedIds = indexed.map((m) => m.id);

      // Keyword candidate source for hybrid RRF: relevance-ranked, filter applied
      // (buildResult re-filters the fused set too, so this is just less waste).
      // Malformed boolean syntax degrades to a literal phrase here too;
      // lexicalDegraded carries the flag into whichever degrade string the
      // hybrid path ends up emitting.
      let lexicalDegraded: string | null = null;
      const mergeDegraded = (d: string | null): string | null =>
        [d, lexicalDegraded].filter(Boolean).join(',') || null;
      // `relax` (#496, PR-571 review): only the keyword-ONLY hybrid FALLBACK
      // (no vector index / embeddings unavailable) opts in, so that path reaches
      // the same AND→OR relaxation mode:keyword does — otherwise `mode:hybrid`
      // on a non-indexed memory is strictly weaker than `mode:keyword` for the
      // same bare query. TRUE hybrid (vector present) does NOT relax: the vector
      // half already supplies recall, and relaxing would pollute the RRF inputs
      // and mislabel a vector-found result as `and_relaxed_to_or`.
      const runKeywordRanked = async (opts: { relax?: boolean } = {}) => {
        const args = {
          db: ctx.db, memoryIds: scopeIds, fields: lexFields, filter: sqlFilter,
          includeDeleted: !!f.includeDeleted, sort: 'relevance' as const, offset: 0, limit: fetchN,
        };
        const result = await hybridKeywordCandidates(q, query => provider.lexicalSearch({ ...args, query }), !!opts.relax);
        lexicalDegraded = result.degraded;
        return result.hits;
      };

      if (indexedIds.length === 0) {
        if (effectiveMode === 'hybrid') {
          return await buildResult(await runKeywordRanked({ relax: true }), null, null, mergeDegraded('no_vector_index'));
        }
        return { hits: [], passages: [], total: 0, reason: 'no_vector_index', degraded: null };
      }
      if (!isEmbeddingConfigured()) {
        if (effectiveMode === 'hybrid') {
          return await buildResult(await runKeywordRanked({ relax: true }), null, null, mergeDegraded('embedding_unavailable'));
        }
        return { hits: [], passages: [], total: 0, reason: 'embedding_unavailable', degraded: null };
      }

      let qvec: number[] | undefined;
      try {
        [qvec] = await getEmbeddingClient().embed([q], 'query');
      } catch (err) {
        console.warn(`[findNodes] embed() failed in mode:${effectiveMode}; degrading.`, err);
        if (effectiveMode === 'hybrid') {
          return await buildResult(await runKeywordRanked({ relax: true }), null, null, mergeDegraded('embedding_unavailable'));
        }
        return { hits: [], passages: [], total: 0, reason: 'embedding_unavailable', degraded: null };
      }
      if (!qvec) {
        return { hits: [], passages: [], total: 0, reason: 'embedding_unavailable', degraded: null };
      }

      // Chunk granularity (vector only) → passages, mirroring nodeSearch.
      // #1345 review (@codex P2): every structured node filter applies to the
      // passage's PARENT exactly as it does to a node hit — the same
      // `structuredWhere` (nodeType, objectType, isRunnable, role, tags,
      // locPrefix, createdBy, updated*, includeDeleted) plus the #719 `where`
      // predicate. v1 applied only `where`, so `role` / `isRunnable` — which the
      // MCP tool promises "in every mode" — silently returned passages from any
      // parent. And the filters run BEFORE paging, with the same over-fetch the
      // node path uses: a filtered-out passage must neither appear in nor
      // consume the requested page.
      if (granularity === 'chunk') {
        if (effectiveMode !== 'vector') {
          throw badInput(`findNodes granularity:chunk is only supported in mode:vector (got mode:${effectiveMode}).`);
        }
        // Fetch through the offset so paging works (vectorSearchChunks has no offset).
        // #497 — apply the minScore floor to the scored passages too (PR-569
        // review, Codex): filter before paging so a floor drops sub-threshold
        // chunks rather than silently returning them.
        const rawChunks = await widenVectorWindow((limit, onWindow) =>
          provider.vectorSearchChunks({ db: ctx.db, queryEmbedding: qvec, memoryIds: indexedIds, limit, onWindow, contentScope }),
        );
        const scoredChunks = scoreFloor == null ? rawChunks : rawChunks.filter((c) => c.score >= scoreFloor);
        const candidateParentIds = [...new Set(scoredChunks.map((c) => c.nodeId))];
        // #719 — honor `where` on chunk passages: keep only passages whose PARENT
        // node satisfies the predicate (also re-asserts the memory scope).
        let whereAllowed: Set<string> | null = null;
        if (f.where != null) {
          whereAllowed = new Set(
            await provider.filterWhere({
              db: ctx.db, ids: candidateParentIds,
              memoryIds: scopeIds, where: f.where, includeDeleted: !!f.includeDeleted,
              tombstoneMemoryIds: recoverableIds,
            }),
          );
        }
        const parents = await ctx.db.node.findMany({
          where: {
            id: { in: whereAllowed ? candidateParentIds.filter((id) => whereAllowed!.has(id)) : candidateParentIds },
            // @copilot: re-assert scope at hydration, as buildResult does.
            memoryId: { in: scopeIds },
            ...structuredWhere,
          },
          include: { memory: { select: { urn: true } } },
        });
        // #1885 (Diego, #1891 P2-1, chunk mode): the scope's exclusions were a
        // snapshot, so re-check every hydrated parent against the effective
        // set now, before eligibility, paging, usage and passage text. A base
        // node a child override or a boot-prompt turn took out after the
        // snapshot keeps its indexed chunks, and its text must not come back.
        if (inheritance.inheritedFrom.size > 0) {
          const kept = new Set((await retainEffective(ctx.db, parents, inheritance)).map((p) => p.id));
          for (let i = parents.length - 1; i >= 0; i--) if (!kept.has(parents[i]!.id)) parents.splice(i, 1);
        }
        const eligible = new Set(parents.map((p) => p.id));
        const chunkHits = scoredChunks.filter((c) => eligible.has(c.nodeId)).slice(off, off + finalLimit);
        const pageParentIds = new Set(chunkHits.map((c) => c.nodeId));
        const parentById = new Map(parents.map((p) => [p.id, p]));
        // #1061 — chunk granularity returns passages rather than whole nodes,
        // but the passage text IS node content, so each DISTINCT parent counts
        // once (not once per passage: three chunks of one node is one node's
        // content read, and per-chunk counting would make a node's read count
        // depend on how finely it happens to be chunked). Scoped to the parents
        // on the returned PAGE, so a filtered-out or off-page node records nothing.
        recordNodeUsage(
          ctx.db,
          'read',
          toUsageNodeRefs(parents.filter((p) => pageParentIds.has(p.id))),
          ctx,
        );
        const passages = chunkHits
          .filter((c) => parentById.has(c.nodeId))
          .map((c) => {
            const p = parentById.get(c.nodeId)! as { loc: string; memory: { urn: string } };
            // #697 Stage 2: emit the flat v2 node URN (matches Node.urn); fall
            // back to a best-effort flat-v2 join (still `hrn:node:`-prefixed and
            // single-colon, so parentNodeUrn stays uniform with the strict hits)
            // only if the stored memory urn can't compose.
            let parentNodeUrn: string;
            try {
              parentNodeUrn = emitNodeUrnV2(p.memory.urn, p.loc);
            } catch {
              parentNodeUrn = bestEffortFlatNodeUrn('node', p.memory.urn, p.loc);
            }
            return {
              parentNodeId: c.nodeId,
              parentNodeUrn,
              chunkIndex: c.chunkIndex,
              charStart: c.charStart,
              charEnd: c.charEnd,
              text: c.chunkText,
              score: c.score,
            };
          });
        return { hits: [], passages, total: null, reason: null, degraded: null };
      }

      const vecHits = await widenVectorWindow((limit, onWindow) =>
        provider.vectorSearch({ db: ctx.db, queryEmbedding: qvec, memoryIds: indexedIds, limit, onWindow, contentScope }),
      );

      if (effectiveMode === 'vector') {
        const simById = new Map(vecHits.map((h) => [h.nodeId, h.score]));
        return await buildResult(vecHits.map((h) => ({ nodeId: h.nodeId, score: h.score })), simById, null, null);
      }

      // hybrid — fuse keyword + vector by RRF (keyword already relevance-ranked by FTS).
      // The hit score is the FUSED RRF score (the value the hit was actually ranked
      // by), not the raw vector-sim / keyword-rank the pre-#497 code attached — those
      // aren't commensurable, so mixing them gave a misleading number and no sound
      // within-result-set relevance signal. The cosine similarity is still carried
      // separately on `vector.similarity` (simById below).
      const kwRanked = await runKeywordRanked();
      const fused = composeHybridRanking(kwRanked, vecHits, Math.max(fetchN, vecHits.length));
      const simById = new Map(vecHits.map((h) => [h.nodeId, h.score]));
      return await buildResult(
        fused.map((r) => ({ nodeId: r.nodeId, score: r.score })),
        simById,
        null,
        mergeDegraded(null),
      );
      };

      // ── Spec 049 Phase 3 — a scope named in the call (D-2026-09-13-002) ──
      // Resolve it, then run the core with the scope's memories as the explicit
      // memory set (S2: already ∩ the caller's access — a lens never grants,
      // D-004) and, for `global`, the organization narrowing; add the
      // disclosure envelope on the way out. `filter.memoryIds` narrows WITHIN
      // the scope. Omitted ⇒ the pre-049 semantics are untouched: the portal
      // and the CLI pass orgId and filters explicitly and never this argument,
      // so their results do not change under them from a flag they never passed
      // (`cor:acl:020:03` rule 5's surprise). The ambient rungs (session,
      // active App, active org) live on the MCP surface, which has session state.
      if (scope == null || scope.trim() === '') return core(coreArgs);

      const f = coreArgs.filter ?? {};
      const scopeRes = await resolveNamedScopeForQuery(ctx, scope, appRef ?? null, coreArgs.orgId ?? null);
      const info = await scopeInfoOf(ctx, scopeRes);
      const narrowed = scopeRes.droppedCount > 0 ? SCOPE_NARROWED : null;
      let innerFilter = f;
      let innerOrgId = coreArgs.orgId;
      if (scopeRes.memoryIds !== null) {
        let requested = scopeRes.memoryIds;
        if (f.memoryIds && f.memoryIds.length > 0) {
          const explicit = (
            await Promise.all(
              f.memoryIds.map((ref) =>
                isId(ref) ? Promise.resolve(ref) : resolveMemoryRef(ctx.db, ref).then((r) => r.id).catch(() => null)),
            )
          ).filter((id): id is string => id !== null);
          requested = scopeRes.memoryIds.filter((id) => explicit.includes(id));
        }
        if (requested.length === 0) {
          return { hits: [], passages: [], total: 0, reason: null, degraded: narrowed, scope: info };
        }
        innerFilter = { ...f, memoryIds: requested };
      } else if (scopeRes.kind === 'global') {
        innerOrgId = scopeRes.orgScopeId;
      }
      const inner = await core({ ...coreArgs, filter: innerFilter, orgId: innerOrgId });
      return { ...inner, scope: info, degraded: mergeDegradedCodes(inner.degraded, narrowed) };
    },

    /**
     * Spec cor:api:040 — batch node read. Returns the full per-node projection
     * for MANY nodes in one round-trip (the durable server-side primitive that
     * lets `spec lint --all` stop doing one nodeById per node). Two mutually-
     * exclusive forms: an explicit `refs` set (input order) or a `memory` +
     * `locPrefix` subtree (loc order).
     *
     * cor:api:140 / conventions:ref-param-naming (#813): each entry of `refs`
     * is a PK **or** a fully-qualified node URN, resolved through the shared
     * `resolveNodeRef`. It was PK-only until #813, which made the batch not
     * actually batch for URN callers — every URN needed its own resolveUrn
     * round trip first, so `nodeBatch` only halved the N+1 it exists to
     * remove. A malformed / unqualified ref still throws
     * (`UrnNotQualifiedError`): a caller bug must stay loud rather than hide
     * in `unavailable`, which is exactly the failure mode that let the missing
     * URN capability go unnoticed.
     *
     * Authorization is per-node and identical to the single-node read.
     * `resolveNodeRef` is a pure lookup — it does NOT gate — so the
     * memoryAccessFilter still scopes the fetch to readable memories AFTER
     * resolution (#554: widening an arg to accept a URN must not broaden the
     * reachable set). A denied OR missing ref simply isn't in the result and
     * lands in `unavailable` — indistinguishable, never failing the call
     * (cor:api:040:03, BOLA). `unavailable` / `omitted` echo the caller's own
     * ref strings, so a URN caller gets back something actionable rather than
     * a PK it never sent. Hard caps (cor:api:040:02): over the node-count cap
     * throws; over the response-size cap returns a partial result flagged
     * `truncated` — never a silent short read. Records one `read` UsageEvent
     * per node ACTUALLY RETURNED (#1061 — a node the size cap omitted is not
     * counted), matching the single-node GraphQL read (`node`), which records
     * one — per-surface parity. Before #1061 neither recorded anything, which
     * is what this sentence used to say (PR #1062 review — Copilot).
     */
    nodeBatch: async (
      _: unknown,
      { refs, memory, locPrefix }: { refs?: string[]; memory?: string; locPrefix?: string },
      ctx: Context,
    ) => {
      const hasSet = Array.isArray(refs) && refs.length > 0;
      const hasPrefix = memory != null && locPrefix != null;
      if (hasSet === hasPrefix) {
        throw new GraphQLError(
          'nodeBatch: provide EITHER `refs` (an explicit set) OR `memory` + `locPrefix` (a subtree) — not both, not neither.',
          { extensions: { code: 'BAD_USER_INPUT' } },
        );
      }

      const access = await memoryAccessFilter(ctx);
      // Select identities before reconciliation and packing. A response-size cap
      // checked AFTER loading every body does not bound the allocating read.
      const identity = { id: true, loc: true, memoryId: true, deletedAt: true, revSeq: true, role: true } as const;
      let ordered: Array<{
        id: string;
        loc: string;
        memoryId: string;
        deletedAt: Date | null;
        revSeq: number;
        role: string | null;
      }> = [];
      const unavailable: string[] = [];
      let batchInheritance: Awaited<ReturnType<typeof effectiveScope>> | null = null;
      let readViaMemoryId: string | null = null;
      // Explicit-set form only: resolved node id -> the caller's ref string, so
      // `unavailable` / `omitted` report back what the caller actually sent.
      // Null for the prefix form, where there are no caller refs (ids there).
      let refByNodeId: Map<string, string> | null = null;
      // #1885 — explicit refs that read through a child's effective system
      // memory (as node(ref:) does), with the child each came through.
      const explicitInherited = new Map<string, InheritedFrom>();
      const memoryAllowed = (memoryId: string) => {
        const scoped = access.memoryId as { in: string[] } | undefined;
        return !scoped || scoped.in.includes(memoryId);
      };

      if (hasSet) {
        // Count cap (cor:api:040:02) — caller knows the count; fail loud up front.
        if (refs!.length > BATCH_READ_MAX_NODES) {
          throw new GraphQLError(
            `nodeBatch: ${refs!.length} refs exceeds the ${BATCH_READ_MAX_NODES}-node cap. Split into smaller batches; the batch read does not silently truncate.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        // Dedup the raw input first (a repeated ref costs nothing to resolve
        // twice), then again on the RESOLVED id below — a PK and that node's
        // URN are different strings naming one node, and the single nodeById
        // can't duplicate, so neither should the batch.
        const uniqueRefs = [...new Set(refs!)];
        // Resolve every ref concurrently. A ref that names no live node
        // (NodeNotFoundError) is reported in `unavailable` exactly like a
        // denied one — one bad ref never fails the batch. A malformed /
        // unqualified ref propagates (UrnNotQualifiedError).
        //
        // A PK-shaped ref IS its own id, so it skips the lookup entirely: the
        // findMany below already filters `deletedAt` + access, which is where a
        // missing PK became `unavailable` before this surface took URNs at all.
        // That keeps the heavy PK callers (`spec lint --all`, `memory export` —
        // 200 ids straight off a findNodes page) at exactly one query, and
        // makes the added round trips proportional to the URNs actually passed.
        const resolved = await Promise.all(
          uniqueRefs.map(async (ref) => {
            if (isId(ref)) return { ref, id: ref as string | null };
            // A WRONG-TYPE URN (`hrn:mem:…`, `hrn:app:…`) is a coercion bug,
            // not a miss — but resolveNodeRef reports it with the SAME
            // NodeNotFoundError a genuinely absent node raises, so letting it
            // reach the catch below would file a caller's type error under
            // `unavailable`: the exact silence this surface just removed.
            // Screen it here with the shared parser, matching what the
            // single-node node(ref:) read does (PR #815 review, Codex P2).
            const typeErr = validateUrnType(parseUrnInput(ref), 'node');
            if (typeErr) {
              throw new GraphQLError(`nodeBatch: ${typeErr} (ref "${ref}")`, {
                extensions: { code: 'BAD_USER_INPUT' },
              });
            }
            try {
              const { id } = await resolveNodeRefForCaller(ctx, ref);
              return { ref, id: id as string | null };
            } catch (e) {
              if (e instanceof AmbiguousLegacyUrnError) return { ref, id: null };
              if (!(e instanceof NodeNotFoundError)) throw e;
              // #1885 (cor:dmo:050:14) — no node of its own and none moved:
              // a child URN reads through to the base that passes the loc
              // down, gated on the child's memory (Diego, #1891 P2-3).
              let parts: { memoryUrn: string; loc: string };
              try {
                parts = splitNodeUrn(ref);
              } catch {
                return { ref, id: null };
              }
              const child = await resolveMemoryRef(ctx.db, parts.memoryUrn).catch(() => null);
              if (!child || !memoryAllowed(child.id)) return { ref, id: null };
              const effective = await findEffectiveNodeIdByLoc(ctx.db, child.id, parts.loc);
              if (!effective?.inheritedFrom) return { ref, id: null };
              explicitInherited.set(effective.id, effective.inheritedFrom);
              return { ref, id: effective.id as string | null };
            }
          }),
        );
        refByNodeId = new Map();
        for (const { ref, id } of resolved) {
          if (id === null) {
            unavailable.push(ref);
            continue;
          }
          // First occurrence wins — its ref is the one echoed back and its
          // position sets the input order.
          if (!refByNodeId.has(id)) refByNodeId.set(id, ref);
        }
        // The access filter scopes to readable memories, so a denied node is
        // simply absent from the result — reported indistinguishably from a
        // ref that never resolved.
        const rows = await ctx.db.node.findMany({
          where: explicitInherited.size > 0
            ? { id: { in: [...refByNodeId.keys()] }, deletedAt: null, OR: [access, { id: { in: [...explicitInherited.keys()] } }] }
            : { id: { in: [...refByNodeId.keys()] }, deletedAt: null, ...access },
          select: identity,
        });
        const byId = new Map(rows.map((n) => [n.id, n]));
        for (const [id, ref] of refByNodeId) {
          const n = byId.get(id);
          if (n) ordered.push(n);
          else unavailable.push(ref);
        }
      } else {
        // #1316: an unreadable memory answers MEMORY_NOT_FOUND exactly like a
        // missing one; the FORBIDDEN it used to throw disclosed existence.
        // Gated on `access`, the node-content filter computed above, rather
        // than a second authorization round (@copilot, #1350).
        const { id: memId } = await resolveMemoryRef(ctx.db, memory!);
        const accessibleIds = access.memoryId as { in: string[] } | undefined;
        if (accessibleIds && !accessibleIds.in.includes(memId)) throw new MemoryNotFoundError(memory!);
        // Count cap: take MAX+1 to detect overflow, then fail loud rather than
        // silently returning a truncated subtree.
        // #1885 (cor:dmo:050:14) — the subtree of an Agent's system memory
        // reads as its effective memory, as MCP hadron_get_nodes does.
        readViaMemoryId = memId;
        batchInheritance = await effectiveScope(ctx.db, [memId]);
        const rows = await ctx.db.node.findMany({
          where: {
            memoryId: { in: batchInheritance.memoryIds },
            loc: { startsWith: locPrefix! },
            deletedAt: null,
            ...(batchInheritance.excludeNodeIds.length > 0 ? { id: { notIn: batchInheritance.excludeNodeIds } } : {}),
          },
          orderBy: { loc: 'asc' },
          take: BATCH_READ_MAX_NODES + 1,
          select: identity,
        });
        if (rows.length > BATCH_READ_MAX_NODES) {
          throw new GraphQLError(
            `nodeBatch: prefix "${locPrefix}" matches more than the ${BATCH_READ_MAX_NODES}-node cap. Narrow the prefix; the batch read does not silently truncate.`,
            { extensions: { code: 'BAD_USER_INPUT' } },
          );
        }
        ordered = rows;
      }

      // Recheck selected identities before packing. Bodies are reconciled and
      // authorized in separate short transactions only when about to be packed;
      // no batch transaction accumulates locks against multi-node writers.
      const selectedById = new Map(ordered.map((n) => [n.id, n]));
      const liveIds = [...selectedById.keys()];
      // #1885 — inherited rows were admitted through the child's memory, so
      // the re-check admits exactly those ids alongside the caller's access.
      const inheritedIds = [
        ...(batchInheritance ? ordered.filter((n) => batchInheritance!.inheritedFrom.has(n.memoryId)).map((n) => n.id) : []),
        ...explicitInherited.keys(),
      ];
      const currentRows = await ctx.db.node.findMany({
        where: inheritedIds.length > 0
          ? { id: { in: liveIds }, deletedAt: null, OR: [access, { id: { in: inheritedIds } }] }
          : { id: { in: liveIds }, deletedAt: null, ...access },
        select: identity,
      });
      if (batchInheritance) {
        const kept = new Set((await retainEffective(ctx.db, currentRows, batchInheritance)).map((n) => n.id));
        for (let i = currentRows.length - 1; i >= 0; i--) if (!kept.has(currentRows[i]!.id)) currentRows.splice(i, 1);
        markInherited(currentRows, batchInheritance.inheritedFrom);
      }
      for (let i = currentRows.length - 1; i >= 0; i--) {
        const row = currentRows[i]!;
        const from = explicitInherited.get(row.id);
        if (!from) continue;
        if (await stillInherited(ctx.db, from, row)) Object.assign(row, { inheritedFrom: from });
        else currentRows.splice(i, 1);
      }
      const currentById = new Map(currentRows.map((n) => [n.id, n]));
      ordered = ordered.flatMap((selected) => {
        const current = currentById.get(selected.id);
        if (
          !current ||
          current.memoryId !== selected.memoryId ||
          current.loc !== selected.loc
        ) {
          unavailable.push(refByNodeId?.get(selected.id) ?? selected.id);
          return [];
        }
        return [current];
      });
      // Response-size cap (cor:api:040:02) — pack until the byte ceiling, then
      // stop and flag `truncated` with the omitted nodes. At least one node
      // always returns (a single oversize node still comes back). Size is
      // measured on the decrypted content + abstract; the client selects the
      // rest. Dropped entries are reported as the caller's own ref (explicit-set
      // form) so they can be re-requested verbatim; the prefix form has no
      // caller refs, so it reports ids.
      const nodes: unknown[] = [];
      const omitted: string[] = [];
      const echo = (id: string) => refByNodeId?.get(id) ?? id;
      let bytes = 0;
      let truncated = false;
      for (const selected of ordered) {
        if (truncated) {
          omitted.push(echo(selected.id));
          continue;
        }
        // Hydrate only the next row being packed, pinned to the authorized
        // identity. Recheck inherited eligibility on the actual hydrated row.
        const from = (selected as typeof selected & { inheritedFrom?: InheritedFrom }).inheritedFrom;
        const n = await withReconciledNodeRead(ctx.db, selected.id, selected.memoryId,
          async (tx, mayReconcile) => {
            const fresh = await (mayReconcile ? liveTxContext : liveReadSnapshotContext)(ctx, tx);
            return isMemoryReadableCached(fresh, from?.via ?? readViaMemoryId ?? selected.memoryId);
          },
          async (tx) => {
            const row = await tx.node.findFirst({
              where: { id: selected.id, memoryId: selected.memoryId, loc: selected.loc, deletedAt: null },
            });
            return row && (!from || await stillInherited(tx, from, row)) ? row : null;
          },
          { timeoutMs: 60_000, maxWaitMs: 15_000 },
        );
        if (!n) {
          unavailable.push(echo(selected.id));
          continue;
        }
        if (from) Object.assign(n, { inheritedFrom: from });
        await decryptNodesBatch(ctx.db, [n]);
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
          omitted.push(echo(n.id));
          continue;
        }
        nodes.push(Object.assign(n, { [CONTENT_RAW_DEFAULT]: true }));
        bytes += size;
      }

      // #1061 — one read per node actually RETURNED. Deliberately `nodes` and
      // not `ordered`: a node the byte cap omitted was never handed to the
      // caller, so counting it would credit a read that didn't happen.
      recordNodeUsage(ctx.db, 'read', toUsageNodeRefs(nodes), ctx);
      markBatchReadNodes(nodes as object[]);

      return { nodes, unavailable, truncated, omitted };
    },

    /**
     * Usage events for a node loc, most recent first.
     *
     * @deprecated Use `usageEvents(loc: <loc>)` — see the `@deprecated`
     * directive on the schema field. `usageEvents`' `loc` argument is the SAME
     * verbatim exact `nodeLoc` match under the same gate, so the migration is
     * a rename; it is additionally a strict superset (PK / fully-qualified URN
     * refs via `nodeId`, `type`, `memoryId`, `offset`). NOT `nodeId: <loc>`:
     * that slot is shape-classified, and a hierarchical loc (≥3 colon
     * segments, e.g. a spec citation) qualifies as node-URN shape and routes
     * to ref resolution instead (PR-986 review, Codex P2).
     *
     * Deprecated for REDUNDANCY, not because it is unsafe — it is gated (below)
     * and stays supported. Keep it working: the deprecation is a signpost for
     * clients, and this resolver is the only thing standing behind any caller
     * that hasn't migrated. Delete only after a deprecation window, and only
     * once portal / CLI / docs are re-checked for callers.
     *
     * `loc` names no memory, so this is a CROSS-MEMORY exact `nodeLoc` match —
     * the same verbatim semantics as `usageEvents(loc: <loc>)`, bounded to
     * the memories the caller may read. It is a filter, not a lookup: an
     * unknown loc yields `[]` rather than NODE_NOT_FOUND. A bare loc cannot
     * disambiguate the same loc in two memories; `usageEvents(nodeId: <PK|URN>)`
     * is the memory-precise form.
     *
     * Access control (#802): this resolver previously had NO gate at all —
     * neither `requireRole` nor memory scoping — so any caller could read any
     * tenant's usage events for any loc they could guess. It now mirrors its
     * siblings (`usageEvents` #250, `memoryUsageSummary`, `nodeRevisions`
     * #602): `requireRole(READER)`, which also rejects App-key callers
     * (`roles: []` — App usage reads go through MCP, not GraphQL), plus
     * `getAccessibleMemoryIds` scoping.
     *
     * Scoping is on the denormalized `UsageEvent.memoryId` COLUMN, not a
     * `node: { memoryId }` relation join: `nodeId` is `SetNull`, so a join
     * drops every event whose node has since been deleted — the loss #796
     * moved `usageEvents` / `memoryUsageSummary` onto the column to prevent.
     * An event with a NULL `memoryId` (its node was already gone at backfill
     * time) is excluded by the `IN`, exactly as in `usageEvents`, so the two
     * surfaces stay in parity.
     *
     * Non-disclosure: an unreadable loc and a nonexistent one are both `[]` —
     * never a thrown Forbidden, matching `memoryUsageSummary` / `usageActivity`.
     */
    nodeUsage: async (_: unknown, { loc, limit }: { loc: string; limit?: number }, ctx: Context) => {
      requireRole(ctx, 'READER');
      // `string[] | null`, where null means "unrestricted (no filter)". Every
      // branch returns an explicit list today — ADMIN/OWNER included, so the
      // personal/private carve-out still applies — so the `!== null` guard is
      // defensive for the type contract rather than a live path.
      const accessibleMemoryIds = await getAccessibleMemoryIds(ctx);
      return ctx.db.usageEvent.findMany({
        where: {
          nodeLoc: loc,
          ...(accessibleMemoryIds !== null ? { memoryId: { in: accessibleMemoryIds } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 20,
      });
    },

    nodeEdgeRemovals: async (_: unknown, { nodeRef, limit }: { nodeRef: string; limit?: number }, ctx: Context) => {
      const scope = await nodeRevisionsScope(ctx, nodeRef);
      if (!scope) return [];
      // Each entry carries the memory it was recorded in: a source that later MOVED keeps no more history
      // visible than nodeRevisions shows, so the memory gate is in the `where`, before `take`.
      const rows = await ctx.db.nodeEdgeRemoval.findMany({
        where: scope.accessible === null
          ? { sourceId: scope.nodeId }
          : { sourceId: scope.nodeId, memoryId: { in: scope.accessible } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit ?? 20,
      });
      // The deleted target's address is another node's identity, and the edge's own loc is derived from both
      // endpoints: show neither where the target's memory is not readable.
      return rows.map((r) => {
        const readable = scope.canRead(r.targetMemoryId);
        return { ...r, targetLoc: readable ? r.targetLoc : null, edgeLoc: readable ? r.edgeLoc : null };
      });
    },

    nodeRevisions: async (_: unknown, { nodeRef, limit }: { nodeRef: string; limit?: number }, ctx: Context) => {
      const scope = await nodeRevisionsScope(ctx, nodeRef);
      if (!scope) return [];
      const { nodeId, memoryId, canRead } = scope;
      const revisions = await ctx.db.nodeRevision.findMany({
        where: { nodeId },
        orderBy: { createdAt: 'desc' },
        take: limit ?? 20,
      });
      // Drop snapshots captured while the node lived in a memory the caller
      // can't read. Legacy rows (memoryId NULL) fall back to the node's current
      // memory, already authorized above. (Filter after take: a >limit-revision
      // node spanning inaccessible memories may under-return near the limit —
      // safe, never over-returns.)
      return decryptReadableRevisions(
        ctx.db, revisions.filter((v) => canRead(v.memoryId ?? memoryId)), memoryId,
      );
    },

    /**
     * #2212 A1 — `nodeRevisions` as a page. Same admission (one shared `nodeRevisionsScope`), but the
     * per-snapshot memory gate is in the SQL `where`, so `total` counts only snapshots the caller may read
     * and the page does not under-return. Legacy rows (memoryId NULL) fall back to the node's memory,
     * already authorized by the scope. Decryption runs on the returned page only.
     */
    nodeRevisionsPage: async (
      _: unknown,
      args: { nodeRef: string; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => {
      const { take, skip } = pageArgs(args);
      const scope = await nodeRevisionsScope(ctx, args.nodeRef);
      if (!scope) return pageEnvelope([], 0, skip);
      const { nodeId, memoryId, accessible } = scope;
      const where: Prisma.NodeRevisionWhereInput = accessible === null
        ? { nodeId }
        : { nodeId, OR: [{ memoryId: { in: accessible } }, { memoryId: null }] };
      const [total, rows] = await ctx.db.$transaction([
        ctx.db.nodeRevision.count({ where }),
        ctx.db.nodeRevision.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take, skip }),
      ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
      return pageEnvelope(await decryptReadableRevisions(ctx.db, rows, memoryId), total, skip);
    },

    // #617 (Display) — a single snapshot by id, so the portal doesn't filter
    // the list client-side. Access-gated like nodeRevisions: read on the node's
    // current memory AND on the snapshot's own memory (per-snapshot gating —
    // a moved node keeps its id, so a snapshot may live in a memory the caller
    // can't read). Any miss collapses to null (no existence disclosure).
    nodeRevision: async (_: unknown, { revisionId }: { revisionId: string }, ctx: Context) => {
      requireRole(ctx, 'READER');
      const revision = await ctx.db.nodeRevision.findUnique({ where: { id: revisionId } });
      if (!revision) return null;
      const node = await ctx.db.node.findUnique({
        where: { id: revision.nodeId },
        select: { memoryId: true, deletedAt: true },
      });
      // A soft-deleted node drops out of every read surface: nodeRevisions
      // resolves through resolveNodeRef (excludes tombstones) → []. This by-id
      // read must match, or a retained revisionId keeps leaking a deleted node's
      // history to any reader of its memory (PR #618 review).
      if (!node || node.deletedAt) return null;
      const accessible = await getAccessibleMemoryIds(ctx);
      const canRead = (memId: string) => accessible === null || accessible.includes(memId);
      if (!canRead(node.memoryId)) return null;
      if (!canRead(revision.memoryId ?? node.memoryId)) return null;
      if (await isConcealedCommentHistory(ctx, revision.nodeId)) return null; // #1663
      return (await decryptReadableRevisions(ctx.db, [revision], node.memoryId))[0]!;
    },

    /** #2190 (cor:dmo:050:17): the memories appNodes reads for this caller, one page. */
    appMemoryScope: (
      _: unknown,
      { appRef, limit, offset }: { appRef: string; limit?: number | null; offset?: number | null },
      ctx: Context,
    ) => appMemoryScopePage(ctx, appRef, limit, offset),

    appNodes: async (
      _: unknown,
      { appRef, filter, limit }: {
        appRef: string;
        filter?: {
          // Memory-scope fields — NOT supported by appNodes (the App's scope is
          // authoritative). Present only so we can reject them explicitly.
          memoryIds?: string[] | null;
          memoryClasses?: string[] | null;
          nodeType?: string | null;
          objectType?: string | null;
          tags?: string[] | null;
          isRunnable?: boolean | null;
          role?: string | null;
          locPrefix?: string | null;
          createdBy?: string | null;
          updatedAfter?: string | null;
          updatedBefore?: string | null;
          includeDeleted?: boolean | null;
          /** #1591 */
          approvalState?: NodeApprovalState | null;
          /** #1591 */
          minted?: boolean | null;
        } | null;
        limit?: number;
      },
      ctx: Context,
    ) => {
      // #2190 (cor:dmo:050:17) — admission and the memory scope are ONE
      // computation, shared with appMemoryScope: a second copy would drift.
      const scope = await resolveAppNodeScope(ctx, appRef);
      if (!scope) return [];
      const { inheritance } = scope;
      const memoryIds = inheritance.memoryIds;

      // #525 — optional node-level NodeFilter, pushed server-side so callers
      // (e.g. an App's runnable-task picker) can request `{ isRunnable: true }`
      // without fetching everything and filtering client-side. The App's memory
      // scope stays authoritative, and unlike findNodes we do NOT impose the
      // default `nodeType != 'system'` exclusion — appNodes deliberately
      // surfaces the system memory (#524).
      const f = filter ?? {};
      const badInput = (msg: string) =>
        new GraphQLError(msg, { extensions: { code: 'BAD_USER_INPUT' } });
      // #526 review — NodeFilter carries memory-scope fields that appNodes can't
      // honor (its scope is the App's memories). Reject rather than silently
      // ignore them, so a caller who assumed they scoped fails fast instead of
      // getting a surprising superset. Use findNodes for cross-memory scoping.
      if (f.memoryIds?.length || f.memoryClasses?.length) {
        throw badInput(
          'appNodes: filter.memoryIds / filter.memoryClasses are not supported — ' +
            "the App's installed-agent memories are the authoritative scope. " +
            'Use findNodes for cross-memory scoping.',
        );
      }
      if (f.updatedAfter && Number.isNaN(Date.parse(f.updatedAfter))) {
        throw badInput('appNodes filter.updatedAfter must be a valid date string.');
      }
      if (f.updatedBefore && Number.isNaN(Date.parse(f.updatedBefore))) {
        throw badInput('appNodes filter.updatedBefore must be a valid date string.');
      }

      const recoverableAppMemoryIds = f.includeDeleted ? await recoveryMemoryIds(ctx, memoryIds) : [];
      const results = await ctx.db.node.findMany({
        where: {
          memoryId: { in: memoryIds },
          ...(f.includeDeleted ? {} : { deletedAt: null }),
          ...(f.nodeType ? { nodeType: f.nodeType } : {}),
          ...(f.objectType ? { objectType: f.objectType } : {}),
          ...(f.isRunnable != null ? { isRunnable: f.isRunnable } : {}),
          ...(f.role != null
            ? {
                OR: [
                  { role: f.role },
                  { role: { startsWith: escapePrismaLikePattern(`${f.role}.`) } },
                ],
              }
            : {}),
          ...(f.tags?.length ? tagsFilter(f.tags) : {}),
          ...(f.locPrefix ? { loc: { startsWith: f.locPrefix } } : {}),
          ...(f.createdBy ? { createdBy: f.createdBy } : {}),
          ...((f.updatedAfter || f.updatedBefore)
            ? { updatedAt: {
                ...(f.updatedAfter ? { gte: new Date(f.updatedAfter) } : {}),
                ...(f.updatedBefore ? { lte: new Date(f.updatedBefore) } : {}),
              } }
            : {}),
          ...approvalStatePrismaWhere(f.approvalState, ctx.db),
          // #1607 (cor:dmo:110:06) — approval and mint status sets never contain comments.
          // #1607 + #1608 — no comments in status sets; content, comments or
          // both by contentScope (CONTENT by default, cor:dmo:110:08).
          AND: [
            ...(f.includeDeleted ? [{ OR: [{ deletedAt: null }, { memoryId: { in: recoverableAppMemoryIds }, nodeType: { not: COMMENT_NODE_TYPE } }] }] : []),
            ...(f.minted != null ? [mintedPrismaWhere(f.minted)] : []),
            ...(f.approvalState != null || f.minted != null ? [{ nodeType: { not: COMMENT_NODE_TYPE } }] : []),
            ...((sw) => (sw ? [sw] : []))(contentScopeWhere(effectiveContentScope(f))),
            ...(inheritance.excludeNodeIds.length > 0 ? [{ id: { notIn: inheritance.excludeNodeIds } }] : []),
          ],
        },
        orderBy: { loc: 'asc' },
        take: limit ?? 20,
        include: {
          outgoingEdges: { include: { target: true } },
          incomingEdges: { include: { source: true } },
          memory: { select: { id: true, urn: true, name: true, organizationId: true } },
        },
      });
      // The exclusion list was a snapshot: re-check what was read (P2-1).
      const kept = new Set((await retainEffective(ctx.db, results, inheritance)).map((r) => r.id));
      for (let i = results.length - 1; i >= 0; i--) if (!kept.has(results[i]!.id)) results.splice(i, 1);
      await decryptNodesBatch(ctx.db, results);
      markInherited(results, inheritance.inheritedFrom);
      // #1061 — the App-scoped node list returns full node projections, so each
      // one is a read. Scope is the App's installed-agent memories, established
      // above.
      recordNodeUsage(ctx.db, 'read', toUsageNodeRefs(results), ctx);
      return results;
    },

};
