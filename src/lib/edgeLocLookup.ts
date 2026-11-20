import type { PrismaClient } from '../generated/prisma/index.js';
import { deriveEdgeLoc, deriveEdgeLocAlternates } from './edgeLoc.js';

/**
 * The loc an upsert of a DERIVED edge should address (#4583). Normally {@link deriveEdgeLoc}'s. When the name has a
 * second spelling (a non-BMP code point between alphanumerics, see `edgeLoc.ts`) and the memory already holds THIS
 * edge under the migrated spelling, that edge's loc: the upsert then reaches the existing edge instead of creating a
 * twin beside it, which is what keeps a re-sync idempotent for a migrated edge (cor:dmo:060:03).
 *
 * The migrated spelling includes the backfill's own collision suffix (`<migrated>:2`, `:3`...).
 *
 * Precedence, so no existing behavior moves: a row at the runtime spelling always wins; the migrated spelling is used
 * only when no row holds the runtime one AND the row there is the same edge: same name, same source, same target. A
 * different edge that merely owns the migrated loc (an edge literally named `a-b` for the name `a😀b`) is never
 * taken for it. Soft-deleted rows count, as for the primary spelling: the (loc, memory) unique is unfiltered, so the
 * caller's existing occupant checks must reach them.
 *
 * Never writes, never rewrites a loc, and reads nothing for a name with a single spelling.
 *
 * The selection is made BEFORE the caller's upsert and may go stale (another writer between the two). That is safe
 * because every caller's upsert is `update: {}` followed by the occupant check on the returned row (live, same
 * source, same target, same name) inside the same transaction, which refuses an occupant that is not this edge: a
 * stale selection degrades to the refusal each caller already had for an occupied loc, never to a wrong write. Both
 * spellings stay distinct locs, so it cannot create a (loc, memory) collision.
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
  if (rows.some((r) => r.loc === primary)) return primary;
  const rank = (loc: string): number | null => {
    for (const a of alternates) {
      if (loc === a) return 0;
      const suffix = loc.startsWith(`${a}:`) ? loc.slice(a.length + 1) : '';
      if (/^[0-9]+$/.test(suffix) && Number(suffix) >= 2) return Number(suffix);
    }
    return null;
  };
  // The same edge only: same name, source and target. The unsuffixed loc wins over a suffixed one, a lower suffix over
  // a higher one, so the choice is deterministic.
  const same = rows
    .filter((r) => r.name === (edge.name ?? null) && r.sourceId === edge.sourceId && r.targetId === edge.targetId)
    .map((r) => ({ loc: r.loc, rank: rank(r.loc) }))
    .filter((r): r is { loc: string; rank: number } => r.rank !== null)
    .sort((x, y) => x.rank - y.rank)[0];
  return same ? same.loc : primary;
}
