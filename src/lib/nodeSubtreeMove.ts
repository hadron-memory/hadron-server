/**
 * moveNodeSubtree — relocate a node AND its loc-subtree inside an open
 * transaction (#768).
 *
 * A node's parent/child relationship is expressed by its loc PREFIX (`a:b` is
 * the parent of `a:b:c`) and its URN is `<memoryUrn>::<loc>`. So relocating only
 * the named node — the old moveNode / hadron_move_node behavior — stranded every
 * descendant at its original loc, leaving their computed URNs pointing under a
 * parent path that no longer exists (issue #768). This helper is the ONE shared
 * implementation both the GraphQL `moveNode` resolver and the MCP
 * `hadron_move_node` tool call, so the two surfaces can't drift.
 *
 * It rebases every node in the subtree (`<source.loc>` and each
 * `<source.loc>:…` descendant, on `:` path boundaries) onto `destLoc`, writes a
 * pre-move NodeRevision for each, moves the rows BY ID (stable — every edge
 * reference stays valid), carries the moved nodes' embedding rows to the
 * destination (cross-memory), and rewrites every edge whose SOURCE moved
 * (re-derived loc + destination memoryId).
 *
 * Every edge whose source moves MUST follow it: Edge.memoryId denormalizes the
 * source node's memory and edge reads authorize on it, so a stale value is a
 * cross-tenant read path (#780 review P1). Edges whose source did NOT move (an
 * incoming boundary edge, source outside the subtree) keep their memoryId — it's
 * already correct — and their loc; re-deriving that loc would need the unmoved
 * source's memory context, the same limitation a single-node move always had.
 *
 * The CALLER owns everything around it: write-authorization to both memories,
 * the destination ancestor lock (lockAncestorsForCreate), the same-slot no-op
 * short-circuit, any overwrite/eviction of the destination slot, and the
 * post-move fetch/return shape. `source` MUST be the full live node row (all
 * revisioned fields loaded — buildNodeRevisionSnapshot needs them).
 */

import { Prisma } from '../generated/prisma/index.js';
import { deriveEdgeLoc } from './edgeLoc.js';
import { lockNodeForDelete } from './nodeSubtreeLock.js';
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

export interface MoveNodeSubtreeResult {
  /** Number of nodes relocated (the source node plus its descendants). */
  movedCount: number;
}

/**
 * Relocate `source` and its loc-subtree. See the module doc for the caller's
 * responsibilities. Throws {@link SubtreeMoveIntoSelfError} /
 * {@link SubtreeMoveCollisionError}; the caller maps these to its own error
 * surface.
 */
export async function moveNodeSubtree(
  tx: Prisma.TransactionClient,
  opts: {
    source: SnapshotSourceNode;
    destMemoryId: string;
    destLoc: string;
    editor: SnapshotEditor;
    /**
     * Also set the moved SOURCE node's `name` to destLoc's leaf atom (the MCP
     * `hadron_move_node` behavior). The GraphQL `moveNode` leaves name untouched.
     * Descendants' names are never rewritten — only their loc prefix changes.
     */
    renameSourceLeaf?: boolean;
  },
): Promise<MoveNodeSubtreeResult> {
  const { source, destMemoryId, destLoc, editor, renameSourceLeaf } = opts;

  // A node can't be moved INTO its own subtree — the rebase would fold the loc
  // prefix onto itself. Only reachable within one memory.
  if (destMemoryId === source.memoryId && destLoc.startsWith(`${source.loc}:`)) {
    throw new SubtreeMoveIntoSelfError(destLoc);
  }
  const crossMemory = destMemoryId !== source.memoryId;

  // Serialize against a concurrent create under the source subtree. A create of
  // `source.loc:x` locks `source.loc` as its ancestor (lockAncestorsForCreate),
  // so acquiring the SAME advisory key here means such a create either commits
  // before this descendant read (and is swept into the move) or blocks until the
  // move completes (and lands under the already-moved prefix). Without it a
  // create racing the read below is omitted and stranded at the old prefix — the
  // very bug #768 fixes. The caller has already locked the DESTINATION ancestor
  // path; this adds the source side.
  await lockNodeForDelete(tx, source.memoryId, source.loc);

  // The subtree: the source node's descendants, on ':' path boundaries (so
  // `findings:auth` doesn't sweep in `findings:auth-v2`). Read BEFORE any write
  // so their old locs are intact.
  const descendants = await tx.node.findMany({
    where: {
      memoryId: source.memoryId,
      deletedAt: null,
      loc: { startsWith: `${source.loc}:` },
    },
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

  // Pre-move NodeRevision + row move for every node. New locs share the
  // destination prefix and are disjoint from the old locs, so per-row update
  // order never trips the (loc, memoryId) unique mid-transaction.
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

  // Embeddings follow the node on a cross-memory move. NodeEmbedding.memoryId is
  // independently denormalized and vector retrieval filters on it, so a moved
  // node would otherwise be invisible to destination-memory search and pollute
  // the source memory's candidate window. The unique key is
  // (nodeId, kind, chunkIndex) — memoryId isn't in it — so this can't collide.
  // Same-memory move: memoryId is unchanged, nothing to do.
  if (crossMemory) {
    await tx.nodeEmbedding.updateMany({
      where: { nodeId: { in: [...movedIds] } },
      data: { memoryId: destMemoryId },
    });
  }

  // Edges whose SOURCE moved follow it. Edge.memoryId denormalizes the SOURCE
  // node's memory, edge reads authorize on that column, and Edge.source/target
  // load the endpoint WITHOUT a re-check (resolvers.types.ts). So leaving a moved
  // node's outgoing edge at the old memoryId would let an old-memory reader
  // resolve Edge.source to the moved (destination-memory) node — a cross-tenant
  // read path. Set memoryId to the destination and re-derive the loc from the
  // rebased source + the target's loc (rebased when the target also moved, else
  // its current loc). Every such edge currently sits in the source memory, so
  // the mover (who has write access to it) may rewrite it. Edges whose source did
  // NOT move keep their memoryId (already correct) and loc.
  const outgoing = await tx.edge.findMany({
    where: { deletedAt: null, sourceId: { in: [...movedIds] } },
  });
  if (outgoing.length > 0) {
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
    const usedLocs = new Set<string>();
    for (const e of outgoing) {
      const tgtLoc = newLocById.get(e.targetId) ?? outsideTargetLoc.get(e.targetId);
      if (tgtLoc == null) continue; // target vanished (defensive; shouldn't happen)
      const base = deriveEdgeLoc(newLocById.get(e.sourceId)!, e.name, tgtLoc);
      let loc = base;
      for (let k = 2; usedLocs.has(loc); k++) loc = `${base}:${k}`;
      usedLocs.add(loc);
      await tx.edge.update({ where: { id: e.id }, data: { loc, memoryId: destMemoryId } });
    }
  }

  return { movedCount: subtree.length };
}
