/**
 * moveNodeSubtree — rebase a node AND its loc-subtree WITHIN one memory (#768).
 *
 * A node's parent/child relationship is expressed by its loc PREFIX (`a:b` is
 * the parent of `a:b:c`) and its URN is `<memoryUrn>::<loc>`. So renaming a node
 * — the old moveNode / hadron_move_node behavior of relocating only the named
 * node — stranded every descendant at its original loc, leaving their computed
 * URNs pointing under a parent path that no longer exists (issue #768). This
 * helper is the ONE shared implementation both the GraphQL `moveNode` resolver
 * and the MCP `hadron_move_node` tool call for a SAME-MEMORY move, so the two
 * surfaces can't drift.
 *
 * **Same-memory only, by design.** Cross-memory relocation of a subtree is NOT
 * handled here: moving descendants into another memory turns the subtree's
 * boundary edges into cross-memory edges whose endpoints (`Edge.source` /
 * `Edge.target`) are resolved WITHOUT a per-endpoint access check, so a reader
 * of one memory could reach a node in the other — a systemic concern that
 * belongs with `extractParentNode` (purpose-built for cross-memory subtree
 * moves) and a dedicated Edge-endpoint gating fix, tracked separately. The
 * callers reject a cross-memory move that carries descendants and fall back to
 * their single-node path for a cross-memory LEAF move.
 *
 * It rebases every node in the subtree (`<source.loc>` and each
 * `<source.loc>:…` descendant, on `:` path boundaries) onto `destLoc`, writes a
 * pre-move NodeRevision for each, and moves the rows BY ID (stable — every edge
 * reference stays valid). Everything stays in the one memory, so no `memoryId`
 * ever changes and there is no cross-tenant surface. EDGES are left untouched:
 * their loc is a derived denormalization, references are by stable id (the graph
 * stays intact), and re-deriving edge locs on a move — with its collision +
 * incoming/outgoing symmetry — is out of scope for the #768 rename fix (folded
 * into #781), exactly as a single-node move has always left them.
 *
 * The CALLER owns everything around it: write-authorization, the destination
 * ancestor lock (`lockAncestorsForCreate`), the same-slot no-op short-circuit,
 * the cross-memory guard, any overwrite/eviction of the destination slot, and
 * the post-move fetch/return shape. `source` MUST be the full live node row
 * (all revisioned fields loaded — `buildNodeRevisionSnapshot` needs them) and
 * MUST live in the same memory it's moving within.
 */

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
 * Relocate `source` and its loc-subtree to `destLoc` within the SAME memory. See
 * the module doc for the caller's responsibilities. Throws
 * {@link SubtreeMoveIntoSelfError} / {@link SubtreeMoveCollisionError} /
 * {@link SubtreeMoveSourceChangedError}; the caller maps these to its surface.
 */
export async function moveNodeSubtree(
  tx: Prisma.TransactionClient,
  opts: {
    source: SnapshotSourceNode;
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
  const { source, destLoc, editor, renameSourceLeaf } = opts;
  const memoryId = source.memoryId;

  // A node can't be moved INTO its own subtree — the rebase would fold the loc
  // prefix onto itself.
  if (destLoc.startsWith(`${source.loc}:`)) {
    throw new SubtreeMoveIntoSelfError(destLoc);
  }

  // Serialize this move against concurrent creates/moves anywhere in the source
  // subtree, on two advisory keys:
  //   - `source.loc` itself (lockNodeForDelete): a create of `source.loc:x` locks
  //     `source.loc` as its ancestor, so it either commits before the descendant
  //     read below (swept in) or blocks until this move completes (lands under
  //     the moved prefix).
  //   - the source's ANCESTOR path (lockAncestorsForCreate): a concurrent move of
  //     a DESCENDANT (e.g. `source.loc:c`) locks its own ancestors — which
  //     include `source.loc` — so it contends with THIS move's `source.loc` lock.
  //     Without this, an ancestor move and a descendant move take disjoint exact
  //     locks, both snapshot overlapping rows, and the later writer pulls the
  //     descendant out of the earlier move's subtree (PR #780 review P1). Now one
  //     blocks the other; the loser re-reads and either sees the moved prefix or
  //     aborts via the source revalidation below.
  // The caller has already locked the DESTINATION ancestor path. Two moves that
  // relocate into each other's subtrees can still deadlock on these keys —
  // Postgres detects and aborts one (self-healing; moves are infrequent).
  await lockAncestorsForCreate(tx, memoryId, source.loc);
  await lockNodeForDelete(tx, memoryId, source.loc);

  // Revalidate the source AFTER the lock: a concurrent move of the SAME node
  // could have relocated it between the caller's pre-transaction resolve and
  // this lock, leaving `source.loc` empty. Proceeding would move the node by id
  // while its descendants (now under the other destination) are missed and
  // stranded — the very bug this fixes. Abort so the caller can retry.
  const fresh = await tx.node.findUnique({
    where: { id: source.id },
    select: { loc: true, memoryId: true, deletedAt: true },
  });
  if (!fresh || fresh.deletedAt || fresh.loc !== source.loc || fresh.memoryId !== memoryId) {
    throw new SubtreeMoveSourceChangedError(source.id);
  }

  // The subtree: the source node's descendants, on ':' path boundaries (so
  // `findings:auth` doesn't sweep in `findings:auth-v2`).
  const descendants = await tx.node.findMany({
    where: { memoryId, deletedAt: null, loc: { startsWith: `${source.loc}:` } },
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
    where: { memoryId, loc: { in: [...newLocById.values()] } },
    select: { id: true, loc: true },
  });
  const blocker = occupants.find((o) => !movedIds.has(o.id));
  if (blocker) throw new SubtreeMoveCollisionError(blocker.loc, memoryId);

  // Move every node in two phases so per-row updates never trip the
  // (loc, memoryId) unique mid-transaction. A rebased loc is NOT always disjoint
  // from the old subtree: moving a node UP into a (possibly virtual) ancestor
  // slot maps a descendant onto a sibling's old loc — e.g. `a:b` → `a` sends the
  // grandchild `a:b:b` to `a:b`, the source's own old slot. Phase 1 parks every
  // moved node at a unique temp loc (freeing all old slots); phase 2 writes the
  // final locs + a pre-move NodeRevision. The snapshot/diff read the original
  // `n` (its pre-move loc), so temp parking doesn't affect audit history. Temp
  // locs mirror deleteNode's `__deleted-<id>` re-stamp — id-unique, and outside
  // any real loc namespace.
  for (const n of subtree) {
    await tx.node.update({ where: { id: n.id }, data: { loc: `__moving-${n.id}` } });
  }
  const leaf = destLoc.split(':').pop()!;
  for (const n of subtree) {
    const newLoc = newLocById.get(n.id)!;
    const rename = renameSourceLeaf === true && n.id === source.id;
    const changed = { loc: newLoc, ...(rename ? { name: leaf } : {}) };
    await createNodeRevision(
      tx,
      buildNodeRevisionSnapshot(n, editor, { changes: diffNodeChanges(n, changed) }),
    );
    await tx.node.update({ where: { id: n.id }, data: changed });
  }

  // Edges are intentionally left untouched (their loc is a derived
  // denormalization of the endpoint locs). Edge references are by stable id, so
  // the graph stays intact; only an edge's derived `loc`/URN goes stale — exactly
  // as a single-node move has always left it. Re-deriving edge locs on a move
  // opens up (loc, memoryId) collision handling and incoming/outgoing symmetry
  // that is out of scope for the #768 rename fix; it's folded into #781.

  return { movedCount: subtree.length };
}
