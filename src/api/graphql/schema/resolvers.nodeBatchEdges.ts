import { GraphQLError } from 'graphql';
import { BATCH_READ_MAX_EDGES } from '../../../lib/batchRead.js';
import { edgeDisplayOrder } from '../../../lib/edgeOrder.js';
import { isMemoryReadableCached, loadEdgeEndpointNode, type Context } from './resolvers.helpers.js';
import type { Edge } from '../../../generated/prisma/index.js';
import type { InheritedFrom } from '../../../lib/effectiveSystemMemory.js';

type Parent = { id: string; memoryId: string; outgoingEdges?: unknown; incomingEdges?: unknown };
type Budget = { remaining: number; pending: Map<string, Promise<Edge[]>>; tail: Promise<void>; failed: boolean; failure?: unknown };
const budgets = new WeakMap<object, Budget>();
type EndpointIdentity = { id: string; memoryId: string; loc: string; deletedAt: Date | null; role?: string | null; inheritedFrom?: InheritedFrom };
const inheritedEndpoints = new WeakMap<object, Partial<Record<'source' | 'target', { endpoint: EndpointIdentity; via: string }>>>();

export function markBatchInheritedEndpoint(edge: object, side: 'source' | 'target', endpoint: EndpointIdentity, via: string): void {
  const refs = inheritedEndpoints.get(edge) ?? {};
  refs[side] = { endpoint, via };
  inheritedEndpoints.set(edge, refs);
}
export function batchInheritedEndpoint(edge: object, side: 'source' | 'target') {
  return inheritedEndpoints.get(edge)?.[side];
}

export function batchReadEdgeLimit(parent: object): number | undefined {
  return budgets.get(parent)?.remaining;
}

export function batchReadEdgeOverflow(): never {
  throw new GraphQLError(`nodeBatch: more than ${BATCH_READ_MAX_EDGES} selected edges exceeds the edge cap. Read edges in pages with edges(filter, limit, offset).`, {
    extensions: { code: 'BAD_USER_INPUT', limit: 'edges', max: BATCH_READ_MAX_EDGES },
  });
}

export function chargeBatchReadEdges(parent: object, count: number): void {
  const budget = budgets.get(parent);
  if (!budget) return;
  if (count > budget.remaining) batchReadEdgeOverflow();
  budget.remaining -= count;
}

/** One serialized allocation lane per batch, shared by nodes, directions and aliases. */
export function loadBatchReadEdges(parent: Parent, direction: 'out' | 'in', load: (remaining: number) => Promise<Edge[]>): Promise<Edge[]> | undefined {
  const budget = budgets.get(parent);
  if (!budget) return undefined;
  const key = `${direction}:${parent.id}:${parent.memoryId}`;
  let pending = budget.pending.get(key);
  if (!pending) {
    pending = budget.tail.then(async () => {
      if (budget.failed) throw budget.failure;
      try {
        // Only this loader can allocate against the remaining budget until it
        // charges. One extra row detects overflow; queued fields then stop.
        const rows = await load(budget.remaining);
        chargeBatchReadEdges(parent, rows.length);
        return rows;
      } catch (error) {
        budget.failed = true;
        budget.failure = error;
        throw error;
      }
    });
    budget.tail = pending.then(() => undefined, () => undefined);
    budget.pending.set(key, pending);
  }
  return pending;
}

export function markBatchReadNodes(nodes: object[]): void {
  const budget: Budget = { remaining: BATCH_READ_MAX_EDGES, pending: new Map(), tail: Promise.resolve(), failed: false };
  for (const node of nodes) budgets.set(node, budget);
}

/**
 * Memories the read that returned a node admitted beyond the node-content gate (`appNodes`, whose App scope is its own gate).
 * Only an explicit mark widens the list of a node's edges.
 */
const admittedMemories = new WeakMap<object, ReadonlySet<string>>();
export function markAdmittedMemories(nodes: object[], memoryIds: ReadonlySet<string>): void {
  for (const node of nodes) admittedMemories.set(node, memoryIds);
}

/**
 * Of `memoryIds`, those whose edges and nodes may be listed: one the reader may read, and for a list on a `parent` node also its own (the read
 * that returned it was gated) or an admitted one. The one predicate of the node lists, `edge` and `edges` (hadron-internal#79).
 */
export async function listableMemories(parent: Parent | null, ctx: Context, memoryIds: Iterable<string>): Promise<Set<string>> {
  const ids = [...new Set(memoryIds)];
  const ok = await Promise.all(ids.map((id) => id === parent?.memoryId || (parent && admittedMemories.get(parent)?.has(id)) || isMemoryReadableCached(ctx, id)));
  return new Set(ids.filter((_id, i) => ok[i]));
}

/** An edge held in one of `ids`, with each of `ends` in one of them. */
export const edgeWithin = (ids: string[], ends: ReadonlyArray<'source' | 'target'>) => ({
  memoryId: { in: ids }, ...Object.fromEntries(ends.map((end) => [end, { memoryId: { in: ids } }])),
});

/**
 * hadron-internal#74 (cor:api:140:03, cor:acl:010:02) — a node lists an edge when the reader may list both the memory that HOLDS the
 * edge and the memory of its far node ({@link listableMemories}); any other edge is absent, as in MCP. Every read of the two fields comes
 * here, batch or not, but an inherited node's, which `resolveInheritedEdges` answers with the same two questions over
 * its inheritance chain (no admitted set there). Both are asked: a stored `Edge.memoryId` is the source side,
 * and may differ from either end after a move.
 */
export async function batchReadEdges(parent: Parent, ctx: Context, direction: 'out' | 'in'): Promise<unknown> {
  const field = direction === 'out' ? 'outgoingEdges' : 'incomingEdges';
  const far = direction === 'out' ? 'target' : 'source';
  const where = direction === 'out'
    ? { sourceId: parent.id, source: { memoryId: parent.memoryId, deletedAt: null } }
    : { targetId: parent.id, target: { memoryId: parent.memoryId, deletedAt: null } };
  const pending = loadBatchReadEdges(parent, direction, async (remaining) => {
    // The filter is in the query, so a capped read counts and returns listed edges only. The grouping runs in the database.
    const [holderMemories, farMemories] = await Promise.all([
      ctx.db.edge.groupBy({ by: ['memoryId'], where }),
      ctx.db.node.groupBy({ by: ['memoryId'], where: direction === 'out' ? { incomingEdges: { some: where } } : { outgoingEdges: { some: where } } }),
    ]);
    const ids = [...await listableMemories(parent, ctx, [...holderMemories, ...farMemories].map((r) => r.memoryId))];
    return ctx.db.edge.findMany({
      where: { AND: [where, edgeWithin(ids, [far])] },
      // #2967 — order before the take, so the overflow probe sees the same edges in the same order
      // as the single `node` read (cor:api:040:01 parity).
      orderBy: edgeDisplayOrder(),
      take: remaining + 1,
    });
  });
  if (pending) return pending;
  const rows = parent[field] as Array<Edge & Partial<Record<'source' | 'target', { memoryId?: string } | null>>> | undefined;
  if (!rows?.length) return rows;
  const farIds = await Promise.all(rows.map(async (e) =>
    e[far]?.memoryId ?? (await loadEdgeEndpointNode(ctx, direction === 'out' ? e.targetId : e.sourceId, true) as { memoryId: string } | null)?.memoryId ?? null));
  const ids = await listableMemories(parent, ctx, [...rows.map((e) => e.memoryId), ...farIds.filter((id) => id !== null)]);
  return rows.filter((e, i) => ids.has(e.memoryId) && farIds[i] !== null && ids.has(farIds[i]));
}
