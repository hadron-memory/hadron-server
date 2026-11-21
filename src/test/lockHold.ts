/**
 * #4751: the one "hold a lock until released" latch shared by the #3558 edge-only revision pins
 * (`src/api/graphql/schema/resolvers.edgeOnlyRevision3497.test.ts`, `src/mcp/server.edgeOnlyRevision3497.test.ts`), which
 * used to carry three copies of it between them.
 *
 * `holdInTransaction(db, lock)` opens a Prisma interactive transaction, runs `lock(tx)` (take the row or advisory lock the
 * race needs), records the transaction's own backend pid, and resolves once the lock is held. The transaction then waits
 * until `release()` is called. Two hardenings over the inline copies:
 *
 * - **Fail fast.** If `lock(tx)` throws, the returned promise REJECTS with that error at once. Before, the latch only resolved
 *   on success, so a failing initial lock left the test waiting for the suite timeout.
 * - **The holder's pid.** `pid` is the backend that holds the lock, so a pin can require its waiter to be blocked by THAT
 *   backend (`waitBlocked` in `./lockObserver.ts`) rather than counting lock waiters in the database.
 */
import type { Prisma, PrismaClient } from '../generated/prisma/index.js';

export interface HeldLock {
  /** The backend pid of the transaction holding the lock. */
  pid: number;
  /** Let the holding transaction commit. */
  release: () => void;
  /** Settles when the holding transaction does. */
  done: Promise<unknown>;
}

export function holdInTransaction(
  db: PrismaClient,
  lock: (tx: Prisma.TransactionClient) => Promise<unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<HeldLock> {
  let release!: () => void;
  let held!: (pid: number) => void;
  const holding = new Promise<number>((resolve) => (held = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const done = db.$transaction(async (tx) => {
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await lock(tx);
    held(Number(pid));
    await gate;
  }, { timeout: opts.timeoutMs ?? 15_000 });
  // Whichever settles first: the lock is held (resolve), or the transaction failed before holding it (reject now).
  return Promise.race([
    holding.then((pid) => ({ pid, release, done })),
    done.then(
      () => { throw new Error('holdInTransaction: the transaction ended before the lock was held'); },
      (e: unknown) => { throw e; },
    ),
  ]);
}
