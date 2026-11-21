/**
 * #3539 — the serialization-failure predicate, a leaf with no project imports, so the alarm helpers that only need to
 * recognise the abort do not reach `stall.ts` (and through it the GraphQL resolvers). `stall.ts` re-exports it, so every
 * existing import keeps working. The body is moved verbatim; the retry wrapper (`serializableRetry.ts`, which carries its
 * own predicate and a different retry policy) is deliberately not touched.
 */

import { Prisma } from '../../generated/prisma/index.js';

/**
 * A serialization failure: Prisma reports P2034 for the transaction, or
 * P2010 with SQLSTATE 40001 when a raw statement hits it.
 */
export function isSerializationFailure(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (e.code === 'P2034') return true;
  const meta = e.meta as { code?: unknown } | undefined;
  return e.code === 'P2010' && meta?.code === '40001';
}
