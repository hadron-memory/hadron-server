/**
 * moveNodeSubtree — rebase a node AND its loc-subtree, within one memory OR
 * across memories (#768 same-memory rename; #781 cross-memory relocation).
 *
 * A node's parent/child relationship is expressed by its loc PREFIX (`a:b` is
 * the parent of `a:b:c`) and its URN is `<memoryUrn>::<loc>`. So relocating only
 * the named node stranded every descendant at its original loc, leaving their
 * computed URNs pointing under a parent path that no longer exists (#768). This
 * helper is the ONE shared implementation both the GraphQL `moveNode` resolver
 * and the MCP `hadron_move_node` tool call, so the two surfaces can't drift.
 *
 * It gathers the subtree (`<source.loc>` and each `<source.loc>:…` descendant,
 * on `:` path boundaries), rebases every loc onto `destLoc`, writes a pre-move
 * NodeRevision for each, and moves the rows BY ID (stable — every edge reference
 * stays valid). Nodes move in two phases (park at a unique temp loc, then the
 * final loc) so a rebase that overlaps the source subtree — e.g. moving `a:b`
 * UP to `a` sends grandchild `a:b:b` onto the source's old `a:b` slot — never
 * trips the `(loc, memoryId)` unique mid-transaction.
 *
 * **Cross-memory (`destMemoryId` ≠ the source's memory):**
 *   - Every moved node's `memoryId` becomes `destMemoryId`.
 *   - The moved nodes' `NodeEmbedding` rows are carried to `destMemoryId`
 *     (denormalized; vector retrieval filters on `node_embeddings.memory_id`).
 *   - Edges whose SOURCE moved follow it: `Edge.memoryId` (the denormalized
 *     source-side memory) becomes `destMemoryId` and the loc is re-derived from
 *     the rebased source + the target's loc (rebased when the target also moved),
 *     disambiguated against sibling and pre-existing destination edges so the
 *     `(loc, memoryId)` unique never trips. A boundary edge whose source did NOT
 *     move keeps its memoryId (its source didn't move) — it simply becomes a
 *     legitimate cross-memory edge, whose endpoints are gated by #783.
 * Same-memory moves change no `memoryId` and leave edges untouched (an edge's
 * loc is a derived denormalization; references are by stable id, so the graph
 * stays intact — same-memory edge-loc rebasing is the separate #781 concern).
 *
 * The CALLER owns: write-authorization to BOTH memories, the destination
 * ancestor lock (`lockAncestorsForCreate`), the same-slot no-op short-circuit,
 * any overwrite/eviction of the destination slot, and the post-move fetch/return
 * shape. `source` MUST be the full live node row (all revisioned fields loaded).
 */

import { deriveEdgeLoc } from './edgeLoc.js';
import { lockAncestorsForCreate, lockNodeForDelete } from './nodeSubtreeLock.js';
import type { Prisma } from '../generated/prisma/index.js';
import {
  buildNodeRevisionSnapshot,
  createNodeRevision,
  diffNodeChanges,
  type SnapshotSourceNode,
  type SnapshotEditor,
} from './nodeRevisionSnapshot.js';

/** A node OUTSIDE the moving set already occupies a destination slot. */
export class SubtreeMoveCollisionError extends Error {
  constructor(
    public readonly loc: string,
    public readonly memoryId: string,
  ) {
    super(`A node already occupies loc "${loc}" in the destination memory.`);
    this.name = 'SubtreeMoveCollisionError';
  }
}

/** The destination is inside the source's own subtree — a loc-prefix cycle. */
export class SubtreeMoveIntoSelfError extends Error {
  constructor(public readonly loc: string) {
    super('Cannot move a node into its own subtree.');
    this.name = 'SubtreeMoveIntoSelfError';
  }
}

/** The source node was relocated by a concurrent move after it was resolved. */
export class SubtreeMoveSourceChangedError extends Error {
  constructor(public readonly nodeId: string) {
    super('The node was moved concurrently; retry the move.');
    this.name = 'SubtreeMoveSourceChangedError';
  }
}

export interface MoveNodeSubtreeResult {
  /** Number of nodes relocated (the source node plus its descendants). */
  movedCount: number;
}

/**
 * Acquire the source-subtree advisory locks and revalidate the source row.
 * Shared by {@link moveNodeSubtree} AND the callers' single-node paths, so EVERY
 * move that reads or relocates from `source.loc` serializes the same way.
 * Without this, a path that resolves the source before the transaction (all of
 * them) and then reads/counts under `source.loc` races a concurrent move of that
 * node: the concurrent move can commit `p → q` first, this path then sees an
 * empty `p:` prefix and acts on a stale snapshot — stranding descendants.
 *
 * Locks (a) the source's ANCESTOR path — so a concurrent move of a DESCENDANT,
 * which locks its own ancestors (including `source.loc`), contends here — and
 * (b) `source.loc` itself — matching the key a descendant CREATE locks as its
 * ancestor. Then re-reads the row by id and throws
 * {@link SubtreeMoveSourceChangedError} if it was relocated/deleted meanwhile.
 * The caller must already hold the DESTINATION ancestor lock. Two moves that
 * relocate into each other's subtrees can still deadlock on these keys —
 * Postgres detects and aborts one (self-healing; moves are infrequent).
 */
export async function lockSourceForMove(
  tx: Prisma.TransactionClient,
  source: { id: string; loc: string; memoryId: string },
): Promise<void> {
  await lockAncestorsForCreate(tx, source.memoryId, source.loc);
  await lockNodeForDelete(tx, source.memoryId, source.loc);
  const fresh = await tx.node.findUnique({
    where: { id: source.id },
    select: { loc: true, memoryId: true, deletedAt: true },
  });
  if (
    !fresh ||
    fresh.deletedAt ||
    fresh.loc !== source.loc ||
    fresh.memoryId !== source.memoryId
  ) {
    throw new SubtreeMoveSourceChangedError(source.id);
  }
}

/**
 * Relocate `source` and its loc-subtree to `destLoc` (in `destMemoryId`, which
 * defaults to the source's own memory). See the module doc for the caller's
 * responsibilities. Throws {@link SubtreeMoveIntoSelfError} /
 * {@link SubtreeMoveCollisionError} / {@link SubtreeMoveSourceChangedError}; the
 * caller maps these to its surface.
 */
export async function moveNodeSubtree(
  tx: Prisma.TransactionClient,
  opts: {
    source: SnapshotSourceNode;
    destLoc: string;
    /** Destination memory. Omit / equal to source.memoryId for a same-memory move. */
    destMemoryId?: string;
    editor: SnapshotEditor;
    /**
     * Also set the moved SOURCE node's `name` to destLoc's leaf atom (the MCP
     * `hadron_move_node` behavior). The GraphQL `moveNode` leaves name untouched.
     * Descendants' names are never rewritten — only their loc prefix changes.
     */
    renameSourceLeaf?: boolean;
  },
): Promise<MoveNodeSubtreeResult> {
  const { source, destLoc, editor, renameSourceLeaf } = opts;
  const srcMemoryId = source.memoryId;
  const destMemoryId = opts.destMemoryId ?? srcMemoryId;
  const crossMemory = destMemoryId !== srcMemoryId;

  // A node can't be moved INTO its own subtree — the rebase would fold the loc
  // prefix onto itself. Only possible within one memory.
  if (!crossMemory && destLoc.startsWith(`${source.loc}:`)) {
    throw new SubtreeMoveIntoSelfError(destLoc);
  }

  // Lock the source subtree + revalidate the source. The caller already holds
  // the destination ancestor lock.
  await lockSourceForMove(tx, source);

  // The subtree: the source node's descendants, on ':' path boundaries (so
  // `findings:auth` doesn't sweep in `findings:auth-v2`).
  const descendants = await tx.node.findMany({
    where: { memoryId: srcMemoryId, deletedAt: null, loc: { startsWith: `${source.loc}:` } },
  });
  const subtree: SnapshotSourceNode[] = [source, ...descendants];
  // Rebase a source-subtree loc onto the destination: source.loc → destLoc,
  // source.loc:x → destLoc:x. slice(source.loc.length) is '' for the source
  // node and ':x…' for a descendant.
  const newLocById = new Map(
    subtree.map((n) => [n.id, destLoc + n.loc.slice(source.loc.length)] as const),
  );
  const movedIds = new Set(subtree.map((n) => n.id));

  // Fail loudly if any node OUTSIDE the moving set already occupies a
  // destination slot. Live OR soft-deleted blocks: the (loc, memoryId) unique
  // index is full, so a tombstone at the target still rejects the write.
  const occupants = await tx.node.findMany({
    where: { memoryId: destMemoryId, loc: { in: [...newLocById.values()] } },
    select: { id: true, loc: true },
  });
  const blocker = occupants.find((o) => !movedIds.has(o.id));
  if (blocker) throw new SubtreeMoveCollisionError(blocker.loc, destMemoryId);

  // Move every node in two phases so per-row updates never trip the
  // (loc, memoryId) unique mid-transaction — a same-memory rebase can overlap
  // the source subtree (moving `a:b` → `a` sends grandchild `a:b:b` onto the
  // source's old `a:b` slot). Phase 1 parks each node at a unique temp loc;
  // phase 2 writes the final loc (+ destination memory) and a pre-move
  // NodeRevision. The snapshot/diff read the original `n` (its pre-move loc), so
  // temp parking doesn't affect audit history. Temp locs mirror deleteNode's
  // `__deleted-<id>` re-stamp — id-unique, outside any real loc namespace.
  for (const n of subtree) {
    await tx.node.update({ where: { id: n.id }, data: { loc: `__moving-${n.id}` } });
  }
  const leaf = destLoc.split(':').pop()!;
  for (const n of subtree) {
    const newLoc = newLocById.get(n.id)!;
    const rename = renameSourceLeaf === true && n.id === source.id;
    const changed = { loc: newLoc, memoryId: destMemoryId, ...(rename ? { name: leaf } : {}) };
    await createNodeRevision(
      tx,
      buildNodeRevisionSnapshot(n, editor, { changes: diffNodeChanges(n, changed) }),
    );
    await tx.node.update({ where: { id: n.id }, data: changed });
  }

  if (!crossMemory) {
    // Same-memory: no memoryId changes anywhere, edges left untouched (#768).
    return { movedCount: subtree.length };
  }

  // ── Cross-memory carry-over ─────────────────────────────────────────────
  // Embeddings follow the node: NodeEmbedding.memoryId is denormalized and
  // vector retrieval filters on it. The vectors are content-based and unchanged,
  // so moving the rows (rather than deleting + re-embedding) keeps the node
  // searchable in the destination and out of the source's candidate window. The
  // unique key is (nodeId, kind, chunkIndex) — memoryId isn't in it — so this
  // can't collide.
  await tx.nodeEmbedding.updateMany({
    where: { nodeId: { in: [...movedIds] } },
    data: { memoryId: destMemoryId },
  });

  // Edges whose SOURCE moved follow it (Edge.memoryId denormalizes the source's
  // memory). Re-derive the loc from the rebased source + the target's loc
  // (rebased if the target also moved, else its current loc), and relocate the
  // edge to the destination memory. Edges whose source did NOT move keep their
  // memoryId (their source stayed) — they simply become cross-memory edges,
  // gated at read time by #783.
  const outgoing = await tx.edge.findMany({
    where: { deletedAt: null, sourceId: { in: [...movedIds] } },
  });
  if (outgoing.length === 0) return { movedCount: subtree.length };

  // Target locs for boundary targets (targets outside the moved set).
  const outsideTargetIds = [
    ...new Set(outgoing.map((e) => e.targetId).filter((id) => !movedIds.has(id))),
  ];
  const outsideTargetLoc = new Map<string, string>();
  if (outsideTargetIds.length > 0) {
    const rows = await tx.node.findMany({
      where: { id: { in: outsideTargetIds } },
      select: { id: true, loc: true },
    });
    for (const r of rows) outsideTargetLoc.set(r.id, r.loc);
  }

  // Desired base loc per moved edge (null target loc ⇒ skip defensively).
  const desired = outgoing.map((e) => {
    const tgtLoc = newLocById.get(e.targetId) ?? outsideTargetLoc.get(e.targetId);
    return {
      id: e.id,
      base: tgtLoc == null ? null : deriveEdgeLoc(newLocById.get(e.sourceId)!, e.name, tgtLoc),
    };
  });

  // Pre-existing destination edges that already hold a candidate loc — the exact
  // base OR a numeric-suffixed variant (`<base>:2`, …), since the disambiguation
  // loop below emits those. Missing the suffixed variants would let the loop pick
  // a `<base>:2` that already exists → (loc, memoryId) unique violation (live OR
  // tombstoned — the index is full). `startsWith <base>:` over-matches unrelated
  // deeper locs, which is harmless (we only ever avoid taken locs). The moved
  // edges are still in the source memory here, so they aren't matched.
  const bases = [...new Set(desired.map((d) => d.base).filter((b): b is string => b != null))];
  const taken = new Set<string>();
  if (bases.length > 0) {
    const rows = await tx.edge.findMany({
      where: {
        memoryId: destMemoryId,
        OR: [{ loc: { in: bases } }, ...bases.map((b) => ({ loc: { startsWith: `${b}:` } }))],
      },
      select: { loc: true },
    });
    for (const r of rows) taken.add(r.loc);
  }

  for (const d of desired) {
    if (d.base == null) continue; // target vanished — leave the edge as-is
    let loc = d.base;
    for (let k = 2; taken.has(loc); k++) loc = `${d.base}:${k}`;
    taken.add(loc);
    await tx.edge.update({ where: { id: d.id }, data: { loc, memoryId: destMemoryId } });
  }

  return { movedCount: subtree.length };
}
