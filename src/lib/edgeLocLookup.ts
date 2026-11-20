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
 * The selection is made BEFORE the caller's upsert and this module does not serialize the two, so the guarantee is
 * stated exactly.
 *
 * While the selected same-edge row stays at its loc, two writers that both go through this seam cannot twin each
 * other: a seam writer picks the runtime spelling only when no same-edge row holds the migrated one, so both address
 * the same loc and meet on the (loc, memory) unique. Each caller's `update: {}` upsert is followed, in the same
 * transaction, by the occupant check (live, same source, target, name), which refuses a different edge at that loc
 * rather than overwriting it.
 *
 * It does NOT hold if the selected row leaves its loc between the selection and the upsert: a hard delete (deleteEdge,
 * the inline and MCP outgoing-edge replacement, a merge drop) or an endpoint move that re-keys it. The writer that had
 * selected it then upserts at the migrated loc and creates the edge there, while a writer that selected after the
 * change creates it at the runtime loc: ONE duplicate edge. A writer off this seam (the fresh-edge create paths:
 * createEdge in GraphQL and MCP, inline edges, merge, subtree move, extract), which only ever writes the runtime
 * spelling and is out of scope of #4583, can leave one the same way.
 *
 * What the selection itself does in these races: it is a read and writes nothing, so the outcome is the duplicate edge
 * described above, not a lost or merged one. (What the caller's own upsert does under contention is that caller's
 * concern and is not claimed here.) Serializing the selection through the upsert (an advisory lock per relationship)
 * was declined: the seam's callers handle several relationships per transaction in differing orders, so a late-taken
 * lock risks a lock-order deadlock, a worse failure than the duplicate.
 */
export async function derivedEdgeLocForUpsert(
  db: Pick<PrismaClient, 'edge'>,
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
  const rows = await db.edge.findMany({
    where: {
      memoryId: edge.memoryId,
      OR: [{ loc: { in: [primary, ...alternates] } }, ...alternates.map((a) => ({ loc: { startsWith: `${a}:` } }))],
    },
    select: { loc: true, name: true, sourceId: true, targetId: true },
  });
  const isThisEdge = (r: { name: string | null; sourceId: string; targetId: string }) =>
    r.name === (edge.name ?? null) && r.sourceId === edge.sourceId && r.targetId === edge.targetId;
  // The runtime loc wins when it IS this edge (what main already did for it). When a DIFFERENT edge owns it, that must
  // not hide a same-edge migrated row: the caller's occupant check would refuse although the right edge exists.
  if (rows.some((r) => r.loc === primary && isThisEdge(r))) return primary;
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
    .map((r) => ({ loc: r.loc, rank: rank(r.loc) }))
    .filter((r): r is { loc: string; rank: string } => r.rank !== null)
    .sort((x, y) => compareMigratedSuffix(x.rank, y.rank))[0];
  return same ? same.loc : primary;
}
