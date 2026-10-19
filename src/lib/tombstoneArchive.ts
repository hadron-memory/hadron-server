/**
 * Moving a soft-deleted node out of its address (`<loc>__deleted-<id>`), with
 * the edge addresses that were DERIVED from that address.
 */
import type { Prisma } from '../generated/prisma/index.js';
import { deriveEdgeLoc } from './edgeLoc.js';
import { acquireLockSet } from './nodeSubtreeLock.js';

/** The loc a tombstone is archived at: id-unique, outside any real loc namespace. */
export function archivedTombstoneLoc(loc: string, id: string): string {
  return `${loc}__deleted-${id}`;
}

/** Speculative metadata only, authorized by the caller before discovery. */
export type TombstoneArchivePlan = {
  memoryId: string; loc: string;
  occupant: { id: string; deletedAt: Date | null } | null;
  descendantLocs: string[];
};
export class ArchivePlanStaleError extends Error {
  constructor() { super('Archive address plan changed'); this.name = 'ArchivePlanStaleError'; }
}
export class ArchivePlanExhaustedError extends Error {
  constructor() { super('Node addresses changed concurrently; re-read and retry.'); this.name = 'ArchivePlanExhaustedError'; }
}

/** Discover before the FIRST address acquisition, never extend a held set. */
export async function discoverArchivePlan(tx: Prisma.TransactionClient, memoryId: string, loc: string): Promise<TombstoneArchivePlan> {
  const occupant = await tx.node.findUnique({ where: { loc_memoryId: { loc, memoryId } }, select: { id: true, deletedAt: true } });
  const descendants = await tx.node.findMany({ where: { memoryId, loc: { startsWith: `${loc}:` } }, select: { loc: true }, orderBy: { loc: 'asc' } });
  return { memoryId, loc, occupant, descendantLocs: descendants.map(n => n.loc) };
}

/** Under the root and complete initial set, before any mutation. READ COMMITTED supplies a fresh view. */
export async function validateArchivePlan(tx: Prisma.TransactionClient, plan: TombstoneArchivePlan): Promise<void> {
  const fresh = await discoverArchivePlan(tx, plan.memoryId, plan.loc);
  if (fresh.occupant?.id !== plan.occupant?.id ||
      fresh.occupant?.deletedAt?.getTime() !== plan.occupant?.deletedAt?.getTime() ||
      JSON.stringify(fresh.descendantLocs) !== JSON.stringify(plan.descendantLocs)) throw new ArchivePlanStaleError();
}

/** Stale metadata only: rollback completes before the next attempt. One outer deadline,
 * never retry permission errors, 40P01, timeouts, or an already-mutated operation. */
export async function withArchivePlanRetries<T>(attempt: (remainingMs: number) => Promise<T>, budgetMs = 120_000): Promise<T> {
  const entered = performance.now();
  for (let i = 0; i < 3; i++) {
    const remainingMs = Math.ceil(budgetMs - (performance.now() - entered));
    if (remainingMs <= 0) throw new Error('Transaction timed out');
    try { return await attempt(remainingMs); }
    catch (error) {
      if (!(error instanceof ArchivePlanStaleError)) throw error;
      if (i === 2) throw new ArchivePlanExhaustedError();
    }
  }
  throw new Error('Unreachable archive retry state');
}

/**
 * Re-stamp a TOMBSTONE and deleted descendant branches under
 * {@link archivedTombstoneLoc} so a fresh node can take its address without
 * inheriting a recursively deleted subtree. Live descendants and everything
 * under them stay in place; a new parent already permits those live children.
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
  plan: TombstoneArchivePlan,
): Promise<string> {
  const { id, loc, memoryId } = tombstone;
  if (plan.memoryId !== memoryId || plan.loc !== loc || plan.occupant?.id !== id) throw new Error('Archive plan does not cover its target');
  const archived = archivedTombstoneLoc(loc, id);
  const addresses = await tx.node.findMany({
    where: { memoryId, loc: { startsWith: `${loc}:` } },
    select: { loc: true },
  });
  // The root now fences new descendants. Verify that no helper can expand the
  // validated set; this invariant failure is NOT a retry sentinel after eviction.
  const planned = new Set(plan.descendantLocs);
  if (addresses.some(n => !planned.has(n.loc))) throw new Error('Archive address coverage changed after validation');
  await acquireLockSet(tx, addresses.map(node => ({ memoryId, loc: node.loc })));
  const prefix = `${loc}:`;
  const descendants = await tx.$queryRaw<Array<{ id: string; loc: string; deletedAt: Date | null }>>`
    SELECT id, loc, deleted_at AS "deletedAt"
    FROM nodes
    WHERE memory_id = ${memoryId} AND left(loc, ${prefix.length}::integer) = ${prefix}
    ORDER BY char_length(loc), loc
    FOR NO KEY UPDATE
  `;
  // A live descendant belongs to the current address, not the old deleted
  // branch. Keep its entire subtree in place, including any deleted children.
  // Sorted locs put every ancestor before its descendants.
  const retainedLive: string[] = [];
  const moved = [{ id, oldLoc: loc, newLoc: archived }];
  for (const node of descendants) {
    if (retainedLive.some((liveLoc) => node.loc.startsWith(`${liveLoc}:`))) continue;
    if (node.deletedAt === null) {
      retainedLive.push(node.loc);
      continue;
    }
    moved.push({ id: node.id, oldLoc: node.loc, newLoc: `${archived}${node.loc.slice(loc.length)}` });
  }
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
