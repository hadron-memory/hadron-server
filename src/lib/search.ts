/**
 * Graph-neighbour expansion for node search — the `expand` (BFS) helper shared
 * by the GraphQL `findNodes` resolver and the MCP `hadron_find_nodes` surface.
 *
 * Lives in `src/lib/` (no MCP / GraphQL deps) so both consumers can import
 * from a leaf module — extracted in PR-223 review to break the circular
 * dependency that was forming once GraphQL started consuming the helpers.
 * (The legacy `matchesQuery` / `keywordRelevanceRank` keyword helpers lived
 * here too until PR3 removed the `nodes` / `nodeSearch` queries.)
 */

import type { PrismaClient } from '../generated/prisma/index.js';

/**
 * Spec 033 US3 (T049) — append undirected graph neighbors after the
 * ranked hits, unscored. BFS from the ranked-hit set up to `depth` hops,
 * traversing all edge types in both directions. Deduplicated against
 * the seed set and prior hops; scoped to live edges, live nodes, and
 * the supplied memory set.
 *
 * Returns the appended node IDs in BFS-traversal order. The caller
 * concatenates this onto the ranked-hits list; "unscored" in the
 * contract means literally "appended after, with no fused score" —
 * not "scored zero."
 *
 * Determinism: edge query carries `orderBy: [{ sourceId }, { targetId }]`
 * so a given seed-set + edge-set yields the same traversal order across
 * runs (Postgres makes no row-order guarantee without ORDER BY).
 *
 * Soft-delete handling: `edge.deletedAt: null` filters out tombstoned
 * edges so expansion can't traverse logically-deleted links (PR-223
 * review, Copilot).
 */
export async function expandWithNeighbors(
  db: PrismaClient,
  seedIds: string[],
  depth: number,
  memoryScope: { memoryIds?: string[] | null } = {},
): Promise<string[]> {
  if (depth <= 0 || seedIds.length === 0) return [];
  const seen = new Set<string>(seedIds);
  let frontier = new Set<string>(seedIds);
  const appended: string[] = [];
  for (let d = 0; d < depth; d++) {
    if (frontier.size === 0) break;
    const frontierIds = Array.from(frontier);
    const edges = await db.edge.findMany({
      where: {
        deletedAt: null,
        OR: [{ sourceId: { in: frontierIds } }, { targetId: { in: frontierIds } }],
      },
      select: { sourceId: true, targetId: true },
      orderBy: [{ sourceId: 'asc' }, { targetId: 'asc' }],
    });
    const candidateIds = new Set<string>();
    for (const e of edges) {
      if (!seen.has(e.sourceId)) candidateIds.add(e.sourceId);
      if (!seen.has(e.targetId)) candidateIds.add(e.targetId);
    }
    if (candidateIds.size === 0) {
      frontier = new Set<string>();
      continue;
    }
    // Filter to alive nodes within scope. memoryIds === null means
    // admin/all — no extra filter; explicit array gates by memory.
    const memWhere =
      memoryScope.memoryIds == null ? {} : { memoryId: { in: memoryScope.memoryIds } };
    const aliveNeighbors = await db.node.findMany({
      where: { id: { in: Array.from(candidateIds) }, deletedAt: null, ...memWhere },
      select: { id: true },
    });
    const aliveSet = new Set(aliveNeighbors.map((n) => n.id));
    const nextFrontier = new Set<string>();
    // Preserve BFS traversal order: iterate candidateIds in insertion order
    // (the order edges were emitted by findMany, deterministic via orderBy
    // above), keep only alive ones.
    for (const id of candidateIds) {
      if (aliveSet.has(id)) {
        seen.add(id);
        appended.push(id);
        nextFrontier.add(id);
      }
    }
    frontier = nextFrontier;
  }
  return appended;
}
