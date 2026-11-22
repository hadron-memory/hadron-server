import type { PrismaClient } from '../generated/prisma/index.js';
import { deriveEdgeLoc, deriveEdgeLocAlternates, compareMigratedSuffix, migratedLocSuffix } from './edgeLoc.js';

/**
 * The loc an upsert of a DERIVED edge should address (#4583). Normally {@link deriveEdgeLoc}'s. When the name has a
 * second spelling (a non-BMP code point between alphanumerics, see `edgeLoc.ts`) and the memory already holds THIS
 * edge under the migrated spelling, that edge's loc: the upsert then reaches the existing edge instead of creating a
 * twin beside it, which is what keeps a re-sync idempotent for a migrated edge (cor:dmo:060:03).
 *
 * The migrated spelling includes the backfill's own collision suffix (`<migrated>:2`, `:3`...).
 *
 * Precedence: a row at the runtime spelling that IS this edge (same name, source, target) wins, as on main. Otherwise a
 * same-edge row at the migrated spelling is used, even when a DIFFERENT edge owns the runtime loc (an edge literally
 * named `a--b` beside the migrated `a😀b`): that edge must not hide the right one, or the caller's occupant check would
 * refuse an edge that exists. A different edge that merely owns the migrated loc (an edge literally named `a-b` for the
 * name `a😀b`) is never taken for it, and with no same-edge row anywhere the runtime loc is returned, so an occupant
 * stays refused as before. Soft-deleted rows count, as for the primary spelling: the (loc, memory) unique is
 * unfiltered, so the caller's existing occupant checks must reach them.
 *
 * Never writes, never rewrites a loc, and reads nothing for a name with a single spelling.
 *
 * Contract (#4718, closes the #4637 gap). When the selection returns a MIGRATED row's loc, that row is locked
 * `FOR KEY SHARE` before the loc is returned, and the lock is held to the end of the CALLER's transaction. A hard
 * delete or a loc update of that row (an endpoint re-key) takes a conflicting lock, so it waits for the caller's
 * upsert and commit instead of landing between the selection and the upsert; the caller upserts at a row that is still
 * there, so the migrated edge is never twinned. The lock is re-checked after it is taken: a row that was deleted or
 * re-keyed between the read and the lock is not returned, and the selection runs again against the new state (bounded,
 * then the newest selection is returned). Locks of this class are compatible with each other, so two seam writers
 * never wait on one another. The primary (runtime) spelling and the no-row answer take no lock: a row missing there
 * only makes every writer create the same runtime loc, which meets on the (loc, memory) unique.
 *
 * BLOCKING AND ITS ERRORS. The seam can now wait: a delete or re-key of the selected row holds the caller until that
 * writer finishes, so the caller's transaction can surface a lock timeout (P2028) or, in the one cycle the order below
 * cannot prevent, a deadlock (40P01). That cycle: a caller that key-shares TWO migrated edges, in its own relationship
 * order, against a writer without the channel key (`moveNodeSubtree`'s edge pass; the tombstone archive's edge update has the same
 * shape) that re-keys the same two in its plan order. The pinned case is the move: it is the victim and aborts cleanly,
 * and a retry succeeds.
 * No retry is added here or in the callers: the error reaches them as any other transaction failure does, and
 * wrapping the move in a deadlock retry is a follow-up. Pinned in `edgeLocLock4718.test.ts`.
 *
 * It is only a lock when `db` is the caller's open transaction client; outside a transaction it ends with the statement.
 *
 * LOCK ORDER (one fixed order across paths; the order among SEVERAL edge rows is each writer's own, which is the case above):
 *   1. the memory channel key (`lockMemoriesForChannelChange`; the seam's callers hold it),
 *   2. the subtree advisory locks (`moveNodeSubtree`: destination ancestors, `lockSourceForMove`),
 *   3. the node rows and the memory fences,
 *   4. the edge row (this lock; `moveNodeSubtree`'s edge pass writes edge rows last, in plan order, after 1-3).
 * The seam takes at most ONE edge-row lock per call and never takes a node, memory or advisory lock after it; a caller
 * that holds the key share and then reaches for a node row held by a move is the one cycle this order forbids, and
 * `edgeLocLock4718.test.ts` pins the cross-memory `moveNodeSubtree` interleaving.
 *
 * Writers that never go through the seam (the fresh-edge create paths: createEdge, inline edges, merge, extract) only
 * write the runtime spelling and are out of scope of #4583.
 */
export async function derivedEdgeLocForUpsert(
  db: Pick<PrismaClient, 'edge' | '$queryRaw'>,
  edge: {
    memoryId: string;
    sourceId: string;
    targetId: string;
    sourceLoc: string;
    targetLoc: string;
    name: string | null | undefined;
  },
): Promise<string> {
  const primary = deriveEdgeLoc(edge.sourceLoc, edge.name, edge.targetLoc);
  const alternates = deriveEdgeLocAlternates(edge.sourceLoc, edge.name, edge.targetLoc);
  if (alternates.length === 0) return primary;
  // The backfill also appended `:N` (N >= 2) to the migrated loc when two names between the same endpoints sanitized to
  // one atom (migration lines 70-89), so those locs are candidates too: `<alternate>:2`, `<alternate>:3`, ...
  for (let attempt = 0; ; attempt++) {
    const picked = await select(db, edge, primary, alternates);
    if (picked.lock === null) return picked.loc;
    // FOR KEY SHARE conflicts with a delete and with a key (loc) update, and waits for either to finish.
    const held = await db.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM edges WHERE id = ${picked.lock} AND memory_id = ${edge.memoryId} AND loc = ${picked.loc} FOR KEY SHARE`;
    if (held.length > 0 || attempt >= MAX_LOCK_ATTEMPTS) return picked.loc;
  }
}

const MAX_LOCK_ATTEMPTS = 5;

async function select(
  db: Pick<PrismaClient, 'edge'>,
  edge: { memoryId: string; sourceId: string; targetId: string; name: string | null | undefined },
  primary: string,
  alternates: string[],
): Promise<{ loc: string; lock: string | null }> {
  const rows = await db.edge.findMany({
    where: {
      memoryId: edge.memoryId,
      OR: [{ loc: { in: [primary, ...alternates] } }, ...alternates.map((a) => ({ loc: { startsWith: `${a}:` } }))],
    },
    select: { id: true, loc: true, name: true, sourceId: true, targetId: true },
  });
  const isThisEdge = (r: { name: string | null; sourceId: string; targetId: string }) =>
    r.name === (edge.name ?? null) && r.sourceId === edge.sourceId && r.targetId === edge.targetId;
  // The runtime loc wins when it IS this edge (what main already did for it). When a DIFFERENT edge owns it, that must
  // not hide a same-edge migrated row: the caller's occupant check would refuse although the right edge exists.
  if (rows.some((r) => r.loc === primary && isThisEdge(r))) return { loc: primary, lock: null };
  // Rank within one alternate: the plain loc first, then suffixes as DECIMALS (shorter digit string first, then
  // lexicographic: the canonical form has no leading zeros, so this is numeric order without floating point).
  const rank = (loc: string): string | null => {
    for (const a of alternates) {
      if (loc === a) return ''; // the plain loc: the empty suffix sorts before every real one
      const suffix = migratedLocSuffix(loc, a);
      if (suffix !== null) return suffix;
    }
    return null;
  };
  // The same edge only: same name, source and target.
  const same = rows
    .filter(isThisEdge)
    .map((r) => ({ id: r.id, loc: r.loc, rank: rank(r.loc) }))
    .filter((r): r is { id: string; loc: string; rank: string } => r.rank !== null)
    .sort((x, y) => compareMigratedSuffix(x.rank, y.rank))[0];
  return same ? { loc: same.loc, lock: same.id } : { loc: primary, lock: null };
}
