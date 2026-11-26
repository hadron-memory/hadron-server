// edgeQueries — the uniform Edge read surface (#473). Edges are first-class,
// loc-addressed peers of nodes (spec 037); until now they had no top-level
// find-one/find-many queries (only the slim graph-view memoryEdges).
import { resolveEdgeRef } from '../../../lib/entityRef/edgeRef.js';
import { resolveMemoryRef } from '../../../lib/entityRef/memoryRef.js';
import { resolveNodeRef } from '../../../lib/entityRef/nodeRef.js';
import { EdgeNotFoundError } from '../../../lib/entityRef/errors.js';
import { edgeWithin, listableMemories } from './resolvers.nodeBatchEdges.js';
import {
  type Context,
  clampListTake,
  getAccessibleMemoryIds,
  memoryAccessFilter,
  resolveOrgScope,
} from './resolvers.helpers.js';

export interface EdgeFilterInput {
  memoryRef?: string | null;
  sourceRef?: string | null;
  targetRef?: string | null;
  isRunnable?: boolean | null;
  includeDeleted?: boolean | null;
}

export const edgeQueries = {
  // Uniform single-edge read: ref = PK | hrn:edge:<memory-urn>::<loc>.
  // Access: the edge's (denormalized, source-side) memory and the memory of each end must be readable (hadron-internal#79).
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
    const row = await ctx.db.edge.findUnique({ where: { id }, include: { source: { select: { memoryId: true } }, target: { select: { memoryId: true } } } });
    if (!row || row.deletedAt) return null;
    const { source, target, ...edge } = row;
    const access = await memoryAccessFilter(ctx);
    if (access.memoryId && typeof access.memoryId === 'object' && 'in' in access.memoryId) {
      if (!(access.memoryId.in as string[]).includes(edge.memoryId)) return null;
    }
    const touched = [edge.memoryId, source.memoryId, target.memoryId];
    const listable = await listableMemories(null, ctx, touched);
    if (!touched.every((memoryId) => listable.has(memoryId))) return null;
    return edge;
  },

  // Uniform paginated edge list. Scope: the caller's readable memories,
  // AND-narrowed by the filter and the cor:api:100:01 orgRef scope. Every
  // unresolvable filter ref collapses to an empty page (no existence
  // disclosure — consistent with the orgRef contract on this surface).
  edges: async (
    _: unknown,
    {
      filter,
      orgRef,
      limit,
      offset,
    }: {
      filter?: EdgeFilterInput | null;
      orgRef?: string | null;
      limit?: number | null;
      offset?: number | null;
    },
    ctx: Context,
  ) => {
    const empty = { items: [], total: 0 };
    const f = filter ?? {};

    const scope = await resolveOrgScope(ctx, orgRef);
    if (!scope) return empty;

    const accessible = await getAccessibleMemoryIds(ctx);

    // Memory clause: readable set ∩ filter.memoryRef ∩ org scope.
    let memoryWhere: Record<string, unknown>;
    if (f.memoryRef != null) {
      let resolvedMemoryId: string;
      try {
        ({ id: resolvedMemoryId } = await resolveMemoryRef(ctx.db, f.memoryRef));
      } catch {
        return empty;
      }
      if (!accessible.includes(resolvedMemoryId)) return empty;
      memoryWhere = { memoryId: resolvedMemoryId };
    } else {
      memoryWhere = { memoryId: { in: accessible } };
    }
    if (scope.scopedOrgId) {
      memoryWhere = { ...memoryWhere, memory: { organizationId: scope.scopedOrgId } };
    }

    // Endpoint clauses — node refs accept PK or fully-qualified URN.
    // One outside the readable set is answered as one that does not resolve (hadron-internal#79).
    const readable = new Set(accessible);
    let endpointWhere: Record<string, unknown> = {};
    for (const [ref, key] of [[f.sourceRef, 'sourceId'], [f.targetRef, 'targetId']] as const) {
      if (ref == null) continue;
      let id: string;
      try {
        ({ id } = await resolveNodeRef(ctx.db, ref));
      } catch {
        return empty;
      }
      const node = await ctx.db.node.findUnique({ where: { id }, select: { memoryId: true } });
      if (!node || !readable.has(node.memoryId)) return empty;
      endpointWhere = { ...endpointWhere, [key]: id };
    }

    const where = {
      ...memoryWhere,
      ...endpointWhere,
      ...(f.isRunnable != null ? { isRunnable: f.isRunnable } : {}),
      ...(f.includeDeleted ? {} : { deletedAt: null }),
      // The readable set is `listableMemories`' own gate (getAccessibleMemoryIds), asked once for the whole list. It is never narrowed.
      AND: [edgeWithin(accessible, ['source', 'target'])],
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
