import { Prisma } from '../generated/prisma/index.js';
import { GraphQLError } from 'graphql';

/**
 * #1753 — Postgres picked this transaction as a deadlock victim (SQLSTATE
 * 40P01). Raw `SELECT … FOR UPDATE/SHARE` statements surface it as Prisma
 * P2010 with `meta.code`, a model operation as P2034.
 */
export function isDeadlockVictim(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === 'P2034') return true;
  const meta = e.meta as { code?: unknown } | undefined;
  return e.code === 'P2010' && meta?.code === '40P01';
}

/**
 * Runs a memory-writing transaction and reports a deadlock victim as the
 * documented, retryable MEMORY_WRITE_CONFLICT instead of a raw 40P01 / 500.
 * The lock order (memory, then node) is what prevents the known cycle with
 * promotion; this is the net under any ordering we have not found.
 */
export async function mapDeadlockToWriteConflict<T>(memoryId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (isDeadlockVictim(e)) {
      throw new GraphQLError('Memory write conflicted with a concurrent operation; retry.', {
        extensions: { code: 'MEMORY_WRITE_CONFLICT', memoryId },
      });
    }
    throw e;
  }
}
