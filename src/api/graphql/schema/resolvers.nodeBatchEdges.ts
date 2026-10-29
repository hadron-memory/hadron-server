import { GraphQLError } from 'graphql';
import { BATCH_READ_MAX_EDGES } from '../../../lib/batchRead.js';
import type { Context } from './resolvers.helpers.js';
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

export function batchReadEdges(parent: Parent, ctx: Context, direction: 'out' | 'in'): unknown {
  const field = direction === 'out' ? 'outgoingEdges' : 'incomingEdges';
  return loadBatchReadEdges(parent, direction, (remaining) => ctx.db.edge.findMany({
    where: direction === 'out'
      ? { sourceId: parent.id, source: { memoryId: parent.memoryId, deletedAt: null } }
      : { targetId: parent.id, target: { memoryId: parent.memoryId, deletedAt: null } },
    take: remaining + 1,
  })) ?? parent[field];
}
