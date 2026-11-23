import { Prisma } from '../../generated/prisma/index.js';

/**
 * #4775 (item 5): an infrastructure fault (the database is unreachable, a query failed) is not a judgment about a secret.
 * A catch that turns "this secret cannot be used" into a refusal must let these through, so an outage never reads as
 * "invalid binding" or "secret unavailable" (#1955).
 */
const INFRASTRUCTURE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);

export function isStoreFault(error: unknown): boolean {
  // A known-request error is an outage only for the connection class (cannot reach, timed out, closed, pool exhausted, transaction
  // aborted, write conflict). A missing row (P2025) or a constraint (P2002, P2003) is a judgment about data, so it keeps its own path.
  if (error instanceof Prisma.PrismaClientKnownRequestError) return INFRASTRUCTURE_CODES.has(error.code);
  return error instanceof Prisma.PrismaClientUnknownRequestError || error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientRustPanicError;
}
