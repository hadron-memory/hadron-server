import { GraphQLError } from 'graphql';

/**
 * #2403: an App's session timeout stamps every session's expiry, which cor:aut:020:02 makes a promise, so a
 * non-positive ceiling would be past before the session began. Refuses it with BAD_USER_INPUT; null/omitted
 * passes (the caller keeps or defaults it). No floor or cap: a range is a product ruling. Callers run it after
 * their access gate and before any write, so it adds no oracle.
 */
export function assertPositiveSessionTimeout(seconds: number | null | undefined): void {
  if (seconds != null && seconds <= 0) {
    throw new GraphQLError('sessionTimeoutSeconds must be a positive number of seconds.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
}
