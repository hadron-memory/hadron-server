import type { PrismaClient } from '../../generated/prisma/index.js';
import { computeContentHash } from '../../lib/contentHash.js';
import {
  buildNodeVersionSnapshot,
  type SnapshotEditor,
} from '../../lib/nodeVersionSnapshot.js';
import {
  mergeNodeFields,
  type NodeMergeField,
} from '../../lib/nodeMerge.js';
import { NodeAbstractTooLongError } from '../../lib/entityRef/errors.js';

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
 *   1. **Classify + relocate** — keyset-page the source nodes (id+loc
 *      projection only) against the target by loc. Colliding nodes (the small
 *      set) are recorded for Phase 2; the rest RELOCATE in a bulk `updateMany`
 *      per page. Ids are preserved, so inbound edges keep resolving, and every
 *      SQL id/loc list stays bounded by the page size (no unbounded `notIn`).
 *   2. **Fold** — fold colliding nodes in batches; per node: snapshot the
 *      target counterpart (`NodeVersion`), merge the selected fields,
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
 * gating, per-memory write authorization (including third memories whose
 * edges re-point), and the post-merge embedding backfill. Encrypted memories
 * are rejected upstream, so every row read here is plaintext.
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

export async function mergeMemoryGraph(
  db: PrismaClient,
  args: MergeMemoryArgs,
): Promise<MergeMemoryResult> {
  const { sourceMemoryId, targetMemoryId, fields, deleteSourceMem, editor } = args;
  const actorId = editor.userId ?? editor.info ?? null;
  // Clamp to >= 1: a zero/negative batchSize (the test seam is public) would
  // never advance the fold loop and spin forever.
  const batchSize = Math.max(1, Math.floor(args.batchSize ?? MERGE_BATCH_SIZE));
  const classifyPage = Math.max(1, Math.floor(args.classifyPageSize ?? CLASSIFY_PAGE));
  const withEdges = fields.has('EDGES');

  // === Phase 1: classify + relocate, in one keyset-paged scan. ===
  // Page the live source nodes by id (id+loc projection only — never the full
  // rows) and match each page against the target by loc. A source node whose
  // loc already exists in the target FOLDS into that counterpart (Phase 2 below);
  // the rest RELOCATE here, one bulk `updateMany` per page. Folding and
  // relocating in the same scan means the colliding set is the ONLY id list
  // we hold in memory, and every SQL `IN (...)`/`updateMany` list is bounded
  // by the page size — a giant source memory never builds an unbounded
  // `notIn` (which would blow the DB bind-parameter limit). Keyset (`id >
  // cursor`) is required: relocated movers leave the `memoryId = source` set,
  // but the colliding rows we leave behind would otherwise be re-read forever
  // by an offset/`take`-only loop.
  const survivor = new Map<string, string>(); // colliding src id → target counterpart id
  const collidingSrcIds: string[] = [];
  let relocatedCount = 0;
  for (let cursor: string | undefined; ; ) {
    const page = await db.node.findMany({
      where: { memoryId: sourceMemoryId, deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
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
      const relocate = await db.node.updateMany({
        where: { id: { in: relocateIds }, memoryId: sourceMemoryId, deletedAt: null },
        data: { memoryId: targetMemoryId },
      });
      relocatedCount += relocate.count;
    }
    if (page.length < classifyPage) break;
  }

  // === Phase 2: fold the colliding nodes, in batches. ===
  // Each batch is its own transaction (bounded size + lock duration). Per
  // node: snapshot the target counterpart, merge fields, recompute the
  // abstract hash, repoint its incident edges (when EDGES is selected), then
  // delete the emptied source row. Repointing happens BEFORE the delete so an
  // edge transferred onto the counterpart doesn't cascade away with the row.
  let foldedCount = 0;
  let edgesMovedCount = 0;
  let edgesDroppedCount = 0;

  for (let i = 0; i < collidingSrcIds.length; i += batchSize) {
    const batchIds = collidingSrcIds.slice(i, i + batchSize);

    const batch = await db.$transaction(async (tx) => {
      let moved = 0;
      let dropped = 0;

      // Read the batch's rows INSIDE the transaction, constrained to their
      // expected memory + live state. Reading here (rather than before the tx)
      // closes a race: a concurrent relocate/delete between classification and
      // this fold can no longer cause a lost update or a stray cross-memory
      // write — the rows are read and mutated under the same tx. Only source
      // rows whose target counterpart is still live get folded; a vanished
      // counterpart leaves its source row untouched for a later pass (the
      // merge is resumable), never silently deleted.
      const srcRows = await tx.node.findMany({
        where: { id: { in: batchIds }, memoryId: sourceMemoryId, deletedAt: null },
      });
      const tgtRows = await tx.node.findMany({
        where: {
          id: { in: srcRows.map((s) => survivor.get(s.id)!) },
          memoryId: targetMemoryId,
          deletedAt: null,
        },
      });
      const tgtById = new Map(tgtRows.map((t) => [t.id, t]));
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
        await tx.nodeVersion.create({
          data: buildNodeVersionSnapshot(tgt, editor, {
            changes: Object.keys(merged.changed),
          }),
        });
        if (Object.keys(merged.changed).length > 0) {
          const writeData: Record<string, unknown> = { ...merged.changed, updatedBy: actorId };
          if (merged.abstractChanged) {
            writeData.abstractOriginHash = computeContentHash(
              merged.contentChanged ? (merged.changed.content as string | null) : tgt.content,
            );
          }
          await tx.node.update({ where: { id: tgt.id }, data: writeData });
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
          where: { OR: [{ sourceId: { in: foldedIds } }, { targetId: { in: foldedIds } }] },
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
      if (foldedIds.length > 0) {
        await tx.node.deleteMany({ where: { id: { in: foldedIds }, memoryId: sourceMemoryId } });
      }
      return { folded: foldedIds.length, moved, dropped };
    }, BATCH_TX_OPTS);

    foldedCount += batch.folded;
    edgesMovedCount += batch.moved;
    edgesDroppedCount += batch.dropped;
  }

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
      where: { memoryId: sourceMemoryId },
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
      if (drop.length > 0) await tx.edge.deleteMany({ where: { id: { in: drop } } });
      if (move.length > 0) {
        await tx.edge.updateMany({ where: { id: { in: move } }, data: { memoryId: targetMemoryId } });
      }
    }, BATCH_TX_OPTS);
    edgesMovedCount += move.length;
    edgesDroppedCount += drop.length;
    if (edges.length < batchSize) break;
  }

  // === Final: soft-delete the now-empty source memory when asked. ===
  if (deleteSourceMem) {
    await db.memory.update({ where: { id: sourceMemoryId }, data: { deletedAt: new Date() } });
  }

  return { relocatedCount, foldedCount, edgesMovedCount, edgesDroppedCount };
}
