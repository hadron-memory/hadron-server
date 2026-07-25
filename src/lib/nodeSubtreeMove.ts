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
 * reference stays valid), and re-derives the loc (+ memoryId, for a cross-memory
 * move) of edges wholly INSIDE the subtree.
 *
 * The CALLER owns everything around it: write-authorization to both memories,
 * the destination ancestor lock (lockAncestorsForCreate), the same-slot no-op
 * short-circuit, any overwrite/eviction of the destination slot, and the
 * post-move fetch/return shape. `source` MUST be the full live node row (all
 * revisioned fields loaded — buildNodeRevisionSnapshot needs them).
 *
 * Boundary-crossing edges (only one endpoint in the subtree) keep their loc and
 * memory — re-deriving one needs the unmoved endpoint's memory context, the same
 * limitation a single-node move has always had.
 */

import { Prisma } from '../generated/prisma/index.js';
import { deriveEdgeLoc } from './edgeLoc.js';
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

  // Edges wholly INSIDE the subtree (both endpoints moved) follow it: their
  // derived loc is recomputed from the rebased endpoint locs and, for a
  // cross-memory move, they relocate to the destination memory. A numeric suffix
  // disambiguates the rare derived-loc collision (mirrors extractParentNode).
  if (descendants.length > 0) {
    const intraEdges = await tx.edge.findMany({
      where: {
        deletedAt: null,
        sourceId: { in: [...movedIds] },
        targetId: { in: [...movedIds] },
      },
    });
    const usedLocs = new Set<string>();
    for (const e of intraEdges) {
      const base = deriveEdgeLoc(newLocById.get(e.sourceId)!, e.name, newLocById.get(e.targetId)!);
      let loc = base;
      for (let k = 2; usedLocs.has(loc); k++) loc = `${base}:${k}`;
      usedLocs.add(loc);
      await tx.edge.update({ where: { id: e.id }, data: { loc, memoryId: destMemoryId } });
    }
  }

  return { movedCount: subtree.length };
}
