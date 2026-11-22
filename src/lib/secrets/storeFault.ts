import { Prisma } from '../../generated/prisma/index.js';

/**
 * #4775 (item 5): an infrastructure fault (the database is unreachable, a query failed) is not a judgment about a secret.
 * A catch that turns "this secret cannot be used" into a refusal must let these through, so an outage never reads as
 * "invalid binding" or "secret unavailable" (#1955).
 */
export function isStoreFault(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError || error instanceof Prisma.PrismaClientRustPanicError;
}
