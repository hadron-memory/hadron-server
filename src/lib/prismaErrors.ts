import { Prisma } from '../generated/prisma/index.js';

/**
 * #1688: Prisma messages contain query arguments and schema internals, so none
 * may reach a client. One predicate for every surface that redacts them — the
 * GraphQL formatter, and a wrapper that would otherwise copy the message into
 * an error of its own (#1691: the partial-merge wrapper).
 */
export function isPrismaClientError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientValidationError ||
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError;
}

/** What a client is told in place of a Prisma message. */
export const REDACTED_DB_ERROR_MESSAGE = 'Unable to complete this request. Please try again.';
