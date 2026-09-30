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
 * Re-stamp a TOMBSTONE and its deleted descendants under
 * {@link archivedTombstoneLoc} so a fresh node can take its address without
 * inheriting a recursively deleted subtree.
 *
 * Soft deletion leaves nodes and their edges attached, and an edge's loc is usually
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
  const descendants = await tx.node.findMany({
    where: { memoryId, loc: { startsWith: `${loc}:` } },
    select: { id: true, loc: true, deletedAt: true },
    orderBy: { loc: 'asc' },
  });
  // A live child must never silently become part of the old deleted tree.
  // The address lock on `loc` excludes concurrent child creation here.
  if (descendants.some((node) => node.deletedAt === null)) {
    throw new Error(`Cannot archive tombstone ${loc}: a live descendant remains`);
  }
  const moved = [
    { id, oldLoc: loc, newLoc: archived },
    ...descendants.map((node) => ({
      id: node.id, oldLoc: node.loc, newLoc: `${archived}${node.loc.slice(loc.length)}`,
    })),
  ];
  const byId = new Map(moved.map((node) => [node.id, node]));
  // Re-stamp FIRST, then list the edges (Chip's QA, PR #1452). `loc` is in the
  // (loc, memory_id) unique index, so this update takes the row FOR UPDATE and
  // waits out any in-flight edge insert still holding its FK KEY SHARE on the
  // node; the listing below, a fresh READ COMMITTED statement, then sees that
  // edge. Listing first would miss it, and it would commit at the old address.
  for (const node of moved) {
    await tx.node.update({ where: { id: node.id }, data: { loc: node.newLoc }, select: { id: true } });
  }
  const edges = await tx.edge.findMany({
    where: { memoryId, OR: [{ sourceId: { in: moved.map((node) => node.id) } }, { targetId: { in: moved.map((node) => node.id) } }] },
    select: {
      id: true, loc: true, name: true, sourceId: true, targetId: true,
      source: { select: { loc: true } },
      target: { select: { loc: true } },
    },
  });
  for (const edge of edges) {
    const renamed = rekeyedEdgeLoc(edge, byId);
    if (renamed !== null) {
      await tx.edge.update({ where: { id: edge.id }, data: { loc: renamed }, select: { id: true } });
    }
  }
  return archived;
}

/** The edge's loc after any of its archived endpoints move, or null when it does not depend on those addresses. */
function rekeyedEdgeLoc(
  edge: {
    loc: string; name: string | null; sourceId: string; targetId: string;
    source: { loc: string }; target: { loc: string };
  },
  moved: ReadonlyMap<string, { oldLoc: string; newLoc: string }>,
): string | null {
  const source = moved.get(edge.sourceId);
  const target = moved.get(edge.targetId);
  const oldSourceLoc = source?.oldLoc ?? edge.source.loc;
  const oldTargetLoc = target?.oldLoc ?? edge.target.loc;
  if (edge.loc === deriveEdgeLoc(oldSourceLoc, edge.name, oldTargetLoc)) {
    return deriveEdgeLoc(
      source?.newLoc ?? oldSourceLoc,
      edge.name,
      target?.newLoc ?? oldTargetLoc,
    );
  }
  if (source && edge.loc.startsWith(`${source.oldLoc}:`)) {
    return `${source.newLoc}${edge.loc.slice(source.oldLoc.length)}`;
  }
  return null;
}
