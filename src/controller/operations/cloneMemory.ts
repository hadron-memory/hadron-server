import { COMPILED_BOOT_PROMPT_NODE_TYPE, assertNoBootPromptRowsForWorkerSession } from '../../lib/bootPrompt.js';
import { assertCopiedIncludesWritable, resyncDerivedIncludesForNodes, type ReadableMemoryIds } from '../../lib/includes/writeIncludes.js';
import type { PrismaClient } from '../../generated/prisma/index.js';
import { COMMENT_NODE_TYPE } from '../../lib/comments/index.js';
import { NOT_DECISION_FAMILY_WHERE } from '../../lib/decisions/index.js';
import { Prisma } from '../../generated/prisma/index.js';
import { mapChatSeqConflict } from '../../lib/prismaErrors.js';
import { generateId } from '../../lib/id.js';
import { ensureCurrentNodeRevisionInTransaction, jsonOrDbNull } from '../../lib/nodeRevisionSnapshot.js';
import { carryGovernedSignals } from '../../lib/governedSignals.js';
import { carryNodeAuthorship, clearNodeAuthorship } from '../../lib/nodeAuthorship.js';
import { computeContentHash } from '../../lib/contentHash.js';
import { resetEmbeddingObligations } from '../../services/embedding/obligation.js';
import { memoryIsVectorIndexed } from '../../lib/embedding/indexing.js';
import {
  pendingEdgeStableTargetId,
  pendingEdgeStableTargetKey,
} from '../../lib/pendingEdgePromotion.js';

/**
 * Clone a Memory: copy the Memory row plus its live graph (Nodes, Edges,
 * PendingEdges) into a new Memory under a new URN, rewriting references to
 * the source memory's URN inside node content/abstract and pending-edge
 * targets.
 *
 * What is deliberately NOT copied (the clone is a fresh start, not a fork
 * of the source's operational state):
 *   - NodeRevision history — clone nodes are "newly created" (the create
 *     path in upsertNode also writes no initial version).
 *   - NodeEmbedding vectors — content changes under URN rewrite, so the
 *     caller re-stamps via backfillMemoryEmbeddings when the clone is
 *     vector-indexed.
 *   - MemorySubscription / MemoryShare / MemoryMember / Session /
 *     MemoryLicense / AgentMemoryItem / MemoryLogEntry rows — social and
 *     operational state belongs to the source. (Group-class clones get the
 *     caller bootstrapped as first owner, matching createMemory.)
 *   - Assets — bytes live in object storage; copying them is a future
 *     follow-up. Asset URNs in content keep pointing at the source memory.
 *   - Git-sync config (source, tokens, branches, sync state) — a clone
 *     syncing from the source repo would be destructively overwritten
 *     (repo wins), so it starts DB-only.
 *   - Soft-deleted nodes/edges — only the live graph is cloned.
 */

/**
 * The two textual forms a memory URN appears in inside node content.
 * `Memory.urn` is STORED in legacy form `<org>:<slug>` (org URNs contain no
 * `:`); the spec-021 canonical form doubles the org→memory separator:
 * `<org>::<slug>`. Node references in content appear as
 * `urn:node:<org>::<slug>::<loc>`, bare `<org>::<slug>::<loc>`, or legacy
 * `<org>:<slug>:<loc>` — all share one of these two memory-URN prefixes.
 */
export function memoryUrnForms(storedUrn: string): { legacy: string; canonical: string } {
  const sep = storedUrn.indexOf(':');
  const canonical =
    sep === -1 ? storedUrn : `${storedUrn.slice(0, sep)}::${storedUrn.slice(sep + 1)}`;
  return { legacy: storedUrn, canonical };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Slug-atom charset per the spec-021 grammar is [a-z0-9._-]; boundary
// classes below decide where a memory-URN match may begin/end inside prose.
//
// Left boundary INCLUDES `.` — so `foo.acme.com:dev` (a different org that
// happens to end with the source org's domain) is not rewritten.
// Right boundary: a bare `.` followed by a non-slug char (or end) is
// sentence punctuation ("see acme.com::dev.") and must NOT block the
// rewrite — but `.` followed by another slug-atom char is still inside an
// identifier (`acme.com::dev.x` is a DIFFERENT memory whose slug extends
// the source's with a dot atom), so that blocks the match (PR-265 review,
// Copilot).
const LEFT_BOUNDARY = 'A-Za-z0-9._-';
const RIGHT_BOUNDARY = 'A-Za-z0-9_-';
const SLUG_ATOM = 'A-Za-z0-9._-';

/**
 * Rewrite every reference to `oldUrn` (stored legacy form) into `newUrn`
 * inside a text blob. Handles both the canonical (`org::slug`) and legacy
 * (`org:slug`) spellings, including `urn:<type>:`-prefixed and
 * node-loc-suffixed (`...::loc:part`) occurrences. Returns the input
 * unchanged (same reference) when nothing matches.
 */
export function rewriteMemoryUrnRefs(
  text: string | null,
  oldUrn: string,
  newUrn: string,
): string | null {
  if (!text) return text;
  const oldForms = memoryUrnForms(oldUrn);
  const newForms = memoryUrnForms(newUrn);
  let out = text;
  // Canonical pass first: after it, no canonical spelling of the old URN
  // remains, so the legacy pass can't partially match inside one.
  for (const [from, to] of [
    [oldForms.canonical, newForms.canonical],
    [oldForms.legacy, newForms.legacy],
  ] as const) {
    const re = new RegExp(
      `(?<![${LEFT_BOUNDARY}])${escapeRegExp(from)}(?![${RIGHT_BOUNDARY}])(?!\\.[${SLUG_ATOM}])`,
      'g',
    );
    out = out.replace(re, to);
  }
  return out;
}



export interface CloneMemoryArgs {
  sourceMemoryId: string;
  /** New memory display name; the caller derives `newUrn` from it. */
  name: string;
  /** Pre-computed `<org.urn>:<name>` for the clone (caller checks collisions). */
  newUrn: string;
  /**
   * Org the clone lands in. Same as the source's org for an in-org clone, or a
   * DIFFERENT org for a cross-org clone (#604) — the caller resolves it from
   * `newUrn`'s org segment and authorizes the target org before we get here.
   */
  targetOrganizationId: string;
  /** Owner for personal/private clones (chk_personal_visibility_user). */
  ownerUserId: string | null;
  /** Bootstrap this user as the group-class clone's first owner member. */
  groupOwnerUserId: string | null;
  /** Audit attribution for createdBy columns. */
  actorId: string | null;
  /** #2167 — memories the copier may read (`getAccessibleMemoryIds`); `null` = unrestricted. */
  copierReadableMemoryIds: ReadableMemoryIds;
}

export interface CloneMemoryResult {
  memoryId: string;
  nodeCount: number;
  edgeCount: number;
  pendingEdgeCount: number;
}

/** {@link CloneMemoryResult} plus what an in-transaction caller (agent clone, #2245) needs to remap and audit. */
export interface CloneMemoryInTxResult extends CloneMemoryResult {
  /** Source node id -> cloned node id, for every copied node. */
  nodeIdMap: ReadonlyMap<string, string>;
  /** Live source edges not copied (soft-deleted or cross-org external targets). */
  skippedEdgeCount: number;
  /** The ids of the source rows this copy actually read, sorted; checked by `cloneAgent` against the source's live membership. */
  consumed: CopySetKeys;
}

/** The ids of the source rows a clone copies, sorted. */
export interface CopySetKeys {
  nodeIds: string[];
  edgeIds: string[];
  pendingEdgeIds: string[];
}

/**
 * Execute the clone inside one transaction. The caller is responsible for
 * authorization, source-class/encryption gating, and URN collision checks
 * (see the cloneMemory resolver), plus post-clone embedding backfill.
 */
export async function cloneMemoryGraph(
  db: PrismaClient,
  args: CloneMemoryArgs,
): Promise<CloneMemoryResult> {
  return db.$transaction(
    async (tx) => {
      const { nodeIdMap: _nodeIdMap, skippedEdgeCount: _skipped, ...result } = await cloneMemoryGraphInTx(tx, args);
      return result;
    },
    // Large memories copy thousands of rows; the default 5s interactive-
    // transaction timeout is too tight.
    { timeout: 120_000 },
  );
}

/**
 * {@link cloneMemoryGraph}'s body inside the caller's transaction (#2245): the caller owns the
 * transaction, its locks and its timeout, and reads the node id map back. Behaviour is the
 * wrapper's, unchanged.
 */
/** The source nodes a clone copies. */
function copyableNodeWhere(memoryId: string): Prisma.NodeWhereInput {
  return {
    memoryId, deletedAt: null, nodeType: { notIn: [COMMENT_NODE_TYPE, COMPILED_BOOT_PROMPT_NODE_TYPE] },
    // #1641 §3.2 — nor decisions or their logs: a copy would mint decisions
    // no decision operation wrote, under codes that belong to the source log.
    AND: [NOT_DECISION_FAMILY_WHERE],
  };
}

/** Derived INCLUDE edges (#2040) are re-derived for the clones, not copied. */
const copyableEdgeWhere = (nodeIds: string[]): Prisma.EdgeWhereInput =>
  ({ deletedAt: null, sourceId: { in: nodeIds }, OR: [{ governedKind: null }, { governedKind: { not: 'INCLUDE' } }] });

const copyablePendingEdgeWhere = (nodeIds: string[]): Prisma.PendingEdgeWhereInput =>
  ({ deletedAt: null, sourceId: { in: nodeIds } });

/**
 * Reconcile every authorship-stamped source node with its revision state (a raw writer may have changed it
 * without advancing the revision) and return the refetched rows. Idempotent: a second pass writes nothing.
 * `cloneAgent` runs it BEFORE its source baseline, so these intentional writes are not read as source churn.
 */
export async function reconcileStampedNodes<N extends { id: string; authorshipKind: unknown }>(
  tx: Prisma.TransactionClient,
  sourceMemoryId: string,
  selectedNodes: N[],
): Promise<Map<string, N>> {
  const refreshed = new Map<string, N>();
  for (const n of selectedNodes.filter((n) => n.authorshipKind).sort((a, b) => a.id.localeCompare(b.id))) {
    const rev = await ensureCurrentNodeRevisionInTransaction(tx, n.id, { expectedMemoryId: sourceMemoryId });
    const current = rev == null ? null : await tx.node.findUnique({ where: { id: n.id } });
    if (!current || current.deletedAt || current.memoryId !== sourceMemoryId) {
      throw new Error('cloneMemory: a source node changed during the copy; retry.');
    }
    refreshed.set(n.id, current as unknown as N);
  }
  return refreshed;
}

/** Reconcile the stamped nodes of a memory about to be cloned; see {@link reconcileStampedNodes}. */
export async function reconcileStampedSourceNodes(tx: Prisma.TransactionClient, sourceMemoryId: string): Promise<void> {
  await reconcileStampedNodes(tx, sourceMemoryId, await tx.node.findMany({ where: { ...copyableNodeWhere(sourceMemoryId), authorshipKind: { not: null } } }));
}

export async function cloneMemoryGraphInTx(
  tx: Prisma.TransactionClient,
  args: CloneMemoryArgs,
): Promise<CloneMemoryInTxResult> {
  const source = await tx.memory.findUniqueOrThrow({
    where: { id: args.sourceMemoryId },
  });

  const memoryId = generateId();
  await tx.memory.create({
    data: {
      id: memoryId,
      // #604: the clone lands in the caller-resolved target org, which may
      // differ from the source's (cross-org clone). Same-org clones pass
      // the source's own org id here, so this is a no-op for them.
      organizationId: args.targetOrganizationId,
      urn: args.newUrn,
      name: args.name,
      shortDescription: source.shortDescription,
      description: source.description,
      tags: source.tags,
      license: source.license,
      category0: source.category0,
      category1: source.category1,
      category2: source.category2,
      iconUrl: source.iconUrl,
      heroUrl: source.heroUrl,
      homeUrl: source.homeUrl,
      visibility: source.visibility,
      class: source.class,
      requiresLicense: source.requiresLicense,
      acceptsUploads: source.acceptsUploads,
      // 033 vector-index config carries over; vectors themselves are
      // re-derived (the caller backfills after the transaction).
      vectorIndexEnabled: source.vectorIndexEnabled,
      embeddingSource: source.embeddingSource,
      chunkTokens: source.chunkTokens,
      chunkOverlap: source.chunkOverlap,
      forceFixedSize: source.forceFixedSize,
      // #621 — clone inherits the source's revision cap.
      maxRevCount: source.maxRevCount,
      // #725 — carry the property schema so the clone's copied objectType
      // nodes stay governed (and MCP discovery keeps reporting the contract).
      schema: jsonOrDbNull(source.schema),
      // Git-sync config intentionally NOT copied — see module doc.
      // userId only for personal/private (CHECK-enforced both ways).
      userId: args.ownerUserId,
      createdBy: args.actorId,
    },
  });

  // ── Nodes ──────────────────────────────────────────────────────────
  // #1606 — comments are discussion about the source's nodes, not content:
  // a clone starts without them (and a generic copy could not produce one,
  // cor:dmo:110:04). Their governed edges drop with them below, since an
  // edge is copied only from a cloned source.
  const selectedNodes = await tx.node.findMany({ where: copyableNodeWhere(source.id) });
  // #2043 (cor:agt:040:11) — a worker session's copy never writes a boot prompt.
  await assertNoBootPromptRowsForWorkerSession(tx, source.id, 'clone');
  // A raw writer may have changed a stamped source without advancing its
  // revision. Reconcile and refetch stamped rows before the destination
  // insert can certify a stale claim against freshly copied content.
  const refreshed = await reconcileStampedNodes(tx, source.id, selectedNodes);
  const nodes = selectedNodes.map((n) => refreshed.get(n.id) ?? n);

  const idMap = new Map<string, string>();
  for (const n of nodes) idMap.set(n.id, generateId());

  const nodeRows: Prisma.NodeCreateManyInput[] = nodes.map((n) => {
    const newContent = rewriteMemoryUrnRefs(n.content, source.urn, args.newUrn);
    const newAbstract = rewriteMemoryUrnRefs(n.abstract, source.urn, args.newUrn);
    const contentChanged = newContent !== n.content;
    // Spec 032: abstractOriginHash is SHA256(plaintext content) at
    // abstract-authoring time. If the source abstract was FRESH
    // (origin hash matches the old content), keep it fresh against the
    // rewritten content; if it was already stale, preserve the old
    // hash so the staleness signal survives the clone.
    let abstractOriginHash = n.abstractOriginHash;
    if (
      contentChanged &&
      abstractOriginHash !== null &&
      abstractOriginHash === computeContentHash(n.content)
    ) {
      abstractOriginHash = computeContentHash(newContent);
    }
    return {
      id: idMap.get(n.id)!,
      memoryId,
      nodeType: n.nodeType,
      objectType: n.objectType,
      name: n.name,
      alias: n.alias,
      loc: n.loc,
      isLink: n.isLink,
      description: n.description,
      abstract: newAbstract,
      content: newContent,
      // contentHash lives in the external-producer hash domain
      // (SHA256(yaml+md), set by git sync). The rewrite invalidates it
      // and the clone has no git backing — null it when content
      // changed rather than storing a hash that describes other bytes.
      contentHash: contentChanged ? null : n.contentHash,
      abstractOriginHash,
      tags: n.tags,
      properties: jsonOrDbNull(n.properties),
      data: jsonOrDbNull(n.data),
      seq: n.seq,
      ownerRepo: n.ownerRepo,
      // #1591: a placeholder's copy is a placeholder. Draft rights are per
      // node, and the copy is a new, unminted node (no mint record or
      // approval is copied), so the destination's mint refuses while it
      // remains rather than publishing a citation with no spec.
      isPlaceholder: n.isPlaceholder,
      // #1218 — clone is an OWNING OPERATION: it carries the governed
      // signals (`role`, `isRunnable`) instead of dropping them. Before
      // this, `isRunnable` was copied by hand and `role` was not, so a
      // cloned task stayed governed and a cloned review or spec silently
      // did not — from one field's absence in this list. Preserves, never
      // mints. See `governedSignals.ts` for why the set is derived from the
      // register rather than written out here.
      ...carryGovernedSignals(n),
      // #1326 — provenance describes the copied content's origin, not a
      // new execution of the authoring task by this clone operation.
      ...(newContent === n.content && newAbstract === n.abstract
        ? carryNodeAuthorship(n)
        : clearNodeAuthorship()),
      llmModel: n.llmModel,
      aiAgent: n.aiAgent,
      tokens: n.tokens,
      // Embedding markers start clean; backfill re-stamps if indexed.
      createdBy: args.actorId,
    };
  });
  if (nodeRows.length > 0) {
    // #992/#2622: the copy preserves loc + seq.
    // Unreachable by input today — a clone always lands in a NEW memory — but
    // the wrap is parity defense with every other chat-message writer: the day
    // a same-memory copy variant exists, a collision answers typed instead of
    // the raw P2002 internal error (#2622's original finding class).
    await mapChatSeqConflict(() => tx.node.createMany({ data: nodeRows }));
    await resetEmbeddingObligations(tx, nodeRows.map(row => row.id!), memoryIsVectorIndexed(source));
  }

  // #3496: operational history follows each cloned chat root, including hard-deleted high-water seqs.
  const counterRoots = await tx.chatRootCounter.findMany({where:{chatRoot:{memoryId:source.id}},select:{chatRootNodeId:true}});
  const counterIdMap = Object.fromEntries(counterRoots.filter(c=>idMap.has(c.chatRootNodeId))
    .map(c=>[c.chatRootNodeId,idMap.get(c.chatRootNodeId)!]));
  // Copy the timestamp in SQL: finite PostgreSQL years need not fit in JS Date/Prisma DateTime.
  if(counterRoots.length) await tx.$executeRaw`INSERT INTO chat_root_counters(chat_root_node_id,message_count,last_message_at,updated_at)
    SELECT mapped.value,c.message_count,c.last_message_at,CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
    FROM chat_root_counters c JOIN jsonb_each_text(${JSON.stringify(counterIdMap)}::jsonb) mapped ON mapped.key=c.chat_root_node_id`;

  // #3501: encrypted sources already refuse above. Plaintext operational state follows the cloned root id.
  const engines = await tx.chatRootEngineState.findMany({ where: { chatRoot: { memoryId: source.id } } });
  const engineCopies = engines.filter(row => idMap.has(row.chatRootNodeId)).map(row => ({ chatRootNodeId: idMap.get(row.chatRootNodeId)!, state: row.state as Prisma.InputJsonValue }));
  if (engineCopies.length) await tx.chatRootEngineState.createMany({ data: engineCopies });

  // ── MemoryConfig + NodeRoleRule (#1337) ────────────────────────────
  // The source's rulebook is part of what the clone is: copy the config and
  // each rule, with `sourceTemplateId` and `locked` intact (a locked rule
  // arrives locked; nothing here goes through updateNodeRoleRule, so the
  // caller gains no edit right over it). New rows are independent of the
  // source: fresh ids, `revision` 1, the cloning actor as creator. A source
  // with no config row (an absent row reads as the empty config) gets none.
  // References: the three node ids remap through the clone's id map; a node the
  // clone excluded (soft-deleted, a comment) becomes null, which leaves the
  // rule's `*Required` flag set and so fails closed (D-2026-09-25-E); a node in
  // ANOTHER memory is kept on a same-org clone and dropped on a cross-org one,
  // the same isolation rule as edges below (#604). No org default templates
  // apply to a clone (#1334 ruling), so nothing else writes config here.
  const sourceConfig = await tx.memoryConfig.findUnique({
    where: { memoryId: source.id },
    include: { rules: true },
  });
  if (sourceConfig) {
    const crossOrgClone = args.targetOrganizationId !== source.organizationId;
    const externalIds = new Set<string>();
    for (const r of sourceConfig.rules) {
      for (const ref of [r.authorTaskId, r.validationTaskId, r.descriptionNodeId]) {
        if (ref && !idMap.has(ref)) externalIds.add(ref);
      }
    }
    // Of the unmapped ids, only a live node of ANOTHER memory is an external
    // reference; one in the source memory was excluded from this clone. A
    // retained reference must be one the cloning actor could have SAVED into a
    // rule (the saver must read the node, resolvers.memoryConfigRefs.ts), so it
    // is kept only when its memory belongs to the clone's org and the copier may
    // read it (`null` = unrestricted). Anything else becomes null: a third org's
    // node, or one the actor cannot read, is never carried into a new rulebook.
    const foreignIds = new Set(
      externalIds.size > 0 && !crossOrgClone
        ? (
            await tx.node.findMany({
              where: {
                id: { in: [...externalIds] },
                memoryId: args.copierReadableMemoryIds === null
                  ? { not: source.id }
                  : { not: source.id, in: [...args.copierReadableMemoryIds] },
                deletedAt: null,
                memory: { organizationId: args.targetOrganizationId, deletedAt: null },
              },
              select: { id: true },
            })
          ).map((n) => n.id)
        : [],
    );
    const carryRef = (ref: string | null): string | null => {
      if (!ref) return null;
      return idMap.get(ref) ?? (foreignIds.has(ref) ? ref : null);
    };
    const newConfigId = generateId();
    await tx.memoryConfig.create({
      data: { id: newConfigId, memoryId, createdBy: args.actorId },
    });
    if (sourceConfig.rules.length > 0) {
      await tx.nodeRoleRule.createMany({
        data: sourceConfig.rules.map((r) => ({
          id: generateId(),
          configId: newConfigId,
          role: r.role,
          authorTaskId: carryRef(r.authorTaskId),
          authorTaskRequired: r.authorTaskRequired,
          validationTaskId: carryRef(r.validationTaskId),
          validationTaskRequired: r.validationTaskRequired,
          descriptionNodeId: carryRef(r.descriptionNodeId),
          strictSubRoles: r.strictSubRoles,
          writers: r.writers,
          validateBy: r.validateBy,
          enabled: r.enabled,
          sourceTemplateId: r.sourceTemplateId,
          locked: r.locked,
          revision: 1,
          createdBy: args.actorId,
        })),
      });
    }
  }

  // ── Edges ──────────────────────────────────────────────────────────
  // Clone every live edge whose SOURCE lives in this memory. Targets:
  //   - live internal node → remapped to its clone
  //   - soft-deleted internal node → edge skipped
  //   - external node (cross-memory edge) → original target kept for a
  //     SAME-org clone; DROPPED for a cross-org clone (see below)
  // Incoming edges from other memories' nodes are NOT cloned — that
  // would add outgoing edges to nodes the clone doesn't own.
  //
  // #604 cross-org leak (Codex P1): a preserved external target points at
  // a node in the SOURCE (or a third) memory, which lives in the source
  // org. On a cross-org clone the clone is readable by the TARGET org, and
  // Edge.target lazily loads the FK without re-checking the target node's
  // memory — so keeping the raw external id would let a target-org reader
  // traverse into a node they may not be allowed to read. Drop external
  // targets on cross-org clones. Same-org clones keep prior behavior (the
  // source already exposed that edge within the same org).
  const isCrossOrg = args.targetOrganizationId !== source.organizationId;
  const edges = await tx.edge.findMany({ where: copyableEdgeWhere([...idMap.keys()]) });
  // Targets not in the live-ID map are either soft-deleted internal
  // nodes (skip the edge) or external nodes (keep the original id).
  // Query only those — not every node id of the source memory — to
  // classify them (PR-265 review, Gemini).
  const unmappedTargetIds = [
    ...new Set(edges.map((e) => e.targetId).filter((id) => !idMap.has(id))),
  ];
  const deletedInternalTargetIds = new Set(
    unmappedTargetIds.length > 0
      ? (
          await tx.node.findMany({
            where: { id: { in: unmappedTargetIds }, memoryId: source.id },
            select: { id: true },
          })
        ).map((n) => n.id)
      : [],
  );
  const edgeRows: Prisma.EdgeCreateManyInput[] = [];
  for (const e of edges) {
    const newTarget = idMap.get(e.targetId);
    if (!newTarget) {
      // Target isn't a live internal node of the source: a soft-deleted
      // internal node (always skip), or an external cross-memory node —
      // which we also skip on a cross-org clone to avoid the leak above.
      if (deletedInternalTargetIds.has(e.targetId) || isCrossOrg) continue;
    }
    edgeRows.push({
      id: generateId(),
      // Spec 037: edge identity is (loc, memoryId). The clone preserves
      // node locs, so the derived edge loc stays valid + unique; just
      // copy it and retarget memoryId to the new memory.
      memoryId,
      sourceId: idMap.get(e.sourceId)!,
      targetId: newTarget ?? e.targetId,
      loc: e.loc,
      name: e.name,
      description: e.description,
      isRunnable: e.isRunnable,
      condition: jsonOrDbNull(e.condition),
      priority: e.priority,
      data: jsonOrDbNull(e.data),
      createdBy: args.actorId,
    });
  }
  if (edgeRows.length > 0) {
    await tx.edge.createMany({ data: edgeRows, skipDuplicates: true });
  }
  // #2167 — every copied tag is an added tag, checked after the URN rewrite.
  const copiedIds = nodeRows.map((r) => r.id as string);
  await assertCopiedIncludesWritable(tx, copiedIds, memoryId, args.copierReadableMemoryIds);
  // #2040 — the copies' include edges are re-derived from their content.
  await resyncDerivedIncludesForNodes(tx, copiedIds);

  // ── PendingEdges ───────────────────────────────────────────────────
  // targetId is a free-form string (not a FK). Loc/URN-keyed references
  // are rewritten like content; explicitly marked stable-id work follows
  // the same internal-remap / cross-org-drop rules as materialized Edges.
  const pendingEdges = await tx.pendingEdge.findMany({ where: copyablePendingEdgeWhere([...idMap.keys()]) });
  const unmappedStableTargetIds = [
    ...new Set(
      pendingEdges
        .map((p) => pendingEdgeStableTargetId(p.targetId))
        .filter((id): id is string => id !== null && !idMap.has(id)),
    ),
  ];
  const internalStableTargetIds = new Set(
    unmappedStableTargetIds.length > 0
      ? (
          await tx.node.findMany({
            where: { id: { in: unmappedStableTargetIds }, memoryId: source.id },
            select: { id: true },
          })
        ).map((n) => n.id)
      : [],
  );
  const pendingRows: Prisma.PendingEdgeCreateManyInput[] = [];
  for (const p of pendingEdges) {
    const stableTargetId = pendingEdgeStableTargetId(p.targetId);
    let targetId: string;
    if (stableTargetId) {
      const remappedTargetId = idMap.get(stableTargetId);
      if (!remappedTargetId) {
        // A soft-deleted internal target is absent from the clone. An
        // external target is also dropped across orgs, matching the Edge
        // isolation rule above; same-org clones may retain it.
        if (internalStableTargetIds.has(stableTargetId) || isCrossOrg) continue;
      }
      targetId = pendingEdgeStableTargetKey(remappedTargetId ?? stableTargetId);
    } else {
      targetId = rewriteMemoryUrnRefs(p.targetId, source.urn, args.newUrn)!;
    }
    pendingRows.push({
      id: generateId(),
      sourceId: idMap.get(p.sourceId)!,
      targetId,
      loc: p.loc,
      name: p.name,
      description: p.description,
      data: jsonOrDbNull(p.data),
      createdBy: args.actorId,
    });
  }
  if (pendingRows.length > 0) {
    await tx.pendingEdge.createMany({ data: pendingRows, skipDuplicates: true });
  }
  if (pendingRows.length > 0) {
    await tx.memory.update({
      where: { id: memoryId },
      data: { pendingEdgeCount: pendingRows.length },
    });
  }

  // Group-class clone: caller becomes the first owner in the SAME
  // transaction so the memory is never persisted zero-owner
  // (matches createMemory's bootstrap).
  if (source.class === 'group' && args.groupOwnerUserId) {
    await tx.memoryMember.create({
      data: {
        memoryId,
        userId: args.groupOwnerUserId,
        role: 'owner',
        createdBy: args.groupOwnerUserId,
      },
    });
  }

  // Provenance breadcrumb on the clone.
  await tx.memoryLogEntry.create({
    data: {
      id: generateId(),
      memoryId,
      level: 'INFO',
      eventType: 'OTHER',
      message: `Cloned from memory "${source.urn}"`,
      detail: { sourceMemoryId: source.id, sourceMemoryUrn: source.urn },
      createdBy: args.actorId,
    },
  });

  return {
    memoryId,
    nodeCount: nodeRows.length,
    edgeCount: edgeRows.length,
    pendingEdgeCount: pendingRows.length,
    nodeIdMap: idMap,
    skippedEdgeCount: edges.length - edgeRows.length,
    consumed: {
      nodeIds: [...idMap.keys()].sort(),
      edgeIds: edges.map((e) => e.id).sort(),
      pendingEdgeIds: pendingEdges.map((p) => p.id).sort(),
    },
  };
}
