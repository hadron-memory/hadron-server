/** Test-only advisory barrier shared by the #1739 regression and its callers. */
import type { PrismaClient } from '../generated/prisma/index.js';

export type AdvisoryWaiter = { pid: number; key:
  | { form: 'int-pair'; first: string; second: string }
  | { form: 'hashed-bigint'; value: string }
};

/** Snapshot used by deterministic negative controls; currently reproduces #1739. */
export async function advisoryWaiterPresent(db: PrismaClient, _scope?: AdvisoryWaiter): Promise<boolean> {
  const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>`
    SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
  return n > 0n;
}

/** Wait on actual PG state, bounded as the original helpers were. */
export async function waitForAdvisoryWaiter(db: PrismaClient, scope?: AdvisoryWaiter, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await advisoryWaiterPresent(db, scope)) return;
    if (Date.now() > deadline) throw new Error('no target backend waited on the expected advisory lock');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
