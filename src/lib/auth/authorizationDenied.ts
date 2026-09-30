import { GraphQLError } from 'graphql';

/**
 * The shared gates' authorization denial, typed (#1493, following #1313).
 *
 * The gates used to throw a plain `Error('Forbidden')`. Apollo wraps a plain
 * `Error` as `extensions.code: "INTERNAL_SERVER_ERROR"`, so an ordinary
 * refusal reached every client as a server fault. A client could only tell the
 * two apart by parsing the message, and alerting paged on refusals
 * (`conventions:the-error-code-is-the-contract-the-prose-is-not`).
 *
 * The message is unchanged on purpose. Callers that collapse a denial into
 * `false`, `null` or a concealed not-found match on
 * `e instanceof Error && e.message === 'Forbidden'`. A `GraphQLError` is an
 * `Error` with the same message, so every one of them still matches. A surface
 * that conceals existence keeps its own code: it catches this and rethrows
 * its concealment error, so typing the denial does not reach its wire.
 *
 * @param message The refusal text. Defaults to the gates' established `Forbidden`.
 */
export function authorizationDenied(message = 'Forbidden'): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });
}
