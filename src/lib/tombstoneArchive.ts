/**
 * Moving a soft-deleted node out of its address (`<loc>__deleted-<id>`), with
 * the edge addresses that were DERIVED from that address.
 */
import type { Prisma } from '../generated/prisma/index.js';
import { deriveEdgeLoc } from './edgeLoc.js';

/** The loc a tombstone is archived at: id-unique, outside any real loc namespace. */
export function archivedTombstoneLoc(loc: string, id: string): string {
  return `${loc}__deleted-${id}`;
}

/**
 * Re-stamp a TOMBSTONE's loc to {@link archivedTombstoneLoc} so a fresh node
 * can take its address, and carry the tombstone's edge addresses with it.
 *
 * Soft deletion leaves a node's edges attached, and an edge's loc is usually
 * derived from its endpoints' locs (`deriveEdgeLoc`). Re-stamping only the node
 * would leave those edges holding the addresses a fresh node at the old loc
 * derives for the same relationships, so the fresh node's edge write collides
 * on `(loc, memoryId)`: `createMany({ skipDuplicates })` silently drops the new
 * edge, and `createEdge` fails on a raw unique violation (@codex P2, PR #1452).
 *
 * Rewritten, within the tombstone's memory only:
 * - an edge whose loc is exactly the derivation from its endpoints is
 *   re-derived with the archived loc substituted for the tombstone's;
 * - an OUTGOING edge authored under the tombstone's own loc namespace
 *   (`<loc>:…`, including a move's `:<k>` disambiguation) has that prefix
 *   re-stamped.
 * Any other authored loc is left alone: it never depended on this address.
 * Incoming edges from OTHER memories are left alone too. Their loc lives in the
 * source memory, which the caller has not been authorized to write.
 *
 * The caller must hold the edge-endpoint memory key for the tombstone's memory
 * (`lockEdgeEndpointMemories`, taken before any address lock, the order every
 * edge writer uses) and the address locks for `loc`, and must have verified
 * the row is a tombstone. Returns the archived loc.
 */
export async function archiveTombstone(
  tx: Prisma.TransactionClient,
  tombstone: { id: string; loc: string; memoryId: string },
): Promise<string> {
  const { id, loc, memoryId } = tombstone;
  const archived = archivedTombstoneLoc(loc, id);
  // Re-stamp FIRST, then list the edges (Chip's QA, PR #1452). `loc` is in the
  // (loc, memory_id) unique index, so this update takes the row FOR UPDATE and
  // waits out any in-flight edge insert still holding its FK KEY SHARE on the
  // node; the listing below, a fresh READ COMMITTED statement, then sees that
  // edge. Listing first would miss it, and it would commit at the old address.
  await tx.node.update({ where: { id }, data: { loc: archived }, select: { id: true } });
  const edges = await tx.edge.findMany({
    where: { memoryId, OR: [{ sourceId: id }, { targetId: id }] },
    select: {
      id: true, loc: true, name: true, sourceId: true, targetId: true,
      source: { select: { loc: true } },
      target: { select: { loc: true } },
    },
  });
  for (const edge of edges) {
    const renamed = rekeyedEdgeLoc(edge, id, loc, archived);
    if (renamed !== null) {
      await tx.edge.update({ where: { id: edge.id }, data: { loc: renamed }, select: { id: true } });
    }
  }
  return archived;
}

/** The edge's loc after its endpoint `nodeId` moves from `oldLoc` to `newLoc`, or null when it does not depend on that address. */
function rekeyedEdgeLoc(
  edge: {
    loc: string; name: string | null; sourceId: string; targetId: string;
    source: { loc: string }; target: { loc: string };
  },
  nodeId: string,
  oldLoc: string,
  newLoc: string,
): string | null {
  const sourceLoc = edge.sourceId === nodeId ? oldLoc : edge.source.loc;
  const targetLoc = edge.targetId === nodeId ? oldLoc : edge.target.loc;
  if (edge.loc === deriveEdgeLoc(sourceLoc, edge.name, targetLoc)) {
    return deriveEdgeLoc(
      edge.sourceId === nodeId ? newLoc : sourceLoc,
      edge.name,
      edge.targetId === nodeId ? newLoc : targetLoc,
    );
  }
  if (edge.sourceId === nodeId && edge.loc.startsWith(`${oldLoc}:`)) {
    return `${newLoc}${edge.loc.slice(oldLoc.length)}`;
  }
  return null;
}
