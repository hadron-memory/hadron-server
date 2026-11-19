/**
 * #3113 (`cor:api:090:02`) — `NodeFilter.nodeTypes`: an explicit list of node
 * types, a union.
 *
 * ONE validator for every consumer (findNodes, appNodes, and the MCP tool before
 * it reaches the resolver), so no surface can take a second reading of the rule:
 *
 *   - `null` / omitted: no list, nothing changes;
 *   - `[]`: refused (a list that names nothing is a mistake, not "no filter");
 *   - set together with the singular `nodeType` (an empty string counts as set):
 *     refused, never "the singular wins";
 *   - more than {@link MAX_NODE_TYPES} supplied entries, counted BEFORE
 *     de-duplication: refused;
 *   - an entry that is not a string: refused;
 *   - an entry equal to `comment`: refused, with or without `contentScope`;
 *     comments are searched with the singular `nodeType` or `contentScope`
 *     (`cor:dmo:110:08`), which keep their meaning;
 *   - otherwise the exact, case-sensitive values, de-duplicated. No trimming, no
 *     lower-casing and no vocabulary check: an unknown value matches nothing.
 *
 * Refusals name the field and never echo a supplied value.
 */
import { COMMENT_NODE_TYPE } from '../comments/index.js';

export const MAX_NODE_TYPES = 20;

/** A refusal of the `nodeTypes` shape; surfaces map it to BAD_USER_INPUT / a tool refusal. */
export class NodeTypesFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeTypesFilterError';
  }
}

/**
 * The validated, de-duplicated list, or `null` when the filter carries none.
 * Pure and side-effect free, so it can run before admission, scope resolution
 * and any early return.
 */
export function checkNodeTypesFilter(
  filter: { nodeType?: string | null; nodeTypes?: readonly unknown[] | null } | null | undefined,
  surface: string,
): string[] | null {
  const list = filter?.nodeTypes;
  if (list == null) return null;
  const fail = (what: string) => new NodeTypesFilterError(`${surface}: filter.nodeTypes ${what}`);
  if (!Array.isArray(list)) throw fail('must be a list of node types.');
  if (filter?.nodeType != null) throw fail('cannot be combined with filter.nodeType; pass one of the two.');
  if (list.length === 0) throw fail('must name at least one node type; omit it to apply no node-type list.');
  if (list.length > MAX_NODE_TYPES) throw fail(`accepts at most ${MAX_NODE_TYPES} entries.`);
  for (const entry of list) if (typeof entry !== 'string') throw fail('entries must be strings.');
  if (list.includes(COMMENT_NODE_TYPE)) {
    throw fail('cannot list the comment node type; search comments with filter.nodeType or filter.contentScope.');
  }
  return [...new Set(list as string[])];
}
