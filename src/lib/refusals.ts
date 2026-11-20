/**
 * Typed forms of the refusals most resolvers raise (#1789; not-found added by #4537). A plain `new Error('Forbidden')` is indistinguishable from
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

/**
 * A typed not-found refusal named for its entity (#4537; hrn:node:hadronmemory.com:specs:cor:api:140:01 fixes the
 * entity-named code, e.g. SESSION_NOT_FOUND). The code is the caller's, so no surface is hard-wired to a bare NOT_FOUND;
 * clients map any `*_NOT_FOUND` to not-found. Use one call, with one message, for every reason a reference does not
 * resolve for the caller (missing, deleted, another tenant's), so the answer is no existence oracle
 * (hrn:node:hadronmemory.com:specs:cor:api:260:01).
 */
export function notFoundError(code: `${string}_NOT_FOUND`, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}
