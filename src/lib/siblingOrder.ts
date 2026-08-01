/**
 * The guided-reading-order comparator (#817), shared by the GraphQL `nextNode`
 * query and the MCP `hadron_get_next_node` tool.
 *
 * Extracted after PR #857 review (Codex P2): the two surfaces were ordering by
 * different rules and could disagree. GraphQL sorted in SQL, so ties fell to
 * the DATABASE COLLATION, while the MCP tool sorted in JS with
 * `localeCompare`. On a C-collation Postgres, SQL puts `A` before `a` while
 * `localeCompare` puts `a` before `A` — and `SEGMENT_RE` in validateLoc.ts
 * permits both cases (`[a-zA-Z0-9]`), so the traversal chain could change when
 * a client switched surfaces. One comparator makes that impossible by
 * construction rather than by convention.
 *
 * The rules, unchanged from the original MCP implementation:
 *   - `seq` ascending;
 *   - a NULL `seq` sorts LAST, after every explicitly ordered sibling;
 *   - ties (equal seq, or two nulls) break on `loc` via `localeCompare`.
 */

export interface OrderableSibling {
  loc: string;
  seq: number | null;
}

/** Array.prototype.sort comparator for sibling reading order. */
export function compareSiblings(a: OrderableSibling, b: OrderableSibling): number {
  if (a.seq !== null && b.seq !== null) {
    return a.seq - b.seq || a.loc.localeCompare(b.loc);
  }
  if (a.seq !== null) return -1;
  if (b.seq !== null) return 1;
  return a.loc.localeCompare(b.loc);
}

/** Sort a copy into reading order. */
export function sortSiblings<T extends OrderableSibling>(siblings: readonly T[]): T[] {
  return [...siblings].sort(compareSiblings);
}
