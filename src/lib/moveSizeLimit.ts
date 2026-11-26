/**
 * #5128 (cor:api:190:01, Holger 2026-11-25): a subtree move of more than N nodes is refused at once, before any write,
 * with a typed refusal naming N and the subtree's count. N defaults to 5,000 and a deployment may change it. It covers
 * every subtree move, within one memory and across, through GraphQL `moveNode`, `planNodeMove` and MCP `hadron_move_node`.
 *
 * The count is advisory, not a lock: it runs before the move's key-set locks, so a concurrent insert under the subtree can slip past
 * it (the move's own work is bounded by the ceiling either way). It is exact because the refusal names the subtree's count.
 *
 * The check is a bare COUNT, run AFTER the caller's read and write gates (the callers place it there), so it tells a
 * caller nothing about a subtree they could not already move (acceptance 7: no size oracle).
 *
 * #5230: the limit bounds size, not time. A move whose interactive transaction expires is rolled back and answers
 * `SubtreeMoveTimedOutError` (`isMoveTransactionExpired`).
 *
 * `MOVE_NODE_MAX_NODES`: a plain positive integer up to 30,000. The ceiling sits under Postgres's 32,767 bind-variable cap because the rest of the move still binds one id per moved node in single statements (occupant, comment-carry and other lookups): a higher limit would let a move pass the gate and then fail with a raw database message after its locks and reconcile work. The lookups whose binds follow edges or content links are chunked (#5128, #5230). Anything else (unset, empty, signed,
 * fractional, exponent, hex, zero, above the ceiling) falls back to 5,000, so a typo can neither switch the limit off nor
 * refuse every move; a set but invalid value warns once per process, without the value. Read per call.
 */
import { Prisma } from '../generated/prisma/index.js';

export const MOVE_NODE_MAX_NODES_DEFAULT = 5_000;
export const MOVE_NODE_MAX_NODES_CEILING = 30_000;

let warnedInvalid = false;

export function moveNodeMaxNodes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MOVE_NODE_MAX_NODES;
  if (raw !== undefined && /^[1-9][0-9]{0,4}$/.test(raw)) {
    const n = Number(raw);
    if (n <= MOVE_NODE_MAX_NODES_CEILING) return n;
  }
  if (raw !== undefined && !warnedInvalid) {
    warnedInvalid = true;
    console.warn(
      `move_node_max_nodes_env_invalid: MOVE_NODE_MAX_NODES must be an integer from 1 to ${MOVE_NODE_MAX_NODES_CEILING}; using ${MOVE_NODE_MAX_NODES_DEFAULT}`,
    );
  }
  return MOVE_NODE_MAX_NODES_DEFAULT;
}

/** The move's transaction expired. The database rolled it back, so nothing was written. */
export class SubtreeMoveTimedOutError extends Error {
  constructor() {
    super('The move ran out of time and was rolled back, so nothing was moved. Move it in smaller parts.');
    this.name = 'SubtreeMoveTimedOutError';
  }
}

/**
 * #5230: whether `error`, raised by the move's `$transaction` call, says the interactive transaction expired or was closed
 * under a running statement. Prisma raises P2028 for more than that, so the code alone is not the test: "Unable to start a
 * transaction in the given time" (the pool's `maxWait`) is not a slow move, and a query on a COMMITTED transaction must
 * never read as "nothing was moved".
 */
export function isMoveTransactionExpired(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2028' &&
    /Transaction already closed|Transaction not found/.test(error.message) &&
    !/on a committed transaction/.test(error.message)
  );
}

/** Run the move's transaction call, answering its expiry with `SubtreeMoveTimedOutError`. Wrap ONLY that call. */
export async function mapMoveExpiry<T>(transaction: () => Promise<T>): Promise<T> {
  try {
    return await transaction();
  } catch (error) {
    if (isMoveTransactionExpired(error)) throw new SubtreeMoveTimedOutError();
    throw error;
  }
}

/** The subtree to move has more nodes than the deployment's limit. Nothing was written. */
export class SubtreeMoveTooLargeError extends Error {
  constructor(public readonly limit: number, public readonly count: number) {
    super(`This move covers ${count} nodes, more than the limit of ${limit} nodes for one move (limit ${limit}, count ${count}). Nothing was moved. Move it in smaller parts.`);
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
