/** #1162: only our typed DB guard becomes a public provenance refusal. */
import { GraphQLError } from 'graphql';
import { Prisma } from '../generated/prisma/index.js';

export function workerReferenceError(error: unknown): GraphQLError | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError)) return null;
  // PostgreSQL errors retain our static marker in both model and raw-query
  // wrappers. Hex carries exactly the ref, without escaping/diagnostic prose.
  const meta = error instanceof Prisma.PrismaClientKnownRequestError ? error.meta : undefined;
  const diagnostic = meta?.code === 'P1162' && typeof meta.message === 'string'
    ? meta.message
    : error.message.match(/PostgresError \{ code: "P1162", message: "([^"]*)"/)?.[1];
  // Do not promote an echoed query argument containing our marker into a
  // trusted domain refusal: require the connector's dedicated SQLSTATE.
  const match = diagnostic?.match(/WORKER_REFERENCE_NOT_FOUND ref=([0-9a-f]+) kind=(worker|session) writer=([a-z_]+)/);
  if (!match) return null;
  const referenceRef = Buffer.from(match[1], 'hex').toString('utf8');
  const referenceKind = match[2];
  const writer = match[3];
  return new GraphQLError(`Cannot add a new ${referenceKind} reference to an identity that no longer exists (${referenceRef}, writer ${writer}).`, {
    extensions: { code: 'WORKER_REFERENCE_NOT_FOUND', referenceRef, referenceKind, writer,
      ...(referenceKind === 'worker' ? { workerRef: referenceRef } : {}) },
  });
}
