/**
 * Typed forms of the two refusals most resolvers raise (#1789). A plain `new Error('Forbidden')` is indistinguishable from
 * an internal fault, so the generic-error boundary (cor:api:260:01) would genericize an authorization refusal; these carry
 * their code, which also reaches the wire as FORBIDDEN / UNAUTHENTICATED instead of INTERNAL_SERVER_ERROR. The message is
 * unchanged, so callers that read it keep working.
 */
import { GraphQLError } from 'graphql';

export function forbiddenError(message = 'Forbidden'): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });
}

export function unauthenticatedError(): GraphQLError {
  return new GraphQLError('Unauthenticated', { extensions: { code: 'UNAUTHENTICATED' } });
}
