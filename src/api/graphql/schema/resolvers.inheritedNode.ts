/**
 * #1885 (cor:dmo:050:14) — what an inherited node shows its reader.
 *
 * An inherited node is a base Agent's node read through a child's system
 * memory, by someone who may read the child's and need hold no access to the
 * base's (ruling 4). Its content is the child's effective memory, so it is
 * returned. Its other fields are the BASE tenant's records, and their
 * resolvers assume the node's own memory was gated before they run: a
 * same-memory edge's endpoint is loaded unchecked (resolveEdgeEndpoint), the
 * memory resolver loads the base Memory row, approvals and signatures name the
 * base tenant's people. Read through the child, those would hand out exactly
 * the "base's other content" the rule forbids, an overridden node among them
 * (AGENTS.md: relaxing a read gate re-derives the field surface it admits).
 *
 * So every Node field that returns another object, or names a person, reads
 * as empty on a node stamped `inheritedFrom`: no edges, no memory, no
 * authorship or actor refs, no comments, no signing requests, no asset; a
 * status keeps its state (an approved, minted or signed node says so) and
 * drops who and the records behind it. Wrapping the merged Node resolver map,
 * rather than each surface, keeps one place for it: a field added later is
 * either listed here or reviewed against this list.
 *
 * Inherited edges (a base's edges resolved through the child, the way #10932
 * resolves its bare-loc links) are a follow-up; until then an inherited node
 * reads as having none.
 */

type Resolver = (parent: any, args?: any, ctx?: any, info?: any) => unknown;

const none = () => null;
const empty = () => [];

/** Field → what an inherited node returns, given the field's normal value. */
const INHERITED_PROJECTION: Record<string, (value: () => Promise<any>) => unknown> = {
  memory: none,
  outgoingEdges: empty,
  incomingEdges: empty,
  moveLinkWarnings: none,
  authorship: none,
  createdByWorker: none,
  createdByAgent: none,
  updatedByWorker: none,
  updatedByAgent: none,
  asComment: none,
  asset: none,
  signingRequests: empty,
  commentSummary: () => ({ openThreads: 0, resolvedThreads: 0, comments: 0, viewerOpenThreadId: null }),
  approvalStatus: async (value) => {
    const s = await value();
    return { state: s.state, approval: null };
  },
  mintStatus: async (value) => {
    const s = await value();
    return { ...s, mintedBy: null, mintedByInfo: null };
  },
  signatureStatus: async (value) => {
    const s = await value();
    return { state: s.state, signatures: [], integrityProblems: s.integrityProblems };
  },
  contentValidation: async (value) => {
    const s = await value();
    return { state: s.state, latestReport: null };
  },
};

/** The fields {@link withInheritedNodeProjection} covers, for the drift pin. */
export const INHERITED_PROJECTION_FIELDS = Object.keys(INHERITED_PROJECTION);

/** Wrap the merged Node resolver map with the inherited projection. */
export function withInheritedNodeProjection<T extends Record<string, any>>(node: T): T {
  const out: Record<string, Resolver> = { ...node };
  for (const [field, project] of Object.entries(INHERITED_PROJECTION)) {
    const original: Resolver = node[field] ?? ((parent) => parent[field]);
    out[field] = (parent, args, ctx, info) =>
      parent?.inheritedFrom
        ? project(async () => original(parent, args, ctx, info))
        : original(parent, args, ctx, info);
  }
  return out as T;
}
