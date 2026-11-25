/**
 * #5128 (cor:api:190:01, Holger 2026-11-25): a subtree move of more than N nodes is refused at once, before any write,
 * with a typed refusal naming N and the subtree's count. N defaults to 5,000 and a deployment may change it. It covers
 * every subtree move, within one memory and across, through GraphQL `moveNode`, `planNodeMove` and MCP `hadron_move_node`.
 *
 * The check is a bare COUNT, run AFTER the caller's read and write gates (the callers place it there), so it tells a
 * caller nothing about a subtree they could not already move (acceptance 7: no size oracle).
 *
 * `MOVE_NODE_MAX_NODES`: a plain positive integer up to 10,000,000. Anything else (unset, empty, signed, fractional,
 * exponent, hex, zero, above the ceiling) falls back to 5,000, so a typo can neither switch the limit off nor refuse
 * every move. Read per call.
 */
import type { Prisma } from '../generated/prisma/index.js';

export const MOVE_NODE_MAX_NODES_DEFAULT = 5_000;
export const MOVE_NODE_MAX_NODES_CEILING = 10_000_000;

export function moveNodeMaxNodes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MOVE_NODE_MAX_NODES;
  if (raw !== undefined && /^[1-9][0-9]{0,7}$/.test(raw)) {
    const n = Number(raw);
    if (n <= MOVE_NODE_MAX_NODES_CEILING) return n;
  }
  return MOVE_NODE_MAX_NODES_DEFAULT;
}

/** The subtree to move has more nodes than the deployment's limit. Nothing was written. */
export class SubtreeMoveTooLargeError extends Error {
  constructor(public readonly limit: number, public readonly count: number) {
    super(`This move covers ${count} nodes, more than the limit of ${limit} nodes for one move. Nothing was moved. Move it in smaller parts.`);
    this.name = 'SubtreeMoveTooLargeError';
  }
}

/**
 * Throw `SubtreeMoveTooLargeError` when the source node and its live descendants number more than the limit. Counts at
 * most limit + 1 rows' worth only in the sense of cost: it is one COUNT on the loc-prefix index, never a row read.
 */
export async function assertMoveWithinSizeLimit(
  tx: Prisma.TransactionClient,
  source: { id: string; memoryId: string; loc: string },
): Promise<void> {
  const limit = moveNodeMaxNodes();
  const descendants = await tx.node.count({
    where: { memoryId: source.memoryId, deletedAt: null, loc: { startsWith: `${source.loc}:` } },
  });
  const count = descendants + 1;
  if (count > limit) throw new SubtreeMoveTooLargeError(limit, count);
}
