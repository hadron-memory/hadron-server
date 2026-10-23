import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { reconcileNodeWithIncludeHistory } from '../nodeRevisionSnapshot.js';
import { includeHistoryClient, withIncludeHistoryTransaction, type IncludeHistoryTransactionOptions } from './includeHistoryFence.js';

/**
 * Unchanged reads do not participate in history publication. Check the stored
 * fingerprint and fetch the authorized projection in ONE read-only RR snapshot:
 * a concurrent raw writer cannot turn the checked row into an unchecked body.
 * No row/advisory lock is taken on this path (including a missing-row refusal).
 *
 * Drift, including an uninitialized fingerprint, closes that transaction before
 * opening the exclusive first-statement fence. Authority and drift are checked
 * again there, with RC snapshots after the wait. Only this path can reconcile.
 * Callbacks must use the supplied client. Fast callbacks cannot write or lock;
 * the slow authorization callback may lock rows after taking the outer fence.
 */
export async function withReconciledNodeRead<T>(
  db: Pick<PrismaClient, '$transaction'>,
  nodeId: string,
  expectedMemoryId: string,
  authorize: (tx: Prisma.TransactionClient, mayReconcile: boolean) => Promise<boolean>,
  project: (tx: Prisma.TransactionClient) => Promise<T>,
  options: IncludeHistoryTransactionOptions = {},
): Promise<T | null> {
  const fast = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    const [row] = await tx.$queryRaw<Array<{ unchanged: boolean }>>`
      SELECT revision_content_hash IS NOT NULL
        AND revision_content_hash = hadron_node_revision_state_hash(n) AS unchanged
      FROM nodes n
      WHERE id = ${nodeId} AND memory_id = ${expectedMemoryId} AND deleted_at IS NULL`;
    if (!row) return { drift: false as const, value: null };
    if (!row.unchanged) return { drift: true as const };
    return { drift: false as const, value: await authorize(tx, false) ? await project(tx) : null };
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    timeout: options.timeoutMs ?? 5_000,
    maxWait: options.maxWaitMs ?? 2_000,
  });
  if (!fast.drift) return fast.value;
  return withIncludeHistoryTransaction(db, async (history) => {
    const tx = includeHistoryClient(history);
    if (!(await authorize(tx, true))) return null;
    if ((await reconcileNodeWithIncludeHistory(history, nodeId, { expectedMemoryId })) == null) return null;
    return project(tx);
  }, options);
}
