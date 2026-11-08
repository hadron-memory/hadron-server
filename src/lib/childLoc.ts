/**
 * #2832 — the direct-children rule for `NodeFilter.childrenOf` (cor:api:090:02).
 *
 * A node's parent is derived from its `loc`, never stored: the direct children of `P`
 * are the locs that are exactly `P:<one segment>` (a segment holds no colon), and the
 * children of the root (`P` = "") are the locs with no colon at all. The rule reads
 * loc strings only. It never checks that a node exists at `P`, so a loc whose parent
 * has no node still counts as a child of that loc. Edges and `parentRel` play no part.
 */

/**
 * SQL for "the parent loc of `loc`": drops the last segment, and gives "" for a top-level
 * loc. The expression index `nodes_memory_parent_loc_idx` (migration
 * 20261030100000_nodes_parent_loc_index and prisma/post-push.sql) is built on EXACTLY this
 * text, so a filter must compare it unchanged for the planner to use the index.
 */
export const PARENT_LOC_SQL = "regexp_replace(loc, '(^|:)[^:]*$', '')";

/** The same rule in TypeScript, for re-asserting the filter on rows read back by id. */
export function isDirectChildLoc(loc: string, parent: string): boolean {
  if (loc === '') return false; // the mirror root's empty loc is nobody's child
  const cut = loc.lastIndexOf(':');
  return (cut === -1 ? '' : loc.slice(0, cut)) === parent;
}
