import { resetEmbeddingObligations, stampEmbeddingObligation } from '../../services/embedding/obligation.js';
import { memoryIsVectorIndexed } from '../../lib/embedding/indexing.js';
import { COMPILED_BOOT_PROMPT_NODE_TYPE, assertNoBootPromptMergeCollisions, assertNoBootPromptRows, assertNoBootPromptRowsForWorkerSession } from '../../lib/bootPrompt.js';
import { resyncDerivedIncludesForNodes } from '../../lib/includes/writeIncludes.js';
import { assertRoleWritersForNodes, type RoleWriterPrincipal } from '../../lib/nodeRoleWriters.js';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { COMMENT_NODE_TYPE } from '../../lib/comments/index.js';
import { hardDeleteThreadsOfTargets } from '../../lib/comments/lifecycle.js';
import { carryThreadsInTx, preflightMergeComments, refuseLiveThreadsOnFold } from '../../lib/comments/merge.js';
import { assertBatchMutable, assertMemoryBulkMutable, assertNoProtectedReach } from '../../lib/bulkMutationGate.js';
import {
  assertNoMintedCorpusRemoval,
  assertNoMintedSpecRemoval,
  preflightNoMintedCorpusRemoval,
} from '../../lib/mintedSpecPermanence.js';
import { lockMemoryForChannelChange } from '../../lib/channels.js';
import { computeContentHash } from '../../lib/contentHash.js';
import { clearNodeAuthorship } from '../../lib/nodeAuthorship.js';
import {
  ensureCurrentNodeRevisionInTransaction,
  buildNodeRevisionSnapshot,
  revisionStateHashRefreshMarker,
  createNodeRevision,
  type SnapshotEditor,
} from '../../lib/nodeRevisionSnapshot.js';
import {
  mergeNodeFields,
  type NodeMergeField,
} from '../../lib/nodeMerge.js';
import { NodeAbstractTooLongError } from '../../lib/entityRef/errors.js';
import { GraphQLError } from 'graphql';
import { validateNodeAgainstSchema, NodeSchemaViolation } from '../../lib/validateNodeAgainstSchema.js';
import { normalizeObjectType } from '../../lib/enforceNodeSchema.js';
import type { MemorySchema } from '../../lib/memorySchema.js';
import { acquireLockSet } from '../../lib/nodeSubtreeLock.js';
import { recordUrnRename } from '../../lib/urnAlias.js';
import { safeNodeUrnV2 } from '../../lib/urnEmit.js';
import { placeholderFillPatch } from '../../lib/specCorpus.js';
import { isPrismaClientError, REDACTED_DB_ERROR_MESSAGE } from '../../lib/prismaErrors.js';
import { deletePendingEdgesTargetingNodes, reconcilePendingEdgeCounts } from '../../lib/pendingEdgePromotion.js';

/**
 * Batched, resumable execution of a memory→memory merge (spec cor:api:080).
 *
 * Folds a SOURCE memory's live graph into a TARGET memory: each live source
 * node is placed by `loc` — a node whose loc already exists in the target is
 * FOLDED into that counterpart (per-field strategy), the rest RELOCATE with
 * their stable id and loc preserved. Edges follow (spec cor:api:080:01).
 *
 * ## Why batched (issue #363)
 *
 * The v1 implementation (#354) ran the whole merge inside one Prisma
 * interactive transaction. That is atomic but does not scale: a source memory
 * with thousands of nodes/edges blows past the ~5s interactive-transaction
 * timeout, materializes every node/edge in memory at once, and holds row
 * locks for the merge's full duration. This version decomposes the work into
 * bounded units so each transaction stays small.
 *
 * The work splits into three phases, each safe to commit on its own:
 *
 *   1. **Classify + relocate** — keyset-page source addresses against the
 *      target by loc. Colliding nodes (the small set) are recorded for Phase 2;
 *      the rest RELOCATE in bounded transactions, snapshotting each pre-move
 *      state. Ids are preserved, so inbound edges keep resolving, and every SQL
 *      id/loc list stays bounded by the page size (no unbounded `notIn`).
 *   2. **Fold** — fold colliding nodes in batches; per node: snapshot the
 *      target counterpart (`NodeRevision`), merge the selected fields,
 *      recompute `abstractOriginHash`, repoint/transfer its incident edges
 *      onto the counterpart (when EDGES is selected), then delete the emptied
 *      source row. One transaction per batch, all reads + writes inside it.
 *   3. **Edge relocate** — drain the surviving source-memory edges (sourced
 *      from relocated nodes) into the target's loc namespace in batches,
 *      dropping any whose loc is already taken in the target.
 *
 * A final step soft-deletes the now-empty source memory when requested.
 *
 * ## Partial-progress / resume semantics
 *
 * Whole-merge atomicity is traded for bounded transactions (the spec lists
 * the batching + ordering of the underlying writes as TUNABLE — cor:api:080).
 * Each phase commits a CONSISTENT intermediate state — no orphaned edges, no
 * partially-folded node (each fold+delete is one transaction), and the
 * counterpart a colliding node folds into is a target row that exists
 * throughout. If the process dies mid-merge, simply **re-running
 * mergeMemories on the same pair completes it**: classification rederives the
 * surviving colliding set from live rows, the relocate `updateMany` only
 * touches nodes still in the source, and a folded node is GONE (deleted with
 * its fold), so its text is never concatenated twice. The merge is therefore
 * idempotent under retry.
 *
 * Caller (the `mergeMemories` resolver) owns: ref resolution, class/encryption
 * preflight gating, per-memory write authorization (including third memories whose
 * edges re-point), and the post-merge embedding backfill. Encrypted memories
 * are rejected upstream and rechecked under row locks in every writing batch.
 */

/** Nodes folded / edges drained per inner transaction. Bounds tx size + lock duration. */
export const MERGE_BATCH_SIZE = 250;

/** Source nodes scanned per classification page (lightweight id+loc projection). */
const CLASSIFY_PAGE = 1000;

/**
 * Per-batch interactive-transaction timeout. A batch is at most
 * MERGE_BATCH_SIZE folds (each a version-create + an update) plus its incident
 * edges — comfortably bounded, but the default 5s is too tight under a slow
 * link, so we give generous headroom while keeping each tx finite.
 */
const BATCH_TX_OPTS = { timeout: 60_000, maxWait: 15_000 } as const;

export interface MergeMemoryArgs {
  sourceMemoryId: string;
  targetMemoryId: string;
  /** Field strategy for colliding nodes (CONTENT/ABSTRACT/.../EDGES). */
  fields: Set<NodeMergeField>;
  /** Soft-delete the (now-empty) source memory when true. */
  deleteSourceMem: boolean;
  /** Audit attribution for version/edit/update columns (#620: user PK vs
   *  fallback principal info are captured separately). */
  editor: SnapshotEditor;
  /**
   * #1331 — the caller, for the role writer level of every node the merge writes,
   * relocates or removes (judged in the memory it leaves and the one it enters).
   * Omitted only by server-authored callers.
   */
  principal?: RoleWriterPrincipal;
  /** Nodes folded / edges drained per inner transaction. Test seam; defaults to MERGE_BATCH_SIZE. */
  batchSize?: number;
  /** Source nodes scanned per classify+relocate page. Test seam; defaults to CLASSIFY_PAGE. */
  classifyPageSize?: number;
}

export interface MergeMemoryResult {
  relocatedCount: number;
  foldedCount: number;
  edgesMovedCount: number;
  edgesDroppedCount: number;
}

/** NodeAbstractTooLongError carrying the offending loc (for the GraphQL extension). */
type AbstractTooLongAtLoc = NodeAbstractTooLongError & { loc?: string };

/** Tombstoned locs named in a {@link mergeTargetLocTombstonedError}; the full count rides alongside. */
const TOMBSTONED_LOCS_REPORTED = 25;

/**
 * #1684 — the typed refusal for a source node whose loc the TARGET holds with a
 * soft-deleted node. The `(loc, memory_id)` unique index is total, so the
 * tombstone still owns the address: a relocate would fail with a raw P2002, and
 * folding into a deleted node would silently resurrect it. Neither is the
 * merge's call to make, so it refuses and names the locs; hard-deleting the
 * tombstone frees the address, and resurrecting it (a create at that loc)
 * turns the address into an ordinary fold. Matches `moveNodeSubtree`, which
 * already counts a tombstone as an occupant.
 */
export function mergeTargetLocTombstonedError(targetMemoryId: string, locs: string[], count = locs.length): GraphQLError {
  const named = [...locs].sort().slice(0, TOMBSTONED_LOCS_REPORTED);
  return new GraphQLError(
    `mergeMemories cannot place ${count === 1 ? `loc "${named[0]}"` : `${count} locs (${named.map((l) => `"${l}"`).join(', ')}${count > named.length ? ', …' : ''})`} in the target memory: ` +
      `a soft-deleted node still holds ${count === 1 ? 'that address' : 'those addresses'}. ` +
      'Hard-delete the tombstone, or recreate a node at that loc so it folds, then re-run the merge.',
    {
      extensions: { code: 'MERGE_TARGET_LOC_TOMBSTONED', memoryId: targetMemoryId, loc: named[0], locs: named, count },
    },
  );
}

/**
 * #1686 — what a refused merge had ALREADY applied. The merge commits in
 * batches by design (each batch a consistent prefix, the whole resumable), so
 * a refusal raised by a later batch under its locks — a thread posted on a
 * folding node (#1682), a governed kind or a Channel appearing in reach, a
 * tombstone or a live row appearing at a target loc (#1684) — lands after
 * earlier batches committed.
 * The caller is told so, with counts, rather than left to discover a silent
 * half-move. Absent when the refusal came before any batch committed.
 */
export interface PartialMergeReport {
  applied: true;
  relocated: number;
  folded: number;
  edgesMoved: number;
  edgesDropped: number;
  /** Live source nodes still to merge; null when the recount itself failed. */
  remainingSourceNodes: number | null;
  /**
   * Whether the source memory still exists. A refused merge never deletes it;
   * only a failure AFTER a completed merge (the resolver's post-commit steps)
   * can report false, when `deleteSourceMem` had already removed it.
   */
  sourceIntact: boolean;
  remedy: string;
}

/**
 * #1691 — the remedy when the merge itself completed and a step after it (the
 * resolver re-indexing the target, or reading it back) failed. Re-running the
 * merge is not the answer once the source was deleted.
 */
export const MERGE_POST_COMMIT_REMEDY =
  'The merge itself completed. Re-read the target memory; if it indexes vectors, re-index it, since its merged nodes may not have been queued for embedding.';

const PARTIAL_MERGE_REMEDY =
  'Part of the merge was already applied. Resolve the blocker and re-run the same merge: it resumes from what remains.';

function partialSentence(report: PartialMergeReport): string {
  return ` The merge was partially applied (${report.relocated} relocated, ${report.folded} folded${report.remainingSourceNodes != null ? `, ${report.remainingSourceNodes} source node(s) remaining` : ''}); the source memory is intact. Resolve the blocker and re-run the same merge to finish it.`;
}

/**
 * Attach the partial-state report to a merge failure. A typed refusal keeps
 * its code and gains `extensions.partialMerge`; an untyped error (no code a
 * client can branch on) becomes `MERGE_PARTIALLY_APPLIED`, carrying the
 * original's Prisma code when it has one. A NodeAbstractTooLongError keeps
 * its class (the resolver types it) and carries the report on the instance.
 */
export function withPartialMerge(error: unknown, report: PartialMergeReport, sentence = partialSentence(report)): unknown {
  if (error instanceof GraphQLError) {
    return new GraphQLError(error.message + sentence, {
      extensions: { ...error.extensions, partialMerge: report },
      originalError: error.originalError ?? error,
    });
  }
  if (error instanceof NodeAbstractTooLongError) {
    (error as NodeAbstractTooLongError & { partialMerge?: PartialMergeReport }).partialMerge = report;
    return error;
  }
  const prismaCode = (error as { code?: unknown })?.code;
  // #1691: a Prisma message carries query arguments and schema internals. The
  // formatter redacts a Prisma error only one wrapper deep, and this wrapper
  // puts the message in an error of its own, so redact it here; the original
  // stays on `originalError` for server reporting.
  const cause = isPrismaClientError(error) ? REDACTED_DB_ERROR_MESSAGE : `${(error as Error)?.message ?? String(error)}.`;
  return new GraphQLError(`mergeMemories stopped part-way: ${cause}` + sentence, {
    extensions: {
      code: 'MERGE_PARTIALLY_APPLIED',
      ...(typeof prismaCode === 'string' ? { causeCode: prismaCode } : {}),
      partialMerge: report,
    },
    originalError: error instanceof Error ? error : undefined,
  });
}

export async function mergeMemoryGraph(
  db: PrismaClient,
  args: MergeMemoryArgs,
): Promise<MergeMemoryResult> {
  const progress: MergeMemoryResult = { relocatedCount: 0, foldedCount: 0, edgesMovedCount: 0, edgesDroppedCount: 0 };
  try {
    return await runMerge(db, args, progress);
  } catch (error) {
    const committed = progress.relocatedCount + progress.foldedCount + progress.edgesMovedCount + progress.edgesDroppedCount;
    if (committed === 0) throw error;
    const remainingSourceNodes = await db.node
      .count({ where: { memoryId: args.sourceMemoryId, deletedAt: null, nodeType: { notIn: [COMMENT_NODE_TYPE, COMPILED_BOOT_PROMPT_NODE_TYPE] } } })
      .catch(() => null);
    throw withPartialMerge(error, {
      applied: true,
      relocated: progress.relocatedCount,
      folded: progress.foldedCount,
      edgesMoved: progress.edgesMovedCount,
      edgesDropped: progress.edgesDroppedCount,
      remainingSourceNodes,
      sourceIntact: true,
      remedy: PARTIAL_MERGE_REMEDY,
    });
  }
}

async function runMerge(
  db: PrismaClient,
  args: MergeMemoryArgs,
  progress: MergeMemoryResult,
): Promise<MergeMemoryResult> {
  const { sourceMemoryId, targetMemoryId, fields, deleteSourceMem, editor } = args;
  const actorId = editor.userId ?? editor.info ?? null;
  // Clamp to >= 1: a zero/negative batchSize (the test seam is public) would
  // never advance the fold loop and spin forever.
  const batchSize = Math.max(1, Math.floor(args.batchSize ?? MERGE_BATCH_SIZE));
  const classifyPage = Math.max(1, Math.floor(args.classifyPageSize ?? CLASSIFY_PAGE));
  const withEdges = fields.has('EDGES');

  /** #409 / cor:api:190:02: rebuild moved vectors under the destination policy.
   * Runs with the moved Node and Memory locks held, before relocation commits;
   * the fresh marker also fences an old source worker, even in the same ms.
   */
  const resetRelocatedVectors = async (tx: Prisma.TransactionClient, ids: string[]) => {
    if (ids.length === 0) return;
    const destination = await tx.memory.findUniqueOrThrow({
      where: { id: targetMemoryId }, select: { vectorIndexEnabled: true, class: true },
    });
    await tx.nodeEmbedding.deleteMany({ where: { nodeId: { in: ids } } });
    await resetEmbeddingObligations(tx, ids, memoryIsVectorIndexed(destination));
  };

  /** Hold both flags through a batch so encryptMemory cannot flip mid-write. */
  const lockMergeMemoryRows = async (
    tx: Prisma.TransactionClient,
    lockMode: 'share' | 'update' | 'delete-source' = 'share',
    requirePlaintext = true,
  ): Promise<Map<string, string>> => {
    const urns = new Map<string, string>();
    for (const id of [sourceMemoryId, targetMemoryId].sort()) {
      // 'delete-source' (#1468): the disposition deletes the source, so it
      // takes that row FOR UPDATE — the lock that excludes a concurrent node
      // insert (FK KEY SHARE) or first-spec mark (FOR SHARE) between the
      // minted-corpus scan and the tombstone. First lock on the row in its
      // transaction, so nothing is upgraded.
      const [memory] = lockMode === 'delete-source' && id === sourceMemoryId
        ? await tx.$queryRaw<Array<{ urn: string; is_encrypted: boolean }>>`
            SELECT urn, is_encrypted FROM memories WHERE id = ${id} FOR UPDATE
          `
        : lockMode !== 'share'
        ? await tx.$queryRaw<Array<{ urn: string; is_encrypted: boolean }>>`
            SELECT urn, is_encrypted FROM memories WHERE id = ${id} FOR NO KEY UPDATE
          `
        : await tx.$queryRaw<Array<{ urn: string; is_encrypted: boolean }>>`
            SELECT urn, is_encrypted FROM memories WHERE id = ${id} FOR SHARE
          `;
      if (!memory) throw new Error(`merge memory ${id} disappeared while locking; retry the merge`);
      if (requirePlaintext && memory.is_encrypted) {
        throw new GraphQLError('mergeMemories does not support encrypted memories yet.', {
          extensions: { code: 'ENCRYPTED_MEMORY_MERGE_UNSUPPORTED', memoryId: id },
        });
      }
      urns.set(id, memory.urn);
    }
    return urns;
  };

  // #725/#737 — nodes landing in a schema-governed target (relocated OR folded)
  // must satisfy the target schema. A merge is a LONG batched op; the target's
  // schema can be tightened concurrently (an admin hardening the memory), so a
  // single snapshot taken at the top goes stale for later batches and would let
  // a non-conforming node fold in. Re-read the schema per relocate-page (Phase 1)
  // and per fold-batch INSIDE its transaction (Phase 2), so enforcement always
  // sees the schema current at write time. assertConformsAgainst no-ops for an
  // unschema'd target or a non-collection node.
  const fetchTargetSchema = async (client: Pick<typeof db, 'memory'>): Promise<MemorySchema | null> =>
    ((await client.memory.findUnique({ where: { id: targetMemoryId }, select: { schema: true } }))
      ?.schema as unknown as MemorySchema | null);
  const assertConformsAgainst = (
    schema: MemorySchema | null,
    objectType: string | null,
    properties: unknown,
  ): void => {
    const norm = normalizeObjectType(objectType);
    if (norm == null) return;
    try {
      validateNodeAgainstSchema(schema, norm, (properties ?? null) as Record<string, unknown> | null);
    } catch (e) {
      if (e instanceof NodeSchemaViolation) {
        throw new GraphQLError(e.message, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      throw e;
    }
  };

  // === Preflight: the two gates every per-node writer consults (#1191). ===
  // Counted on `main` before this: ZERO gate calls in this whole operation, so
  // an authorized merge could relocate, rewrite or delete the nodes under a
  // Channel's address, or move a review node out from under the review door.
  //
  // BOTH endpoints, because a merge touches both: every source node relocates
  // or folds, and a fold OVERWRITES its target counterpart. Whole-memory
  // (`'all'`) rather than a loc set, because there is no partial merge — a
  // Channel left behind in the source would keep `Channel.memoryId`/`loc`
  // reserving an address its root no longer occupies, which is why
  // `nodeSubtreeMove` refuses a cross-memory move of a chat root for the same
  // reason.
  //
  // This preflight is FAIL-FAST ONLY and is not the authoritative check
  // (@codex + @copilot, both P1). A merge is paged across SEPARATE
  // transactions, so a Channel created — or a node promoted to a governed kind
  // — after this read and before a later page is invisible to it: "a check
  // before the lock was a TOCTOU window the size of the wait" (PR #1165), and
  // here the window was the whole merge. `assertBatchMutable` runs inside each
  // writing transaction and is what actually holds.
  //
  // It stays because refusing a doomed merge before it relocates anything is
  // worth one query per endpoint, and because the refusal is far more useful
  // up front than eight pages in.
  // #1664 (cor:dmo:110:02) — threads are CARRIED with their targets (below),
  // so live comments no longer refuse; what can't be carried refuses here,
  // before the first batch commits.
  await assertMemoryBulkMutable(db, sourceMemoryId, 'merge', { comments: 'carry' });
  await assertMemoryBulkMutable(db, targetMemoryId, 'merge into', { comments: 'carry' });
  // #2043 (cor:agt:040:11) — a worker session's merge that would write ANY
  // boot-prompt node (source or compiled) is refused whole, before any batch
  // commits. For any other caller compiled nodes are excluded below, like
  // comments: a merge is not a compile and the target recompiles.
  await assertNoBootPromptRowsForWorkerSession(db, sourceMemoryId, 'merge');
  // Destination writes too (Ruth P2): a source node folding onto a compiled target, or onto a
  // boot-prompt target under a worker session, is refused before any batch commits.
  await assertNoBootPromptMergeCollisions(db, sourceMemoryId, targetMemoryId);
  await preflightMergeComments(db, sourceMemoryId, targetMemoryId);
  // #1468 — every source node leaves the source memory (relocated, or folded
  // and deleted) and the source memory is then deleted: a mint-stamped source
  // corpus holding a spec cannot be merged away. Fail fast here; each batch
  // and the final disposition re-check under their own locks.
  await preflightNoMintedCorpusRemoval(db, sourceMemoryId, 'merge out of its corpus', { includeTombstones: false });

  // #1684 — a target TOMBSTONE at an address this merge would move into.
  // Classification below matches live rows only (a tombstone is no fold
  // counterpart), but the unique index is total, so a node at such a loc can
  // neither fold nor relocate. Refuse before the first batch commits, naming
  // the locs (the first TOMBSTONED_LOCS_REPORTED of them, with the full count).
  //
  // The candidates are exactly what Phase 1 MOVES, read in its own page shape:
  // a live non-comment node with no live target counterpart, plus EVERY thread
  // (live or deleted) anchored to one, since carryThreadsInTx carries deleted
  // comments too, locs unchanged (#1710 review, Diego P2). Not every source
  // tombstone: an ordinary deleted node never moves, and the deleted threads
  // of a FOLDING node are destroyed with it rather than carried.
  //
  // Fail-fast only, like the preflights above. Under each relocate batch's
  // locks, the batch rechecks its own rows and its carried threads; a
  // tombstone that appears after this scan refuses there, but batches that
  // committed before it stay committed (the merge is resumable, not atomic).
  {
    const tombstoned: string[] = [];
    let count = 0;
    for (let cursor: string | undefined; ; ) {
      const page = await db.node.findMany({
        where: { memoryId: sourceMemoryId, deletedAt: null, nodeType: { notIn: [COMMENT_NODE_TYPE, COMPILED_BOOT_PROMPT_NODE_TYPE] }, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, loc: true },
        orderBy: { id: 'asc' },
        take: classifyPage,
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1].id;
      const folds = new Set(
        (await db.node.findMany({
          where: { memoryId: targetMemoryId, deletedAt: null, loc: { in: page.map((n) => n.loc) } },
          select: { loc: true },
        })).map((t) => t.loc),
      );
      const moving = page.filter((n) => !folds.has(n.loc));
      const carried = moving.length
        ? await db.node.findMany({
            where: { commentMeta: { targetNodeId: { in: moving.map((n) => n.id) } } },
            select: { loc: true },
          })
        : [];
      const candidates = [...moving.map((n) => n.loc), ...carried.map((c) => c.loc)];
      const held = candidates.length
        ? await db.node.findMany({
            where: { memoryId: targetMemoryId, deletedAt: { not: null }, loc: { in: candidates } },
            select: { loc: true },
          })
        : [];
      count += held.length;
      for (const { loc } of held) if (tombstoned.length < TOMBSTONED_LOCS_REPORTED) tombstoned.push(loc);
      if (page.length < classifyPage) break;
    }
    if (count > 0) throw mergeTargetLocTombstonedError(targetMemoryId, tombstoned, count);
  }

  // === Phase 1: classify + relocate, in one keyset-paged scan. ===
  // Page the live source node addresses by id and match each page against the
  // target by loc. A source node whose
  // loc already exists in the target FOLDS into that counterpart (Phase 2 below);
  // the rest RELOCATE here in revisioned batches. Folding and
  // relocating in the same scan means the colliding set is the ONLY id list
  // we hold in memory, and every SQL `IN (...)`/`updateMany` list is bounded
  // by the page size — a giant source memory never builds an unbounded
  // `notIn` (which would blow the DB bind-parameter limit). Keyset (`id >
  // cursor`) is required: relocated movers leave the `memoryId = source` set,
  // but the colliding rows we leave behind would otherwise be re-read forever
  // by an offset/`take`-only loop.
  const survivor = new Map<string, string>(); // colliding src id → target counterpart id
  const collidingSrcIds: string[] = [];
  for (let cursor: string | undefined; ; ) {
    const page = await db.node.findMany({
      // #1664 — comments never relocate on their own: each moves in its
      // target's transaction (carryThreadsInTx).
      where: { memoryId: sourceMemoryId, deletedAt: null, nodeType: { notIn: [COMMENT_NODE_TYPE, COMPILED_BOOT_PROMPT_NODE_TYPE] }, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: { id: true, loc: true },
      orderBy: { id: 'asc' },
      take: classifyPage,
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;
    const matches = await db.node.findMany({
      where: { memoryId: targetMemoryId, deletedAt: null, loc: { in: page.map((n) => n.loc) } },
      select: { id: true, loc: true },
    });
    const tgtByLoc = new Map(matches.map((t) => [t.loc, t.id]));
    const relocateIds: string[] = [];
    for (const s of page) {
      const tgtId = tgtByLoc.get(s.loc);
      if (tgtId) {
        survivor.set(s.id, tgtId);
        collidingSrcIds.push(s.id);
      } else {
        relocateIds.push(s.id);
      }
    }
    if (relocateIds.length > 0) {
      const relocateIdSet = new Set(relocateIds);
      const classifiedLocById = new Map(
        page.filter((row) => relocateIdSet.has(row.id)).map((row) => [row.id, row.loc]),
      );
      // Enforce the target schema on the collection members relocating in (only
      // when the target IS schema'd — page rows are id/loc-only, so fetch the
      // typed subset's discriminator/properties for validation). Re-read the
      // schema here so a mid-merge tightening is honored (not the top-of-fn one).
      const relocateSchema = await fetchTargetSchema(db);
      if (relocateSchema != null) {
        const typed = await db.node.findMany({
          where: { id: { in: relocateIds }, objectType: { not: null } },
          select: { objectType: true, properties: true },
        });
        for (const t of typed) assertConformsAgainst(relocateSchema, t.objectType, t.properties);
      }
      // The relocate moves into its own transaction so the AUTHORITATIVE gate
      // can hold the Channel-memory locks across the check and the write. It
      // was a bare `updateMany` before, which left nothing for the gate to be
      // authoritative inside.
      for (let i = 0; i < relocateIds.length; i += batchSize) {
        const ids = relocateIds.slice(i, i + batchSize);
        const moved = await db.$transaction(async (tx) => {
          let rows = await tx.node.findMany({
            where: { id: { in: ids }, memoryId: sourceMemoryId, deletedAt: null },
          });
          // Memory-scope locks precede every loc-scope lock in the global
          // protocol. This first gate acquires them and gives a fast refusal;
          // the second gate below rechecks the authoritative post-loc-lock rows.
          await assertBatchMutable(tx, [sourceMemoryId, targetMemoryId], rows, 'merge');
          if (args.principal) {
            await assertRoleWritersForNodes(tx, args.principal, rows, { from: sourceMemoryId, to: targetMemoryId });
          }
          await acquireLockSet(
            tx,
            ids.flatMap((id) => {
              const loc = classifiedLocById.get(id)!;
              return [
                { memoryId: sourceMemoryId, loc },
                { memoryId: targetMemoryId, loc },
              ];
            }),
          );
          // Lock node rows before Memory rows, matching moveNodeSubtree's
          // order. The resolver's one-time flag check can go stale between
          // batches, so pin both flags before reconciliation mints history.
          for (const id of [...ids].sort()) {
            await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
          }
          const memoryUrns = await lockMergeMemoryRows(tx);
          rows = await tx.node.findMany({
            where: { id: { in: ids }, memoryId: sourceMemoryId, deletedAt: null },
          });
          // #1468 — authoritative for this batch, under its node + memory locks.
          await assertNoMintedSpecRemoval(tx, sourceMemoryId, rows.map((r) => r.id), 'merge out of its corpus');
          for (const row of rows) {
            if (row.loc !== classifiedLocById.get(row.id)) {
              throw new Error(`merge source node ${row.id} moved during classification; retry the merge`);
            }
          }
          // Total occupancy, like the unique index (#1684): a live row that
          // appeared is a retryable race; a tombstone is the typed refusal (a
          // live target soft-deleted after the preflight lands here).
          const lateCollisions = await tx.node.findMany({
            where: { memoryId: targetMemoryId, loc: { in: rows.map((row) => row.loc) } },
            select: { loc: true, deletedAt: true },
          });
          const lateTombstones = lateCollisions.filter((row) => row.deletedAt != null).map((row) => row.loc);
          if (lateTombstones.length > 0) throw mergeTargetLocTombstonedError(targetMemoryId, lateTombstones);
          if (lateCollisions.length > 0) {
            throw new Error(`merge target loc ${lateCollisions[0].loc} appeared during classification; retry the merge`);
          }
          // Reentrant memory locks; fresh governed/protected facts for the rows
          // now serialized by their source + destination address locks.
          await assertBatchMutable(tx, [sourceMemoryId, targetMemoryId], rows, 'merge');
          // #2043 — the preflight boot-prompt scan is fail-fast only: a role set or a
          // compiled node created after it is caught here, on the locked rows.
          await assertNoBootPromptRows(tx, rows.map((r) => r.id), 'merge');
          if (args.principal) {
            await assertRoleWritersForNodes(tx, args.principal, rows, { from: sourceMemoryId, to: targetMemoryId });
          }
          // #1323 (@codex P1, PR #1339): reconcile unrevisioned drift as each
          // row's OWN revision before its relocation snapshot, under the row
          // lock, in id order (one global order, so two multi-row operations
          // cannot lock-invert). Then re-read and re-validate: the snapshot
          // must describe the row as it is now, not as classified.
          const relocationIds = rows.map((row) => row.id).sort();
          for (const id of relocationIds) {
            await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: sourceMemoryId });
          }
          rows = await tx.node.findMany({ where: { id: { in: relocationIds } }, orderBy: { id: 'asc' } });
          for (const row of rows) {
            if (row.memoryId !== sourceMemoryId || row.deletedAt || row.loc !== classifiedLocById.get(row.id)) {
              throw new Error(`merge source node ${row.id} changed during the merge; retry the merge`);
            }
          }
          if (rows.length !== relocationIds.length) {
            throw new Error('a merge source node was deleted during the merge; retry the merge');
          }
          // The held Memory rows also pin both URNs against a concurrent rename.
          const sourceUrn = memoryUrns.get(sourceMemoryId)!;
          const targetUrn = memoryUrns.get(targetMemoryId)!;
          // #1448, per node since #1591: relocating an UNMINTED node leaves no
          // alias, exactly like a move — its number was never published. The
          // rows were read under their locks above, and a concurrent mint
          // fences the memory row held here, so the answer cannot change
          // mid-batch. A placeholder may relocate anywhere: it stays unminted,
          // and the target's mint refuses while it remains.
          for (const row of rows) {
            await createNodeRevision(
              tx,
              buildNodeRevisionSnapshot(row, editor, { changes: ['memoryId'] }),
            );
            // cor:urn:030:01 — this stable node ID changes its composed URN.
            // Record the old address beside the write in this bounded tx;
            // folded/deleted identities never reach this relocation loop.
            // The mirror root has loc='' and no round-trippable v2 node URN.
            if (row.loc && row.mintedAt !== null) {
              await recordUrnRename(tx, {
                entityType: 'NODE',
                entityId: row.id,
                oldUrn: safeNodeUrnV2(sourceUrn, row.loc).slice('hrn:node:'.length),
                newUrn: safeNodeUrnV2(targetUrn, row.loc).slice('hrn:node:'.length),
                createdBy: actorId,
              });
            }
            await tx.node.update({
              where: { id: row.id },
              data: {
                memoryId: targetMemoryId,
                updatedBy: actorId,
                revisionContentHash: revisionStateHashRefreshMarker(),
              },
            });
          }
          await resetRelocatedVectors(tx, relocationIds);
          // #1664 — the batch's threads move in the same transaction as their targets.
          // #1684 — its final member set, read under the carry's locks, is
          // rechecked against the target's TOTAL occupancy before it moves.
          await carryThreadsInTx(tx, relocationIds, targetMemoryId, async (threadIds) => {
            const threadLocs = (await tx.node.findMany({ where: { id: { in: threadIds } }, select: { loc: true } }))
              .map((c) => c.loc);
            const occupied = await tx.node.findMany({
              where: { memoryId: targetMemoryId, loc: { in: threadLocs } },
              select: { loc: true, deletedAt: true },
            });
            const tombstones = occupied.filter((row) => row.deletedAt != null).map((row) => row.loc);
            if (tombstones.length > 0) throw mergeTargetLocTombstonedError(targetMemoryId, tombstones);
            if (occupied.length > 0) {
              throw new Error(`merge target loc ${occupied[0].loc} is occupied by a node; a comment cannot move there; retry the merge`);
            }
            await resetRelocatedVectors(tx, threadIds);
          });
          return rows.length;
        }, BATCH_TX_OPTS);
        progress.relocatedCount += moved;
      }
    }
    if (page.length < classifyPage) break;
  }

  // === Phase 2: fold the colliding nodes, in batches. ===
  // Each batch is its own transaction (bounded size + lock duration). Per
  // node: snapshot the target counterpart, merge fields, recompute the
  // abstract hash, repoint its incident edges (when EDGES is selected), then
  // delete the emptied source row. Repointing happens BEFORE the delete so an
  // edge transferred onto the counterpart doesn't cascade away with the row.

  for (let i = 0; i < collidingSrcIds.length; i += batchSize) {
    const batchIds = collidingSrcIds.slice(i, i + batchSize);

    const batch = await db.$transaction(async (tx) => {
      let moved = 0;
      let dropped = 0;

      // The authoritative gate below reacquires these keys after refreshing
      // the fold rows. Take the complete Channel-memory set first: holding the
      // Node/Memory rows while waiting for a Channel key would invert against
      // final source disposition, which takes that key before its Memory rows.
      for (const id of [...new Set([sourceMemoryId, targetMemoryId])].sort()) {
        await lockMemoryForChannelChange(tx, id);
      }

      // Read the target schema INSIDE the tx so the fold validates against the
      // schema current at fold time (a tightening committed between batches is
      // honored), consistent with this batch's other reads/writes.
      const batchSchema = await fetchTargetSchema(tx);

      // Read the batch's rows INSIDE the transaction, constrained to their
      // expected memory + live state. Reading here (rather than before the tx)
      // closes a race: a concurrent relocate/delete between classification and
      // this fold can no longer cause a lost update or a stray cross-memory
      // write — the rows are read and mutated under the same tx. Only source
      // rows whose target counterpart is still live get folded; a vanished
      // counterpart leaves its source row untouched for a later pass (the
      // merge is resumable), never silently deleted.
      let srcRows = await tx.node.findMany({
        where: { id: { in: batchIds }, memoryId: sourceMemoryId, deletedAt: null },
      });
      let tgtRows = await tx.node.findMany({
        where: {
          id: { in: srcRows.map((s) => survivor.get(s.id)!) },
          memoryId: targetMemoryId,
          deletedAt: null,
        },
      });
      // #1323 (@codex P1, PR #1339): every row this fold reads or snapshots is
      // row-locked and reconciled (drift as its OWN revision) in id order
      // before anything is computed from it, then re-read — so the fold works
      // from the rows as they are under the lock, not as first fetched.
      // The loc pair each fold was CLASSIFIED on; a row that moved before its
      // lock no longer forms that collision (@copilot, PR #1339).
      const classifiedLoc = new Map([...srcRows, ...tgtRows].map((row) => [row.id, row.loc]));
      const foldIds = [...new Set([...srcRows, ...tgtRows].map((row) => row.id))].sort();
      // Each row only within the memory it was classified in (@copilot, PR
      // #1339): a row that moved out is neither reconciled nor silently
      // dropped — the transaction refuses, so nothing commits in its new memory.
      const foldMemory = new Map<string, string>([
        ...srcRows.map((row) => [row.id, sourceMemoryId] as const),
        ...tgtRows.map((row) => [row.id, targetMemoryId] as const),
      ]);
      // Lock all node rows first, as on other move paths; then recheck both
      // flags before the first drift reconciliation snapshot.
      for (const id of foldIds) {
        await tx.$queryRaw`SELECT id FROM nodes WHERE id = ${id} FOR UPDATE`;
      }
      await lockMergeMemoryRows(tx);
      // #1468 — the folded source rows are deleted below: authoritative here.
      await assertNoMintedSpecRemoval(tx, sourceMemoryId, srcRows.map((r) => r.id), 'merge out of its corpus');
      // #2043 — boot-prompt guard on the node-locked source+target rows BEFORE reconciliation
      // mints any revision; the post-read check below covers rows re-read after it.
      await assertNoBootPromptRows(tx, foldIds, 'merge');
      for (const id of foldIds) {
        const reconciled = await ensureCurrentNodeRevisionInTransaction(tx, id, { expectedMemoryId: foldMemory.get(id)! });
        if (reconciled == null) throw new Error(`merge node ${id} moved or vanished during the fold; retry the merge`);
      }
      srcRows = await tx.node.findMany({
        where: { id: { in: srcRows.map((row) => row.id) }, memoryId: sourceMemoryId, deletedAt: null },
      });
      tgtRows = await tx.node.findMany({
        where: {
          id: { in: srcRows.map((s) => survivor.get(s.id)!) },
          memoryId: targetMemoryId,
          deletedAt: null,
        },
      });
      for (const row of [...srcRows, ...tgtRows]) {
        if (row.loc !== classifiedLoc.get(row.id)) {
          throw new Error(`merge node ${row.id} moved during the fold; retry the merge`);
        }
      }
      const tgtById = new Map(tgtRows.map((t) => [t.id, t]));
      // The AUTHORITATIVE gate for this batch — both endpoints' rows, read
      // inside this transaction, under the Channel-memory locks. The Phase-1
      // preflight cannot cover a fold that runs transactions later.
      await assertBatchMutable(tx, [sourceMemoryId, targetMemoryId], [...srcRows, ...tgtRows], 'merge');
      // #2043 — authoritative boot-prompt recheck on the locked source AND target rows
      // (the preflight collision scan cannot see a role or compiled node added since).
      await assertNoBootPromptRows(tx, [...srcRows, ...tgtRows].map((r) => r.id), 'merge');
      if (args.principal) {
        await assertRoleWritersForNodes(tx, args.principal, srcRows, { from: sourceMemoryId, to: targetMemoryId });
        await assertRoleWritersForNodes(tx, args.principal, tgtRows, { from: targetMemoryId });
      }
      const foldedIds: string[] = []; // source rows actually folded → safe to delete

      // -- Fold fields (per colliding node). --
      for (const src of srcRows) {
        const tgt = tgtById.get(survivor.get(src.id)!);
        if (!tgt) continue; // counterpart vanished (concurrent delete) — skip
        let merged;
        try {
          merged = mergeNodeFields(
            { content: src.content, abstract: src.abstract, description: src.description, tags: src.tags, data: src.data, properties: src.properties },
            { content: tgt.content, abstract: tgt.abstract, description: tgt.description, tags: tgt.tags, data: tgt.data, properties: tgt.properties },
            fields,
          );
        } catch (e) {
          // Tag the offending loc so the resolver can surface it (tx rolls back).
          if (e instanceof NodeAbstractTooLongError) (e as AbstractTooLongAtLoc).loc = tgt.loc;
          throw e;
        }
        await createNodeRevision(
          tx,
          buildNodeRevisionSnapshot(tgt, editor, {
            changes: Object.keys(merged.changed),
          }),
        );
        const fill = fields.has('CONTENT')
          ? placeholderFillPatch(tgt, 'content' in merged.changed ? merged.changed.content : tgt.content)
          : {};
        if (Object.keys(merged.changed).length > 0 || Object.keys(fill).length > 0) {
          // #725/#737 — the folded target must still satisfy its collection.
          assertConformsAgainst(batchSchema, tgt.objectType, 'properties' in merged.changed ? merged.changed.properties : tgt.properties);
          // A collision fold authors a new target content state. Keep the
          // target's old stamp in its pre-fold NodeRevision above; the live
          // combination has no single verified author. Unchanged folds never
          // enter this branch, and relocations preserve their source stamp.
          const writeData: Record<string, unknown> = {
            ...merged.changed,
            ...fill,
            ...clearNodeAuthorship(),
            updatedBy: actorId,
          };
          if (merged.abstractChanged) {
            writeData.abstractOriginHash = computeContentHash(
              merged.contentChanged ? (merged.changed.content as string | null) : tgt.content,
            );
          }
          writeData.revisionContentHash = revisionStateHashRefreshMarker();
          await tx.node.update({ where: { id: tgt.id }, data: writeData });
          await stampEmbeddingObligation(tx, tgt.id, targetMemoryId);
        }
        foldedIds.push(src.id);
      }

      // -- Re-point the folded nodes' incident edges onto the survivors. --
      // An edge touching a colliding node transfers only when EDGES is
      // selected; otherwise it is left to cascade with the deleted row.
      // Self-loops (both endpoints fold to the same survivor) and
      // (loc, memory) collisions in the target drop. Keyed off the nodes we
      // actually folded (not the raw batch) so a skipped node's edges are left
      // intact for its later pass.
      if (withEdges && foldedIds.length > 0) {
        const incident = await tx.edge.findMany({
          // #1664 — a comment's governed edge never re-homes: it goes with its
          // (deleted) thread when the folded node is removed below.
          where: { OR: [{ sourceId: { in: foldedIds } }, { targetId: { in: foldedIds } }], governedKind: null },
        });
        const incidentIds = new Set(incident.map((e) => e.id));

        // The denormalized memory of an edge follows its SOURCE endpoint. A
        // re-pointed source endpoint that is a colliding node lands on its
        // counterpart (a target row → target memory). For an endpoint we
        // leave unchanged we read its CURRENT memory (a relocated node now
        // sits in the target; a foreign node keeps its own memory).
        const unknownSrc = new Set<string>();
        for (const e of incident) {
          if (!survivor.has(e.sourceId)) unknownSrc.add(e.sourceId);
        }
        const memById = new Map<string, string>();
        if (unknownSrc.size > 0) {
          for (const r of await tx.node.findMany({
            where: { id: { in: [...unknownSrc] } },
            select: { id: true, memoryId: true },
          })) {
            memById.set(r.id, r.memoryId);
          }
        }

        // Locs already taken in the target an incoming edge could collide
        // with — restricted to the candidate locs and EXCLUDING the in-flight
        // edges themselves (an edge already in the target memory that is also
        // incident to a colliding node appears here and must not be treated
        // as colliding with its own loc).
        const occupied = new Set<string>(
          (
            await tx.edge.findMany({
              where: { memoryId: targetMemoryId, loc: { in: incident.map((e) => e.loc) } },
              select: { id: true, loc: true },
            })
          )
            .filter((e) => !incidentIds.has(e.id))
            .map((e) => e.loc),
        );

        const toDrop: string[] = [];
        const memoryOnly: string[] = [];
        const remaps: Array<{ id: string; sourceId: string; targetId: string; memoryId: string }> = [];
        for (const e of incident) {
          const newSourceId = survivor.get(e.sourceId) ?? e.sourceId;
          const newTargetId = survivor.get(e.targetId) ?? e.targetId;
          if (newSourceId === newTargetId) {
            toDrop.push(e.id);
            continue;
          }
          const newMemoryId = survivor.has(e.sourceId)
            ? targetMemoryId
            : (memById.get(newSourceId) ?? e.memoryId);
          if (newMemoryId === targetMemoryId) {
            if (occupied.has(e.loc)) {
              toDrop.push(e.id);
              continue;
            }
            occupied.add(e.loc);
          }
          const endpointChanged = newSourceId !== e.sourceId || newTargetId !== e.targetId;
          if (endpointChanged) {
            remaps.push({ id: e.id, sourceId: newSourceId, targetId: newTargetId, memoryId: newMemoryId });
          } else if (newMemoryId !== e.memoryId) {
            memoryOnly.push(e.id);
          }
        }
        if (toDrop.length > 0) {
          await tx.edge.deleteMany({ where: { id: { in: toDrop } } });
        }
        if (memoryOnly.length > 0) {
          await tx.edge.updateMany({ where: { id: { in: memoryOnly } }, data: { memoryId: targetMemoryId } });
        }
        for (const r of remaps) {
          await tx.edge.update({
            where: { id: r.id },
            data: { sourceId: r.sourceId, targetId: r.targetId, memoryId: r.memoryId },
          });
        }
        moved += remaps.length + memoryOnly.length;
        dropped += toDrop.length;
      }

      // -- Delete the now-emptied colliding source rows. Only the rows we
      //    folded, and only if still in the source memory, so a concurrently
      //    relocated row is never cross-memory deleted. Any edge not
      //    transferred above cascades away with the row. --
      // #449 — PendingEdges aimed at the folded rows go with their ids:
      // targetId is not a foreign key, so the row cascade never reaches them.
      let pendingSourceMemories: string[] = [];
      if (foldedIds.length > 0) {
        // #1664 — a live thread posted after the preflight refuses the fold;
        // deleted threads go with the folded node (their anchor can't move).
        await refuseLiveThreadsOnFold(tx, foldedIds);
        await hardDeleteThreadsOfTargets(tx, foldedIds);
        pendingSourceMemories = await deletePendingEdgesTargetingNodes(tx, foldedIds);
        await tx.node.deleteMany({ where: { id: { in: foldedIds }, memoryId: sourceMemoryId } });
      }
      return { folded: foldedIds.length, moved, dropped, pendingSourceMemories };
    }, BATCH_TX_OPTS);

    progress.foldedCount += batch.folded;
    await reconcilePendingEdgeCounts(db, batch.pendingSourceMemories).catch((err) =>
      console.warn('[mergeMemories] pending-edge count reconcile failed (the periodic repair will fix it):', err),
    );
    progress.edgesMovedCount += batch.moved;
    progress.edgesDroppedCount += batch.dropped;
  }

  // Derived INCLUDE edges (#2040) are not relocated (their loc is id-derived and
  // the governed-edge trigger forbids rewriting them): drop the source memory's,
  // then re-derive them for the target's nodes once Phase 3 has settled.
  await db.edge.deleteMany({ where: { memoryId: sourceMemoryId, governedKind: 'INCLUDE' } });

  // === Phase 3: relocate the surviving source-memory edges into the target. ===
  // After Phases 2-3 the source memory holds no live nodes, so every edge
  // still denormalized to it is sourced from a relocated node (its endpoints
  // are unchanged — ids were preserved) and must follow into the target's loc
  // namespace. Drained in batches: each batch's source-memory edges have
  // distinct locs (the source's own unique index), so the only collisions are
  // against the target's existing locs — re-queried each batch so a prior
  // batch's moves are visible. Colliding edges drop; the rest move.
  for (;;) {
    const edges = await db.edge.findMany({
      // #1664 — governed comment edges moved with their threads; one still
      // here belongs to a thread that stays (its target did), so it stays too.
      where: { memoryId: sourceMemoryId, governedKind: null },
      select: { id: true, loc: true },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (edges.length === 0) break;
    const taken = new Set(
      (
        await db.edge.findMany({
          where: { memoryId: targetMemoryId, loc: { in: edges.map((e) => e.loc) } },
          select: { loc: true },
        })
      ).map((e) => e.loc),
    );
    const drop = edges.filter((e) => taken.has(e.loc)).map((e) => e.id);
    const move = edges.filter((e) => !taken.has(e.loc)).map((e) => e.id);
    await db.$transaction(async (tx) => {
      await lockMergeMemoryRows(tx);
      if (drop.length > 0) await tx.edge.deleteMany({ where: { id: { in: drop } } });
      if (move.length > 0) {
        await tx.edge.updateMany({ where: { id: { in: move } }, data: { memoryId: targetMemoryId } });
      }
    }, BATCH_TX_OPTS);
    progress.edgesMovedCount += move.length;
    progress.edgesDroppedCount += drop.length;
    if (edges.length < batchSize) break;
  }

  {
    // #2040 — re-derive include edges for the target's nodes that carry tags.
    // Encrypted content is ciphertext and never matches; those wait for their
    // next content write.
    const tagged = await db.node.findMany({
      where: { memoryId: targetMemoryId, deletedAt: null, content: { contains: '{{>' } },
      select: { id: true },
    });
    for (let i = 0; i < tagged.length; i += batchSize) {
      const ids = tagged.slice(i, i + batchSize).map((n) => n.id);
      await db.$transaction((tx) => resyncDerivedIncludesForNodes(tx, ids), BATCH_TX_OPTS);
    }
  }

  // === Final: soft-delete the now-empty source memory when asked. ===
  if (deleteSourceMem) {
    // Under the lock and re-checked (@copilot round 2). The per-batch gates
    // release `channel-host:<source>` when their transactions end, so a Channel
    // created between the last batch and this update would otherwise let a
    // merge soft-delete a memory that now HOSTS one — the normal delete path
    // locks and re-checks for exactly this reason, and this one did not.
    await db.$transaction(async (tx) => {
      // `'all'`, not the batch form with an empty row list — that would make
      // the check vacuous, since an empty loc list overlaps nothing. Deleting
      // the memory puts EVERY address in it out of reach, so any Channel at all
      // refuses.
      await lockMemoryForChannelChange(tx, sourceMemoryId);
      // The later memory.update needs NO KEY UPDATE. Take it on BOTH rows in
      // stable ID order now; opposing merges must not each upgrade a shared
      // lock on a different source row after holding SHARE on both.
      // All content and edge writes have committed. Disposition only marks
      // the source deleted, so a target encryption flip after those batches
      // must not strand the requested cleanup.
      await lockMergeMemoryRows(tx, 'delete-source', false);
      await assertNoProtectedReach(tx, sourceMemoryId, 'all', 'delete');
      // #1468 — the source memory's deletion: whatever the batches left.
      await assertNoMintedCorpusRemoval(tx, sourceMemoryId, 'merge out of its corpus', { includeTombstones: false });
      await tx.memory.update({ where: { id: sourceMemoryId }, data: { deletedAt: new Date() } });
    });
  }

  return progress;
}
