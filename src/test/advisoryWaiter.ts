/** Exact PostgreSQL advisory barriers for race tests (#1739). Test code only. */
import type { PrismaClient } from '../generated/prisma/index.js';

export type AdvisoryWaiter = { pid: number; key:
  | { form: 'int-pair'; first: string; second: string }
  | { form: 'hashed-bigint'; value: string }
};

/** Match the target backend, current database and actual advisory function/key form. */
export async function advisoryWaiterPresent(db: PrismaClient, scope: AdvisoryWaiter): Promise<boolean> {
  const { pid, key } = scope;
  if (key.form === 'int-pair') {
    const [{ present }] = await db.$queryRaw<Array<{ present: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted AND pid = ${pid}
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = hashtext(${key.first})::oid
          AND objid = hashtext(${key.second})::oid AND objsubid = 2) AS present`;
    return present;
  }
  const [{ present }] = await db.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS(SELECT 1 FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted AND pid = ${pid}
        AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        AND classid = (((hashtext(${key.value})::bigint >> 32) & 4294967295))::oid
        AND objid = ((hashtext(${key.value})::bigint & 4294967295))::oid
        AND objsubid = 1) AS present`;
  return present;
}

/** Wait on actual PG state, bounded as the original helpers were. */
export async function waitForAdvisoryWaiter(db: PrismaClient, scope: AdvisoryWaiter, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await advisoryWaiterPresent(db, scope)) return;
    if (Date.now() > deadline) throw new Error('no target backend waited on the expected advisory lock');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Observe the real interactive transaction's backend without replacing its
 * connection, callback, options or lock sequence. Pass this client only to the
 * operation under test; its holder/observer keep the original client (#1739).
 */
export function observeTransactionBackend(db: PrismaClient): {
  db: PrismaClient;
  backendFor: (operation: Promise<unknown>) => Promise<number>;
} {
  let resolve!: (pid: number) => void;
  const backend = new Promise<number>((done) => { resolve = done; });
  const transaction = db.$transaction.bind(db);
  const observed = new Proxy(db, {
    get(target, property) {
      if (property !== '$transaction') return Reflect.get(target, property, target);
      return (action: unknown, options?: unknown) => {
        if (typeof action !== 'function') return Reflect.apply(transaction, db, [action, options]);
        return transaction(async (tx) => {
          const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          resolve(pid);
          return action(tx);
        }, options as Parameters<typeof transaction>[1]);
      };
    },
  });
  return {
    db: observed,
    // An operation that refuses before starting a transaction must not leave
    // the test awaiting a PID forever (or create an unhandled rejection).
    backendFor: (operation) => Promise.race([backend, operation.then(() => {
      throw new Error('operation finished without an observed interactive transaction');
    })]),
  };
}
