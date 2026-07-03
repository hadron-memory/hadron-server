// edgeQueries — the uniform Edge read surface (#473). Edges are first-class,
// loc-addressed peers of nodes (spec 037); until now they had no top-level
// find-one/find-many queries (only the slim graph-view memoryEdges).
import { resolveEdgeRef } from '../../../lib/entityRef/edgeRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { EdgeNotFoundError } from '../../../lib/entityRef/errors.js';
import {
  type Context,
  clampListTake,
  getAccessibleMemoryIds,
  memoryAccessFilter,
  resolveOrgScope,
} from './resolvers.helpers.js';

export interface EdgeFilterInput {
  memoryId?: string | null;
  sourceNodeId?: string | null;
  targetNodeId?: string | null;
  isRunnable?: boolean | null;
  includeDeleted?: boolean | null;
}

export const edgeQueries = {
  // Uniform single-edge read: ref = PK | hrn:edge:<memory-urn>::<loc>.
  // Access: the edge's (denormalized, source-side) memory must be readable.
  // Denied ≡ not-found (null) — same non-disclosure posture as node(ref:).
  edge: async (_: unknown, { ref }: { ref: string }, ctx: Context) => {
    let id: string;
    try {
      ({ id } = await resolveEdgeRef(ctx.db, ref));
    } catch (e) {
      // A genuine miss is null; a malformed URN (UrnNotQualifiedError) or an
      // unexpected DB error propagates rather than masking as not-found.
      if (e instanceof EdgeNotFoundError) return null;
      throw e;
    }
    const edge = await ctx.db.edge.findUnique({ where: { id } });
    if (!edge || edge.deletedAt) return null;
    const access = await memoryAccessFilter(ctx);
    if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
      if (!(access.memoryId.in as string[]).includes(edge.memoryId)) return null;
    }
    return edge;
  },

  // Uniform paginated edge list. Scope: the caller's readable memories,
  // AND-narrowed by the filter and the cor:api:100:01 orgId scope. Every
  // unresolvable filter ref collapses to an empty page (no existence
  // disclosure — consistent with the orgId contract on this surface).
  edges: async (
    _: unknown,
    {
      filter,
      orgId,
      limit,
      offset,
    }: {
      filter?: EdgeFilterInput | null;
      orgId?: string | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ) => {
    const empty = { items: [], total: 0 };
    const f = filter ?? {};

    const scope = await resolveOrgScope(ctx, orgId);
    if (!scope) return empty;

    const accessible = await getAccessibleMemoryIds(ctx);

    // Memory clause: readable set ∩ filter.memoryId ∩ org scope.
    let memoryWhere: Record<string, unknown>;
    if (f.memoryId != null) {
      let resolvedMemoryId: string;
      try {
        ({ id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, f.memoryId));
      } catch {
        return empty;
      }
      if (accessible !== null && !accessible.includes(resolvedMemoryId)) return empty;
      memoryWhere = { memoryId: resolvedMemoryId };
    } else if (accessible !== null) {
      memoryWhere = { memoryId: { in: accessible } };
    } else {
      memoryWhere = {};
    }
    if (scope.scopedOrgId) {
      memoryWhere = { ...memoryWhere, memory: { organizationId: scope.scopedOrgId } };
    }

    // Endpoint clauses — node refs accept PK or fully-qualified URN.
    let endpointWhere: Record<string, unknown> = {};
    if (f.sourceNodeId != null) {
      try {
        const { id } = await resolveNodeRef(ctx.db, f.sourceNodeId);
        endpointWhere = { ...endpointWhere, sourceId: id };
      } catch {
        return empty;
      }
    }
    if (f.targetNodeId != null) {
      try {
        const { id } = await resolveNodeRef(ctx.db, f.targetNodeId);
        endpointWhere = { ...endpointWhere, targetId: id };
      } catch {
        return empty;
      }
    }

    const where = {
      ...memoryWhere,
      ...endpointWhere,
      ...(f.isRunnable != null ? { isRunnable: f.isRunnable } : {}),
      ...(f.includeDeleted ? {} : { deletedAt: null }),
    };

    const take = clampListTake(limit);
    const skip = Math.max(0, offset ?? 0);
    const [total, items] = await Promise.all([
      ctx.db.edge.count({ where }),
      take === 0
        ? Promise.resolve([])
        : ctx.db.edge.findMany({
            where,
            // loc is unique per memory; the id tiebreak keeps cross-memory
            // pages deterministic too.
            orderBy: [{ loc: 'asc' }, { id: 'asc' }],
            skip,
            take,
          }),
    ]);
    return { items, total };
  },
};
