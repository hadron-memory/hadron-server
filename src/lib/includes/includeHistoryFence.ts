import { AsyncLocalStorage } from 'node:async_hooks';
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';

declare const prepared: unique symbol;

/**
 * #2063: proof that the outer transaction took the exclusive include-history
 * fence before any caller work. Only withIncludeHistoryTransaction creates
 * this context; nested helpers consume it rather than acquiring a late lock.
 */
export interface IncludeHistoryTransaction {
  readonly [prepared]: true;
}

const clients = new WeakMap<IncludeHistoryTransaction, {
  tx: Prisma.TransactionClient;
  expiresAt: number;
}>();
const current = new AsyncLocalStorage<IncludeHistoryTransaction>();

/** Obtain the SAME transaction client, refusing forged, raw or expired contexts before work. */
export function includeHistoryClient(context: IncludeHistoryTransaction): Prisma.TransactionClient {
  const state = context && clients.get(context);
  if (!state || performance.now() >= state.expiresAt) {
    throw new Error('A live prepared include-history transaction is required');
  }
  return state.tx;
}

/** Transaction budgets, including time waiting for the fence; no isolation or lock-mode override. */
export interface IncludeHistoryTransactionOptions {
  /** Prisma interactive-transaction lifetime, including the lock wait. Default 30 seconds. */
  timeoutMs?: number;
  /** Pool acquisition budget before the transaction starts. Default 5 seconds. */
  maxWaitMs?: number;
}

/** Fail before opening a transaction when a caller provides an invalid budget. */
function budget(value: number | undefined, fallback: number): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error('Include-history transaction budgets must be a positive safe integer');
  }
  return result;
}

/**
 * #2063 / hrn:node:hadronmemory.com:specs:cor:dmo:150:07: serialize include
 * publication, revision selection/qualification and pruning in one connection.
 *
 * The dedicated two-int advisory key (2063,1772) is exclusive and scoped to
 * this database/transaction. Acquisition is the FIRST statement; callbacks
 * then retain their existing authority/edge/path/row ordering. READ COMMITTED
 * gives their rechecks a fresh snapshot after the wait. No shared mode,
 * base-client fallback, late prepare(tx), or nested pooled transaction exists.
 *
 * Callers must do all guarded DB work through includeHistoryClient(context),
 * recheck authority after the wait, and keep network work/ceremonies outside.
 * The context is valid only during the callback. Post-commit side effects
 * belong after this promise resolves. This foundation alone activates no
 * production caller, retention policy or maintenance operation.
 */
export async function withIncludeHistoryTransaction<T>(
  db: Pick<PrismaClient, '$transaction'>,
  work: (context: IncludeHistoryTransaction) => Promise<T>,
  options: IncludeHistoryTransactionOptions = {},
): Promise<T> {
  if (current.getStore()) {
    throw new Error('A nested include-history transaction is forbidden; pass the prepared context');
  }
  const timeout = budget(options.timeoutMs, 30_000);
  const maxWait = budget(options.maxWaitMs, 5_000);
  return db.$transaction(async (tx) => {
    const expiresAt = performance.now() + timeout;
    // Prisma's transaction timeout does not interrupt an in-flight advisory wait.
    // Materialization applies the transaction-local lock budget before acquisition,
    // in the same first statement. executeRaw avoids deserializing PostgreSQL void.
    await tx.$executeRaw`
      WITH fence_budget AS MATERIALIZED (
        SELECT set_config('lock_timeout', ${`${timeout}ms`}, true)
      )
      SELECT pg_advisory_xact_lock(2063, 1772) FROM fence_budget`;
    if (performance.now() >= expiresAt) throw new Error('Include-history transaction expired');
    const context = Object.freeze(Object.create(null)) as IncludeHistoryTransaction;
    clients.set(context, { tx, expiresAt });
    try {
      return await current.run(context, () => work(context));
    } finally {
      clients.delete(context);
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait,
    timeout,
  });
}
