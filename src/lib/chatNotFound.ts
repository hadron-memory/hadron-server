import { GraphQLError } from 'graphql';

/** #3582 / cor:api:140:03: a missing or concealed chat answers one fixed refusal; it relays neither a resolved identity nor the caller's own selector (#5168). */
export function chatNotFoundError(): GraphQLError {
  return new GraphQLError('Chat not found', { extensions: { code: 'CHAT_NOT_FOUND' } });
}
