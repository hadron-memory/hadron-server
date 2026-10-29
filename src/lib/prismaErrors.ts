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

/** `meta.target` spellings of the Node `@@unique([loc, memoryId])` (the engine emits either mapping). */
const NODE_LOC_UNIQUE_COLUMNS = [['loc', 'memory_id'], ['loc', 'memoryId']] as const;
const NODE_LOC_UNIQUE_NAME = 'nodes_loc_memory_id_key';

/**
 * #2476: true only for a P2002 on the Node `(loc, memory_id)` unique — the
 * cold-path loss of an `update: {}` ensure-upsert, where "the row exists" is
 * the promised post-condition (hrn:node:hadronmemory.com:dev:findings:prisma-upsert-not-race-safe).
 * Any other unique, a missing target, or a non-Prisma error is not that race.
 */
export function isNodeLocUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  if (target === NODE_LOC_UNIQUE_NAME) return true;
  if (!Array.isArray(target) || target.length !== 2) return false;
  return NODE_LOC_UNIQUE_COLUMNS.some((cols) => cols.every((c) => target.includes(c)));
}
