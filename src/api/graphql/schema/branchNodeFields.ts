/**
 * #5412 section 5 (gate rulings issuecomment-7238580841 conditions 5, issuecomment-7238581276 condition 2): what a node read
 * ONLY through a `branch` grant carries. The node surfaces admit such a node inside its branch, but nothing reachable FROM it may
 * carry the rest of the memory: other nodes (edges, references, comments, inheritance), the memory record, revisions, or the
 * memory's attribution, approval, signing and validation records.
 *
 * Every `Node` field is classified once, here: {@link BRANCH_GUARDED_FIELDS} answer their empty value for a branch-only node, and
 * {@link BRANCH_OWN_FIELDS} are the node's own stored columns (or a pure derivation of them) and resolve as usual. The drift pin
 * (`branchNodeFields5412.test.ts`) fails on a `Node` field in neither map, so a field added later is decided before it ships.
 *
 * A node is branch-only when its memory is a key of the caller's {@link nodeBranchScopes} map, which never holds a memory the
 * caller also reads whole; every other node resolves exactly as before.
 */
import { validateListPageInput } from '../../../lib/listPage.js';
import { isBranchOnlyMemory, type Context } from './resolvers.helpers.js';

type FieldResolver = (parent: any, args?: any, ctx?: any, info?: any) => unknown;

/** Node field → what a branch-only node answers instead of its resolver's value. */
const GUARDED: Record<string, (parent: any, args?: any) => unknown> = {
  // Other nodes and the memory record.
  memory: () => null,
  outgoingEdges: () => [],
  incomingEdges: () => [],
  inheritedFrom: () => null,
  asComment: () => null,
  asset: () => null,
  actionUrn: () => null,
  moveLinkWarnings: () => null,
  moveEdgeUrnChanges: () => null,
  lintWarnings: () => null, // link lint reports which linked nodes exist and can be read
  commentSummary: () => ({ openThreads: 0, resolvedThreads: 0, comments: 0, viewerOpenThreadId: null, oldestOpenThreadAt: null }),
  // Revisions and the records kept about them (closed surfaces for a branch-only memory).
  revisionBytes: () => null,
  authorship: () => null,
  createdByWorker: () => null,
  createdByAgent: () => null,
  updatedByWorker: () => null,
  updatedByAgent: () => null,
  updatedByUser: () => null,
  createdByUser: () => null,
  approvalStatus: () => ({ state: 'NOT_APPLICABLE', approval: null }),
  mintStatus: () => ({ minted: false, mintedAt: null, mintedBy: null, mintedByInfo: null, revision: null, hash: null }),
  signatureStatus: () => ({ state: null, signatures: [], integrityProblems: 0 }),
  signingRequests: () => [],
  signingRequestsPage: (_parent, args) => {
    validateListPageInput(args ?? {});
    return { items: [], total: 0, hasMore: false, nextCursor: null };
  },
  contentValidation: () => ({ state: 'UNVALIDATED', latestReport: null }),
  validationTasks: () => null,
  // The stored text only: include tags are not resolved (an include can read any node of the memory).
  content: (parent) => parent?.content ?? null,
};

/** The guarded fields, for the drift pin. */
export const BRANCH_GUARDED_FIELDS: readonly string[] = Object.keys(GUARDED);

/** What a branch-only node answers for a guarded field (the per-field pins compare the served resolver against it). */
export function branchGuardedValue(field: string, parent: unknown, args?: unknown): unknown {
  return GUARDED[field]!(parent, args);
}

/** Node fields a branch-only node serves as usual, each with the reason: its own stored columns, or derived from them alone. */
export const BRANCH_OWN_FIELDS: Readonly<Record<string, string>> = {
  id: 'the row', memoryId: 'the row (the memory the grant names)', loc: 'the row (inside the branch)', deletedAt: 'the row (always null: tombstones are not served)',
  urn: "the memory's address (the grant names it) and the node's loc", portalUrl: 'derived from urn',
  nodeType: 'the row', objectType: 'the row', isPlaceholder: 'the row', isLink: 'the row', name: 'the row', alias: 'the row',
  description: 'the row', abstract: 'the row', abstractOriginHash: 'the row', tokens: 'the row', tags: 'the row', properties: 'the row',
  data: 'the row', seq: 'the row', ownerRepo: 'the row', isRunnable: 'the row', role: 'the row', llmModel: 'the row', aiAgent: 'the row',
  createdAt: 'the row', updatedAt: 'the row',
  embeddingPendingAt: 'the row', embeddingFailedAt: 'the row', embeddingError: 'the row', embeddingAttempts: 'the row',
  indexTruncated: "this node's own chunk count", storedBytes: "this node's own size (#5018)",
  revision: "this node's own revision counter (reconciled from its own row)",
  specLint: 'pure over the stored text of this node',
};

/**
 * Wrap the merged `Node` resolvers: a guarded field answers its empty value for a branch-only node and resolves as before for any
 * other node. Applied innermost-out alongside `withInstallConcealment`.
 */
export function withBranchNodeGuard<T extends Record<string, any>>(node: T): T {
  const out: Record<string, FieldResolver> = { ...node };
  for (const [field, empty] of Object.entries(GUARDED)) {
    const original: FieldResolver = node[field] ?? ((parent) => parent?.[field]);
    out[field] = async (parent, args, ctx: Context, info) => {
      if (parent?.memoryId && ctx && (await isBranchOnlyMemory(ctx, parent.memoryId))) return empty(parent, args);
      return original(parent, args, ctx, info);
    };
  }
  return out as T;
}
