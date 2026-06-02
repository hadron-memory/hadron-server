/**
 * Spec 033 US3 — shared search helpers used by both the MCP h-find-nodes
 * surface (`src/mcp/server.ts`) and the GraphQL nodeSearch resolver
 * (`src/api/graphql/schema/resolvers.ts`).
 *
 * Lives in `src/lib/` (no MCP / GraphQL deps) so both consumers can import
 * from a leaf module — extracted in PR-223 review to break the circular
 * dependency that was forming once GraphQL started consuming the helpers
 * (mcp/server.ts already imports from resolvers.ts via the chat tools).
 */

import type { PrismaClient } from '../generated/prisma/index.js';

/**
 * Substring match across name + loc + description + tags. The keyword
 * search predicate for h-find-nodes.
 *
 * Issue #170: `*` and trimmed-empty are "match all" — without this an
 * agent surveying a memory will reasonably try `query: "*"` first, get
 * "No nodes found", and proceed to write over an existing tree.
 */
export function matchesQuery(
  node: { name: string; loc: string; description: string | null; tags: string[] },
  query: string,
): boolean {
  const trimmed = query.trim();
  if (trimmed === '' || trimmed === '*') return true;
  const terms = trimmed.toLowerCase().split(/\s+/);
  const haystack = [node.name, node.loc, node.description || '', ...node.tags]
    .join(' ')
    .toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/**
 * Spec 033 US3 (T048) — re-rank keyword hits by relevance signal so RRF
 * fusion isn't biased by the default alphabetical-by-loc order from
 * `db.node.findMany`. Today's `mode:keyword` (default) path renders
 * results in DB order for stability; this helper feeds the RRF input
 * only on the hybrid path.
 *
 * Signal ordering per contracts/h-find-nodes.md:
 *   1. Distinct query terms matched (desc) — does the node hit MORE of
 *      the query? Strong indicator.
 *   2. Total term frequency across the haystack (desc) — secondary
 *      relevance signal for ties on (1).
 *   3. `loc` ascending — deterministic tiebreak so the same input
 *      always produces the same output.
 *
 * The haystack mirrors `matchesQuery` (name + loc + description + tags).
 * Query is lowercased + split on whitespace; empty/`*` query maps to no
 * terms and the function returns the input unchanged.
 */
export function keywordRelevanceRank<
  T extends { name: string; loc: string; description: string | null; tags: string[] },
>(nodes: T[], query: string): T[] {
  const trimmed = query.trim();
  if (trimmed === '' || trimmed === '*') return [...nodes];
  const terms = trimmed.toLowerCase().split(/\s+/).filter(Boolean);
  return [...nodes]
    .map((node) => {
      const haystack = [node.name, node.loc, node.description || '', ...node.tags]
        .join(' ')
        .toLowerCase();
      let distinctMatches = 0;
      let totalFreq = 0;
      for (const term of terms) {
        const occurrences = haystack.split(term).length - 1;
        if (occurrences > 0) distinctMatches += 1;
        totalFreq += occurrences;
      }
      return { node, distinctMatches, totalFreq };
    })
    .sort((a, b) => {
      if (a.distinctMatches !== b.distinctMatches) return b.distinctMatches - a.distinctMatches;
      if (a.totalFreq !== b.totalFreq) return b.totalFreq - a.totalFreq;
      return a.node.loc.localeCompare(b.node.loc);
    })
    .map((entry) => entry.node);
}

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
