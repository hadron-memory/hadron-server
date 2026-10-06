/**
 * #1608 (`cor:dmo:110:08`) — which nodes a search or list returns, by kind:
 *
 *   - `CONTENT`  (the default): content only, never comments;
 *   - `COMMENTS`: comments only, never content;
 *   - `ALL`: both.
 *
 * Applied by the server as a predicate on the node set BEFORE ranking,
 * pagination and result caps, in every mode, so a comments-only search finds
 * every matching comment rather than the comments that happened to fall into
 * a page of general results.
 *
 * An explicit `nodeType: "comment"` filter with no scope means COMMENTS: it
 * asks for comments by name, and the content default would otherwise empty it.
 */
import { COMMENT_NODE_TYPE } from './index.js';

export type ContentScope = 'CONTENT' | 'COMMENTS' | 'ALL';

/** The scope a filter asks for, with the default applied. */
export function effectiveContentScope(filter: { contentScope?: ContentScope | null; nodeType?: string | null } | null | undefined): ContentScope {
  if (filter?.contentScope) return filter.contentScope;
  return filter?.nodeType === COMMENT_NODE_TYPE ? 'COMMENTS' : 'CONTENT';
}

/** The scope as a Prisma node predicate (null = no restriction). */
export function contentScopeWhere(scope: ContentScope): { nodeType: string | { not: string } } | null {
  if (scope === 'CONTENT') return { nodeType: { not: COMMENT_NODE_TYPE } };
  if (scope === 'COMMENTS') return { nodeType: COMMENT_NODE_TYPE };
  return null;
}

/** The scope as a SQL predicate over `nodes.node_type` (`alias` = the nodes table alias, if any). */
export function contentScopeSql(scope: ContentScope, alias = ''): string | null {
  const col = alias ? `${alias}.node_type` : 'node_type';
  if (scope === 'CONTENT') return `${col} <> '${COMMENT_NODE_TYPE}'`;
  if (scope === 'COMMENTS') return `${col} = '${COMMENT_NODE_TYPE}'`;
  return null;
}
