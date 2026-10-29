import { GraphQLError } from 'graphql';
import { BATCH_READ_MAX_EDGES } from '../../../lib/batchRead.js';
import type { Context } from './resolvers.helpers.js';
import type { Edge } from '../../../generated/prisma/index.js';

type Parent = { id: string; memoryId: string; outgoingEdges?: unknown; incomingEdges?: unknown };
type Budget = { remaining: number; pending: Map<string, Promise<Edge[]>> };
const budgets = new WeakMap<object, Budget>();

export function batchReadEdgeLimit(parent: object): number | undefined {
  return budgets.has(parent) ? BATCH_READ_MAX_EDGES : undefined;
}

export function batchReadEdgeOverflow(): never {
  throw new GraphQLError(`nodeBatch: selected edges exceed the ${BATCH_READ_MAX_EDGES}-edge cap. Read edges in pages instead.`, {
    extensions: { code: 'BAD_USER_INPUT', limit: 'edges', max: BATCH_READ_MAX_EDGES },
  });
}

export function chargeBatchReadEdges(parent: object, count: number): void {
  const budget = budgets.get(parent);
  if (!budget) return;
  if (count > budget.remaining) batchReadEdgeOverflow();
  budget.remaining -= count;
}

/** One budget per batch result, not per alias or Node field. No endpoint bodies are preloaded. */
export function markBatchReadNodes(nodes: object[]): void {
  const budget: Budget = { remaining: BATCH_READ_MAX_EDGES, pending: new Map() };
  for (const node of nodes) budgets.set(node, budget);
}

export function batchReadEdges(parent: Parent, ctx: Context, direction: 'out' | 'in'): unknown {
  const field = direction === 'out' ? 'outgoingEdges' : 'incomingEdges';
  const budget = budgets.get(parent);
  // Other Node surfaces retain their existing projections and inherited-node wrapper.
  if (!budget) return parent[field];
  const key = `${direction}:${parent.id}:${parent.memoryId}`;
  let pending = budget.pending.get(key);
  if (!pending) {
    pending = (async () => {
      const rows = await ctx.db.edge.findMany({
        where: direction === 'out'
          ? { sourceId: parent.id, source: { memoryId: parent.memoryId, deletedAt: null } }
          : { targetId: parent.id, target: { memoryId: parent.memoryId, deletedAt: null } },
        take: BATCH_READ_MAX_EDGES + 1,
      });
      chargeBatchReadEdges(parent, rows.length);
      return rows;
    })();
    budget.pending.set(key, pending);
  }
  return pending;
}
