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
/** The fence modes. They never nest: neither inside itself nor inside the other. */
type FenceMode = 'rc' | 'serializable-account';
const current = new AsyncLocalStorage<{ context: IncludeHistoryTransaction; mode: FenceMode }>();

/** The proof a SERIALIZABLE account transaction holds the fence AND a snapshot the epoch UPDATE proved fresh. */
export interface AccountFenceTransaction {
  readonly [prepared]: true;
}
const accountClients = new WeakMap<AccountFenceTransaction, {
  tx: Prisma.TransactionClient;
  expiresAt: number;
}>();

/** Obtain the SAME SERIALIZABLE transaction client; refuses forged, raw, reused or expired proofs. */
export function accountFenceClient(context: AccountFenceTransaction): Prisma.TransactionClient {
  const state = context && accountClients.get(context);
  if (!state || performance.now() >= state.expiresAt) {
    throw new Error('A live prepared account-fence transaction is required');
  }
  return state.tx;
}

/**
 * #2046 S9-3: advance the authority epoch. EVERY transaction that holds the fence runs this immediately after
 * acquiring it and before any caller work, so the bump commits (or rolls back) with the holder's own effects.
 * A SERIALIZABLE account transaction's copy of this statement is also its freshness proof: updating a row a
 * predecessor changed after the account's snapshot raises 40001. The row is seeded by migration/post-push and is
 * never inserted here, so a missing row fails closed.
 */
async function advanceEpoch(tx: Prisma.TransactionClient): Promise<void> {
  const updated = await tx.$executeRaw`UPDATE include_history_epoch SET n = n + 1 WHERE id = 1`;
  if (updated !== 1) throw new Error('The include-history epoch row is missing; refusing to run unfenced');
}

/** First statement of every fence holder: the lock, with its wait bounded by the transaction budget. */
async function acquireFence(tx: Prisma.TransactionClient, timeout: number): Promise<void> {
  // Prisma's transaction timeout does not interrupt an in-flight advisory wait.
  // Materialization applies the transaction-local lock budget before acquisition,
  // in the same first statement. executeRaw avoids deserializing PostgreSQL void.
  await tx.$executeRaw`
    WITH fence_budget AS MATERIALIZED (
      SELECT set_config('lock_timeout', ${`${timeout}ms`}, true)
    )
    SELECT pg_advisory_xact_lock(2063, 1772) FROM fence_budget`;
}

/** Obtain the SAME transaction client, refusing forged, raw or expired contexts before work. */
export function includeHistoryClient(context: IncludeHistoryTransaction): Prisma.TransactionClient {
  const state = context && clients.get(context);
  if (!state || performance.now() >= state.expiresAt) {
    throw new Error('A live prepared include-history transaction is required');
  }
  return state.tx;
}

/** One shared guard for both modes: opening any fence inside any fence is refused before a statement runs. */
function refuseNestedFence(): void {
  const open = current.getStore();
  if (open) {
    throw new Error(`A nested include-history transaction is forbidden (inside ${open.mode}); pass the prepared context`);
  }
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
  refuseNestedFence();
  const timeout = budget(options.timeoutMs, 30_000);
  const maxWait = budget(options.maxWaitMs, 5_000);
  return db.$transaction(async (tx) => {
    const expiresAt = performance.now() + timeout;
    await acquireFence(tx, timeout);
    await advanceEpoch(tx);
    if (performance.now() >= expiresAt) throw new Error('Include-history transaction expired');
    const context = Object.freeze(Object.create(null)) as IncludeHistoryTransaction;
    clients.set(context, { tx, expiresAt });
    try {
      return await current.run({ context, mode: 'rc' }, () => work(context));
    } finally {
      clients.delete(context);
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    maxWait,
    timeout,
  });
}

/**
 * #2046 S9-3: the SERIALIZABLE sibling for whole-transaction account operations (deleteUser, mergeUsers,
 * deleteWorker). ONE Prisma transaction on ONE backend: the fence is the first statement (the snapshot is taken as
 * it starts, so it may be stale once the wait ends), then the epoch UPDATE proves it was not. If any fence holder
 * committed after the snapshot, the UPDATE raises 40001 (P2010) and NO work ran; the caller re-runs the WHOLE attempt
 * (fresh transaction, fresh snapshot, recomputed inputs) via {@link isSerializationConflict}. If it passes, no fence
 * holder committed since the snapshot and the fence is held to commit, so none can until this transaction ends. The
 * fence dies with the backend that would commit, so losing the lock owner cannot leave committing unfenced work.
 *
 * Scope of the proof: fence PARTICIPANTS only. It does not make an unfenced writer's change visible; the account
 * operation's own anchors, row locks and SSI stay as they were, and its isolation is not downgraded.
 */
export async function withAccountFenceTransaction<T>(
  db: Pick<PrismaClient, '$transaction'>,
  work: (context: AccountFenceTransaction) => Promise<T>,
  options: IncludeHistoryTransactionOptions = {},
): Promise<T> {
  refuseNestedFence();
  const timeout = budget(options.timeoutMs, 30_000);
  const maxWait = budget(options.maxWaitMs, 5_000);
  return db.$transaction(async (tx) => {
    const expiresAt = performance.now() + timeout;
    await acquireFence(tx, timeout);
    await advanceEpoch(tx);
    if (performance.now() >= expiresAt) throw new Error('Account-fence transaction expired');
    const context = Object.freeze(Object.create(null)) as AccountFenceTransaction;
    accountClients.set(context, { tx, expiresAt });
    try {
      return await current.run({ context: context as unknown as IncludeHistoryTransaction, mode: 'serializable-account' }, () => work(context));
    } finally {
      accountClients.delete(context);
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait,
    timeout,
  });
}

/**
 * True for a serialization/deadlock conflict in EITHER shape Prisma reports: P2034 for the transaction, or P2010 with
 * SQLSTATE 40001/40P01 when a raw statement (the fence, the epoch UPDATE, an account FOR UPDATE) hits it.
 * Timeouts, a missing epoch row, overflow and permission errors are deliberately NOT conflicts.
 */
export function isSerializationConflict(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === 'P2034') return true;
  const sqlstate = (e.meta as { code?: unknown } | undefined)?.code;
  return e.code === 'P2010' && (sqlstate === '40001' || sqlstate === '40P01');
}

/**
 * Bridge existing client callbacks at their OUTER transaction entry. This
 * opens the prepared fence before any callback statement; it never upgrades
 * or reuses an unprepared transaction and offers no isolation override.
 */
export function withIncludeHistoryClientTransaction<T>(
  db: Pick<PrismaClient, '$transaction'>,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { timeout?: number; maxWait?: number } = {},
): Promise<T> {
  return withIncludeHistoryTransaction(db, (history) => work(includeHistoryClient(history)), {
    timeoutMs: options.timeout,
    maxWaitMs: options.maxWait,
  });
}

/** A legacy client-shaped helper still needs the SAME live opaque outer proof. */
export function assertIncludeHistoryClient(client: unknown): void {
  const history = current.getStore();
  if (!history || (history.mode === 'rc'
    ? includeHistoryClient(history.context)
    : accountFenceClient(history.context as unknown as AccountFenceTransaction)) !== client) {
    throw new Error('A live prepared include-history client is required before revision or qualification work');
  }
}
